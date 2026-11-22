import {
  App,
  MarkdownView,
  Platform,
  Scope,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  CalendarTab,
  DateKey,
  DayCalendarMeta,
  POPOVER_SIZE_PRESETS,
  PopoverSizeConfig,
  PopoverSizePreset,
} from "../types";
import { VaultSyncManager } from "../storage/vaultSync";
import { getDayOfWeek, parseDateKey } from "../calendar/dateUtils";

// [ID 6.1] 메모잇 스타일 플로팅 팝오버 + 옵시디언 네이티브 Live Preview 에디터 임베드
// -> 1순위: 옵시디언 내부 ScrollableMarkdownEditor(EmbeddableMarkdownEditor 패턴)를 마운트하여
//          빈 날짜에서 임시 파일을 생성하지 않고도 100% 네이티브 Live Preview([[위키링크]], 체크박스 등)를 제공함.
// -> 2순위(폴백): 내부 API 구조가 변경된 환경에서는 분리된 WorkspaceLeaf의 MarkdownView를 마운트함.
// -> 3순위(최후 폴백): 일반 textarea로 안전하게 동작을 보장함.

const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"];

interface ScrollableMarkdownEditorCtor {
  new (app: App, container: HTMLElement, options: Record<string, unknown>): {
    editorEl: HTMLElement;
    cm: EditorView;
    get(): string;
    set(value: string): void;
    destroy(): void;
    onUpdate?(update: { docChanged: boolean }, changed: boolean): void;
    buildLocalExtensions?(): unknown[];
  };
}

let cachedEditorCtor: ScrollableMarkdownEditorCtor | null | undefined = undefined;

/**
 * [ID 6.2] 옵시디언 내장 ScrollableMarkdownEditor 생성자 동적 추출
 * -> Excalidraw/Make.md 등에서 검증된 embedRegistry.embedByExtension.md 패턴을 사용하여
 *    별도 파일 없이 네이티브 Live Preview 에디터를 인스턴스화할 수 있는 베이스 클래스를 확보함.
 */
function resolveScrollableMarkdownEditorCtor(
  app: App
): ScrollableMarkdownEditorCtor | null {
  if (cachedEditorCtor !== undefined) {
    return cachedEditorCtor;
  }
  try {
    const anyApp = app as unknown as {
      embedRegistry?: {
        embedByExtension?: {
          md?: (
            ctx: Record<string, unknown>,
            file: unknown,
            subpath: string
          ) => {
            editable?: boolean;
            showEditor?: () => void;
            editMode?: Record<string, unknown>;
            unload?: () => void;
          };
        };
      };
    };

    const mdEmbedFactory = anyApp.embedRegistry?.embedByExtension?.md;
    if (!mdEmbedFactory) {
      cachedEditorCtor = null;
      return null;
    }

    const dummyEl = document.createElement("div");
    const fakeFile = {
      basename: "",
      extension: "md",
      name: ".md",
      path: "",
      stat: { ctime: 0, mtime: 0, size: 0 },
      vault: app.vault,
    };
    const embed = mdEmbedFactory(
      {
        app,
        containerEl: dummyEl,
        displayMode: false,
        showInline: false,
        depth: 0,
        linktext: "",
        sourcePath: "",
      },
      fakeFile,
      ""
    );

    embed.editable = true;
    embed.showEditor?.();

    const editMode = embed.editMode;
    let ctor: ScrollableMarkdownEditorCtor | undefined;
    if (editMode) {
      // embed.editMode는 MarkdownEmbedEditor 인스턴스이고, 그 상위 프로토타입이 범용 ScrollableMarkdownEditor임.
      // (MarkdownEmbedEditor는 MarkdownEmbed 전용 owner를 요구하므로 한 단계 위 부모 클래스를 상속해야 안전함)
      const proto1 = Object.getPrototypeOf(editMode);
      const proto2 = proto1 ? Object.getPrototypeOf(proto1) : null;
      if (proto2 && typeof proto2.constructor === "function" && proto2.constructor !== Object) {
        ctor = proto2.constructor as ScrollableMarkdownEditorCtor;
      } else if (proto1 && typeof proto1.constructor === "function" && proto1.constructor !== Object) {
        ctor = proto1.constructor as ScrollableMarkdownEditorCtor;
      }
    }

    embed.unload?.();

    if (typeof ctor === "function") {
      cachedEditorCtor = ctor;
      return ctor;
    }
  } catch (err) {
    console.warn(
      "[calendar-memo] ScrollableMarkdownEditor resolution failed, will use fallback:",
      err
    );
  }
  cachedEditorCtor = null;
  return null;
}

