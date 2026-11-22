import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { LunarDisplayMode } from "./types";
import {
  CustomHolidaysModal,
  RecurringEventsModal,
  TabConfigModal,
} from "./ui/modals";
import { getTodayKey } from "./calendar/dateUtils";
import type CalendarMemoPlugin from "./main";

// [ID 1.3] 플러그인 환경설정 탭
// -> 주 시작 요일, 음력 표시, 기념일 표시, 뷰포트 주 수, 폴더 탭·반복 일정·커스텀 휴일 관리를 제공함.

export class CalendarMemoSettingTab extends PluginSettingTab {
  private plugin: CalendarMemoPlugin;

  constructor(app: App, plugin: CalendarMemoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Calendar Memo 설정" });

    new Setting(containerEl)
      .setName("주 시작 요일")
      .setDesc("달력의 첫 번째 열에 표시할 요일을 선택합니다.")
      .addDropdown((dd) =>
        dd
          .addOption("0", "일요일 시작 (일~토)")
          .addOption("1", "월요일 시작 (월~일)")
          .setValue(String(this.plugin.settings.weekStartsOn))
          .onChange(async (v) => {
            this.plugin.settings.weekStartsOn = v === "1" ? 1 : 0;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName("한 화면에 표시할 주(Row) 수")
      .setDesc("연속 스크롤 캘린더 뷰포트 높이에 맞춰 표시되는 기본 주 수입니다.")
      .addDropdown((dd) =>
        dd
          .addOption("4", "4주 (셀 크게)")
          .addOption("5", "5주 (표준 월간)")
          .addOption("6", "6주 (넓게 조망)")
          .setValue(String(this.plugin.settings.visibleWeeksPerViewport))
          .onChange(async (v) => {
            this.plugin.settings.visibleWeeksPerViewport = Number(v) || 5;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName("음력 날짜 표시")
      .setDesc("오프라인 내장 음력 엔진으로 음력 날짜를 셀 상단에 표시합니다.")
      .addDropdown((dd) =>
        dd
          .addOption("periodic", "매월 음력 1일 · 15일 표시 (권장)")
          .addOption("always", "매일 표시")
          .addOption("off", "표시 안 함")
          .setValue(this.plugin.settings.lunarDisplay)
          .onChange(async (v) => {
            this.plugin.settings.lunarDisplay = v as LunarDisplayMode;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName("한국 주요 기념일 표시")
      .setDesc(
        "공휴일 국가가 대한민국(KR)일 때 어버이날, 스승의날, 정월대보름 등 주요 기념일을 표시합니다."
      )
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
    containerEl.createEl("h3", { text: "국가별 공휴일 (Holidays by Country)" });

    const currentCountry = this.plugin.settings.holidayCountry || "KR";
    const cachedYears = Object.keys(
      this.plugin.settings.cachedCountryHolidays[currentCountry] ?? {}
    ).sort();

    const countryDesc =
      currentCountry === "KR"
        ? "대한민국 공휴일은 플러그인에 내장되어 완전 오프라인으로 동작합니다."
        : currentCountry === "NONE"
          ? "국가 공휴일 표시가 꺼져 있습니다. (커스텀 휴일은 계속 표시됩니다)"
          : cachedYears.length > 0
            ? `Nager.Date 무료 API에서 받아온 로컬 캐시 사용 중 (캐시된 연도: ${cachedYears.join(", ")}) — 이후 오프라인 동작`
            : "해외 국가 선택 시 무료 API(date.nager.at)에서 해당 국가 공휴일만 1회 다운로드해 로컬 캐싱합니다.";

    new Setting(containerEl)
      .setName("공휴일 국가 선택")
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
          .setButtonText("전체 국가(110+) 불러오기")
          .setTooltip("Nager.Date에서 지원하는 전 세계 110개국 이상 목록을 가져옵니다.")
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("불러오는 중...");
            try {
              const list = await this.plugin.loadAllCountriesFromNager();
              new Notice(`${list.length - 2}개 국가 목록을 불러왔습니다.`);
              this.display();
            } catch {
              new Notice("전체 국가 목록을 불러오지 못했습니다. 인터넷 연결을 확인하세요.");
              btn.setDisabled(false);
              btn.setButtonText("전체 국가(110+) 불러오기");
            }
          })
      );

    if (currentCountry !== "KR" && currentCountry !== "NONE") {
      new Setting(containerEl)
        .setName("해외 공휴일 현지어 이름 사용")
        .setDesc("켜면 현지어(예: 元日), 끄면 영문명(예: New Year's Day)으로 표시합니다.")
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
        .setName(`${currentCountry} 공휴일 캐시 관리`)
        .setDesc("최신 연도 공휴일을 다시 받아오거나 저장된 캐시를 비울 수 있습니다.")
        .addButton((btn) =>
          btn.setButtonText("지금 다시 동기화").onClick(async () => {
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
            .setButtonText("캐시 비우기")
            .setWarning()
            .onClick(async () => {
              await this.plugin.clearCountryHolidayCache(currentCountry);
              new Notice(`${currentCountry} 공휴일 캐시를 비웠습니다.`);
              this.display();
            })
        );
    }

    // 폴더 탭 관리 섹션
    containerEl.createEl("h3", { text: "캘린더 폴더 탭" });

    for (const tab of this.plugin.settings.tabs) {
      new Setting(containerEl)
        .setName(tab.name)
        .setDesc(
          `폴더: ${tab.folderPath || "(볼트 루트)"} · 파일 포맷: ${tab.dateFormat}`
        )
        .addButton((btn) =>
          btn.setButtonText("편집").onClick(() => {
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
      .setName("새 폴더 탭 추가")
      .setDesc("다른 폴더의 날짜 노트들을 별도 탭으로 전환해 볼 수 있습니다.")
      .addButton((btn) =>
        btn
          .setButtonText("폴더 탭 추가")
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
    containerEl.createEl("h3", { text: "반복 일정 및 커스텀 휴일" });

    new Setting(containerEl)
      .setName("반복 일정 관리")
      .setDesc(
        `현재 ${this.plugin.settings.recurringEvents.length}개의 반복 일정이 등록되어 있습니다.`
      )
      .addButton((btn) =>
        btn.setButtonText("열기").onClick(() => {
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
      .setName("커스텀 휴일 · 기념일 관리")
      .setDesc(
        `현재 ${this.plugin.settings.customHolidays.length}개의 커스텀 항목이 등록되어 있습니다.`
      )
      .addButton((btn) =>
        btn.setButtonText("열기").onClick(() => {
          new CustomHolidaysModal(this.plugin, () => {
            this.plugin.refreshAllViews();
            this.display();
          }).open();
        })
      );
  }
}

