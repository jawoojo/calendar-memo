import {
  Component,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import {
  ALL_TABS_ID,
  CELL_COLOR_PRESETS,
  CalendarTab,
  DateKey,
  DayCalendarMeta,
} from "../types";
import {
  addDays,
  coordToDateKey,
  dateKeyToCoord,
  getDayOfWeek,
  getTodayKey,
  getWeekStart,
  parseDateKey,
  parseObsidianUriToFilePath,
} from "../calendar/dateUtils";
import {
  excludeRecurringOccurrence,
  getRecurringEventsForDate,
  toggleRecurringCompletion,
} from "../calendar/recurringEvents";
import {
  GridCoord,
  GridUndoHistory,
  HistoryChange,
  InternalClipboardData,
  SelectionRange,
  computePasteTargets,
  extractIncompleteTasks,
  formatExternalClipboardText,
  getRectBounds,
  getSelectedCells,
  isCoordInRange,
  mergeMemoContentForAppend,
} from "../editor/clipboardAndHistory";
import {
  BatchPopoverResult,
  CalendarBatchPopover,
  CalendarPopoverEditor,
} from "./popoverEditor";
import {
  CustomHolidaysModal,
  RecurringEventsModal,
  TabConfigModal,
} from "./modals";
import { applyEmojiHighlightsToPreview } from "./highlightHelper";
import type CalendarMemoPlugin from "../main";

// [ID 5.1] 메모잇 스타일 무한 스크롤 캘린더 그리드 뷰
// -> 상단 폴더 탭 바, 연속 스크롤 그리드, 엑셀형 2D 직사각형 선택, 키보드 내비게이션,
//    셀 마크다운 미리보기(체크박스 즉시 토글), 반복 일정 오버레이, 팝오버 에디터를 통합 제어함.

export const VIEW_TYPE_CALENDAR_MEMO = "calendar-memo-view";

const INITIAL_WEEKS_BEFORE = 10;
const INITIAL_WEEKS_AFTER = 16;
const LOAD_CHUNK_WEEKS = 8;
const SCROLL_THRESHOLD_PX = 340;

/**
 * 셀 미리보기 렌더링 시 YAML 프론트매터를 제거하여 실제 메모 본문만 깔끔하게 노출함.
 */
function stripFrontmatter(markdown: string): {
  body: string;
  frontmatterLength: number;
} {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { body: markdown, frontmatterLength: 0 };
  }
  return {
    body: markdown.slice(match[0].length),
    frontmatterLength: match[0].length,
  };
}

/**
 * 원문 마크다운에서 N번째 체크박스([ ] <-> [x])를 토글함.
 */
function toggleNthTaskCheckbox(
  rawMarkdown: string,
  targetIndex: number
): string | null {
  const { frontmatterLength } = stripFrontmatter(rawMarkdown);
  const body = rawMarkdown.slice(frontmatterLength);
  const taskRegex = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm;

  let currentIndex = 0;
  let replaced = false;
  const updatedBody = body.replace(
    taskRegex,
    (full, prefix: string, state: string, suffix: string) => {
      if (currentIndex === targetIndex) {
        currentIndex++;
        replaced = true;
        const nextState = state === " " ? "x" : " ";
        return `${prefix}${nextState}${suffix}`;
      }
      currentIndex++;
      return full;
    }
  );

  if (!replaced) return null;
  return rawMarkdown.slice(0, frontmatterLength) + updatedBody;
}

export class CalendarMemoView extends ItemView {
  private plugin: CalendarMemoPlugin;

  // DOM 레퍼런스
  private rootEl!: HTMLElement;
  private tabBarEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private searchBarEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private searchCountEl!: HTMLElement;
  private monthTitleEl!: HTMLElement;
  private monthPickerInput!: HTMLInputElement;
  private weekdayHeaderEl!: HTMLElement;
  private gridScrollEl!: HTMLElement;
  private gridBodyEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

  // 무한 스크롤 좌표 및 렌더링 상태
  private originWeekStart: DateKey = getWeekStart(getTodayKey(), 0);
  private firstRow = -INITIAL_WEEKS_BEFORE;
  private lastRow = INITIAL_WEEKS_AFTER;
  private rowElements = new Map<number, HTMLElement>();
  private cellElements = new Map<DateKey, HTMLElement>();
  private cellComponents = new Map<DateKey, Component>();
  private cellRenderSeq = new Map<DateKey, number>();

  // 선택·드래그·클립보드·히스토리·팝오버·검색 상태
  private selection: SelectionRange = {
    anchor: { row: 0, col: 0 },
    focus: { row: 0, col: 0 },
  };
  private isDraggingSelection = false;
  private internalClipboard: InternalClipboardData | null = null;
  private undoHistory = new GridUndoHistory(100);
  private activePopover: CalendarPopoverEditor | null = null;
  private activeBatchPopover: CalendarBatchPopover | null = null;
  private lastRealTabId = "";

  private searchQuery = "";
  private searchMatches: DateKey[] = [];
  private searchMatchSet = new Set<DateKey>();
  private searchMatchIdx = -1;
  private searchTimer: number | null = null;

  private unsubscribeVaultSync: (() => void) | null = null;
  private globalPointerUpHandler: (() => void) | null = null;
  private windowKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private isLoadingRows = false;
  private scrollRafId: number | null = null;
  private displayedYm = "";
  private suppressScrollMonthUntil = 0;

  constructor(leaf: WorkspaceLeaf, plugin: CalendarMemoPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.lastRealTabId = this.plugin.settings.tabs[0]?.id ?? "";
  }

  getViewType(): string {
    return VIEW_TYPE_CALENDAR_MEMO;
  }

  getDisplayText(): string {
    return "Calendar Memo";
  }

  getIcon(): string {
    return "calendar-days";
  }

  isAllTabsMode(): boolean {
    return (
      this.plugin.settings.activeTabId === ALL_TABS_ID &&
      this.plugin.settings.tabs.length > 1
    );
  }

  getActiveTab(): CalendarTab {
    const found = this.plugin.settings.tabs.find(
      (t) => t.id === this.plugin.settings.activeTabId
    );
    if (found) {
      this.lastRealTabId = found.id;
      return found;
    }
    const lastReal = this.plugin.settings.tabs.find(
      (t) => t.id === this.lastRealTabId
    );
    return lastReal ?? this.plugin.settings.tabs[0];
  }

  private hasAnyPopoverOpen(): boolean {
    return Boolean(
      this.activePopover?.isActive() || this.activeBatchPopover?.isActive()
    );
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("cm-view-container");

    this.rootEl = this.contentEl.createDiv({ cls: "cm-root" });

    // [ID 5.2] 상단 영역: 폴더 탭 바 + 내비게이션/편집 툴바 + 검색 바
    this.tabBarEl = this.rootEl.createDiv({ cls: "cm-tab-bar" });
    this.toolbarEl = this.rootEl.createDiv({ cls: "cm-toolbar" });
    this.searchBarEl = this.rootEl.createDiv({ cls: "cm-search-bar is-hidden" });

    // 무한 스크롤 그리드 컨테이너 (키보드 포커스 대상)
    // [ID 5.2.1] 요일 헤더를 스크롤 컨테이너 내부 sticky로 배치
    // -> 스크롤바 너비만큼 요일 헤더와 아래 날짜 셀 열 경계가 미세하게 어긋나는 현상을 원천 제거함.
    this.gridScrollEl = this.rootEl.createDiv({
      cls: "cm-grid-scroll",
      attr: { tabindex: "0", role: "grid", "aria-label": "Calendar Memo Grid" },
    });
    this.weekdayHeaderEl = this.gridScrollEl.createDiv({
      cls: "cm-weekday-header",
    });
    this.gridBodyEl = this.gridScrollEl.createDiv({ cls: "cm-grid-body" });

    this.gridScrollEl.addEventListener("scroll", () => this.onGridScroll(), {
      passive: true,
    });
    this.gridScrollEl.addEventListener("keydown", (e) => this.onGridKeyDown(e));

    // [ID 5.5.1] 캘린더 뷰 전역 Tab / Shift+Tab 폴더 탭 전환
    // -> 브라우저 기본 Tab 포커스 이동(툴바 버튼 순회)을 막고 캘린더 폴더 탭 간 빠른 순환 전환을 제공함.
    this.rootEl.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey) return;
        if (this.hasAnyPopoverOpen()) return;
        const activeTag = (document.activeElement?.tagName ?? "").toLowerCase();
        if (activeTag === "input" || activeTag === "textarea") return;