function hasOpenObsidianPopup(): boolean {
  return Boolean(
    document.querySelector(
      ".suggestion-container, .menu, .prompt, .modal-container"
    )
  );
}

export interface PopoverOpenOptions {
  app: App;
  vaultSync: VaultSyncManager;
  tab: CalendarTab;
  dateKey: DateKey;
  meta: DayCalendarMeta;
  anchorRect: DOMRect;
  initialSize: PopoverSizeConfig;
  onSizeChange: (size: PopoverSizeConfig) => void;
  onClosed: (dateKey: DateKey, finalContent: string) => void;
}

const POPOVER_MIN_WIDTH = 280;
const POPOVER_MIN_HEIGHT = 180;
const POPOVER_VIEWPORT_MARGIN = 12;

export class CalendarPopoverEditor {
  private app: App;
  private vaultSync: VaultSyncManager;
  private tab: CalendarTab;
  private dateKey: DateKey;
  private currentSize: PopoverSizeConfig;
  private onSizeChange: (size: PopoverSizeConfig) => void;
  private onClosed: (dateKey: DateKey, finalContent: string) => void;

  private popoverEl: HTMLElement | null = null;
  private sizeButtons = new Map<
    Exclude<PopoverSizePreset, "custom">,
    HTMLButtonElement
  >();
  private isOpen = false;
  private isClosing = false;
  private isInteracting = false;
  private dirty = false;
  private saveTimer: number | null = null;
  private initialContent = "";

  // 에디터 백엔드 핸들 (셋 중 하나만 활성화)
  private nativeEditor: {
    get(): string;
    destroy(): void;
    cm?: EditorView;
  } | null = null;
  private fallbackLeaf: WorkspaceLeaf | null = null;
  private fallbackFileCreated = false;
  private fallbackTextarea: HTMLTextAreaElement | null = null;

  private scope: Scope | null = null;
  private outsidePointerHandler: ((e: PointerEvent) => void) | null = null;
  private keydownCaptureHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(options: PopoverOpenOptions) {
    this.app = options.app;
    this.vaultSync = options.vaultSync;
    this.tab = options.tab;
    this.dateKey = options.dateKey;
    this.currentSize = { ...options.initialSize };
    this.onSizeChange = options.onSizeChange;
    this.onClosed = options.onClosed;
    void this.open(options.meta, options.anchorRect);
  }

  getDateKey(): DateKey {
    return this.dateKey;
  }

  isActive(): boolean {
    return this.isOpen;
  }

