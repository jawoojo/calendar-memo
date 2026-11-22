import { Notice, Plugin, TFolder, WorkspaceLeaf } from "obsidian";
import {
  CalendarMemoSettings,
  CountryOption,
  DEFAULT_SETTINGS,
  DEFAULT_TAB_ID,
} from "./types";
import { KoreanCalendarService } from "./calendar/koreanCalendar";
import {
  CURATED_COUNTRIES,
  fetchNagerAvailableCountries,
  fetchNagerHolidaysForYear,
} from "./calendar/nagerHolidays";
import { VaultSyncManager } from "./storage/vaultSync";
import {
  CalendarMemoView,
  VIEW_TYPE_CALENDAR_MEMO,
} from "./ui/calendarView";
import { CalendarMemoSettingTab } from "./settings";
import { CustomHolidaysModal, RecurringEventsModal } from "./ui/modals";
import { getTodayKey, remapTabFolderPath } from "./calendar/dateUtils";

// [ID 1.2] Calendar Memo 플러그인 진입점 및 수명 주기 관리
// -> 리본 아이콘/단축키 원클릭 토글, 볼트 파일 실시간 감시, 한국형 캘린더 서비스 초기화를 담당함.

export default class CalendarMemoPlugin extends Plugin {
  settings: CalendarMemoSettings = DEFAULT_SETTINGS;
  koreanCalendar = new KoreanCalendarService();
  vaultSync!: VaultSyncManager;
  availableCountries: CountryOption[] = [...CURATED_COUNTRIES];

