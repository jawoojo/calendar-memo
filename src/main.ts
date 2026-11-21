import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  CalendarMemoSettings,
  DEFAULT_SETTINGS,
  DEFAULT_TAB_ID,
} from "./types";
import { KoreanCalendarService } from "./calendar/koreanCalendar";
import { VaultSyncManager } from "./storage/vaultSync";
import {
  CalendarMemoView,
  VIEW_TYPE_CALENDAR_MEMO,
} from "./ui/calendarView";
import { CalendarMemoSettingTab } from "./settings";
import { CustomHolidaysModal, RecurringEventsModal } from "./ui/modals";
import { getTodayKey } from "./calendar/dateUtils";

// [ID 1.2] Calendar Memo 플러그인 진입점 및 수명 주기 관리
// -> 리본 아이콘/단축키 원클릭 토글, 볼트 파일 실시간 감시, 한국형 캘린더 서비스 초기화를 담당함.

export default class CalendarMemoPlugin extends Plugin {
  settings: CalendarMemoSettings = DEFAULT_SETTINGS;
  koreanCalendar = new KoreanCalendarService();
  vaultSync!: VaultSyncManager;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.koreanCalendar.setCustomHolidays(this.settings.customHolidays);
    this.vaultSync = new VaultSyncManager(this.app, () => this.settings.tabs);

    this.registerView(
      VIEW_TYPE_CALENDAR_MEMO,
      (leaf: WorkspaceLeaf) => new CalendarMemoView(leaf, this)
    );

    // [ID 1.2.1] 리본 아이콘 클릭 한 번으로 캘린더 뷰 열기/닫기 토글
    this.addRibbonIcon("calendar-days", "Calendar Memo 열기/닫기", () => {
      void this.toggleCalendarView();
    });

    // 명령어 등록 (단축키 커스터마이징 지원)
    this.addCommand({
      id: "toggle-calendar-memo",
      name: "캘린더 메모장 열기/닫기 (토글)",
      callback: () => void this.toggleCalendarView(),
    });

    this.addCommand({
      id: "open-today-memo-popover",
      name: "오늘 날짜 메모 팝오버 바로 열기",
      callback: async () => {
        const view = await this.activateCalendarView();
        view?.openPopoverForDate(getTodayKey());
      },
    });

    this.addCommand({
      id: "manage-recurring-events",
      name: "반복 일정 관리 열기",
      callback: () => {
        new RecurringEventsModal(
          this,
          this.settings.activeTabId,
          getTodayKey(),
          () => this.refreshAllViews()
        ).open();
      },
    });

    this.addCommand({
      id: "manage-custom-holidays",
      name: "커스텀 휴일 · 기념일 관리 열기",
      callback: () => {
        new CustomHolidaysModal(this, () => this.refreshAllViews()).open();
      },
    });

    // [ID 4.5] 볼트 파일 변경 실시간 감시 -> 캘린더 양방향 동기화
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) =>
          this.vaultSync.handleVaultFileEvent(file, "create")
        )
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) =>
          this.vaultSync.handleVaultFileEvent(file, "modify")
        )
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) =>
          this.vaultSync.handleVaultFileEvent(file, "delete")
        )
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) =>
          this.vaultSync.handleVaultFileEvent(file, "rename", oldPath)
        )
      );
    });

    this.addSettingTab(new CalendarMemoSettingTab(this.app, this));
  }

  onunload(): void {
    // Obsidian이 뷰를 자동 해제하므로 detachLeavesOfType을 강제 호출하지 않음
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<CalendarMemoSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(loaded ?? {}),
      tabs:
        loaded?.tabs && loaded.tabs.length > 0
          ? loaded.tabs
          : DEFAULT_SETTINGS.tabs.map((t) => ({ ...t })),
      cellColors: loaded?.cellColors ? { ...loaded.cellColors } : {},
      recurringEvents: Array.isArray(loaded?.recurringEvents)
        ? loaded.recurringEvents
        : [],
      customHolidays: Array.isArray(loaded?.customHolidays)
        ? loaded.customHolidays
        : [],
    };

    if (!this.settings.tabs.some((t) => t.id === this.settings.activeTabId)) {
      this.settings.activeTabId = this.settings.tabs[0]?.id ?? DEFAULT_TAB_ID;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async deleteTab(tabId: string): Promise<void> {
    if (this.settings.tabs.length <= 1) return;
    this.settings.tabs = this.settings.tabs.filter((t) => t.id !== tabId);
    delete this.settings.cellColors[tabId];
    if (this.settings.activeTabId === tabId) {
      this.settings.activeTabId = this.settings.tabs[0].id;
    }
    this.vaultSync.invalidateTabCache(tabId);
    await this.saveSettings();
    this.refreshAllViews();
  }

  /**
   * 캘린더 뷰가 이미 열려 있으면 닫고, 닫혀 있으면 새 메인 탭에 즉시 염.
   */
  async toggleCalendarView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR_MEMO);
    if (existing.length > 0) {
      for (const leaf of existing) {
        leaf.detach();
      }
      return;
    }
    await this.activateCalendarView();
  }

  async activateCalendarView(): Promise<CalendarMemoView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR_MEMO);
    let leaf: WorkspaceLeaf;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: VIEW_TYPE_CALENDAR_MEMO,
        active: true,
      });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof CalendarMemoView ? leaf.view : null;
  }

  refreshAllViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR_MEMO);
    for (const leaf of leaves) {
      if (leaf.view instanceof CalendarMemoView) {
        leaf.view.refreshView();
      }
    }
  }
}

