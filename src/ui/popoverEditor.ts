import {
  App,
  MarkdownView,
  Notice,
  Platform,
  Scope,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  CELL_COLOR_PRESETS,
  CalendarTab,
  DateKey,
  DayCalendarMeta,
  POPOVER_SIZE_PRESETS,
  PopoverSizeConfig,
  PopoverSizePreset,
} from "../types";
import { UiStrings } from "../i18n";
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
  allTabs?: CalendarTab[];
  tabsWithMemo?: Set<string>;
  dateKey: DateKey;
  meta: DayCalendarMeta;
  anchorRect: DOMRect;
  initialSize: PopoverSizeConfig;
  strings: UiStrings;
  showTabBadge?: boolean;
  onSwitchToMultiCalendar?: () => void;
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
  private allTabs: CalendarTab[];
  private tabsWithMemo: Set<string>;
  private dateKey: DateKey;
  private currentSize: PopoverSizeConfig;
  private strings: UiStrings;
  private showTabBadge: boolean;
  private onSwitchToMultiCalendar?: () => void;
  private onSizeChange: (size: PopoverSizeConfig) => void;
  private onClosed: (dateKey: DateKey, finalContent: string) => void;

  private popoverEl: HTMLElement | null = null;
  private tabSelectorBarEl: HTMLElement | null = null;
  private editorHostEl: HTMLElement | null = null;
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
    this.allTabs = options.allTabs ?? [options.tab];
    this.tabsWithMemo = options.tabsWithMemo ?? new Set();
    this.dateKey = options.dateKey;
    this.currentSize = { ...options.initialSize };
    this.strings = options.strings;
    this.showTabBadge = Boolean(options.showTabBadge);
    this.onSwitchToMultiCalendar = options.onSwitchToMultiCalendar;
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
    // [ID 6.8.1] 전체 보기 모드에서 단일 셀 편집 시 대상 달력 선택 및 '동시 입력' 전환 바 표시
    if (this.showTabBadge && this.allTabs.length > 1) {
      this.tabSelectorBarEl = popoverEl.createDiv({ cls: "cm-popover-tab-bar" });
      this.renderPopoverTabSelector();
    }
    // [ID 6.7] 팝오버 빠른 서식/삽입 툴바 (체크박스, 글머리, 시간, 이모지 하이라이트, 링크, 구분선)
    this.renderFormattingToolbar(popoverEl);

    const editorHost = popoverEl.createDiv({ cls: "cm-popover-editor-host" });
    this.editorHostEl = editorHost;
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
    const s = this.strings;
    const header = popoverEl.createDiv({ cls: "cm-popover-header" });
    this.attachHeaderDrag(header);
    const titleWrap = header.createDiv({ cls: "cm-popover-title-wrap" });

    const { year, month, day } = parseDateKey(this.dateKey);
    const dow = getDayOfWeek(this.dateKey);
    const titleEl = titleWrap.createSpan({
      cls: "cm-popover-date-title",
      text: s.formatPopoverDate(year, month, day, dow),
    });
    if (meta.isHoliday) {
      titleEl.addClass("is-holiday");
    }

    if (this.showTabBadge) {
      titleWrap.createSpan({
        cls: "cm-popover-tab-badge",
        text: this.tab.name,
      });
    }

    if (meta.holidayNames.length > 0) {
      titleWrap.createSpan({
        cls: "cm-popover-holiday-badge",
        text: meta.holidayNames.join(", "),
      });
    } else if (meta.lunarLabel) {
      titleWrap.createSpan({
        cls: "cm-popover-lunar-badge",
        text: s.lang === "ko" ? `음 ${meta.lunarLabel}` : `Lunar ${meta.lunarLabel}`,
      });
    }

    const actions = header.createDiv({ cls: "cm-popover-actions" });

    // [ID 6.6] 소 / 중 / 대 크기 프리셋 전환 버튼 그룹
    const sizeGroup = actions.createDiv({
      cls: "cm-popover-size-group",
    });
    this.sizeButtons.clear();
    const presets: Array<{
      key: Exclude<PopoverSizePreset, "custom">;
      label: string;
    }> = [
      { key: "small", label: s.sizeSmall },
      { key: "medium", label: s.sizeMedium },
      { key: "large", label: s.sizeLarge },
    ];
    for (const p of presets) {
      const cfg = POPOVER_SIZE_PRESETS[p.key];
      const btn = sizeGroup.createEl("button", {
        cls: "clickable-icon cm-popover-size-btn",
        text: p.label,
        attr: {
          type: "button",
          "aria-label": `${p.label} (${cfg.width}x${cfg.height})`,
        },
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.applySizePreset(p.key);
      });
      this.sizeButtons.set(p.key, btn);
    }
    this.updateSizePresetButtons();

    const hintText = Platform.isMacOS ? s.saveHintMac : s.saveHintWin;
    actions.createSpan({ cls: "cm-popover-hint", text: hintText });

    const openFileBtn = actions.createEl("button", {
      cls: "cm-icon-btn",
      attr: { "aria-label": s.openInTabAria, type: "button" },
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
      attr: { "aria-label": s.saveCloseAria, type: "button" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => void this.close());
  }

  /**
   * [ID 6.8.1] 전체 보기 모드 팝오버 내 대상 달력 전환 바 + '여러 달력 동시 입력' 버튼
   * -> 전체 보기에서 어느 달력에 기록되는지 명확히 선택하고, 필요 시 여러 달력 동시 입력으로 즉시 전환함.
   */
  private renderPopoverTabSelector(): void {
    if (!this.tabSelectorBarEl) return;
    const s = this.strings;
    this.tabSelectorBarEl.empty();

    const chipsWrap = this.tabSelectorBarEl.createDiv({
      cls: "cm-popover-tab-chips",
    });

    this.allTabs.forEach((tab, idx) => {
      const isCurrent = tab.id === this.tab.id;
      const hasNote = this.tabsWithMemo.has(tab.id);
      const chip = chipsWrap.createEl("button", {
        cls: `clickable-icon cm-target-tab-chip cm-tab-color-${idx % 6} ${
          isCurrent ? "is-active" : ""
        }`,
        attr: { type: "button", title: tab.folderPath || "(root)" },
      });
      if (hasNote) {
        chip.createSpan({ cls: "cm-chip-has-memo-dot" });
      }
      chip.createSpan({ text: tab.name });
      chip.addEventListener("mousedown", (e) => e.preventDefault());
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (tab.id !== this.tab.id) {
          void this.switchEditorTargetTab(tab);
        }
      });
    });

    if (this.onSwitchToMultiCalendar) {
      const multiBtn = this.tabSelectorBarEl.createEl("button", {
        cls: "clickable-icon cm-popover-multi-btn",
        attr: {
          type: "button",
          title: s.batchMultiCalendarTip,
          "aria-label": s.batchMultiCalendarTip,
        },
      });
      setIcon(multiBtn.createSpan({ cls: "cm-fmt-icon" }), "layers");
      multiBtn.createSpan({ text: s.batchMultiCalendarBtn });
      multiBtn.addEventListener("mousedown", (e) => e.preventDefault());
      multiBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const switchFn = this.onSwitchToMultiCalendar;
        await this.close();
        switchFn?.();
      });
    }
  }

  private async switchEditorTargetTab(nextTab: CalendarTab): Promise<void> {
    if (!this.isOpen || nextTab.id === this.tab.id) return;

    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // 현재 탭의 수정 사항을 먼저 안전하게 저장
    const currentText = this.getCurrentContent();
    if (this.dirty || currentText !== this.initialContent) {
      await this.vaultSync.writeMemo(this.tab, this.dateKey, currentText);
      if (currentText.trim().length > 0) {
        this.tabsWithMemo.add(this.tab.id);
      } else {
        this.tabsWithMemo.delete(this.tab.id);
      }
    }

    this.tab = nextTab;
    this.initialContent = await this.vaultSync.readMemo(nextTab, this.dateKey);
    this.dirty = false;

    // 헤더의 탭 배지도 함께 갱신
    const headerBadge = this.popoverEl?.querySelector(".cm-popover-tab-badge");
    if (headerBadge) {
      headerBadge.textContent = nextTab.name;
    }
    this.renderPopoverTabSelector();

    // 네이티브 에디터가 활성 중이면 새 탭 내용으로 즉시 교체
    if (this.nativeEditor) {
      const setter = (
        this.nativeEditor as unknown as { set?: (val: string) => void }
      ).set;
      setter?.call(this.nativeEditor, this.initialContent);
      window.requestAnimationFrame(() => {
        const cm = this.nativeEditor?.cm;
        if (cm) {
          cm.focus();
          const len = cm.state.doc.length;
          cm.dispatch({ selection: { anchor: len } });
        }
      });
    } else if (this.fallbackLeaf && this.editorHostEl) {
      try {
        this.fallbackLeaf.detach();
      } catch {
        // ignore
      }
      this.fallbackLeaf = null;
      this.editorHostEl.empty();
      const mounted = await this.mountEditor(this.editorHostEl);
      if (!mounted) this.mountTextareaFallback(this.editorHostEl);
    } else if (this.fallbackTextarea) {
      this.fallbackTextarea.value = this.initialContent;
      this.fallbackTextarea.focus();
    }
  }

  /**
   * [ID 6.7] 캘린더 메모용 경량 서식 툴바
   * -> mousedown에서 preventDefault()를 호출해 버튼 클릭 시 에디터 포커스와 선택 영역이 풀리지 않도록 유지함.
   */
  private renderFormattingToolbar(popoverEl: HTMLElement): void {
    const s = this.strings;
    const bar = popoverEl.createDiv({ cls: "cm-popover-toolbar" });

    const makeBtn = (
      iconName: string,
      label: string,
      tooltip: string,
      onClick: () => void,
      showLabel = false
    ) => {
      const btn = bar.createEl("button", {
        cls: `clickable-icon cm-fmt-btn ${showLabel ? "has-label" : ""}`,
        attr: { type: "button", "aria-label": tooltip, title: tooltip },
      });
      setIcon(btn.createSpan({ cls: "cm-fmt-icon" }), iconName);
      if (showLabel) {
        btn.createSpan({ text: label });
      }
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return btn;
    };

    makeBtn(
      "check-square",
      s.fmtTask,
      s.fmtTaskTip,
      () => this.toggleCheckboxOnCurrentLines(),
      true
    );

    makeBtn("list", "", s.fmtBulletTip, () => this.toggleBulletOnCurrentLines());

    makeBtn("clock", "", s.fmtTimeTip, () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      this.insertTextAtCursor(`${hh}:${mm} `);
    });

    makeBtn("link", "", s.fmtLinkTip, () => {
      this.insertTextAtCursor("[[]]", 2);
    });

    makeBtn("minus", "", s.fmtDividerTip, () => {
      this.insertTextAtCursor("\n---\n");
    });

    bar.createDiv({ cls: "cm-fmt-divider" });

    // 이모지 접두어 하이라이트 빠른 감싸기 (노랑 기본 + 파랑/주황/초록/빨강)
    const hlGroup = bar.createDiv({
      cls: "cm-fmt-hl-group",
      attr: { title: s.fmtHighlightTip },
    });
    const hlPresets: Array<{ emoji: string; cls: string; label: string }> = [
      { emoji: "", cls: "cm-swatch-yellow", label: "==" },
      { emoji: "🔵", cls: "cm-swatch-blue", label: "==🔵==" },
      { emoji: "🟠", cls: "cm-swatch-amber", label: "==🟠==" },
      { emoji: "🟢", cls: "cm-swatch-green", label: "==🟢==" },
      { emoji: "🔴", cls: "cm-swatch-rose", label: "==🔴==" },
    ];
    for (const preset of hlPresets) {
      const dot = hlGroup.createEl("button", {
        cls: `clickable-icon cm-fmt-hl-dot ${preset.cls}`,
        attr: { type: "button", "aria-label": preset.label, title: preset.label },
      });
      dot.addEventListener("mousedown", (e) => e.preventDefault());
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        this.wrapSelectionWithHighlight(preset.emoji);
      });
    }
  }

  private getActiveCodeMirror(): EditorView | null {
    if (this.nativeEditor?.cm) return this.nativeEditor.cm;
    if (this.fallbackLeaf && this.fallbackLeaf.view instanceof MarkdownView) {
      const cm = (this.fallbackLeaf.view.editor as unknown as { cm?: EditorView })
        .cm;
      if (cm) return cm;
    }
    return null;
  }

  private toggleCheckboxOnCurrentLines(): void {
    const cm = this.getActiveCodeMirror();
    if (cm) {
      const { state } = cm;
      const sel = state.selection.main;
      const startLine = state.doc.lineAt(sel.from);
      const endLine = state.doc.lineAt(sel.to);
      const changes: Array<{ from: number; to: number; insert: string }> = [];

      for (let ln = startLine.number; ln <= endLine.number; ln++) {
        const line = state.doc.line(ln);
        const text = line.text;
        const uncheckedMatch = text.match(/^([ \t]*)- \[ \] (.*)$/);
        const checkedMatch = text.match(/^([ \t]*)- \[[xX]\] (.*)$/);
        const bulletMatch = text.match(/^([ \t]*)[-*+] (.*)$/);

        let nextText: string;
        if (uncheckedMatch) {
          nextText = `${uncheckedMatch[1]}- [x] ${uncheckedMatch[2]}`;
        } else if (checkedMatch) {
          nextText = `${checkedMatch[1]}${checkedMatch[2]}`;
        } else if (bulletMatch) {
          nextText = `${bulletMatch[1]}- [ ] ${bulletMatch[2]}`;
        } else {
          const indentMatch = text.match(/^([ \t]*)(.*)$/);
          const indent = indentMatch ? indentMatch[1] : "";
          const rest = indentMatch ? indentMatch[2] : text;
          nextText = `${indent}- [ ] ${rest}`;
        }
        changes.push({ from: line.from, to: line.to, insert: nextText });
      }

      const lastChange = changes[changes.length - 1];
      const delta =
        lastChange.insert.length - (lastChange.to - lastChange.from);
      const nextCursor =
        startLine.number === endLine.number
          ? Math.max(startLine.from, sel.to + delta)
          : lastChange.from + lastChange.insert.length;

      cm.dispatch({
        changes,
        selection: { anchor: nextCursor },
      });
      cm.focus();
      this.dirty = true;
      this.scheduleDebouncedSave();
      return;
    }

    if (this.fallbackTextarea) {
      this.insertIntoTextarea("- [ ] ", 0);
    }
  }

  private toggleBulletOnCurrentLines(): void {
    const cm = this.getActiveCodeMirror();
    if (cm) {
      const { state } = cm;
      const sel = state.selection.main;
      const startLine = state.doc.lineAt(sel.from);
      const endLine = state.doc.lineAt(sel.to);
      const changes: Array<{ from: number; to: number; insert: string }> = [];

      for (let ln = startLine.number; ln <= endLine.number; ln++) {
        const line = state.doc.line(ln);
        const text = line.text;
        const bulletMatch = text.match(/^([ \t]*)- (.*)$/);
        const nextText = bulletMatch
          ? `${bulletMatch[1]}${bulletMatch[2]}`
          : text.replace(/^([ \t]*)/, "$1- ");
        changes.push({ from: line.from, to: line.to, insert: nextText });
      }

      const lastChange = changes[changes.length - 1];
      const delta =
        lastChange.insert.length - (lastChange.to - lastChange.from);
      const nextCursor =
        startLine.number === endLine.number
          ? Math.max(startLine.from, sel.to + delta)
          : lastChange.from + lastChange.insert.length;

      cm.dispatch({
        changes,
        selection: { anchor: nextCursor },
      });
      cm.focus();
      this.dirty = true;
      this.scheduleDebouncedSave();
      return;
    }

    if (this.fallbackTextarea) {
      this.insertIntoTextarea("- ", 0);
    }
  }

  private insertTextAtCursor(text: string, cursorBackOffset = 0): void {
    const cm = this.getActiveCodeMirror();
    if (cm) {
      const sel = cm.state.selection.main;
      const nextPos = sel.from + text.length - cursorBackOffset;
      cm.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: nextPos },
      });
      cm.focus();
      this.dirty = true;
      this.scheduleDebouncedSave();
      return;
    }

    if (this.fallbackTextarea) {
      this.insertIntoTextarea(text, cursorBackOffset);
    }
  }

  private wrapSelectionWithHighlight(emoji: string): void {
    const open = `==${emoji}`;
    const close = "==";
    const cm = this.getActiveCodeMirror();
    if (cm) {
      const sel = cm.state.selection.main;
      const selectedText = cm.state.sliceDoc(sel.from, sel.to);
      const insert = `${open}${selectedText}${close}`;
      const cursorPos = selectedText
        ? sel.from + insert.length
        : sel.from + open.length;
      cm.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        selection: { anchor: cursorPos },
      });
      cm.focus();
      this.dirty = true;
      this.scheduleDebouncedSave();
      return;
    }

    if (this.fallbackTextarea) {
      const ta = this.fallbackTextarea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = ta.value.slice(start, end);
      const insert = `${open}${selected}${close}`;
      ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
      const pos = selected ? start + insert.length : start + open.length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      this.dirty = true;
      this.scheduleDebouncedSave();
    }
  }

  private insertIntoTextarea(text: string, cursorBackOffset: number): void {
    const ta = this.fallbackTextarea;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + text.length - cursorBackOffset;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    this.dirty = true;
    this.scheduleDebouncedSave();
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

// ============================================================================
// [ID 6.8] 다중 날짜 선택 후 Enter -> 공통 문구·배경색 일괄 입력 팝오버
// -> 체크박스·서식 툴바와 배경색 팔레트를 함께 제공하며, Cmd/Ctrl+Enter 또는 '적용' 클릭 시에만
//    선택된 모든 날짜에 일괄 반영하고, 창 바깥 클릭이나 ESC 시에는 변경 없이 즉시 닫힘.
// ============================================================================
export interface BatchPopoverResult {
  content: string;
  colorAction: "keep" | "set";
  colorId: string;
  targetTabIds: string[];
}

export interface BatchPopoverOptions {
  app: App;
  dateKeys: DateKey[];
  tabs: CalendarTab[];
  initialSelectedTabIds: string[];
  anchorRect: DOMRect;
  strings: UiStrings;
  onApply: (result: BatchPopoverResult) => void;
  onCancel: () => void;
}

export class CalendarBatchPopover {
  private app: App;
  private dateKeys: DateKey[];
  private tabs: CalendarTab[];
  private selectedTabIds: Set<string>;
  private strings: UiStrings;
  private onApply: (result: BatchPopoverResult) => void;
  private onCancel: () => void;

  private popoverEl: HTMLElement | null = null;
  private applyBtnEl: HTMLButtonElement | null = null;
  private isOpen = false;
  private isClosing = false;
  private colorAction: "keep" | "set" = "keep";
  private selectedColorId = "";

  private nativeEditor: {
    get(): string;
    destroy(): void;
    cm?: EditorView;
  } | null = null;
  private fallbackTextarea: HTMLTextAreaElement | null = null;

  private scope: Scope | null = null;
  private outsidePointerHandler: ((e: PointerEvent) => void) | null = null;
  private keydownCaptureHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(options: BatchPopoverOptions) {
    this.app = options.app;
    this.dateKeys = [...options.dateKeys].sort();
    this.tabs = options.tabs;
    this.selectedTabIds = new Set(
      options.initialSelectedTabIds.length > 0
        ? options.initialSelectedTabIds
        : options.tabs[0]
          ? [options.tabs[0].id]
          : []
    );
    this.strings = options.strings;
    this.onApply = options.onApply;
    this.onCancel = options.onCancel;
    this.open(options.anchorRect);
  }

  isActive(): boolean {
    return this.isOpen;
  }

  private open(anchorRect: DOMRect): void {
    this.isOpen = true;
    const s = this.strings;
    const popoverEl = document.body.createDiv({
      cls: "cm-popover cm-batch-popover",
    });
    this.popoverEl = popoverEl;

    // 위치 계산 (화면 중앙/앵커 근처에 넉넉하게 배치)
    const margin = POPOVER_VIEWPORT_MARGIN;
    const width = Math.min(460, window.innerWidth - margin * 2);
    const height = Math.min(360, window.innerHeight - margin * 2);
    let left = anchorRect.left - (width - anchorRect.width) / 2;
    let top = anchorRect.top - (height - anchorRect.height) / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    popoverEl.style.left = `${Math.round(left)}px`;
    popoverEl.style.top = `${Math.round(top)}px`;
    popoverEl.style.width = `${Math.round(width)}px`;
    popoverEl.style.height = `${Math.round(height)}px`;

    // 1) 헤더
    const header = popoverEl.createDiv({ cls: "cm-popover-header" });
    const titleWrap = header.createDiv({ cls: "cm-popover-title-wrap" });
    titleWrap.createSpan({
      cls: "cm-popover-date-title",
      text: s.batchTitle(this.dateKeys.length),
    });
    if (this.dateKeys.length > 0) {
      const first = this.dateKeys[0].slice(5).replace("-", "/");
      const last = this.dateKeys[this.dateKeys.length - 1]
        .slice(5)
        .replace("-", "/");
      titleWrap.createSpan({
        cls: "cm-popover-lunar-badge",
        text: this.dateKeys.length === 1 ? first : `${first} ~ ${last}`,
      });
    }
    const closeBtn = header.createEl("button", {
      cls: "cm-icon-btn",
      attr: { "aria-label": s.closeAria, type: "button" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.dismiss(false));

    // 2) [ID 6.8.2] 대상 달력(캘린더) 다중 선택 바 (2개 이상 탭이 있을 때 표시)
    if (this.tabs.length > 1) {
      this.renderTargetCalendarsRow(popoverEl);
    }

    // 3) 서식 툴바 (체크박스, 글머리, 시간, 링크, 구분선, 하이라이트)
    this.renderFormattingToolbar(popoverEl);

    // 4) 배경색 선택 바 (배경색 유지 / 없음 / 8색)
    this.renderColorPickerRow(popoverEl);

    // 5) 네이티브 Live Preview 에디터 (또는 textarea 폴백)
    const editorHost = popoverEl.createDiv({ cls: "cm-popover-editor-host" });
    if (!this.mountNativeEditor(editorHost)) {
      const ta = editorHost.createEl("textarea", {
        cls: "cm-popover-textarea-fallback",
        attr: { placeholder: s.batchPlaceholder },
      });
      this.fallbackTextarea = ta;
      window.requestAnimationFrame(() => ta.focus());
    }

    // 6) 하단 액션 바
    const footer = popoverEl.createDiv({ cls: "cm-batch-footer" });
    footer.createSpan({
      cls: "cm-popover-hint",
      text: Platform.isMacOS ? s.applyHintMac : s.applyHintWin,
    });
    const btns = footer.createDiv({ cls: "cm-batch-footer-btns" });
    const cancelBtn = btns.createEl("button", {
      text: s.batchCancelBtn,
      attr: { type: "button" },
    });
    cancelBtn.addEventListener("click", () => this.dismiss(false));

    const applyBtn = btns.createEl("button", {
      text: s.batchApplyBtn(this.dateKeys.length, this.selectedTabIds.size),
      cls: "mod-cta",
      attr: { type: "button" },
    });
    this.applyBtnEl = applyBtn;
    applyBtn.addEventListener("click", () => this.dismiss(true));

    // 6) 단축키 (Cmd/Ctrl+Enter 적용, ESC 취소) & 창 외부 클릭 시 즉시 사라짐
    const scope = new Scope(this.app.scope);
    scope.register(["Mod"], "Enter", (evt) => {
      evt.preventDefault();
      this.dismiss(true);
      return false;
    });
    scope.register(["Ctrl"], "Enter", (evt) => {
      evt.preventDefault();
      this.dismiss(true);
      return false;
    });
    scope.register([], "Escape", (evt) => {
      if (hasOpenObsidianPopup()) return;
      evt.preventDefault();
      this.dismiss(false);
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
        this.dismiss(true);
        return;
      }
      if (e.key === "Escape" || e.code === "Escape") {
        if (hasOpenObsidianPopup()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.dismiss(false);
      }
    };
    window.addEventListener("keydown", this.keydownCaptureHandler, true);

    window.setTimeout(() => {
      if (!this.isOpen) return;
      this.outsidePointerHandler = (e: PointerEvent) => {
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
        // 창 바깥 클릭 시 저장하지 않고 깔끔하게 편집창 닫기
        this.dismiss(false);
      };
      document.addEventListener("pointerdown", this.outsidePointerHandler, true);
    }, 0);
  }

  /**
   * [ID 6.8.2] 공통 입력을 적용할 대상 캘린더(1개 또는 복수 선택) 토글 칩 바
   */
  private renderTargetCalendarsRow(popoverEl: HTMLElement): void {
    const s = this.strings;
    const row = popoverEl.createDiv({ cls: "cm-batch-tabs-row" });
    row.createSpan({
      cls: "cm-batch-row-label",
      text: s.batchTargetCalendars,
    });

    const chipButtons = new Map<string, HTMLButtonElement>();
    const allToggleBtn = row.createEl("button", {
      cls: "clickable-icon cm-batch-all-cal-btn",
      text: s.batchSelectAllCalendars,
      attr: { type: "button" },
    });

    const syncUi = () => {
      const allSelected = this.selectedTabIds.size === this.tabs.length;
      allToggleBtn.toggleClass("is-active", allSelected);
      for (const [id, btn] of chipButtons.entries()) {
        btn.toggleClass("is-active", this.selectedTabIds.has(id));
      }
      if (this.applyBtnEl) {
        this.applyBtnEl.textContent = s.batchApplyBtn(
          this.dateKeys.length,
          this.selectedTabIds.size
        );
        this.applyBtnEl.disabled = this.selectedTabIds.size === 0;
      }
    };

    allToggleBtn.addEventListener("mousedown", (e) => e.preventDefault());
    allToggleBtn.addEventListener("click", () => {
      if (this.selectedTabIds.size === this.tabs.length) {
        // 모두 선택 상태에서 다시 누르면 첫 번째 탭만 남김
        this.selectedTabIds.clear();
        if (this.tabs[0]) this.selectedTabIds.add(this.tabs[0].id);
      } else {
        this.tabs.forEach((t) => this.selectedTabIds.add(t.id));
      }
      syncUi();
    });

    this.tabs.forEach((tab, idx) => {
      const chip = row.createEl("button", {
        cls: `clickable-icon cm-target-tab-chip cm-tab-color-${idx % 6}`,
        attr: { type: "button", title: tab.folderPath || "(root)" },
      });
      chip.createSpan({ cls: "cm-chip-check", text: "✓" });
      chip.createSpan({ text: tab.name });
      chip.addEventListener("mousedown", (e) => e.preventDefault());
      chip.addEventListener("click", () => {
        if (this.selectedTabIds.has(tab.id)) {
          this.selectedTabIds.delete(tab.id);
        } else {
          this.selectedTabIds.add(tab.id);
        }
        syncUi();
      });
      chipButtons.set(tab.id, chip);
    });

    syncUi();
  }

  private renderColorPickerRow(popoverEl: HTMLElement): void {
    const s = this.strings;
    const row = popoverEl.createDiv({ cls: "cm-batch-color-row" });
    const buttons: HTMLElement[] = [];

    const updateActive = () => {
      buttons.forEach((btn) => btn.removeClass("is-active"));
      if (this.colorAction === "keep") {
        keepBtn.addClass("is-active");
      } else {
        const activeSwatch = row.querySelector(
          `[data-color-id="${this.selectedColorId}"]`
        );
        activeSwatch?.addClass("is-active");
      }
    };

    const keepBtn = row.createEl("button", {
      cls: "clickable-icon cm-batch-keep-btn is-active",
      text: s.batchColorKeep,
      attr: { type: "button" },
    });
    keepBtn.addEventListener("mousedown", (e) => e.preventDefault());
    keepBtn.addEventListener("click", () => {
      this.colorAction = "keep";
      this.selectedColorId = "";
      updateActive();
    });
    buttons.push(keepBtn);

    for (const preset of CELL_COLOR_PRESETS) {
      const label = s.colorLabels[preset.id] ?? preset.label;
      const swatch = row.createEl("button", {
        cls: `clickable-icon cm-color-swatch ${
          preset.id === "" ? "is-clear" : `cm-swatch-${preset.id}`
        }`,
        attr: {
          type: "button",
          "data-color-id": preset.id,
          title: label,
          "aria-label": label,
        },
      });
      if (preset.id === "") {
        setIcon(swatch, "ban");
      } else {
        swatch.style.backgroundColor = preset.swatch;
      }
      swatch.addEventListener("mousedown", (e) => e.preventDefault());
      swatch.addEventListener("click", () => {
        this.colorAction = "set";
        this.selectedColorId = preset.id;
        updateActive();
      });
      buttons.push(swatch);
    }
  }

  private renderFormattingToolbar(popoverEl: HTMLElement): void {
    const s = this.strings;
    const bar = popoverEl.createDiv({ cls: "cm-popover-toolbar" });

    const makeBtn = (
      iconName: string,
      label: string,
      tooltip: string,
      onClick: () => void,
      showLabel = false
    ) => {
      const btn = bar.createEl("button", {
        cls: `clickable-icon cm-fmt-btn ${showLabel ? "has-label" : ""}`,
        attr: { type: "button", "aria-label": tooltip, title: tooltip },
      });
      setIcon(btn.createSpan({ cls: "cm-fmt-icon" }), iconName);
      if (showLabel) btn.createSpan({ text: label });
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
    };

    makeBtn(
      "check-square",
      s.fmtTask,
      s.fmtTaskTip,
      () => this.togglePrefix("- [ ] "),
      true
    );
    makeBtn("list", "", s.fmtBulletTip, () => this.togglePrefix("- "));
    makeBtn("clock", "", s.fmtTimeTip, () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      this.insertText(`${hh}:${mm} `, 0);
    });
    makeBtn("link", "", s.fmtLinkTip, () => this.insertText("[[]]", 2));
    makeBtn("minus", "", s.fmtDividerTip, () => this.insertText("\n---\n", 0));

    bar.createDiv({ cls: "cm-fmt-divider" });
    const hlGroup = bar.createDiv({ cls: "cm-fmt-hl-group" });
    const hlPresets: Array<{ emoji: string; cls: string }> = [
      { emoji: "", cls: "cm-swatch-yellow" },
      { emoji: "🔵", cls: "cm-swatch-blue" },
      { emoji: "🟠", cls: "cm-swatch-amber" },
      { emoji: "🟢", cls: "cm-swatch-green" },
      { emoji: "🔴", cls: "cm-swatch-rose" },
    ];
    for (const p of hlPresets) {
      const dot = hlGroup.createEl("button", {
        cls: `clickable-icon cm-fmt-hl-dot ${p.cls}`,
        attr: { type: "button" },
      });
      dot.addEventListener("mousedown", (e) => e.preventDefault());
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        this.wrapHighlight(p.emoji);
      });
    }
  }

  private mountNativeEditor(hostEl: HTMLElement): boolean {
    const BaseEditor = resolveScrollableMarkdownEditorCtor(this.app);
    if (!BaseEditor) return false;
    try {
      const applyNow = () => this.dismiss(true);
      const cancelNow = () => this.dismiss(false);

      class BatchInlineEditor extends BaseEditor {
        buildLocalExtensions(): unknown[] {
          const parentExts = super.buildLocalExtensions?.() ?? [];
          return [
            ...parentExts,
            Prec.highest(
              keymap.of([
                {
                  key: "Mod-Enter",
                  run: () => {
                    applyNow();
                    return true;
                  },
                },
                {
                  key: "Escape",
                  run: () => {
                    if (hasOpenObsidianPopup()) return false;
                    cancelNow();
                    return true;
                  },
                },
              ])
            ),
          ];
        }
      }

      const owner: Record<string, unknown> = { app: this.app };
      const instance = new BatchInlineEditor(this.app, hostEl, owner);
      owner.editMode = instance;
      owner.editor = (instance as unknown as { editor?: unknown }).editor;
      instance.set("");
      this.nativeEditor = instance;
      window.requestAnimationFrame(() => instance.cm?.focus());
      return true;
    } catch {
      hostEl.empty();
      return false;
    }
  }

  private togglePrefix(prefix: "- [ ] " | "- "): void {
    const cm = this.nativeEditor?.cm;
    if (cm) {
      const sel = cm.state.selection.main;
      const line = cm.state.doc.lineAt(sel.from);
      const hasIt = line.text.startsWith(prefix);
      const next = hasIt ? line.text.slice(prefix.length) : `${prefix}${line.text}`;
      cm.dispatch({
        changes: { from: line.from, to: line.to, insert: next },
        selection: { anchor: line.from + next.length },
      });
      cm.focus();
      return;
    }
    this.insertText(prefix, 0);
  }

  private insertText(text: string, backOffset: number): void {
    const cm = this.nativeEditor?.cm;
    if (cm) {
      const sel = cm.state.selection.main;
      cm.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length - backOffset },
      });
      cm.focus();
      return;
    }
    if (this.fallbackTextarea) {
      const ta = this.fallbackTextarea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
      const pos = start + text.length - backOffset;
      ta.setSelectionRange(pos, pos);
      ta.focus();
    }
  }

  private wrapHighlight(emoji: string): void {
    const open = `==${emoji}`;
    const close = "==";
    const cm = this.nativeEditor?.cm;
    if (cm) {
      const sel = cm.state.selection.main;
      const selected = cm.state.sliceDoc(sel.from, sel.to);
      const insert = `${open}${selected}${close}`;
      const pos = selected ? sel.from + insert.length : sel.from + open.length;
      cm.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        selection: { anchor: pos },
      });
      cm.focus();
      return;
    }
    this.insertText(`${open}${close}`, close.length);
  }

  private getContent(): string {
    if (this.nativeEditor) return this.nativeEditor.get();
    if (this.fallbackTextarea) return this.fallbackTextarea.value;
    return "";
  }

  public close(): void {
    this.dismiss(false);
  }

  private dismiss(apply: boolean): void {
    if (!this.isOpen || this.isClosing) return;
    if (apply && this.selectedTabIds.size === 0) {
      new Notice(this.strings.batchSelectOneNotice);
      return;
    }
    this.isClosing = true;
    this.isOpen = false;

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

    if (
      document.activeElement instanceof HTMLElement &&
      this.popoverEl?.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }

    const content = this.getContent();

    if (this.nativeEditor) {
      try {
        this.nativeEditor.destroy();
      } catch {
        // ignore
      }
      this.nativeEditor = null;
    }
    this.fallbackTextarea = null;

    if (this.scope) {
      this.app.keymap.popScope(this.scope);
      this.scope = null;
    }
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }

    if (apply) {
      this.onApply({
        content,
        colorAction: this.colorAction,
        colorId: this.selectedColorId,
        targetTabIds: Array.from(this.selectedTabIds),
      });
    } else {
      this.onCancel();
    }
  }
}