  private inFlightHolidayFetches = new Set<string>();
  private failedHolidayFetches = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.koreanCalendar.setCustomHolidays(this.settings.customHolidays);
    this.syncHolidayConfigToEngine();
    // [ID 2.5.2] 해외 국가 선택 후 미캐시 연도로 스크롤 시 백그라운드 1회 온디맨드 조회
    this.koreanCalendar.setMissingYearHandler((countryCode, year) => {
      const key = `${countryCode}:${year}`;
      if (
        this.inFlightHolidayFetches.has(key) ||
        this.failedHolidayFetches.has(key)
      ) {
        return;
      }
      void this.syncCountryHolidayYears(countryCode, [year], false, true);
    });
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
    // [ID 1.2.2] 열기 또는 이미 열려있으면 해당 캘린더 탭으로 즉시 포커스 이동
    // -> 다른 노트를 보다가 토글로 껐다 켜지 않고 단축키 한 번으로 캘린더 화면으로 바로 복귀하기 위함.
    this.addCommand({
      id: "open-or-focus-calendar-memo",
      name: "캘린더 메모장 열기 / 화면으로 이동",
      callback: () => void this.activateCalendarView(),
    });

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
        this.app.vault.on("rename", (file, oldPath) => {
          // [ID 4.6] 탐색기에서 폴더 이동/이름 변경 시 연결된 캘린더 탭 경로 자동 업데이트
          if (file instanceof TFolder) {
            void this.handleFolderRename(oldPath, file.path);
          }
          this.vaultSync.handleVaultFileEvent(file, "rename", oldPath);
        })
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
      popoverSize: loaded?.popoverSize
        ? { ...DEFAULT_SETTINGS.popoverSize, ...loaded.popoverSize }
        : { ...DEFAULT_SETTINGS.popoverSize },
      cellColors: loaded?.cellColors ? { ...loaded.cellColors } : {},
      recurringEvents: Array.isArray(loaded?.recurringEvents)
        ? loaded.recurringEvents
        : [],
      customHolidays: Array.isArray(loaded?.customHolidays)
        ? loaded.customHolidays
        : [],
      holidayCountry:
        typeof loaded?.holidayCountry === "string" && loaded.holidayCountry
          ? loaded.holidayCountry
          : DEFAULT_SETTINGS.holidayCountry,
      useLocalHolidayName:
        typeof loaded?.useLocalHolidayName === "boolean"
          ? loaded.useLocalHolidayName
          : DEFAULT_SETTINGS.useLocalHolidayName,
      cachedCountryHolidays:
        loaded?.cachedCountryHolidays &&
        typeof loaded.cachedCountryHolidays === "object"
          ? { ...loaded.cachedCountryHolidays }
          : {},
    };

    if (!this.settings.tabs.some((t) => t.id === this.settings.activeTabId)) {
      this.settings.activeTabId = this.settings.tabs[0]?.id ?? DEFAULT_TAB_ID;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  syncHolidayConfigToEngine(): void {
    this.koreanCalendar.setHolidayCountryConfig(
      this.settings.holidayCountry,
      this.settings.useLocalHolidayName,
      this.settings.cachedCountryHolidays
    );
  }

  /**
   * [ID 2.5.3] 공휴일 국가 변경 및 초기 연도(현재 연도 ±1~2년) 자동 동기화
   * -> KR은 기존 내장 오프라인 데이터를 그대로 쓰고, 해외 국가는 Nager.Date에서 1회 캐싱함.
   */
  async setHolidayCountry(countryCode: string): Promise<void> {
    const normalized = (countryCode || "KR").toUpperCase();
    this.settings.holidayCountry = normalized;
    this.failedHolidayFetches.clear();
    this.syncHolidayConfigToEngine();
    await this.saveSettings();
    this.refreshAllViews();

    if (normalized !== "KR" && normalized !== "NONE") {
      const currentYear = new Date().getFullYear();
      const targetYears = [
        currentYear - 1,
        currentYear,
        currentYear + 1,
        currentYear + 2,
      ];
      await this.syncCountryHolidayYears(normalized, targetYears, false, false);
    }
  }

  async syncCountryHolidayYears(
    countryCode: string,
    years: number[],
    force = false,
    silent = false
  ): Promise<number> {
    const code = countryCode.toUpperCase();
    if (code === "KR" || code === "NONE") return 0;

    if (!this.settings.cachedCountryHolidays[code]) {
      this.settings.cachedCountryHolidays[code] = {};
    }
    const countryBucket = this.settings.cachedCountryHolidays[code];

    const yearsToFetch = years.filter((y) => {
      const key = `${code}:${y}`;
      if (this.inFlightHolidayFetches.has(key)) return false;
      if (!force && countryBucket[String(y)]) return false;
      return true;
    });

    if (yearsToFetch.length === 0) return 0;

    let loadedCount = 0;
    let failedCount = 0;

    await Promise.all(
      yearsToFetch.map(async (year) => {
        const key = `${code}:${year}`;
        this.inFlightHolidayFetches.add(key);
        try {
          const entries = await fetchNagerHolidaysForYear(code, year);
          countryBucket[String(year)] = entries;
          this.failedHolidayFetches.delete(key);
          loadedCount++;
        } catch (err) {
          console.warn(
            `[calendar-memo] Failed to fetch holidays for ${code}/${year}:`,
            err
          );
          this.failedHolidayFetches.add(key);
          failedCount++;
        } finally {
          this.inFlightHolidayFetches.delete(key);
        }
      })
    );

    if (loadedCount > 0) {
      this.syncHolidayConfigToEngine();
      await this.saveSettings();
      this.refreshAllViews();
      if (!silent) {
        new Notice(
          `${code} 공휴일 ${loadedCount}개 연도를 로컬에 저장했습니다. (이후 오프라인 동작)`
        );
      }
    } else if (failedCount > 0 && !silent) {
      new Notice(
        `${code} 공휴일 정보를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.`
      );
    }

    return loadedCount;
  }

  async loadAllCountriesFromNager(): Promise<CountryOption[]> {
    const list = await fetchNagerAvailableCountries();
    this.availableCountries = list;
    return list;
  }

  async clearCountryHolidayCache(countryCode?: string): Promise<void> {
    if (countryCode) {
      delete this.settings.cachedCountryHolidays[countryCode.toUpperCase()];
    } else {
      this.settings.cachedCountryHolidays = {};
    }
    this.failedHolidayFetches.clear();
    this.syncHolidayConfigToEngine();
    await this.saveSettings();
    this.refreshAllViews();
  }

  /**
   * [ID 4.6] 탐색기 폴더 이동·이름 변경 시 연결된 캘린더 탭들의 folderPath를 자동 갱신함.
   * -> 상위 폴더를 통째로 옮긴 경우 하위 폴더 이벤트에서 중복 변환되지 않도록 변경 즉시 설정에 반영함.
   */
  private async handleFolderRename(
    oldPath: string,
    newPath: string
  ): Promise<void> {
    const updatedTabs: Array<{ name: string; nextPath: string }> = [];

    for (const tab of this.settings.tabs) {
      const remapped = remapTabFolderPath(tab.folderPath, oldPath, newPath);
      if (remapped !== null) {
        tab.folderPath = remapped;
        this.vaultSync.invalidateTabCache(tab.id);
        updatedTabs.push({ name: tab.name, nextPath: remapped });
      }
    }

    if (updatedTabs.length === 0) return;

    await this.saveSettings();
    this.refreshAllViews();

    if (updatedTabs.length === 1) {
      const only = updatedTabs[0];
      new Notice(
        `Calendar Memo: "${only.name}" 탭 경로가 "${only.nextPath}"(으)로 자동 업데이트되었습니다.`
      );
    } else {
      new Notice(
        `Calendar Memo: ${updatedTabs.length}개 탭의 폴더 경로가 자동 업데이트되었습니다.`
      );
    }
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
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof CalendarMemoView) {
      leaf.view.focusGrid();
      return leaf.view;
    }
    return null;
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

