import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { LunarDisplayMode, UiLanguage } from "./types";
import {
  CustomHolidaysModal,
  RecurringEventsModal,
  TabConfigModal,
} from "./ui/modals";
import { getTodayKey } from "./calendar/dateUtils";
import type CalendarMemoPlugin from "./main";

// [ID 1.3] 플러그인 환경설정 탭
// -> 표시 언어(한국어/English/자동), 주 시작 요일, 음력 표시, 국가별 공휴일, 폴더 탭·반복 일정 관리를 제공함.

export class CalendarMemoSettingTab extends PluginSettingTab {
  private plugin: CalendarMemoPlugin;

  constructor(app: App, plugin: CalendarMemoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.t();

    containerEl.createEl("h2", { text: s.settingsTitle });

    // [ID 1.4.1] UI 표시 언어 선택 (자동 / 한국어 / English)
    new Setting(containerEl)
      .setName(s.settingLangName)
      .setDesc(s.settingLangDesc)
      .addDropdown((dd) =>
        dd
          .addOption("auto", s.settingLangAuto)
          .addOption("ko", "한국어 (Korean)")
          .addOption("en", "English")
          .setValue(this.plugin.settings.uiLanguage)
          .onChange(async (v) => {
            this.plugin.settings.uiLanguage = v as UiLanguage;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(s.settingWeekStartName)
      .setDesc(s.settingWeekStartDesc)
      .addDropdown((dd) =>
        dd
          .addOption("0", s.settingWeekStartSun)
          .addOption("1", s.settingWeekStartMon)
          .setValue(String(this.plugin.settings.weekStartsOn))
          .onChange(async (v) => {
            this.plugin.settings.weekStartsOn = v === "1" ? 1 : 0;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName(s.settingWeeksPerViewName)
      .setDesc(s.settingWeeksPerViewDesc)
      .addDropdown((dd) =>
        dd
          .addOption("4", s.lang === "en" ? "4 weeks (Larger cells)" : "4주 (셀 크게)")
          .addOption("5", s.lang === "en" ? "5 weeks (Standard)" : "5주 (표준 월간)")
          .addOption("6", s.lang === "en" ? "6 weeks (Compact)" : "6주 (넓게 조망)")
          .setValue(String(this.plugin.settings.visibleWeeksPerViewport))
          .onChange(async (v) => {
            this.plugin.settings.visibleWeeksPerViewport = Number(v) || 5;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName(s.settingLunarName)
      .setDesc(s.settingLunarDesc)
      .addDropdown((dd) =>
        dd
          .addOption("periodic", s.settingLunarPeriodic)
          .addOption("always", s.settingLunarAlways)
          .addOption("off", s.settingLunarOff)
          .setValue(this.plugin.settings.lunarDisplay)
          .onChange(async (v) => {
            this.plugin.settings.lunarDisplay = v as LunarDisplayMode;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName(s.settingAnnivName)
      .setDesc(s.settingAnnivDesc)
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.showAnniversaries)
          .onChange(async (v) => {
            this.plugin.settings.showAnniversaries = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          })
      );

    // [ID 2.5.4] 다국가 공휴일 선택 및 온디맨드 캐시 관리 UI
    containerEl.createEl("h3", { text: s.settingHolidaySection });

    const currentCountry = this.plugin.settings.holidayCountry || "KR";
    const cachedYears = Object.keys(
      this.plugin.settings.cachedCountryHolidays[currentCountry] ?? {}
    ).sort();

    const countryDesc =
      currentCountry === "KR"
        ? s.lang === "en"
          ? "South Korea holidays are built-in and work 100% offline."
          : "대한민국 공휴일은 플러그인에 내장되어 완전 오프라인으로 동작합니다."
        : currentCountry === "NONE"
          ? s.lang === "en"
            ? "Country holidays disabled (custom holidays remain active)."
            : "국가 공휴일 표시가 꺼져 있습니다. (커스텀 휴일은 계속 표시됩니다)"
          : cachedYears.length > 0
            ? s.lang === "en"
              ? `Using local cache from Nager.Date (cached years: ${cachedYears.join(", ")}) — works offline.`
              : `Nager.Date 무료 API에서 받아온 로컬 캐시 사용 중 (캐시된 연도: ${cachedYears.join(", ")}) — 이후 오프라인 동작`
            : s.lang === "en"
              ? "Fetches holidays once from date.nager.at and caches locally for offline use."
              : "해외 국가 선택 시 무료 API(date.nager.at)에서 해당 국가 공휴일만 1회 다운로드해 로컬 캐싱합니다.";

    new Setting(containerEl)
      .setName(s.settingCountryName)
      .setDesc(countryDesc)
      .addDropdown((dd) => {
        const hasCurrent = this.plugin.availableCountries.some(
          (c) => c.code === currentCountry
        );
        for (const c of this.plugin.availableCountries) {
          dd.addOption(c.code, c.name);
        }
        if (!hasCurrent) {
          dd.addOption(currentCountry, `${currentCountry}`);
        }
        dd.setValue(currentCountry).onChange(async (v) => {
          await this.plugin.setHolidayCountry(v);
          this.display();
        });
      })
      .addButton((btn) =>
        btn
          .setButtonText(s.settingLoadAllCountries)
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("...");
            try {
              const list = await this.plugin.loadAllCountriesFromNager();
              new Notice(`${list.length - 2} countries loaded.`);
              this.display();
            } catch {
              new Notice("Failed to load country list.");
              btn.setDisabled(false);
              btn.setButtonText(s.settingLoadAllCountries);
            }
          })
      );

    if (currentCountry !== "KR" && currentCountry !== "NONE") {
      new Setting(containerEl)
        .setName(s.settingLocalHolidayName)
        .setDesc(s.settingLocalHolidayDesc)
        .addToggle((tg) =>
          tg
            .setValue(this.plugin.settings.useLocalHolidayName)
            .onChange(async (v) => {
              this.plugin.settings.useLocalHolidayName = v;
              this.plugin.syncHolidayConfigToEngine();
              await this.plugin.saveSettings();
              this.plugin.refreshAllViews();
            })
        );

      new Setting(containerEl)
        .setName(s.settingCacheManage(currentCountry))
        .addButton((btn) =>
          btn.setButtonText(s.settingResyncBtn).onClick(async () => {
            const yr = new Date().getFullYear();
            await this.plugin.syncCountryHolidayYears(
              currentCountry,
              [yr - 1, yr, yr + 1, yr + 2],
              true,
              false
            );
            this.display();
          })
        )
        .addButton((btn) =>
          btn
            .setButtonText(s.settingClearCacheBtn)
            .setWarning()
            .onClick(async () => {
              await this.plugin.clearCountryHolidayCache(currentCountry);
              this.display();
            })
        );
    }

    // 폴더 탭 관리 섹션
    containerEl.createEl("h3", { text: s.settingTabsSection });

    for (const tab of this.plugin.settings.tabs) {
      new Setting(containerEl)
        .setName(tab.name)
        .setDesc(`${tab.folderPath || "(root)"} · ${tab.dateFormat}`)
        .addButton((btn) =>
          btn.setButtonText(s.settingEditBtn).onClick(() => {
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
                this.plugin.refreshAllViews();
                this.display();
              },
              async (deletedId) => {
                await this.plugin.deleteTab(deletedId);
                this.display();
              }
            ).open();
          })
        );
    }

    new Setting(containerEl)
      .setName(s.settingAddTabName)
      .setDesc(s.settingAddTabDesc)
      .addButton((btn) =>
        btn
          .setButtonText(s.settingAddTabBtn)
          .setCta()
          .onClick(() => {
            new TabConfigModal(this.plugin, null, async (created) => {
              this.plugin.settings.tabs.push(created);
              this.plugin.settings.activeTabId = created.id;
              await this.plugin.saveSettings();
              this.plugin.refreshAllViews();
              this.display();
            }).open();
          })
      );

    // 반복 일정 & 커스텀 휴일 바로가기
    containerEl.createEl("h3", { text: s.settingRecurringSection });

    new Setting(containerEl)
      .setName(s.modalRecurringTitle)
      .setDesc(`(${this.plugin.settings.recurringEvents.length})`)
      .addButton((btn) =>
        btn.setButtonText(s.settingOpenBtn).onClick(() => {
          new RecurringEventsModal(
            this.plugin,
            this.plugin.settings.activeTabId,
            getTodayKey(),
            () => {
              this.plugin.refreshAllViews();
              this.display();
            }
          ).open();
        })
      );

    new Setting(containerEl)
      .setName(s.modalHolidayTitle)
      .setDesc(`(${this.plugin.settings.customHolidays.length})`)
      .addButton((btn) =>
        btn.setButtonText(s.settingOpenBtn).onClick(() => {
          new CustomHolidaysModal(this.plugin, () => {
            this.plugin.refreshAllViews();
            this.display();
          }).open();
        })
      );
  }
}