  private async open(meta: DayCalendarMeta, anchorRect: DOMRect): Promise<void> {
    this.isOpen = true;
    this.initialContent = await this.vaultSync.readMemo(this.tab, this.dateKey);
    if (!this.isOpen) return; // 비동기 로드 중 닫힌 경우 방어

    const popoverEl = document.body.createDiv({ cls: "cm-popover" });
    this.popoverEl = popoverEl;

    this.positionPopover(popoverEl, anchorRect);
    this.renderHeader(popoverEl, meta);

    const editorHost = popoverEl.createDiv({ cls: "cm-popover-editor-host" });
    const mounted = await this.mountEditor(editorHost);
    if (!mounted) {
      this.mountTextareaFallback(editorHost);
    }

    // [ID 6.6.1] 드래그 리사이즈 핸들 부착 (우측·좌측·하단·좌하단·우하단)
    // -> 토요일처럼 화면 우측 끝에 붙은 셀에서도 왼쪽으로 넓힐 수 있도록 양쪽 방향 핸들을 모두 지원함.
    this.attachResizeHandles(popoverEl);

    // [ID 6.3] 팝오버 단축키(Ctrl/Cmd+Enter 저장·닫기, ESC 닫기) 및 외부 클릭 닫기 핸들러
    // -> 옵시디언 전역 키맵(Cmd/Ctrl+Enter = 체크박스 토글)과 한글 IME 조합 상태(e.key === 'Process')보다
    //    먼저 가로채기 위해 Scope 푸시 + window 캡처 리스너(e.code === 'Enter' 병행)를 이중 적용함.
    const scope = new Scope(this.app.scope);
    scope.register(["Mod"], "Enter", (evt) => {
      evt.preventDefault();
      void this.close();
      return false;
    });
    scope.register(["Ctrl"], "Enter", (evt) => {
      evt.preventDefault();
      void this.close();
      return false;
    });
    scope.register([], "Escape", (evt) => {
      if (hasOpenObsidianPopup()) return;
      evt.preventDefault();
      void this.close();
      return false;
    });
    this.scope = scope;
    this.app.keymap.pushScope(scope);

    this.keydownCaptureHandler = (e: KeyboardEvent) => {
      if (!this.isOpen) return;
      const isEnter = e.key === "Enter" || e.code === "Enter";
      if ((e.metaKey || e.ctrlKey) && isEnter) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.close();
        return;
      }
      if (e.key === "Escape" || e.code === "Escape") {
        if (hasOpenObsidianPopup()) {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.close();
      }
    };
    window.addEventListener("keydown", this.keydownCaptureHandler, true);

    // 팝오버를 연 더블클릭/포인터 이벤트와 충돌하지 않도록 다음 프레임에 외부 클릭 리스너 등록
    window.setTimeout(() => {
      if (!this.isOpen) return;
      this.outsidePointerHandler = (e: PointerEvent) => {
        if (this.isInteracting) return;
        const target = e.target as HTMLElement | null;
        if (!target || !this.popoverEl) return;
        if (this.popoverEl.contains(target)) return;
        if (
          target.closest(
            ".suggestion-container, .menu, .modal-container, .prompt"
          )
        ) {
          return;
        }
        void this.close();
      };
      document.addEventListener("pointerdown", this.outsidePointerHandler, true);
    }, 0);
  }

  /**
   * [ID 6.4] 셀 기준 팝오버 위치 및 저장된 크기 산출 (소/중/대/커스텀 지원 + 화면 밖 클램핑)
   */
  private positionPopover(popoverEl: HTMLElement, anchorRect: DOMRect): void {
    const margin = POPOVER_VIEWPORT_MARGIN;
    const maxW = Math.max(POPOVER_MIN_WIDTH, window.innerWidth - margin * 2);
    const maxH = Math.max(POPOVER_MIN_HEIGHT, window.innerHeight - margin * 2);

    const baseWidth =
      this.currentSize.preset !== "custom"
        ? POPOVER_SIZE_PRESETS[this.currentSize.preset].width
        : this.currentSize.width;
    const baseHeight =
      this.currentSize.preset !== "custom"
        ? POPOVER_SIZE_PRESETS[this.currentSize.preset].height
        : this.currentSize.height;

    const width = Math.min(Math.max(baseWidth, POPOVER_MIN_WIDTH), maxW);
    const height = Math.min(Math.max(baseHeight, POPOVER_MIN_HEIGHT), maxH);

    // 셀의 중심을 기준으로 배치하고 화면 밖으로 넘치지 않도록 클램핑
    let left = anchorRect.left - (width - anchorRect.width) / 2;
    let top = anchorRect.top - (height - anchorRect.height) / 2;

    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

    popoverEl.style.left = `${Math.round(left)}px`;
    popoverEl.style.top = `${Math.round(top)}px`;
    popoverEl.style.width = `${Math.round(width)}px`;
    popoverEl.style.height = `${Math.round(height)}px`;
    popoverEl.classList.toggle("is-compact", width < 430);
  }