        e.preventDefault();
        e.stopPropagation();
        this.cycleFolderTab(e.shiftKey ? -1 : 1);
      },
      true
    );

    // [ID 5.8.1] 전역 window 캡처 단계에서 Ctrl/Cmd+F 찾기 토글 및 ESC 찾기 닫기 처리
    // -> 옵시디언 기본 Cmd/Ctrl+F(현재 파일 검색)와 한글 IME(e.key === 'ㄹ')보다 먼저 가로채고,
    //    그리드에 포커스가 있을 때도 ESC 한 번으로 찾기 모드를 깔끔하게 종료함.
    this.windowKeydownHandler = (e: KeyboardEvent) => {
      if (this.app.workspace.getActiveViewOfType(CalendarMemoView) !== this) {
        return;
      }
      if (this.hasAnyPopoverOpen()) return;
      if (
        document.querySelector(
          ".modal-container, .prompt, .suggestion-container, .menu"
        )
      ) {
        return;
      }

      const isFindKey =
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "f" || e.key === "F" || e.code === "KeyF");
      if (isFindKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (this.searchBarEl.hasClass("is-hidden")) {
          this.openSearchBar();
        } else {
          this.closeSearchBar();
        }
        return;
      }

      const isEsc = e.key === "Escape" || e.code === "Escape";
      if (isEsc && !this.searchBarEl.hasClass("is-hidden")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.closeSearchBar();
      }
    };
    window.addEventListener("keydown", this.windowKeydownHandler, true);

    this.globalPointerUpHandler = () => {
      this.isDraggingSelection = false;
    };
    window.addEventListener("pointerup", this.globalPointerUpHandler);

    // 볼트 실시간 변경 구독: 수정된 날짜 셀만 즉시 부분 갱신 (전체 보기 모드에서는 모든 탭 감지)
    this.unsubscribeVaultSync = this.plugin.vaultSync.onChange(
      (tabId, dateKey) => {
        if (!this.isAllTabsMode() && tabId !== this.getActiveTab().id) return;
        const cellEl = this.cellElements.get(dateKey);
        if (cellEl) {
          void this.refreshCellContent(dateKey, cellEl);
        }
      }
    );

    this.rebuildAll(getTodayKey());
  }

  async onClose(): Promise<void> {
    if (this.activePopover) {
      await this.activePopover.close();
      this.activePopover = null;
    }
    if (this.activeBatchPopover) {
      this.activeBatchPopover.close();
      this.activeBatchPopover = null;
    }
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.unsubscribeVaultSync) {
      this.unsubscribeVaultSync();
      this.unsubscribeVaultSync = null;
    }
    if (this.globalPointerUpHandler) {
      window.removeEventListener("pointerup", this.globalPointerUpHandler);
      this.globalPointerUpHandler = null;
    }
    if (this.windowKeydownHandler) {
      window.removeEventListener("keydown", this.windowKeydownHandler, true);
      this.windowKeydownHandler = null;
    }
    if (this.scrollRafId !== null) {
      window.cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = null;
    }
    this.clearAllCellComponents();
  }

  /**
   * 설정 변경/탭 전환/반복 일정 수정 후 전체 뷰를 깔끔하게 재구성함.
   */
  public refreshView(preserveFocusDate?: DateKey): void {
    const focusDate =
      preserveFocusDate ??
      coordToDateKey(
        this.selection.focus.row,
        this.selection.focus.col,
        this.originWeekStart
      );
    this.rebuildAll(focusDate);
  }

  /**
   * 외부 명령어("열기 / 화면으로 이동") 호출 시 그리드로 즉시 키보드 포커스를 되돌림.
   */
  public focusGrid(): void {
    window.requestAnimationFrame(() => {
      if (!this.activePopover?.isActive()) {
        this.gridScrollEl?.focus({ preventScroll: true });
      }
    });
  }

  /**
   * 외부 명령어("오늘 메모 바로 열기")에서 호출 가능.
   */
  public openPopoverForDate(dateKey: DateKey): void {
    this.jumpToDate(dateKey, false);
    window.requestAnimationFrame(() => {
      const cellEl = this.cellElements.get(dateKey);
      if (cellEl) {
        this.openPopover(dateKey, cellEl);
      }
    });
  }

  // ==========================================================================
  // 상단 UI (폴더 탭 바, 툴바, 검색 바, 요일 헤더)
  // ==========================================================================
  private renderTabBar(): void {
    this.tabBarEl.empty();
    const s = this.plugin.t();
    const allMode = this.isAllTabsMode();
    const activeTab = this.getActiveTab();

    // [ID 5.9] 탭이 2개 이상이면 맨 앞에 '전체 보기' 탭을 제공해 모든 폴더 일정을 한 화면에서 조망함
    if (this.plugin.settings.tabs.length > 1) {
      const allBtn = this.tabBarEl.createDiv({
        cls: `cm-tab-item cm-tab-all ${allMode ? "is-active" : ""}`,
        attr: { title: s.allTabsTooltip },
      });
      allBtn.createSpan({ cls: "cm-tab-name", text: s.allTabsLabel });
      allBtn.addEventListener("click", async () => {
        if (this.isAllTabsMode()) return;
        await this.switchTab(ALL_TABS_ID);
      });
    }

    for (const tab of this.plugin.settings.tabs) {
      const isActive = !allMode && tab.id === activeTab.id;
      const tabBtn = this.tabBarEl.createDiv({
        cls: `cm-tab-item ${isActive ? "is-active" : ""}`,
        attr: {
          title: `${tab.folderPath || "(root)"} · ${tab.dateFormat}`,
        },
      });

      tabBtn.createSpan({ cls: "cm-tab-name", text: tab.name });

      // 활성 탭에는 설정 아이콘 노출
      if (isActive) {
        const editIcon = tabBtn.createSpan({
          cls: "cm-tab-edit-btn",
          attr: { "aria-label": s.editTabAria },
        });
        setIcon(editIcon, "sliders-horizontal");
        editIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openTabEditModal(tab);
        });
      }

      tabBtn.addEventListener("click", async () => {
        if (!this.isAllTabsMode() && tab.id === this.plugin.settings.activeTabId) {
          return;
        }
        await this.switchTab(tab.id);
      });

      tabBtn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle(s.ctxEditTab)
            .setIcon("pencil")
            .onClick(() => this.openTabEditModal(tab))
        );
        if (this.plugin.settings.tabs.length > 1) {
          menu.addItem((item) =>
            item
              .setTitle(s.ctxDeleteTab)
              .setIcon("trash-2")
              .onClick(() => void this.plugin.deleteTab(tab.id))
          );
        }
        menu.showAtMouseEvent(e);
      });
    }

    const addBtn = this.tabBarEl.createEl("button", {
      cls: "cm-tab-add-btn",
      attr: { "aria-label": s.addFolderAria, type: "button" },
    });
    setIcon(addBtn, "plus");
    addBtn.createSpan({ text: s.addFolderBtn });
    addBtn.addEventListener("click", () => {
      new TabConfigModal(this.plugin, null, async (created) => {
        this.plugin.settings.tabs.push(created);
        this.plugin.settings.activeTabId = created.id;
        await this.plugin.saveSettings();
        this.refreshView();
        new Notice(s.noticeTabAdded(created.name));
      }).open();
    });
  }

  private openTabEditModal(tab: CalendarTab): void {
    new TabConfigModal(
      this.plugin,
      tab,
      async (updated) => {
        const idx = this.plugin.settings.tabs.findIndex(
          (t) => t.id === updated.id
        );
        if (idx >= 0) this.plugin.settings.tabs[idx] = updated;
        this.plugin.vaultSync.invalidateTabCache(updated.id);
        await this.plugin.saveSettings();
        this.refreshView();
      },
      async (deletedId) => {
        await this.plugin.deleteTab(deletedId);
      }
    ).open();
  }

  private async switchTab(tabId: string): Promise<void> {
    if (this.activePopover) {
      await this.activePopover.close();
    }
    if (this.activeBatchPopover) {
      this.activeBatchPopover.close();
    }
    if (tabId !== ALL_TABS_ID) {
      this.lastRealTabId = tabId;
    }
    this.plugin.settings.activeTabId = tabId;
    await this.plugin.saveSettings();
    this.renderTabBar();
    this.reloadAllRenderedCells();
    if (this.searchQuery) {
      void this.runSearch(this.searchQuery, false);
    }
    this.gridScrollEl.focus({ preventScroll: true });
  }

  /**
   * [ID 5.5.1] Tab / Shift+Tab으로 등록된 캘린더 폴더 탭(및 전체 보기)을 순환 전환함.
   */
  private cycleFolderTab(delta: 1 | -1): void {
    const tabs = this.plugin.settings.tabs;
    if (tabs.length <= 1) {
      this.gridScrollEl.focus({ preventScroll: true });
      return;
    }
    const order = [ALL_TABS_ID, ...tabs.map((t) => t.id)];
    const currentIdx = Math.max(
      0,
      order.indexOf(this.plugin.settings.activeTabId)
    );
    const nextIdx = (currentIdx + delta + order.length) % order.length;
    void this.switchTab(order[nextIdx]);
  }

  private renderToolbar(): void {
    const s = this.plugin.t();
    this.toolbarEl.empty();

    // 좌측: 연/월 탐색 및 오늘 이동
    const navGroup = this.toolbarEl.createDiv({ cls: "cm-toolbar-group" });

    const prevMonthBtn = navGroup.createEl("button", {
      cls: "cm-icon-btn",
      attr: { "aria-label": s.prevMonthAria, type: "button" },
    });
    setIcon(prevMonthBtn, "chevron-left");
    prevMonthBtn.addEventListener("click", () => this.shiftVisibleMonth(-1));

    const monthTitleWrap = navGroup.createDiv({ cls: "cm-month-title-wrap" });
    this.monthTitleEl = monthTitleWrap.createSpan({ cls: "cm-month-title" });
    this.monthPickerInput = monthTitleWrap.createEl("input", {
      cls: "cm-month-picker-hidden",
      attr: { type: "month", "aria-label": "Month picker" },
    });
    this.monthTitleEl.addEventListener("click", () => {
      if (typeof this.monthPickerInput.showPicker === "function") {
        this.monthPickerInput.showPicker();
      } else {
        this.monthPickerInput.focus();
      }
    });
    this.monthPickerInput.addEventListener("change", () => {
      const val = this.monthPickerInput.value; // YYYY-MM
      if (/^\d{4}-\d{2}$/.test(val)) {
        this.jumpToDate(`${val}-01`, true, "start");
      }
    });

    const nextMonthBtn = navGroup.createEl("button", {
      cls: "cm-icon-btn",
      attr: { "aria-label": s.nextMonthAria, type: "button" },
    });
    setIcon(nextMonthBtn, "chevron-right");
    nextMonthBtn.addEventListener("click", () => this.shiftVisibleMonth(1));

    const todayBtn = navGroup.createEl("button", {
      cls: "cm-toolbar-btn",
      text: s.todayBtn,
      attr: { title: s.todayTooltip, type: "button" },
    });
    todayBtn.addEventListener("click", () => this.jumpToDate(getTodayKey(), true));

    // 우측: 검색 + 셀 배경색 팔레트 + Undo/Redo + 반복 일정 + 휴일
    const toolGroup = this.toolbarEl.createDiv({
      cls: "cm-toolbar-group cm-toolbar-right",
    });

    const searchBtn = toolGroup.createEl("button", {
      cls: "cm-icon-btn",
      attr: { "aria-label": s.searchTooltip, title: s.searchTooltip, type: "button" },
    });
    setIcon(searchBtn, "search");
    searchBtn.addEventListener("click", () => {
      if (this.searchBarEl.hasClass("is-hidden")) {
        this.openSearchBar();
      } else {
        this.closeSearchBar();
      }
    });

    const paletteWrap = toolGroup.createDiv({
      cls: "cm-color-palette",
      attr: { title: s.colorPaletteTooltip },
    });
    for (const preset of CELL_COLOR_PRESETS) {
      const colorLabel = s.colorLabels[preset.id] ?? preset.label;
      const swatchBtn = paletteWrap.createEl("button", {
        // [ID 7.2.1] 옵시디언 기본 button:not(.clickable-icon) 배경 덮어쓰기 방지
        cls: `clickable-icon cm-color-swatch ${
          preset.id === "" ? "is-clear" : `cm-swatch-${preset.id}`
        }`,
        attr: { "aria-label": colorLabel, title: colorLabel, type: "button" },
      });
      if (preset.id === "") {
        setIcon(swatchBtn, "ban");
      } else {
        swatchBtn.style.backgroundColor = preset.swatch;
      }
      swatchBtn.addEventListener("click", () => {
        void this.applyColorToSelection(preset.id);
        this.gridScrollEl.focus({ preventScroll: true });
      });
    }

    toolGroup.createDiv({ cls: "cm-toolbar-divider" });

    this.undoBtn = toolGroup.createEl("button", {
      cls: "cm-icon-btn",
      attr: {
        "aria-label": `${s.undoLabel} (${Platform.isMacOS ? "⌘Z" : "Ctrl+Z"})`,
        type: "button",
      },
    });
    setIcon(this.undoBtn, "undo-2");
    this.undoBtn.addEventListener("click", () => void this.performUndo());

    this.redoBtn = toolGroup.createEl("button", {
      cls: "cm-icon-btn",
      attr: {
        "aria-label": `${s.redoLabel} (${Platform.isMacOS ? "⌘Y" : "Ctrl+Y"})`,
        type: "button",
      },
    });
    setIcon(this.redoBtn, "redo-2");
    this.redoBtn.addEventListener("click", () => void this.performRedo());
    this.updateUndoRedoButtons();

    toolGroup.createDiv({ cls: "cm-toolbar-divider" });

    const recurringBtn = toolGroup.createEl("button", {
      cls: "cm-toolbar-btn",
      attr: { title: s.recurringTooltip, type: "button" },
    });
    setIcon(recurringBtn.createSpan({ cls: "cm-btn-icon" }), "repeat");
    recurringBtn.createSpan({ text: s.recurringBtn });
    recurringBtn.addEventListener("click", () => {
      const focusDate = coordToDateKey(
        this.selection.focus.row,
        this.selection.focus.col,
        this.originWeekStart
      );
      new RecurringEventsModal(
        this.plugin,
        this.getActiveTab().id,
        focusDate,
        () => this.reloadAllRenderedCells()
      ).open();
    });

    const holidayBtn = toolGroup.createEl("button", {
      cls: "cm-toolbar-btn",
      attr: { title: s.holidayTooltip, type: "button" },
    });
    setIcon(holidayBtn.createSpan({ cls: "cm-btn-icon" }), "calendar-heart");
    holidayBtn.createSpan({ text: s.holidayBtn });
    holidayBtn.addEventListener("click", () => {
      new CustomHolidaysModal(this.plugin, () =>
        this.reloadAllRenderedCells()
      ).open();
    });
  }

  /**
   * [ID 5.8] 캘린더 내부 즉시 검색 바 구성 (Cmd/Ctrl + F)
   */
  private renderSearchBar(): void {
    const s = this.plugin.t();
    this.searchBarEl.empty();

    this.searchInputEl = this.searchBarEl.createEl("input", {
      cls: "cm-search-input",
      attr: {
        type: "text",
        placeholder: s.searchPlaceholder,
        value: this.searchQuery,
      },
    });
    this.searchInputEl.value = this.searchQuery;

    this.searchCountEl = this.searchBarEl.createSpan({
      cls: "cm-search-count",
    });

    const prevBtn = this.searchBarEl.createEl("button", {
      cls: "cm-icon-btn",
      attr: { type: "button", "aria-label": "Previous match" },
    });
    setIcon(prevBtn, "chevron-up");
    prevBtn.addEventListener("click", () => this.jumpToSearchMatch(-1));

    const nextBtn = this.searchBarEl.createEl("button", {
      cls: "cm-icon-btn",
      attr: { type: "button", "aria-label": "Next match" },
    });
    setIcon(nextBtn, "chevron-down");
    nextBtn.addEventListener("click", () => this.jumpToSearchMatch(1));

    const closeBtn = this.searchBarEl.createEl("button", {
      cls: "cm-icon-btn",
      attr: { type: "button", "aria-label": s.closeAria },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.closeSearchBar());

    this.searchInputEl.addEventListener("input", () => {
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
      const q = this.searchInputEl.value;
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null;
        void this.runSearch(q, true);
      }, 150);
    });

    this.searchInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.code === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const typed = this.searchInputEl.value.trim();
        if (this.searchTimer !== null) {
          window.clearTimeout(this.searchTimer);
          this.searchTimer = null;
        }
        if (typed !== this.searchQuery) {
          void this.runSearch(typed, true);
        } else {
          this.jumpToSearchMatch(e.shiftKey ? -1 : 1);
        }
      } else if (e.key === "Escape" || e.code === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeSearchBar();
      }
    });
  }

  private openSearchBar(): void {
    this.searchBarEl.removeClass("is-hidden");
    this.searchInputEl.focus();
    this.searchInputEl.select();
  }

  private closeSearchBar(): void {
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.searchBarEl.addClass("is-hidden");
    this.searchQuery = "";
    this.searchMatches = [];
    this.searchMatchSet.clear();
    this.searchMatchIdx = -1;
    if (this.searchInputEl) this.searchInputEl.value = "";
    if (this.searchCountEl) this.searchCountEl.setText("");
    this.applySearchHighlightClasses();
    this.gridScrollEl.focus({ preventScroll: true });
  }

  private async runSearch(query: string, autoJump: boolean): Promise<void> {
    this.searchQuery = query.trim();
    if (!this.searchQuery) {
      this.searchMatches = [];
      this.searchMatchSet.clear();
      this.searchMatchIdx = -1;
      this.searchCountEl.setText("");
      this.applySearchHighlightClasses();
      return;
    }

    const tabsToSearch = this.isAllTabsMode()
      ? this.plugin.settings.tabs
      : [this.getActiveTab()];
    const matches = await this.plugin.vaultSync.searchNotesByQuery(
      tabsToSearch,
      this.searchQuery
    );
    this.searchMatches = matches;
    this.searchMatchSet = new Set(matches);

    if (matches.length === 0) {
      this.searchMatchIdx = -1;
      this.searchCountEl.setText(this.plugin.t().searchNoMatches);
      this.applySearchHighlightClasses();
      return;
    }

    // 오늘 날짜와 가장 가까운 결과를 기본 포커스 인덱스로 선택
    const today = getTodayKey();
    let bestIdx = matches.findIndex((d) => d >= today);
    if (bestIdx < 0) bestIdx = matches.length - 1;
    this.searchMatchIdx = bestIdx;
    this.updateSearchCountLabel();
    this.applySearchHighlightClasses();

    if (autoJump) {
      this.jumpToDate(matches[this.searchMatchIdx], true, "center", true);
      this.keepSearchInputFocus();
    }
  }

  private jumpToSearchMatch(delta: 1 | -1): void {
    if (this.searchMatches.length === 0) return;
    this.searchMatchIdx =
      (this.searchMatchIdx + delta + this.searchMatches.length) %
      this.searchMatches.length;
    this.updateSearchCountLabel();
    const targetDate = this.searchMatches[this.searchMatchIdx];
    // [ID 5.8.2] keepFocus=true로 원거리 연도 점프(rebuildAll) 시에도 검색창 포커스 이탈을 방지함
    // -> 마지막 결과에서 다시 처음으로 순환할 때 포커스가 그리드로 넘어가 노트가 열리는 버그를 차단함.
    this.jumpToDate(targetDate, true, "center", true);
    this.applySearchHighlightClasses();
    this.keepSearchInputFocus();
  }

  private keepSearchInputFocus(): void {
    if (!this.searchInputEl || this.searchBarEl.hasClass("is-hidden")) return;
    this.searchInputEl.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (!this.searchBarEl.hasClass("is-hidden") && !this.hasAnyPopoverOpen()) {
        this.searchInputEl?.focus({ preventScroll: true });
      }
    });
  }

  private updateSearchCountLabel(): void {
    if (this.searchMatches.length === 0) {
      this.searchCountEl.setText(
        this.searchQuery ? this.plugin.t().searchNoMatches : ""
      );
      return;
    }
    this.searchCountEl.setText(
      `${this.searchMatchIdx + 1} / ${this.searchMatches.length}`
    );
  }

  private applySearchHighlightClasses(): void {
    const active = this.searchQuery.length > 0;
    this.gridBodyEl.classList.toggle("is-search-active", active);
    const currentDate =
      this.searchMatchIdx >= 0 ? this.searchMatches[this.searchMatchIdx] : null;

    for (const [dateKey, cellEl] of this.cellElements.entries()) {
      const isMatch = active && this.searchMatchSet.has(dateKey);
      cellEl.classList.toggle("is-search-match", isMatch);
      cellEl.classList.toggle(
        "is-search-current",
        active && dateKey === currentDate
      );
    }
  }

  private renderWeekdayHeader(): void {
    this.weekdayHeaderEl.empty();
    const s = this.plugin.t();
    const headers =
      this.plugin.settings.weekStartsOn === 0
        ? s.weekdaysSunFirst
        : s.weekdaysMonFirst;
    headers.forEach((label, idx) => {
      const dow = (this.plugin.settings.weekStartsOn + idx) % 7;
      const colEl = this.weekdayHeaderEl.createDiv({
        cls: "cm-weekday-cell",
        text: label,
      });
      if (dow === 0) colEl.addClass("is-sunday");
      if (dow === 6) colEl.addClass("is-saturday");
    });
  }

  // ==========================================================================
  // [ID 5.3] 무한(연속) 스크롤 그리드 생성 및 확장
  // ==========================================================================
  private rebuildAll(centerDateKey: DateKey, keepFocus = false): void {
    this.clearAllCellComponents();
    this.rowElements.clear();
    this.cellElements.clear();
    this.gridBodyEl.empty();

    const weeksPerView = this.plugin.settings.visibleWeeksPerViewport || 5;
    this.rootEl.style.setProperty("--cm-visible-weeks", String(weeksPerView));

    this.renderTabBar();
    this.renderToolbar();
    // 검색 모드가 열려 있고 이미 검색 input이 존재하면 DOM을 재생성하지 않아 포커스·입력 상태를 보존함
    if (!this.searchInputEl || !this.searchInputEl.isConnected) {
      this.renderSearchBar();
    } else {
      this.searchInputEl.placeholder = this.plugin.t().searchPlaceholder;
      this.updateSearchCountLabel();
    }
    this.renderWeekdayHeader();

    this.originWeekStart = getWeekStart(
      centerDateKey,
      this.plugin.settings.weekStartsOn
    );
    this.firstRow = -INITIAL_WEEKS_BEFORE;
    this.lastRow = INITIAL_WEEKS_AFTER;

    const frag = document.createDocumentFragment();
    for (let r = this.firstRow; r <= this.lastRow; r++) {
      frag.appendChild(this.createWeekRowElement(r));
    }
    this.gridBodyEl.appendChild(frag);

    const targetCoord = dateKeyToCoord(centerDateKey, this.originWeekStart);
    this.selection = { anchor: { ...targetCoord }, focus: { ...targetCoord } };
    this.updateSelectionStyles();
    this.applySearchHighlightClasses();

    window.requestAnimationFrame(() => {
      this.scrollRowIntoView(targetCoord.row, "center");
      this.updateVisibleMonthIndicator();
      // 뷰를 열자마자 클릭 없이도 방향키·Tab·Enter 탐색이 즉시 동작하도록 그리드에 포커스 부여
      // (검색 점프 중에는 검색창 포커스를 빼앗지 않음)
      if (
        !keepFocus &&
        !this.hasAnyPopoverOpen() &&
        this.searchBarEl.hasClass("is-hidden")
      ) {
        this.gridScrollEl.focus({ preventScroll: true });
      }
    });
  }

  private createWeekRowElement(row: number): HTMLElement {
    const rowEl = document.createElement("div");
    rowEl.className = "cm-week-row";
    rowEl.dataset.row = String(row);

    for (let col = 0; col < 7; col++) {
      const dateKey = coordToDateKey(row, col, this.originWeekStart);
      const cellEl = this.createDayCellElement(dateKey, row, col);
      rowEl.appendChild(cellEl);
      this.cellElements.set(dateKey, cellEl);
    }

    this.rowElements.set(row, rowEl);
    return rowEl;
  }

  private createDayCellElement(
    dateKey: DateKey,
    row: number,
    col: number
  ): HTMLElement {
    const cellEl = document.createElement("div");
    cellEl.className = "cm-day-cell";
    cellEl.dataset.date = dateKey;
    cellEl.dataset.row = String(row);
    cellEl.dataset.col = String(col);

    // 짝수달/홀수달 미세 톤 차이로 끊김 없는 그리드에서도 월 경계를 한눈에 구분
    const { month } = parseDateKey(dateKey);
    if (month % 2 === 0) {
      cellEl.classList.add("is-alt-month");
    }

    const dow = getDayOfWeek(dateKey);
    if (dow === 0) cellEl.classList.add("is-sunday");
    if (dow === 6) cellEl.classList.add("is-saturday");
    if (dateKey === getTodayKey()) cellEl.classList.add("is-today");

    // 셀 선택 & 드래그 직사각형 선택
    cellEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // 체크박스·링크·반복일정 배지 클릭 시에는 드래그 선택을 방해하지 않음
      if (
        target.closest(
          ".cm-recurring-item, input[type='checkbox'], a.internal-link, a.external-link"
        )
      ) {
        return;
      }

      this.gridScrollEl.focus({ preventScroll: true });
      const coord: GridCoord = { row, col };
      if (e.shiftKey) {
        this.selection = { anchor: this.selection.anchor, focus: coord };
      } else {
        this.selection = { anchor: coord, focus: coord };
        this.isDraggingSelection = true;
      }
      this.updateSelectionStyles();
    });

    cellEl.addEventListener("pointerenter", () => {
      if (!this.isDraggingSelection) return;
      this.selection = {
        anchor: this.selection.anchor,
        focus: { row, col },
      };
      this.updateSelectionStyles();
    });

    // 더블클릭으로 메모잇 팝오버 열기
    cellEl.addEventListener("dblclick", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("input[type='checkbox'], .cm-recurring-item")) {
        return;
      }
      e.preventDefault();
      this.selection = { anchor: { row, col }, focus: { row, col } };
      this.updateSelectionStyles();
      this.openPopover(dateKey, cellEl);
    });

    // 우클릭 컨텍스트 메뉴
    cellEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const coord: GridCoord = { row, col };
      if (!isCoordInRange(coord, this.selection)) {
        this.selection = { anchor: coord, focus: coord };
        this.updateSelectionStyles();
      }
      this.showCellContextMenu(e, dateKey, cellEl);
    });

    // [ID 5.7] 노트 드래그 앤 드롭 -> 날짜 셀 하단에 [[파일이름]] 링크 자동 추가
    cellEl.addEventListener("dragover", (e) => {
      if (!this.hasDroppableNote(e)) return;
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "link";
      }
      cellEl.classList.add("is-drag-over");
    });

    cellEl.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget as Node | null;
      if (related && cellEl.contains(related)) return;
      cellEl.classList.remove("is-drag-over");
    });

    cellEl.addEventListener("drop", (e) => {
      cellEl.classList.remove("is-drag-over");
      const files = this.resolveDroppedFiles(e);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      void this.appendDroppedNoteLinks(dateKey, files);
    });

    this.populateCellStructure(dateKey, cellEl);
    return cellEl;
  }

  private populateCellStructure(dateKey: DateKey, cellEl: HTMLElement): void {
    const s = this.plugin.t();
    const allMode = this.isAllTabsMode();
    const activeTab = this.getActiveTab();
    const meta = this.plugin.koreanCalendar.getDayMeta(
      dateKey,
      this.plugin.settings.lunarDisplay,
      this.plugin.settings.showAnniversaries
    );

    // 셀 배경색 클래스 적용 (전체 보기 모드에서는 배경색이 지정된 첫 탭의 색 표시)
    const colorTabId = allMode
      ? this.plugin.settings.tabs.find(
          (t) => this.plugin.settings.cellColors[t.id]?.[dateKey]
        )?.id ?? activeTab.id
      : activeTab.id;
    this.applyCellColorClass(cellEl, colorTabId, dateKey);

    cellEl.classList.toggle("is-holiday", meta.isHoliday);

    cellEl.empty();

    // 1) 셀 헤더: 일자 + 공휴일/기념일 + 음력
    const headerEl = cellEl.createDiv({ cls: "cm-cell-header" });
    const { month, day } = parseDateKey(dateKey);

    const dateBadge = headerEl.createSpan({
      cls: `cm-date-num ${day === 1 ? "is-month-first" : ""}`,
      text: day === 1 ? s.formatMonthFirst(month) : String(day),
    });
    void dateBadge;

    const metaEl = headerEl.createDiv({ cls: "cm-cell-meta" });
    if (meta.holidayNames.length > 0) {
      metaEl.createSpan({
        cls: "cm-holiday-label",
        text: meta.holidayNames[0],
        attr: { title: meta.holidayNames.join(", ") },
      });
    } else if (meta.anniversaryNames.length > 0) {
      metaEl.createSpan({
        cls: "cm-anniversary-label",
        text: meta.anniversaryNames[0],
        attr: { title: meta.anniversaryNames.join(", ") },
      });
    }

    if (meta.lunarLabel) {
      metaEl.createSpan({
        cls: "cm-lunar-label",
        text: meta.lunarLabel,
        attr: { title: meta.lunarLabel },
      });
    }

    // 2) 반복 일정 오버레이 영역
    const recurringScopeTabId = allMode ? ALL_TABS_ID : activeTab.id;
    const recurringList = getRecurringEventsForDate(
      this.plugin.settings.recurringEvents,
      dateKey,
      recurringScopeTabId,
      (dk) => this.plugin.koreanCalendar.isBusinessDay(dk)
    );

    if (recurringList.length > 0) {
      const recWrap = cellEl.createDiv({ cls: "cm-recurring-list" });
      for (const item of recurringList) {
        const badge = recWrap.createDiv({
          cls: `cm-recurring-item cm-rec-${item.event.color || "blue"} ${
            item.completed ? "is-completed" : ""
          }`,
          attr: { title: item.event.title },
        });
        badge.createSpan({
          cls: "cm-recurring-check",
          text: item.completed ? "✓" : "↻",
        });
        badge.createSpan({
          cls: "cm-recurring-text",
          text: item.event.title,
        });

        badge.addEventListener("click", async (e) => {
          e.stopPropagation();
          toggleRecurringCompletion(item.event, dateKey);
          await this.plugin.saveSettings();
          this.populateCellStructure(dateKey, cellEl);
        });

        badge.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const menu = new Menu();
          menu.addItem((mi) =>
            mi
              .setTitle(item.completed ? s.ctxMarkUndone : s.ctxMarkDone)
              .setIcon("check")
              .onClick(async () => {
                toggleRecurringCompletion(item.event, dateKey);
                await this.plugin.saveSettings();
                this.populateCellStructure(dateKey, cellEl);
              })
          );
          menu.addItem((mi) =>
            mi
              .setTitle(s.ctxHideThisDate)
              .setIcon("eye-off")
              .onClick(async () => {
                excludeRecurringOccurrence(item.event, dateKey);
                await this.plugin.saveSettings();
                this.populateCellStructure(dateKey, cellEl);
              })
          );
          menu.addItem((mi) =>
            mi
              .setTitle(s.ctxEditRecurring)
              .setIcon("pencil")
              .onClick(() => {
                new RecurringEventsModal(
                  this.plugin,
                  activeTab.id,
                  dateKey,
                  () => this.reloadAllRenderedCells(),
                  item.event
                ).open();
              })
          );
          menu.showAtMouseEvent(e);
        });
      }
    }

    // 3) 마크다운 메모 미리보기 컨테이너 (markdown-rendered 추가로 읽기 뷰 스니펫·플러그인 스타일 호환)
    cellEl.createDiv({ cls: "cm-cell-preview markdown-rendered" });
    void this.refreshCellContent(dateKey, cellEl);
  }

  private applyCellColorClass(
    cellEl: HTMLElement,
    tabId: string,
    dateKey: DateKey
  ): void {
    for (const preset of CELL_COLOR_PRESETS) {
      if (preset.id) {
        cellEl.classList.remove(`cm-bg-${preset.id}`);
      }
    }
    const colorId = this.plugin.settings.cellColors[tabId]?.[dateKey];
    if (colorId) {
      cellEl.classList.add(`cm-bg-${colorId}`);
    }
  }

  /**
   * [ID 5.4] 셀 마크다운 미리보기 렌더링 + 체크박스 직접 토글 + 전체 보기 탭 합쳐보기
   */
  private async refreshCellContent(
    dateKey: DateKey,
    cellEl: HTMLElement
  ): Promise<void> {
    const seq = (this.cellRenderSeq.get(dateKey) ?? 0) + 1;
    this.cellRenderSeq.set(dateKey, seq);

    const previewEl = cellEl.querySelector(".cm-cell-preview") as HTMLElement | null;
    if (!previewEl) return;

    const allMode = this.isAllTabsMode();
    const tabsToRender = allMode
      ? this.plugin.settings.tabs
      : [this.getActiveTab()];

    const entries = await Promise.all(
      tabsToRender.map(async (tab, idx) => ({
        tab,
        idx,
        content: await this.plugin.vaultSync.readMemo(tab, dateKey),
      }))
    );

    if (this.cellRenderSeq.get(dateKey) !== seq || !cellEl.isConnected) return;

    const prevComp = this.cellComponents.get(dateKey);
    if (prevComp) {
      prevComp.unload();
      this.cellComponents.delete(dateKey);
    }

    previewEl.empty();

    const nonEmpty = entries.filter((e) => e.content.trim().length > 0);
    if (nonEmpty.length === 0) {
      cellEl.classList.remove("has-memo");
      return;
    }

    cellEl.classList.add("has-memo");
    const comp = new Component();
    comp.load();
    this.cellComponents.set(dateKey, comp);

    for (const item of nonEmpty) {
      const targetContainer = allMode
        ? previewEl.createDiv({
            cls: `cm-all-tab-block cm-tab-color-${item.idx % 6}`,
          })
        : previewEl;

      if (allMode) {
        const badge = targetContainer.createDiv({
          cls: "cm-all-tab-badge",
          text: item.tab.name,
        });
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.switchTab(item.tab.id);
        });
      }

      const contentHost = allMode
        ? targetContainer.createDiv({ cls: "cm-all-tab-content" })
        : targetContainer;

      const { body } = stripFrontmatter(item.content);
      const notePath = this.plugin.vaultSync.getNotePath(item.tab, dateKey);
      await MarkdownRenderer.render(
        this.app,
        body,
        contentHost,
        notePath,
        comp
      );

      if (this.cellRenderSeq.get(dateKey) !== seq || !previewEl.isConnected) {
        comp.unload();
        return;
      }

      // [ID 5.4.1] 이모지 접두어 하이라이트 경량 색상 적용
      applyEmojiHighlightsToPreview(contentHost);

      // 체크박스 즉시 클릭 토글 (전체 보기에서도 해당 탭의 .md 파일에 정확히 기록)
      const checkboxes = contentHost.querySelectorAll<HTMLInputElement>(
        "input.task-list-item-checkbox"
      );
      checkboxes.forEach((cb, index) => {
        cb.addEventListener("click", async (e) => {
          e.stopPropagation();
          const latest = await this.plugin.vaultSync.readMemo(item.tab, dateKey);
          const toggled = toggleNthTaskCheckbox(latest, index);
          if (toggled !== null) {
            await this.plugin.vaultSync.writeMemo(item.tab, dateKey, toggled);
          }
        });
      });

      const internalLinks = contentHost.querySelectorAll<HTMLAnchorElement>(
        "a.internal-link"
      );
      internalLinks.forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const href =
            link.getAttribute("data-href") || link.getAttribute("href");
          if (href) {
            void this.app.workspace.openLinkText(
              href,
              notePath,
              e.metaKey || e.ctrlKey
            );
          }
        });
      });
    }
  }

  private reloadAllRenderedCells(): void {
    for (const [dateKey, cellEl] of this.cellElements.entries()) {
      this.populateCellStructure(dateKey, cellEl);
    }
    this.updateSelectionStyles();
  }

  private clearAllCellComponents(): void {
    for (const comp of this.cellComponents.values()) {
      comp.unload();
    }
    this.cellComponents.clear();
  }

  // ==========================================================================
  // 무한 스크롤 동적 행 추가 및 연/월 표시 갱신
  // ==========================================================================
  private onGridScroll(): void {
    if (this.scrollRafId !== null) return;
    this.scrollRafId = window.requestAnimationFrame(() => {
      this.scrollRafId = null;
      this.checkInfiniteScrollBounds();
      this.updateVisibleMonthIndicator();
    });
  }

  private checkInfiniteScrollBounds(): void {
    if (this.isLoadingRows) return;
    const el = this.gridScrollEl;
    if (el.scrollTop < SCROLL_THRESHOLD_PX) {
      this.prependWeeks(LOAD_CHUNK_WEEKS);
    } else if (
      el.scrollHeight - el.scrollTop - el.clientHeight <
      SCROLL_THRESHOLD_PX
    ) {
      this.appendWeeks(LOAD_CHUNK_WEEKS);
    }
  }

  private prependWeeks(count: number): void {
    this.isLoadingRows = true;
    const prevScrollHeight = this.gridScrollEl.scrollHeight;
    const prevScrollTop = this.gridScrollEl.scrollTop;

    const newFirst = this.firstRow - count;
    const frag = document.createDocumentFragment();
    for (let r = newFirst; r < this.firstRow; r++) {
      frag.appendChild(this.createWeekRowElement(r));
    }
    this.gridBodyEl.insertBefore(frag, this.gridBodyEl.firstChild);
    this.firstRow = newFirst;

    // 추가된 높이만큼 scrollTop을 즉시 보정하여 화면 튐(점프) 방지
    const addedHeight = this.gridScrollEl.scrollHeight - prevScrollHeight;
    this.gridScrollEl.scrollTop = prevScrollTop + addedHeight;

    this.updateSelectionStyles();
    this.applySearchHighlightClasses();
    this.isLoadingRows = false;
  }

  private appendWeeks(count: number): void {
    this.isLoadingRows = true;
    const newLast = this.lastRow + count;
    const frag = document.createDocumentFragment();
    for (let r = this.lastRow + 1; r <= newLast; r++) {
      frag.appendChild(this.createWeekRowElement(r));
    }
    this.gridBodyEl.appendChild(frag);
    this.lastRow = newLast;

    this.updateSelectionStyles();
    this.applySearchHighlightClasses();
    this.isLoadingRows = false;
  }

  private ensureRowRendered(row: number): void {
    // [ID 5.3.1] 점프 대상 행 아래에도 최소 한 화면 분량의 행을 확보
    // -> 특정 월 1일을 화면 최상단에 정렬할 때 스크롤 여유 높이가 부족해 못 내려가는 현상을 방지함.
    const minTrailing = Math.max(
      LOAD_CHUNK_WEEKS,
      (this.plugin.settings.visibleWeeksPerViewport || 5) + 2
    );
    while (row < this.firstRow + 3) {
      this.prependWeeks(LOAD_CHUNK_WEEKS);
    }
    while (row > this.lastRow - minTrailing) {
      this.appendWeeks(LOAD_CHUNK_WEEKS);
    }
  }

  private setDisplayedMonth(year: number, month: number): void {
    const ym = `${year}-${month < 10 ? "0" : ""}${month}`;
    this.displayedYm = ym;
    this.monthTitleEl.setText(this.plugin.t().formatYearMonth(year, month));
    if (this.monthPickerInput.value !== ym) {
      this.monthPickerInput.value = ym;
    }
  }

  private updateVisibleMonthIndicator(): void {
    if (Date.now() < this.suppressScrollMonthUntil) return;
    const scrollRect = this.gridScrollEl.getBoundingClientRect();
    const headerHeight = this.weekdayHeaderEl.offsetHeight;
    const probeY = scrollRect.top + headerHeight + (scrollRect.height - headerHeight) * 0.35;

    for (let r = this.firstRow; r <= this.lastRow; r++) {
      const rowEl = this.rowElements.get(r);
      if (!rowEl) continue;
      const rect = rowEl.getBoundingClientRect();
      if (rect.top <= probeY && rect.bottom >= probeY) {
        // 해당 주의 가운데 요일(col 3)을 대표 연월로 표시
        const midDate = coordToDateKey(r, 3, this.originWeekStart);
        const { year, month } = parseDateKey(midDate);
        this.setDisplayedMonth(year, month);
        return;
      }
    }
  }

  // [ID 5.3.2] 상단 < / > 월 이동 버튼 처리
  // -> 현재 표시 중인 displayedYm 기준으로 ±1개월의 1일로 점프하며,
  //    해당 주가 화면 최상단에 위치하도록 정렬해 연속 클릭 시에도 막힘 없이 이동함.
  private shiftVisibleMonth(deltaMonths: number): void {
    const baseYm = this.displayedYm || this.monthPickerInput.value;
    let year: number;
    let month: number;
    if (/^\d{4}-\d{2}$/.test(baseYm)) {
      year = Number(baseYm.slice(0, 4));
      month = Number(baseYm.slice(5, 7));
    } else {
      const parsed = parseDateKey(getTodayKey());
      year = parsed.year;
      month = parsed.month;
    }
    const d = new Date(year, month - 1 + deltaMonths, 1);
    const targetYear = d.getFullYear();
    const targetMonth = d.getMonth() + 1;
    const target = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
    this.jumpToDate(target, true, "start");
  }

  public jumpToDate(
    dateKey: DateKey,
    smooth: boolean,
    align: "center" | "start" = "center",
    keepFocus = false
  ): void {
    const coord = dateKeyToCoord(dateKey, this.originWeekStart);
    const { year, month } = parseDateKey(dateKey);

    if (coord.row < this.firstRow - 12 || coord.row > this.lastRow + 12) {
      this.rebuildAll(dateKey, keepFocus);
      this.setDisplayedMonth(year, month);
      return;
    }

    this.ensureRowRendered(coord.row);
    this.selection = { anchor: { ...coord }, focus: { ...coord } };
    this.updateSelectionStyles();

    // 스무스 스크롤 도중 중간 프레임이 상단 연월 텍스트를 덮어쓰지 않도록 짧게 잠금
    this.setDisplayedMonth(year, month);
    this.suppressScrollMonthUntil = Date.now() + (smooth ? 420 : 80);

    this.scrollRowIntoView(coord.row, align, smooth);
    // preventScroll: true 없이 focus()를 호출하면 Chromium이 진행 중인 smooth scroll을 즉시 취소함
    if (!keepFocus) {
      this.gridScrollEl.focus({ preventScroll: true });
    }
  }

  private scrollRowIntoView(
    row: number,
    mode: "center" | "nearest" | "start",
    smooth = false
  ): void {
    const rowEl = this.rowElements.get(row);
    if (!rowEl) return;

    const scrollEl = this.gridScrollEl;
    const headerHeight = this.weekdayHeaderEl.offsetHeight;
    const rowTop = rowEl.offsetTop;
    const rowHeight = rowEl.offsetHeight;
    const visibleHeight = scrollEl.clientHeight - headerHeight;

    let targetTop: number;
    if (mode === "start") {
      targetTop = Math.max(0, rowTop - headerHeight);
    } else if (mode === "center") {
      targetTop = Math.max(
        0,
        rowTop - headerHeight - Math.max(0, (visibleHeight - rowHeight) / 2)
      );
    } else {
      // nearest: 현재 뷰포트 안에 이미 완전히 보이면 스크롤하지 않음
      const viewTop = scrollEl.scrollTop + headerHeight;
      const viewBottom = scrollEl.scrollTop + scrollEl.clientHeight;
      if (rowTop >= viewTop && rowTop + rowHeight <= viewBottom) {
        return;
      }
      targetTop =
        rowTop < viewTop
          ? Math.max(0, rowTop - headerHeight)
          : Math.max(0, rowTop + rowHeight - scrollEl.clientHeight);
    }

    scrollEl.scrollTo({
      top: targetTop,
      behavior: smooth ? "smooth" : "auto",
    });
  }

  // ==========================================================================
  // [ID 5.5] 선택 하이라이트 및 키보드 내비게이션 / 편집 단축키
  // ==========================================================================
  private updateSelectionStyles(): void {
    const bounds = getRectBounds(this.selection);
    const focusKey = coordToDateKey(
      this.selection.focus.row,
      this.selection.focus.col,
      this.originWeekStart
    );

    for (const [dateKey, cellEl] of this.cellElements.entries()) {
      const r = Number(cellEl.dataset.row);
      const c = Number(cellEl.dataset.col);
      const selected =
        r >= bounds.minRow &&
        r <= bounds.maxRow &&
        c >= bounds.minCol &&
        c <= bounds.maxCol;
      cellEl.classList.toggle("is-selected", selected);
      cellEl.classList.toggle("is-focused", dateKey === focusKey);
    }
  }

  private onGridKeyDown(e: KeyboardEvent): void {
    // 팝오버가 열려있거나 인풋에 포커스가 있으면 그리드 단축키를 가로채지 않음
    if (this.hasAnyPopoverOpen()) return;
    const activeTag = (document.activeElement?.tagName ?? "").toLowerCase();
    if (activeTag === "input" || activeTag === "textarea") return;

    const isMod = Platform.isMacOS ? e.metaKey : e.ctrlKey;

    // Alt + 1~9: 폴더 탭 빠른 전환
    if (e.altKey && !isMod && /^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      const targetTab = this.plugin.settings.tabs[idx];
      if (targetTab) {
        e.preventDefault();
        void this.switchTab(targetTab.id);
      }
      return;
    }

    // 방향키 탐색 & Shift+방향키 엑셀형 2D 직사각형 선택
    if (
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight"
    ) {
      e.preventDefault();
      this.handleArrowNavigation(e.key, e.shiftKey);
      return;
    }

    // [ID 6.8] Enter: 다중 선택(2개 이상) 시 공통 일괄 입력 팝오버, 단일 셀이면 개별 팝오버 열기
    if (e.key === "Enter" && !isMod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const selectedCells = getSelectedCells(
        this.selection,
        this.originWeekStart
      );
      const focusKey = coordToDateKey(
        this.selection.focus.row,
        this.selection.focus.col,
        this.originWeekStart
      );
      const cellEl = this.cellElements.get(focusKey);
      if (!cellEl) return;

      if (selectedCells.length > 1) {
        this.openBatchPopover(
          selectedCells.map((c) => c.dateKey),
          cellEl
        );
      } else {
        this.openPopover(focusKey, cellEl);
      }
      return;
    }

    // T: 오늘 날짜로 빠르게 이동
    if ((e.key === "t" || e.key === "T") && !isMod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.jumpToDate(getTodayKey(), true);
      return;
    }

    // 복사 (Ctrl/Cmd + C, 한글 IME 상태 e.code 병행)
    if (isMod && (e.key === "c" || e.key === "C" || e.code === "KeyC")) {
      e.preventDefault();
      void this.copySelection();
      return;
    }

    // [ID 7.5.1] 잘라내기 (Ctrl/Cmd + X)
    if (isMod && (e.key === "x" || e.key === "X" || e.code === "KeyX")) {
      e.preventDefault();
      void this.cutSelection();
      return;
    }

    // 붙여넣기 (Ctrl/Cmd + V)
    if (isMod && (e.key === "v" || e.key === "V" || e.code === "KeyV")) {
      e.preventDefault();
      void this.pasteIntoSelection();
      return;
    }

    // Undo (Ctrl/Cmd + Z) / Redo (Ctrl/Cmd + Y 또는 Ctrl/Cmd + Shift + Z)
    if (isMod && (e.key === "z" || e.key === "Z" || e.code === "KeyZ")) {
      e.preventDefault();
      if (e.shiftKey) {
        void this.performRedo();
      } else {
        void this.performUndo();
      }
      return;
    }
    if (isMod && (e.key === "y" || e.key === "Y" || e.code === "KeyY")) {
      e.preventDefault();
      void this.performRedo();
      return;
    }

    // ESC: 찾기 모드가 켜져 있으면 종료
    if (
      (e.key === "Escape" || e.code === "Escape") &&
      !this.searchBarEl.hasClass("is-hidden")
    ) {
      e.preventDefault();
      this.closeSearchBar();
      return;
    }

    // 선택 셀 일괄 삭제 (Delete / Backspace)
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !isMod &&
      !e.altKey
    ) {
      e.preventDefault();
      void this.deleteSelectionContent();
      return;
    }
  }

  private handleArrowNavigation(
    key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
    extendSelection: boolean
  ): void {
    let { row, col } = this.selection.focus;

    if (key === "ArrowUp") {
      row -= 1;
    } else if (key === "ArrowDown") {
      row += 1;
    } else if (key === "ArrowLeft") {
      if (extendSelection) {
        // 2D 직사각형 선택 중에는 열 경계(0..6) 내에서 확장/축소
        col = Math.max(0, col - 1);
      } else if (col === 0) {
        row -= 1;
        col = 6;
      } else {
        col -= 1;
      }
    } else if (key === "ArrowRight") {
      if (extendSelection) {
        col = Math.min(6, col + 1);
      } else if (col === 6) {
        row += 1;
        col = 0;
      } else {
        col += 1;
      }
    }

    this.ensureRowRendered(row);

    const nextFocus: GridCoord = { row, col };
    if (extendSelection) {
      this.selection = { anchor: this.selection.anchor, focus: nextFocus };
    } else {
      this.selection = { anchor: nextFocus, focus: nextFocus };
    }

    this.updateSelectionStyles();
    this.scrollRowIntoView(row, "nearest");
    this.updateVisibleMonthIndicator();
  }

  // ==========================================================================
  // 팝오버 편집기 열기 (단일 셀 / 다중 셀 공통 입력)
  // ==========================================================================
  private openPopover(dateKey: DateKey, cellEl: HTMLElement): void {
    if (this.activePopover?.isActive()) {
      void this.activePopover.close();
    }
    if (this.activeBatchPopover?.isActive()) {
      this.activeBatchPopover.close();
    }

    // 전체 보기 모드에서 열 경우 해당 날짜에 메모가 있는 첫 탭(없으면 마지막 활성 폴더 탭)을 기본 선택하되,
    // 팝오버 상단 달력 선택 바에서 1클릭 전환 및 '동시 입력' 전환이 가능하도록 모든 탭 목록을 전달함.
    const allMode = this.isAllTabsMode();
    const tabsWithMemo = new Set<string>();
    let targetTab = this.getActiveTab();
    if (allMode) {
      for (const t of this.plugin.settings.tabs) {
        const cached = this.plugin.vaultSync.getCachedContent(t.id, dateKey);
        if (cached && cached.trim().length > 0) {
          tabsWithMemo.add(t.id);
        }
      }
      const firstWithContent = this.plugin.settings.tabs.find((t) =>
        tabsWithMemo.has(t.id)
      );
      if (firstWithContent) targetTab = firstWithContent;
    }

    const meta: DayCalendarMeta = this.plugin.koreanCalendar.getDayMeta(
      dateKey,
      this.plugin.settings.lunarDisplay,
      this.plugin.settings.showAnniversaries
    );

    this.activePopover = new CalendarPopoverEditor({
      app: this.app,
      vaultSync: this.plugin.vaultSync,
      tab: targetTab,
      allTabs: this.plugin.settings.tabs,
      tabsWithMemo,
      dateKey,
      meta,
      anchorRect: cellEl.getBoundingClientRect(),
      initialSize: this.plugin.settings.popoverSize,
      strings: this.plugin.t(),
      showTabBadge: allMode,
      onSwitchToMultiCalendar: () => {
        this.openBatchPopover([dateKey], cellEl, true);
      },
      onSizeChange: (nextSize) => {
        this.plugin.settings.popoverSize = nextSize;
        void this.plugin.saveSettings();
      },
      onClosed: (closedDateKey) => {
        this.activePopover = null;
        const targetCell = this.cellElements.get(closedDateKey);
        if (targetCell) {
          void this.refreshCellContent(closedDateKey, targetCell);
        }
        // 팝오버 닫힌 뒤 즉시 방향키 탐색을 이어갈 수 있도록 그리드로 포커스 복귀
        this.gridScrollEl.focus({ preventScroll: true });
      },
    });
  }

  /**
   * [ID 6.8] 다중 선택된 날짜(또는 여러 달력)에 공통 문구·배경색을 일괄 입력하는 팝오버 열기
   */
  private openBatchPopover(
    dateKeys: DateKey[],
    anchorCellEl: HTMLElement,
    selectAllTabsByDefault = false
  ): void {
    if (this.activePopover?.isActive()) {
      void this.activePopover.close();
    }
    if (this.activeBatchPopover?.isActive()) {
      this.activeBatchPopover.close();
    }

    const initialTabIds = selectAllTabsByDefault
      ? this.plugin.settings.tabs.map((t) => t.id)
      : [this.getActiveTab().id];

    this.activeBatchPopover = new CalendarBatchPopover({
      app: this.app,
      dateKeys,
      tabs: this.plugin.settings.tabs,
      initialSelectedTabIds: initialTabIds,
      anchorRect: anchorCellEl.getBoundingClientRect(),
      strings: this.plugin.t(),
      onApply: (result) => {
        this.activeBatchPopover = null;
        void this.applyBatchInput(dateKeys, result);
        this.gridScrollEl.focus({ preventScroll: true });
      },
      onCancel: () => {
        this.activeBatchPopover = null;
        this.gridScrollEl.focus({ preventScroll: true });
      },
    });
  }

  private async applyBatchInput(
    dateKeys: DateKey[],
    result: BatchPopoverResult
  ): Promise<void> {
    const s = this.plugin.t();
    const targetTabs = this.plugin.settings.tabs.filter((t) =>
      result.targetTabIds.includes(t.id)
    );
    if (targetTabs.length === 0) return;

    const changes: HistoryChange[] = [];
    const hasText = result.content.trim().length > 0;
    let colorDirty = false;
    const allMode = this.isAllTabsMode();
    const activeTabId = this.getActiveTab().id;

    for (const targetTab of targetTabs) {
      if (
        result.colorAction === "set" &&
        !this.plugin.settings.cellColors[targetTab.id]
      ) {
        this.plugin.settings.cellColors[targetTab.id] = {};
      }
      const tabColors = this.plugin.settings.cellColors[targetTab.id];

      for (const dateKey of dateKeys) {
        if (hasText) {
          const before = await this.plugin.vaultSync.readMemo(
            targetTab,
            dateKey
          );
          const merged = mergeMemoContentForAppend(before, result.content);
          if (before !== merged) {
            changes.push({
              type: "content",
              tabId: targetTab.id,
              dateKey,
              before,
              after: merged,
            });
            await this.plugin.vaultSync.writeMemo(targetTab, dateKey, merged);
          }
        }

        if (result.colorAction === "set") {
          const beforeColor = tabColors[dateKey] ?? "";
          if (beforeColor !== result.colorId) {
            changes.push({
              type: "color",
              tabId: targetTab.id,
              dateKey,
              before: beforeColor,
              after: result.colorId,
            });
            if (result.colorId) {
              tabColors[dateKey] = result.colorId;
            } else {
              delete tabColors[dateKey];
            }
            colorDirty = true;
          }
        }
      }
    }

    if (colorDirty) {
      await this.plugin.saveSettings();
      // 변경된 날짜 셀 배경색 즉시 반영
      for (const dateKey of dateKeys) {
        const cellEl = this.cellElements.get(dateKey);
        if (!cellEl) continue;
        const displayTabId = allMode
          ? this.plugin.settings.tabs.find(
              (t) => this.plugin.settings.cellColors[t.id]?.[dateKey]
            )?.id ?? activeTabId
          : activeTabId;
        this.applyCellColorClass(cellEl, displayTabId, dateKey);
      }
    }

    if (changes.length > 0) {
      this.undoHistory.push({
        label: s.batchTitle(dateKeys.length),
        changes,
      });
      this.updateUndoRedoButtons();
      new Notice(s.batchAppliedNotice(dateKeys.length, targetTabs.length));
    }
  }

  // ==========================================================================
  // [ID 5.7] 드래그 앤 드롭 노트 링크 연결 ([[파일이름]])
  // ==========================================================================
  private hasDroppableNote(e: DragEvent): boolean {
    const dragManager = (
      this.app as unknown as {
        dragManager?: {
          draggable?: { type?: string; file?: unknown; files?: unknown[] };
        };
      }
    ).dragManager;
    const draggable = dragManager?.draggable;
    if (
      draggable &&
      (draggable.type === "file" ||
        draggable.type === "files" ||
        draggable.type === "link")
    ) {
      return true;
    }
    const types = e.dataTransfer?.types;
    return Boolean(types && types.includes("text/plain"));
  }

  private resolveDroppedFiles(e: DragEvent): TFile[] {
    const result: TFile[] = [];
    const seen = new Set<string>();
    const addFile = (f: unknown) => {
      if (f instanceof TFile && !seen.has(f.path)) {
        seen.add(f.path);
        result.push(f);
      }
    };

    // 1순위: 옵시디언 내부 dragManager.draggable (탐색기 단일/다중 선택, 탭 헤더 드래그 모두 대응)
    const dragManager = (
      this.app as unknown as {
        dragManager?: {
          draggable?: { file?: unknown; files?: unknown[] };
        };
      }
    ).dragManager;
    const draggable = dragManager?.draggable;
    if (draggable?.file) addFile(draggable.file);
    if (Array.isArray(draggable?.files)) {
      for (const f of draggable.files) addFile(f);
    }

    // 2순위: dataTransfer의 obsidian://open?file=... URI 폴백
    if (result.length === 0 && e.dataTransfer) {
      const raw = e.dataTransfer.getData("text/plain");
      if (raw) {
        const extractedPath = parseObsidianUriToFilePath(raw);
        if (extractedPath) {
          const direct =
            this.app.vault.getAbstractFileByPath(extractedPath) ??
            this.app.vault.getAbstractFileByPath(`${extractedPath}.md`);
          addFile(direct);
          if (result.length === 0) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(
              extractedPath,
              ""
            );
            addFile(dest);
          }
        }
      }
    }

    return result;
  }

  private async appendDroppedNoteLinks(
    dateKey: DateKey,
    files: TFile[]
  ): Promise<void> {
    const activeTab = this.getActiveTab();
    const targetNotePath = this.plugin.vaultSync.getNotePath(activeTab, dateKey);

    const links = files.map((file) => {
      if (file.extension === "md") {
        // 같은 이름의 파일이 볼트에 유일하면 깔끔하게 [[파일이름]], 중복이면 경로 포함 링크 생성
        const resolved = this.app.metadataCache.getFirstLinkpathDest(
          file.basename,
          targetNotePath
        );
        if (!resolved || resolved.path === file.path) {
          return `[[${file.basename}]]`;
        }
        const noExt = file.path.replace(/\.md$/, "");
        return `[[${noExt}|${file.basename}]]`;
      }
      return `[[${file.name}]]`;
    });

    const before = await this.plugin.vaultSync.readMemo(activeTab, dateKey);
    const merged = mergeMemoContentForAppend(before, links.join("\n"));

    if (before !== merged) {
      await this.plugin.vaultSync.writeMemo(activeTab, dateKey, merged);
      this.undoHistory.push({
        label: "노트 링크 추가",
        changes: [
          {
            type: "content",
            tabId: activeTab.id,
            dateKey,
            before,
            after: merged,
          },
        ],
      });
      this.updateUndoRedoButtons();
      new Notice(
        links.length === 1
          ? `${dateKey}에 ${links[0]} 링크 추가됨`
          : `${dateKey}에 ${links.length}개 노트 링크 추가됨`
      );
    }
  }

  // ==========================================================================
  // [ID 7.4] 셀 복붙, 배경색 변경, 일괄 삭제, Undo/Redo 실행
  // ==========================================================================
  private async copySelection(): Promise<void> {
    const activeTab = this.getActiveTab();
    const selected = getSelectedCells(this.selection, this.originWeekStart);
    const bounds = getRectBounds(this.selection);

    const entries: Array<{
      dateKey: DateKey;
      relRow: number;
      relCol: number;
      content: string;
    }> = [];

    for (const cell of selected) {
      const content = await this.plugin.vaultSync.readMemo(
        activeTab,
        cell.dateKey
      );
      entries.push({
        dateKey: cell.dateKey,
        relRow: cell.relRow,
        relCol: cell.relCol,
        content,
      });
    }

    // 외부 메모장 붙여넣기용 포맷 (비어있는 날짜 제외)
    const externalText = formatExternalClipboardText(entries);

    this.internalClipboard = {
      width: bounds.maxCol - bounds.minCol + 1,
      height: bounds.maxRow - bounds.minRow + 1,
      cells: entries.map((e) => ({
        relRow: e.relRow,
        relCol: e.relCol,
        content: e.content,
      })),
      externalText,
    };

    try {
      await navigator.clipboard.writeText(externalText);
    } catch {
      // 클립보드 권한 제한 시 내부 클립보드만 유지
    }

    const nonEmptyCount = entries.filter((e) => e.content.trim().length > 0).length;
    new Notice(
      nonEmptyCount > 0
        ? `${selected.length}개 셀(메모 ${nonEmptyCount}개) 복사됨`
        : `${selected.length}개 빈 셀 복사됨`
    );
  }

  private async pasteIntoSelection(): Promise<void> {
    const activeTab = this.getActiveTab();
    let osText: string | null = null;
    try {
      osText = await navigator.clipboard.readText();
    } catch {
      osText = null;
    }

    const targets = computePasteTargets(
      this.internalClipboard,
      osText,
      this.selection,
      this.originWeekStart
    );
    if (targets.length === 0) return;

    const changes: HistoryChange[] = [];
    for (const target of targets) {
      const before = await this.plugin.vaultSync.readMemo(
        activeTab,
        target.dateKey
      );
      // [ID 7.1.2] 기존 메모를 덮어쓰지 않고 아래에 이어붙임 (빈 셀 붙여넣기는 기존 메모 보존)
      const merged = mergeMemoContentForAppend(before, target.content);
      if (before !== merged) {
        changes.push({
          type: "content",
          tabId: activeTab.id,
          dateKey: target.dateKey,
          before,
          after: merged,
        });
        await this.plugin.vaultSync.writeMemo(
          activeTab,
          target.dateKey,
          merged
        );
      }
    }

    if (changes.length > 0) {
      this.undoHistory.push({ label: "붙여넣기(추가)", changes });
      this.updateUndoRedoButtons();
      new Notice(`${changes.length}개 날짜에 내용 추가 완료`);
    }
  }

  private async deleteSelectionContent(): Promise<void> {
    const activeTab = this.getActiveTab();
    const selected = getSelectedCells(this.selection, this.originWeekStart);
    const changes: HistoryChange[] = [];

    for (const cell of selected) {
      const before = await this.plugin.vaultSync.readMemo(
        activeTab,
        cell.dateKey
      );
      if (before.trim().length > 0) {
        changes.push({
          type: "content",
          tabId: activeTab.id,
          dateKey: cell.dateKey,
          before,
          after: "",
        });
        await this.plugin.vaultSync.writeMemo(activeTab, cell.dateKey, "");
      }
    }

    if (changes.length > 0) {
      this.undoHistory.push({ label: "셀 삭제", changes });
      this.updateUndoRedoButtons();
      new Notice(`${changes.length}개 날짜 메모 삭제됨`);
    }
  }

  private async applyColorToSelection(colorId: string): Promise<void> {
    const activeTab = this.getActiveTab();
    const selected = getSelectedCells(this.selection, this.originWeekStart);

    if (!this.plugin.settings.cellColors[activeTab.id]) {
      this.plugin.settings.cellColors[activeTab.id] = {};
    }
    const tabColors = this.plugin.settings.cellColors[activeTab.id];
    const changes: HistoryChange[] = [];

    for (const cell of selected) {
      const before = tabColors[cell.dateKey] ?? "";
      if (before === colorId) continue;

      changes.push({
        type: "color",
        tabId: activeTab.id,
        dateKey: cell.dateKey,
        before,
        after: colorId,
      });

      if (colorId) {
        tabColors[cell.dateKey] = colorId;
      } else {
        delete tabColors[cell.dateKey];
      }

      const cellEl = this.cellElements.get(cell.dateKey);
      if (cellEl) {
        this.applyCellColorClass(cellEl, activeTab.id, cell.dateKey);
      }
    }

    if (changes.length > 0) {
      this.undoHistory.push({ label: "배경색 변경", changes });
      this.updateUndoRedoButtons();
      await this.plugin.saveSettings();
    }
  }

  private async performUndo(): Promise<void> {
    const batch = this.undoHistory.popUndo();
    if (!batch) return;
    await this.applyHistoryChanges(batch.changes, "undo");
    this.updateUndoRedoButtons();
    new Notice(`실행 취소: ${batch.label}`);
  }

  private async performRedo(): Promise<void> {
    const batch = this.undoHistory.popRedo();
    if (!batch) return;
    await this.applyHistoryChanges(batch.changes, "redo");
    this.updateUndoRedoButtons();
    new Notice(`다시 실행: ${batch.label}`);
  }

  private async applyHistoryChanges(
    changes: HistoryChange[],
    direction: "undo" | "redo"
  ): Promise<void> {
    let colorDirty = false;
    const activeTabId = this.getActiveTab().id;

    for (const change of changes) {
      const value = direction === "undo" ? change.before : change.after;
      if (change.type === "content") {
        const tab = this.plugin.settings.tabs.find((t) => t.id === change.tabId);
        if (tab) {
          await this.plugin.vaultSync.writeMemo(tab, change.dateKey, value);
        }
      } else if (change.type === "color") {
        if (!this.plugin.settings.cellColors[change.tabId]) {
          this.plugin.settings.cellColors[change.tabId] = {};
        }
        if (value) {
          this.plugin.settings.cellColors[change.tabId][change.dateKey] = value;
        } else {
          delete this.plugin.settings.cellColors[change.tabId][change.dateKey];
        }
        colorDirty = true;
        if (change.tabId === activeTabId) {
          const cellEl = this.cellElements.get(change.dateKey);
          if (cellEl) {
            this.applyCellColorClass(cellEl, activeTabId, change.dateKey);
          }
        }
      }
    }

    if (colorDirty) {
      await this.plugin.saveSettings();
    }
  }

  private updateUndoRedoButtons(): void {
    if (!this.undoBtn || !this.redoBtn) return;
    this.undoBtn.disabled = !this.undoHistory.canUndo();
    this.redoBtn.disabled = !this.undoHistory.canRedo();
  }

  // ==========================================================================
  // [ID 7.5] 잘라내기(Cut) 및 미완료 할 일(- [ ]) 이월 (내일 / 다음 영업일)
  // ==========================================================================
  private async cutSelection(): Promise<void> {
    const activeTab = this.getActiveTab();
    const s = this.plugin.t();
    const selected = getSelectedCells(this.selection, this.originWeekStart);
    const bounds = getRectBounds(this.selection);

    const entries: Array<{
      dateKey: DateKey;
      relRow: number;
      relCol: number;
      content: string;
    }> = [];
    const changes: HistoryChange[] = [];

    for (const cell of selected) {
      const content = await this.plugin.vaultSync.readMemo(
        activeTab,
        cell.dateKey
      );
      entries.push({
        dateKey: cell.dateKey,
        relRow: cell.relRow,
        relCol: cell.relCol,
        content,
      });
      if (content.trim().length > 0) {
        changes.push({
          type: "content",
          tabId: activeTab.id,
          dateKey: cell.dateKey,
          before: content,
          after: "",
        });
        await this.plugin.vaultSync.writeMemo(activeTab, cell.dateKey, "");
      }
    }

    const externalText = formatExternalClipboardText(entries);
    this.internalClipboard = {
      width: bounds.maxCol - bounds.minCol + 1,
      height: bounds.maxRow - bounds.minRow + 1,
      cells: entries.map((e) => ({
        relRow: e.relRow,
        relCol: e.relCol,
        content: e.content,
      })),
      externalText,
    };

    try {
      await navigator.clipboard.writeText(externalText);
    } catch {
      // ignore
    }

    if (changes.length > 0) {
      this.undoHistory.push({ label: s.ctxCut, changes });
      this.updateUndoRedoButtons();
      new Notice(s.noticeCut(changes.length));
    }
  }

  private async carryOverIncompleteTasks(
    sourceDateKey: DateKey,
    mode: "tomorrow" | "nextBusinessDay"
  ): Promise<void> {
    const activeTab = this.getActiveTab();
    const s = this.plugin.t();
    const sourceContent = await this.plugin.vaultSync.readMemo(
      activeTab,
      sourceDateKey
    );
    const { remaining, movedTasks } = extractIncompleteTasks(sourceContent);

    if (movedTasks.length === 0) {
      new Notice(s.noticeNoIncompleteTasks);
      return;
    }

    let targetDateKey = addDays(sourceDateKey, 1);
    if (mode === "nextBusinessDay") {
      let guard = 0;
      while (
        !this.plugin.koreanCalendar.isBusinessDay(targetDateKey) &&
        guard < 30
      ) {
        targetDateKey = addDays(targetDateKey, 1);
        guard++;
      }
    }

    const targetBefore = await this.plugin.vaultSync.readMemo(
      activeTab,
      targetDateKey
    );
    const targetAfter = mergeMemoContentForAppend(
      targetBefore,
      movedTasks.join("\n")
    );

    const changes: HistoryChange[] = [
      {
        type: "content",
        tabId: activeTab.id,
        dateKey: sourceDateKey,
        before: sourceContent,
        after: remaining,
      },
      {
        type: "content",
        tabId: activeTab.id,
        dateKey: targetDateKey,
        before: targetBefore,
        after: targetAfter,
      },
    ];

    await this.plugin.vaultSync.writeMemo(activeTab, sourceDateKey, remaining);
    await this.plugin.vaultSync.writeMemo(activeTab, targetDateKey, targetAfter);

    this.undoHistory.push({
      label:
        mode === "tomorrow" ? s.ctxCarryTomorrow : s.ctxCarryNextBizDay,
      changes,
    });
    this.updateUndoRedoButtons();
    new Notice(s.noticeCarriedTasks(movedTasks.length, targetDateKey));
  }

  private showCellContextMenu(
    e: MouseEvent,
    dateKey: DateKey,
    cellEl: HTMLElement
  ): void {
    const activeTab = this.getActiveTab();
    const s = this.plugin.t();
    const selectedCells = getSelectedCells(this.selection, this.originWeekStart);
    const menu = new Menu();

    if (selectedCells.length > 1) {
      menu.addItem((item) =>
        item
          .setTitle(s.ctxBatchEdit(selectedCells.length))
          .setIcon("layers")
          .onClick(() =>
            this.openBatchPopover(
              selectedCells.map((c) => c.dateKey),
              cellEl
            )
          )
      );
    } else if (this.plugin.settings.tabs.length > 1) {
      menu.addItem((item) =>
        item
          .setTitle(s.ctxMultiCalendarInput)
          .setIcon("layers")
          .onClick(() => this.openBatchPopover([dateKey], cellEl, true))
      );
    }

    menu.addItem((item) =>
      item
        .setTitle(s.ctxEditPopover)
        .setIcon("edit-3")
        .onClick(() => this.openPopover(dateKey, cellEl))
    );

    menu.addItem((item) =>
      item
        .setTitle(s.ctxOpenAsNote)
        .setIcon("external-link")
        .onClick(async () => {
          const file = await this.plugin.vaultSync.ensureFileExists(
            activeTab,
            dateKey
          );
          await this.app.workspace.getLeaf(true).openFile(file);
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle(s.ctxCarryTomorrow)
        .setIcon("arrow-right-circle")
        .onClick(() => void this.carryOverIncompleteTasks(dateKey, "tomorrow"))
    );

    menu.addItem((item) =>
      item
        .setTitle(s.ctxCarryNextBizDay)
        .setIcon("briefcase")
        .onClick(
          () => void this.carryOverIncompleteTasks(dateKey, "nextBusinessDay")
        )
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle(s.ctxCopy)
        .setIcon("copy")
        .onClick(() => void this.copySelection())
    );

    menu.addItem((item) =>
      item
        .setTitle(s.ctxCut)
        .setIcon("scissors")
        .onClick(() => void this.cutSelection())
    );

    menu.addItem((item) =>
      item
        .setTitle(s.ctxPaste)
        .setIcon("clipboard-paste")
        .onClick(() => void this.pasteIntoSelection())
    );

    menu.addItem((item) =>
      item
        .setTitle(s.ctxDelete)
        .setIcon("trash-2")
        .onClick(() => void this.deleteSelectionContent())
    );

    menu.addSeparator();

    // 배경색 빠른 지정
    for (const preset of CELL_COLOR_PRESETS) {
      const label = s.colorLabels[preset.id] ?? preset.label;
      menu.addItem((item) =>
        item
          .setTitle(`${s.ctxBgColorPrefix}: ${label}`)
          .setIcon(preset.id ? "palette" : "eraser")
          .onClick(() => void this.applyColorToSelection(preset.id))
      );
    }

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle(s.ctxAddRecurringFromDate)
        .setIcon("repeat")
        .onClick(() => {
          new RecurringEventsModal(
            this.plugin,
            activeTab.id,
            dateKey,
            () => this.reloadAllRenderedCells()
          ).open();
        })
    );

    menu.showAtMouseEvent(e);
  }
}