  /**
   * [ID 6.6.2] 소/중/대 프리셋 클릭 시 중심점을 유지하며 크기 전환 및 설정 저장
   */
  private applySizePreset(preset: Exclude<PopoverSizePreset, "custom">): void {
    if (!this.popoverEl) return;
    const margin = POPOVER_VIEWPORT_MARGIN;
    const target = POPOVER_SIZE_PRESETS[preset];
    const maxW = Math.max(POPOVER_MIN_WIDTH, window.innerWidth - margin * 2);
    const maxH = Math.max(POPOVER_MIN_HEIGHT, window.innerHeight - margin * 2);
    const nextW = Math.min(target.width, maxW);
    const nextH = Math.min(target.height, maxH);

    const rect = this.popoverEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let left = centerX - nextW / 2;
    let top = centerY - nextH / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - nextW - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - nextH - margin));

    this.popoverEl.style.left = `${Math.round(left)}px`;
    this.popoverEl.style.top = `${Math.round(top)}px`;
    this.popoverEl.style.width = `${Math.round(nextW)}px`;
    this.popoverEl.style.height = `${Math.round(nextH)}px`;
    this.popoverEl.classList.toggle("is-compact", nextW < 430);

    this.currentSize = {
      preset,
      width: Math.round(nextW),
      height: Math.round(nextH),
    };
    this.updateSizePresetButtons();
    this.onSizeChange({ ...this.currentSize });
  }

  private updateSizePresetButtons(): void {
    for (const [key, btn] of this.sizeButtons.entries()) {
      btn.toggleClass("is-active", this.currentSize.preset === key);
    }
  }

  /**
   * [ID 6.6.3] 팝오버 헤더 드래그 이동 & 테두리/코너 드래그 크기 조절
   */
  private attachHeaderDrag(headerEl: HTMLElement): void {
    headerEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.popoverEl) return;
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;

      e.preventDefault();
      this.isInteracting = true;
      const startX = e.clientX;
      const startY = e.clientY;
      const startRect = this.popoverEl.getBoundingClientRect();
      this.popoverEl.addClass("is-dragging");

      const onMove = (ev: PointerEvent) => {
        if (!this.popoverEl) return;
        const margin = POPOVER_VIEWPORT_MARGIN;
        const nextLeft = Math.max(
          margin,
          Math.min(
            startRect.left + (ev.clientX - startX),
            window.innerWidth - startRect.width - margin
          )
        );
        const nextTop = Math.max(
          margin,
          Math.min(
            startRect.top + (ev.clientY - startY),
            window.innerHeight - startRect.height - margin
          )
        );
        this.popoverEl.style.left = `${Math.round(nextLeft)}px`;
        this.popoverEl.style.top = `${Math.round(nextTop)}px`;
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        this.popoverEl?.removeClass("is-dragging");
        window.setTimeout(() => {
          this.isInteracting = false;
        }, 0);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  private attachResizeHandles(popoverEl: HTMLElement): void {
    const directions: Array<"e" | "w" | "s" | "se" | "sw"> = [
      "e",
      "w",
      "s",
      "se",
      "sw",
    ];

    for (const dir of directions) {
      const handle = popoverEl.createDiv({
        cls: `cm-popover-resize cm-resize-${dir}`,
        attr: { "aria-label": "창 크기 조절" },
      });

      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !this.popoverEl) return;
        e.preventDefault();
        e.stopPropagation();

        this.isInteracting = true;
        this.popoverEl.addClass("is-resizing");

        const startX = e.clientX;
        const startY = e.clientY;
        const startRect = this.popoverEl.getBoundingClientRect();
        const margin = POPOVER_VIEWPORT_MARGIN;

        const onMove = (ev: PointerEvent) => {
          if (!this.popoverEl) return;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;

          let left = startRect.left;
          let width = startRect.width;
          let height = startRect.height;

          if (dir === "e" || dir === "se") {
            const maxW = window.innerWidth - startRect.left - margin;
            width = Math.max(POPOVER_MIN_WIDTH, Math.min(startRect.width + dx, maxW));
          } else if (dir === "w" || dir === "sw") {
            const maxRight = startRect.right;
            const proposedLeft = Math.max(
              margin,
              Math.min(startRect.left + dx, maxRight - POPOVER_MIN_WIDTH)
            );
            left = proposedLeft;
            width = maxRight - proposedLeft;
          }

          if (dir === "s" || dir === "se" || dir === "sw") {
            const maxH = window.innerHeight - startRect.top - margin;
            height = Math.max(
              POPOVER_MIN_HEIGHT,
              Math.min(startRect.height + dy, maxH)
            );
          }

          this.popoverEl.style.left = `${Math.round(left)}px`;
          this.popoverEl.style.width = `${Math.round(width)}px`;
          this.popoverEl.style.height = `${Math.round(height)}px`;
          this.popoverEl.classList.toggle("is-compact", width < 430);
        };

        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          if (this.popoverEl) {
            this.popoverEl.removeClass("is-resizing");
            const finalRect = this.popoverEl.getBoundingClientRect();
            this.currentSize = {
              preset: "custom",
              width: Math.round(finalRect.width),
              height: Math.round(finalRect.height),
            };
            this.updateSizePresetButtons();
            this.onSizeChange({ ...this.currentSize });
          }
          window.setTimeout(() => {
            this.isInteracting = false;
          }, 0);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    }
  }

  private renderHeader(popoverEl: HTMLElement, meta: DayCalendarMeta): void {
    const header = popoverEl.createDiv({ cls: "cm-popover-header" });
    this.attachHeaderDrag(header);
    const titleWrap = header.createDiv({ cls: "cm-popover-title-wrap" });

    const { year, month, day } = parseDateKey(this.dateKey);
    const dow = WEEKDAY_KR[getDayOfWeek(this.dateKey)];
    const titleEl = titleWrap.createSpan({
      cls: "cm-popover-date-title",
      text: `${year}년 ${month}월 ${day}일 (${dow})`,
    });
    if (meta.isHoliday) {
      titleEl.addClass("is-holiday");
    }

    if (meta.holidayNames.length > 0) {
      titleWrap.createSpan({
        cls: "cm-popover-holiday-badge",
        text: meta.holidayNames.join(", "),
      });
    } else if (meta.lunarLabel) {
      titleWrap.createSpan({
        cls: "cm-popover-lunar-badge",
        text: `음 ${meta.lunarLabel}`,
      });
    }

    const actions = header.createDiv({ cls: "cm-popover-actions" });

    // [ID 6.6] 소 / 중 / 대 크기 프리셋 전환 버튼 그룹
    const sizeGroup = actions.createDiv({
      cls: "cm-popover-size-group",
      attr: { title: "편집창 크기 프리셋 (테두리 드래그로 자유 조절 가능)" },
    });
    this.sizeButtons.clear();
    const presets: Array<Exclude<PopoverSizePreset, "custom">> = [
      "small",
      "medium",
      "large",
    ];
    for (const presetKey of presets) {
      const cfg = POPOVER_SIZE_PRESETS[presetKey];
      const btn = sizeGroup.createEl("button", {
        cls: "clickable-icon cm-popover-size-btn",
        text: cfg.label,
        attr: {
          type: "button",
          "aria-label": `편집창 크기: ${cfg.label} (${cfg.width}x${cfg.height})`,
        },
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.applySizePreset(presetKey);
      });
      this.sizeButtons.set(presetKey, btn);
    }
    this.updateSizePresetButtons();

    const hintText = Platform.isMacOS ? "⌘+Enter 저장" : "Ctrl+Enter 저장";
    actions.createSpan({ cls: "cm-popover-hint", text: hintText });

    const openFileBtn = actions.createEl("button", {
      cls: "cm-icon-btn",
      attr: { "aria-label": "노트 탭으로 열기", type: "button" },
    });
    setIcon(openFileBtn, "external-link");
    openFileBtn.addEventListener("click", async () => {
      const content = this.getCurrentContent();
      await this.close();
      if (content.trim().length > 0) {
        const file = this.vaultSync.getNoteFile(this.tab, this.dateKey);
        if (file) {
          await this.app.workspace.getLeaf(true).openFile(file);
        }
      } else {
        const file = await this.vaultSync.ensureFileExists(
          this.tab,
          this.dateKey
        );
        await this.app.workspace.getLeaf(true).openFile(file);
      }
    });

    const closeBtn = actions.createEl("button", {
      cls: "cm-icon-btn",
      attr: { "aria-label": "저장 후 닫기", type: "button" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => void this.close());
  }

  private async mountEditor(hostEl: HTMLElement): Promise<boolean> {
    // 1순위: 옵시디언 네이티브 ScrollableMarkdownEditor (파일 없이도 Live Preview 작동)
    const BaseEditor = resolveScrollableMarkdownEditorCtor(this.app);
    if (BaseEditor) {
      try {
        const closePopover = () => void this.close();
        const scheduleSave = () => this.scheduleDebouncedSave();
        const notePath = this.vaultSync.getNotePath(this.tab, this.dateKey);

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        class CalendarInlineEditor extends BaseEditor {
          get file() {
            return self.vaultSync.getNoteFile(self.tab, self.dateKey);
          }

          get path() {
            return notePath;
          }

          onUpdate(update: { docChanged: boolean }, changed: boolean): void {
            super.onUpdate?.(update, changed);
            if (changed || update?.docChanged) {
              self.dirty = true;
              scheduleSave();
            }
          }

          buildLocalExtensions(): unknown[] {
            const parentExts = super.buildLocalExtensions?.() ?? [];
            return [
              ...parentExts,
              Prec.highest(
                keymap.of([
                  {
                    key: "Mod-Enter",
                    run: () => {
                      closePopover();
                      return true;
                    },
                  },
                  {
                    key: "Escape",
                    run: () => {
                      if (hasOpenObsidianPopup()) return false;
                      closePopover();
                      return true;
                    },
                  },
                ])
              ),
            ];
          }
        }

        const owner: Record<string, unknown> = {
          app: this.app,
          get file() {
            return self.vaultSync.getNoteFile(self.tab, self.dateKey);
          },
          get path() {
            return notePath;
          },
          onChange: () => {
            this.dirty = true;
            this.scheduleDebouncedSave();
          },
        };

        const instance = new CalendarInlineEditor(this.app, hostEl, owner);
        owner.editMode = instance;
        owner.editor = (instance as unknown as { editor?: unknown }).editor;

        instance.set(this.initialContent);
        this.nativeEditor = instance;

        // 포커스를 문서 끝으로 이동시켜 즉시 타이핑 가능하게 함
        window.requestAnimationFrame(() => {
          const cm = instance.cm;
          if (cm) {
            cm.focus();
            const len = cm.state.doc.length;
            cm.dispatch({ selection: { anchor: len } });
          }
        });
        return true;
      } catch (err) {
        console.warn(
          "[calendar-memo] ScrollableMarkdownEditor mount failed, falling back to MarkdownView:",
          err
        );
        hostEl.empty();
      }
    }

    // 2순위 폴백: 분리된 WorkspaceLeaf에 실제 MarkdownView(Live Preview) 마운트
    try {
      const existingBefore = this.vaultSync.getNoteFile(this.tab, this.dateKey);
      this.fallbackFileCreated = !existingBefore;
      const file = await this.vaultSync.ensureFileExists(this.tab, this.dateKey);

      const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(
        this.app
      );
      this.fallbackLeaf = leaf;
      hostEl.appendChild(
        (leaf as unknown as { containerEl: HTMLElement }).containerEl
      );
      await leaf.openFile(file, {
        active: true,
        state: { mode: "source", source: false },
      });

      const view = leaf.view;
      if (view instanceof MarkdownView) {
        view.editor.focus();
        const lastLine = view.editor.lastLine();
        view.editor.setCursor({
          line: lastLine,
          ch: view.editor.getLine(lastLine).length,
        });
      }
      return true;
    } catch (err) {
      console.warn(
        "[calendar-memo] MarkdownView fallback failed, using textarea:",
        err
      );
      hostEl.empty();
      return false;
    }
  }

  private mountTextareaFallback(hostEl: HTMLElement): void {
    const textarea = hostEl.createEl("textarea", {
      cls: "cm-popover-textarea-fallback",
      attr: { placeholder: "메모를 입력하세요..." },
    });
    textarea.value = this.initialContent;
    textarea.addEventListener("input", () => {
      this.dirty = true;
      this.scheduleDebouncedSave();
    });
    this.fallbackTextarea = textarea;
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }

  private scheduleDebouncedSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (!this.isOpen) return;
      const current = this.getCurrentContent();
      // 입력 도중에는 비어있을 때 바로 파일 삭제하지 않고, 내용이 있을 때만 실시간 동기화함.
      // (전부 지운 상태에서의 자동 삭제는 팝오버 닫을 때 확정 수행)
      if (current.trim().length > 0) {
        void this.vaultSync.writeMemo(this.tab, this.dateKey, current);
      }
    }, 450);
  }

  private getCurrentContent(): string {
    if (this.nativeEditor) {
      return this.nativeEditor.get();
    }
    if (this.fallbackLeaf && this.fallbackLeaf.view instanceof MarkdownView) {
      return this.fallbackLeaf.view.editor.getValue();
    }
    if (this.fallbackTextarea) {
      return this.fallbackTextarea.value;
    }
    return this.initialContent;
  }

  async close(): Promise<void> {
    if (!this.isOpen || this.isClosing) return;
    this.isClosing = true;
    this.isOpen = false;

    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.outsidePointerHandler) {
      document.removeEventListener(
        "pointerdown",
        this.outsidePointerHandler,
        true
      );
      this.outsidePointerHandler = null;
    }

    if (this.keydownCaptureHandler) {
      window.removeEventListener("keydown", this.keydownCaptureHandler, true);
      this.keydownCaptureHandler = null;
    }

    // 한글 IME 조합 중인 마지막 음절이 누락되지 않도록 포커스를 해제해 조합을 먼저 확정함
    if (
      document.activeElement instanceof HTMLElement &&
      this.popoverEl?.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }

    const finalContent = this.getCurrentContent();

    // 백엔드 정리
    if (this.nativeEditor) {
      try {
        this.nativeEditor.destroy();
      } catch {
        // ignore
      }
      this.nativeEditor = null;

      // 내용 변경이 있었거나 기존 파일이 있었는데 비워진 경우에만 저장/삭제 반영
      if (this.dirty || finalContent !== this.initialContent) {
        await this.vaultSync.writeMemo(this.tab, this.dateKey, finalContent);
      }
    } else if (this.fallbackLeaf) {
      try {
        if (this.fallbackLeaf.view instanceof MarkdownView) {
          await this.fallbackLeaf.view.save();
        }
        this.fallbackLeaf.detach();
      } catch {
        // ignore
      }
      this.fallbackLeaf = null;
      await this.vaultSync.deleteIfEmptySilently(
        this.tab,
        this.dateKey,
        this.fallbackFileCreated
      );
    } else if (this.fallbackTextarea) {
      this.fallbackTextarea = null;
      if (this.dirty || finalContent !== this.initialContent) {
        await this.vaultSync.writeMemo(this.tab, this.dateKey, finalContent);
      }
    }

    if (this.scope) {
      this.app.keymap.popScope(this.scope);
      this.scope = null;
    }

    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }

    this.onClosed(this.dateKey, finalContent);
  }
}
