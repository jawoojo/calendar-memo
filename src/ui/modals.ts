import { App, Modal, Notice, Setting } from "obsidian";
import {
  CELL_COLOR_PRESETS,
  CalendarTab,
  CustomHoliday,
  DateKey,
  RecurringEvent,
  RecurringFrequency,
} from "../types";
import {
  buildNotePath,
  getTodayKey,
  normalizeFolderPath,
} from "../calendar/dateUtils";
import { describeRecurringEvent } from "../calendar/recurringEvents";
import type CalendarMemoPlugin from "../main";

// [ID 8.1] 폴더 탭 추가/편집, 반복 일정 관리, 커스텀 휴일 관리 모달 UI
// -> 캘린더 상단 바에서 즉시 접근해 폴더 탭 전환, 반복 일정 등록, 커스텀 공휴일 추가를 수행할 수 있도록 구성함.

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/**
 * 옵시디언 코어 Daily Notes 플러그인 설정(폴더·날짜 포맷)을 읽어오는 헬퍼.
 */
function readCoreDailyNotesConfig(
  app: App
): { folder: string; format: string } | null {
  try {
    const internalPlugins = (
      app as unknown as {
        internalPlugins?: {
          getPluginById?: (id: string) => {
            instance?: {
              options?: { folder?: string; format?: string };
            };
          };
        };
      }
    ).internalPlugins;
    const dailyPlugin = internalPlugins?.getPluginById?.("daily-notes");
    const opts = dailyPlugin?.instance?.options;
    if (!opts) return null;
    return {
      folder: normalizeFolderPath(opts.folder ?? ""),
      format: (opts.format ?? "YYYY-MM-DD").trim() || "YYYY-MM-DD",
    };
  } catch {
    return null;
  }
}

// ============================================================================
// [ID 8.2] 폴더 탭 추가 / 편집 모달
// -> 폴더 경로 미입력 시 '볼트 상단에 탭 이름으로 새 폴더 생성' vs '볼트 최상단(루트) 직접 저장'을 선택할 수 있음.
// ============================================================================
function sanitizeFolderName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/^\.+|\.+$/g, "");
}

export class TabConfigModal extends Modal {
  private plugin: CalendarMemoPlugin;
  private existingTab: CalendarTab | null;
  private onSaved: (tab: CalendarTab) => void;
  private onDeleted?: (tabId: string) => void;

  private nameValue: string;
  private folderValue: string;
  private formatValue: string;
  private emptyFolderMode: "create-by-tab-name" | "vault-root";

  constructor(
    plugin: CalendarMemoPlugin,
    existingTab: CalendarTab | null,
    onSaved: (tab: CalendarTab) => void,
    onDeleted?: (tabId: string) => void
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.existingTab = existingTab;
    this.onSaved = onSaved;
    this.onDeleted = onDeleted;

    this.nameValue = existingTab?.name ?? "";
    this.folderValue = existingTab?.folderPath ?? "";
    this.formatValue = existingTab?.dateFormat ?? "YYYY-MM-DD";
    // 기존 탭이 이미 루트("")를 사용 중이면 vault-root 유지, 새 탭은 탭 이름 폴더 생성을 기본 추천
    this.emptyFolderMode =
      existingTab && existingTab.folderPath === ""
        ? "vault-root"
        : "create-by-tab-name";
  }

  private resolveEffectiveFolderPath(): string {
    const manual = normalizeFolderPath(this.folderValue);
    if (manual) return manual;
    if (this.emptyFolderMode === "create-by-tab-name") {
      return sanitizeFolderName(this.nameValue) || "새 캘린더";
    }
    return "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cm-modal");

    contentEl.createEl("h2", {
      text: this.existingTab ? "캘린더 폴더 탭 편집" : "새 폴더 탭 추가",
    });

    const previewEl = contentEl.createDiv({ cls: "cm-format-preview" });
    let emptyFolderSettingEl: HTMLElement | null = null;

    const updatePreview = () => {
      const effectiveFolder = this.resolveEffectiveFolderPath();
      const sample = buildNotePath(
        effectiveFolder,
        this.formatValue || "YYYY-MM-DD",
        getTodayKey()
      );
      previewEl.setText(`오늘 파일 경로 미리보기: ${sample}`);
      if (emptyFolderSettingEl) {
        // 폴더 경로가 비어 있을 때만 미입력 동작 선택지를 활성화 표시
        emptyFolderSettingEl.style.display =
          normalizeFolderPath(this.folderValue) === "" ? "" : "none";
      }
    };

    new Setting(contentEl)
      .setName("탭 이름")
      .setDesc("캘린더 상단 탭 바에 표시될 이름 (예: 업무, 일기, 프로젝트)")
      .addText((text) =>
        text
          .setPlaceholder("예: 업무")
          .setValue(this.nameValue)
          .onChange((v) => {
            this.nameValue = v;
            updatePreview();
          })
      );

    // 볼트 폴더 자동완성용 datalist
    const datalistId = `cm-folders-${Date.now()}`;
    const datalist = contentEl.createEl("datalist", { attr: { id: datalistId } });
    for (const folder of this.plugin.vaultSync.getAllVaultFolders()) {
      datalist.createEl("option", { attr: { value: folder } });
    }

    let folderInputEl: HTMLInputElement | null = null;
    let formatInputEl: HTMLInputElement | null = null;

    new Setting(contentEl)
      .setName("폴더 경로")
      .setDesc(
        "날짜별 .md 파일이 저장·조회될 볼트 내 경로 (비워두면 아래 미입력 옵션을 따름)"
      )
      .addText((text) => {
        folderInputEl = text.inputEl;
        text.inputEl.setAttribute("list", datalistId);
        text
          .setPlaceholder("예: Daily Notes 또는 Work/Calendar (비워두기 가능)")
          .setValue(this.folderValue)
          .onChange((v) => {
            this.folderValue = v;
            updatePreview();
          });
      });

    // [ID 8.2.1] 폴더 경로 미입력 시 저장 위치 선택 (볼트 최상단 vs 탭 이름으로 새 폴더 생성)
    const emptyFolderSetting = new Setting(contentEl)
      .setName("폴더 경로 미입력 시 위치")
      .setDesc(
        "폴더 경로를 비워두었을 때 볼트 최상단에 바로 저장할지, 탭 이름으로 새 폴더를 만들지 선택합니다."
      )
      .addDropdown((dd) =>
        dd
          .addOption(
            "create-by-tab-name",
            "볼트 상단에 탭 이름으로 새 폴더 생성"
          )
          .addOption("vault-root", "볼트 최상단(루트)에 바로 저장")
          .setValue(this.emptyFolderMode)
          .onChange((v) => {
            this.emptyFolderMode = v as "create-by-tab-name" | "vault-root";
            updatePreview();
          })
      );
    emptyFolderSettingEl = emptyFolderSetting.settingEl;

    new Setting(contentEl)
      .setName("날짜 파일명 포맷")
      .setDesc(
        "옵시디언 데일리 노트 호환 Moment 포맷 (예: YYYY-MM-DD, YYYY/MM/YYYY-MM-DD, YYYY-MM-DD (ddd))"
      )
      .addText((text) => {
        formatInputEl = text.inputEl;
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.formatValue)
          .onChange((v) => {
            this.formatValue = v;
            updatePreview();
          });
      });

    // 옵시디언 기본 데일리 노트 설정 불러오기 도우미
    const dailyCfg = readCoreDailyNotesConfig(this.app);
    if (dailyCfg) {
      new Setting(contentEl)
        .setName("옵시디언 데일리 노트 설정 가져오기")
        .setDesc(
          `현재 데일리 노트: 폴더 "${dailyCfg.folder || "(루트)"}" / 포맷 "${dailyCfg.format}"`
        )
        .addButton((btn) =>
          btn.setButtonText("불러오기").onClick(() => {
            this.folderValue = dailyCfg.folder;
            this.formatValue = dailyCfg.format;
            if (!dailyCfg.folder) {
              this.emptyFolderMode = "vault-root";
            }
            if (folderInputEl) folderInputEl.value = this.folderValue;
            if (formatInputEl) formatInputEl.value = this.formatValue;
            if (!this.nameValue.trim()) {
              this.nameValue = dailyCfg.folder.split("/").pop() || "데일리 노트";
            }
            updatePreview();
            new Notice("데일리 노트 설정을 불러왔습니다.");
          })
        );
    }

    updatePreview();

    const footer = contentEl.createDiv({ cls: "cm-modal-footer" });

    if (this.existingTab && this.plugin.settings.tabs.length > 1) {
      const delBtn = footer.createEl("button", {
        text: "탭 삭제",
        cls: "mod-warning",
      });
      delBtn.addEventListener("click", () => {
        if (this.existingTab && this.onDeleted) {
          this.onDeleted(this.existingTab.id);
        }
        this.close();
      });
    }

    const spacer = footer.createDiv({ cls: "cm-spacer" });
    void spacer;

    const cancelBtn = footer.createEl("button", { text: "취소" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = footer.createEl("button", {
      text: "저장",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", async () => {
      const manualFolder = normalizeFolderPath(this.folderValue);
      const trimmedName =
        this.nameValue.trim() ||
        manualFolder.split("/").pop() ||
        "캘린더";

      let normalizedFolder = manualFolder;
      if (!normalizedFolder && this.emptyFolderMode === "create-by-tab-name") {
        normalizedFolder = sanitizeFolderName(trimmedName) || "캘린더";
        await this.plugin.vaultSync.ensureFolderExists(normalizedFolder);
      }

      const trimmedFormat = this.formatValue.trim() || "YYYY-MM-DD";

      const tab: CalendarTab = this.existingTab
        ? {
            ...this.existingTab,
            name: trimmedName,
            folderPath: normalizedFolder,
            dateFormat: trimmedFormat,
          }
        : {
            id: generateId("tab"),
            name: trimmedName,
            folderPath: normalizedFolder,
            dateFormat: trimmedFormat,
          };

      this.onSaved(tab);
      this.close();
    });
  }
}

// ============================================================================
// [ID 8.3] 반복 일정 관리 모달 (목록 조회 + 추가/편집/삭제)
// ============================================================================
export class RecurringEventsModal extends Modal {
  private plugin: CalendarMemoPlugin;
  private defaultStartDate: DateKey;
  private activeTabId: string;
  private onUpdated: () => void;
  private editingEvent: RecurringEvent | null = null;

  constructor(
    plugin: CalendarMemoPlugin,
    activeTabId: string,
    defaultStartDate: DateKey,
    onUpdated: () => void,
    initialEditEvent?: RecurringEvent
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.activeTabId = activeTabId;
    this.defaultStartDate = defaultStartDate;
    this.onUpdated = onUpdated;
    this.editingEvent = initialEditEvent ?? null;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cm-modal", "cm-recurring-modal");

    contentEl.createEl("h2", { text: "반복 일정 관리" });

    // 1) 추가/편집 폼
    this.renderForm(contentEl);

    // 2) 등록된 반복 일정 목록
    contentEl.createEl("h3", {
      text: `등록된 반복 일정 (${this.plugin.settings.recurringEvents.length})`,
      cls: "cm-section-heading",
    });

    const listEl = contentEl.createDiv({ cls: "cm-list-box" });
    if (this.plugin.settings.recurringEvents.length === 0) {
      listEl.createDiv({
        cls: "cm-empty-hint",
        text: "등록된 반복 일정이 없습니다. 위에서 새 반복 일정을 추가해 보세요.",
      });
      return;
    }

    for (const ev of this.plugin.settings.recurringEvents) {
      const row = listEl.createDiv({ cls: "cm-list-row" });
      const info = row.createDiv({ cls: "cm-list-info" });

      const titleLine = info.createDiv({ cls: "cm-list-title" });
      if (ev.color) {
        const dot = titleLine.createSpan({ cls: `cm-color-dot cm-dot-${ev.color}` });
        void dot;
      }
      titleLine.createSpan({ text: ev.title });

      const tabName =
        ev.scope === "all"
          ? "모든 탭 공통"
          : this.plugin.settings.tabs.find((t) => t.id === ev.tabId)?.name ??
            "특정 탭";
      const endLabel = ev.endDate ? ` ~ ${ev.endDate}` : "";
      info.createDiv({
        cls: "cm-list-sub",
        text: `${describeRecurringEvent(ev)} · ${tabName} · ${ev.startDate}${endLabel}`,
      });

      const actions = row.createDiv({ cls: "cm-list-actions" });
      const editBtn = actions.createEl("button", { text: "편집" });
      editBtn.addEventListener("click", () => {
        this.editingEvent = ev;
        this.render();
      });

      const delBtn = actions.createEl("button", {
        text: "삭제",
        cls: "mod-warning",
      });
      delBtn.addEventListener("click", async () => {
        this.plugin.settings.recurringEvents =
          this.plugin.settings.recurringEvents.filter((item) => item.id !== ev.id);
        if (this.editingEvent?.id === ev.id) {
          this.editingEvent = null;
        }
        await this.plugin.saveSettings();
        this.onUpdated();
        this.render();
      });
    }
  }

  private renderForm(containerEl: HTMLElement): void {
    const formBox = containerEl.createDiv({ cls: "cm-form-box" });
    const editing = this.editingEvent;

    let title = editing?.title ?? "";
    let frequency: RecurringFrequency = editing?.frequency ?? "weekly";
    let weekdays = new Set<number>(editing?.weekdays ?? [1]);
    let monthOfYear =
      editing?.monthOfYear ?? Number(this.defaultStartDate.slice(5, 7));
    let dayOfMonth =
      editing?.dayOfMonth ?? Number(this.defaultStartDate.slice(8, 10));
    let businessDayMode: "every" | "nth" | "last" =
      editing?.businessDayNth === -1
        ? "last"
        : (editing?.businessDayNth ?? 0) > 0
          ? "nth"
          : "every";
    let businessDayNth =
      editing?.businessDayNth && editing.businessDayNth > 0
        ? editing.businessDayNth
        : 1;
    let scope: "all" | "tab" = editing?.scope ?? "tab";
    let tabId = editing?.tabId ?? this.activeTabId;
    let startDate = editing?.startDate ?? this.defaultStartDate;
    let endDate = editing?.endDate ?? "";
    let color = editing?.color ?? "blue";

    new Setting(formBox).setName("일정 제목").addText((t) =>
      t
        .setPlaceholder("예: 주간 회의, 급여일, 월세 납부")
        .setValue(title)
        .onChange((v) => {
          title = v;
        })
    );

    const dynamicArea = formBox.createDiv({ cls: "cm-dynamic-fields" });

    const renderDynamicFields = () => {
      dynamicArea.empty();
      if (frequency === "weekly") {
        const setting = new Setting(dynamicArea).setName("반복 요일");
        const dayWrap = setting.controlEl.createDiv({ cls: "cm-weekday-picker" });
        const labels = ["일", "월", "화", "수", "목", "금", "토"];
        labels.forEach((lbl, idx) => {
          const btn = dayWrap.createEl("button", {
            text: lbl,
            cls: `cm-weekday-btn ${weekdays.has(idx) ? "is-active" : ""}`,
            attr: { type: "button" },
          });
          btn.addEventListener("click", () => {
            if (weekdays.has(idx)) {
              weekdays.delete(idx);
              btn.removeClass("is-active");
            } else {
              weekdays.add(idx);
              btn.addClass("is-active");
            }
          });
        });
      } else if (frequency === "monthly") {
        new Setting(dynamicArea)
          .setName("매월 일자 (1~31)")
          .setDesc("31일 설정 시 2월·4월 등 짧은 달에는 해당 월의 말일에 표시됩니다.")
          .addText((t) =>
            t.setValue(String(dayOfMonth)).onChange((v) => {
              const num = Number(v);
              if (num >= 1 && num <= 31) dayOfMonth = num;
            })
          );
      } else if (frequency === "yearly") {
        new Setting(dynamicArea)
          .setName("매년 월 / 일")
          .setDesc("생일·기념일·연간 갱신일 등에 사용합니다. (2월 29일은 평년에 2월 28일로 보정)")
          .addText((t) =>
            t
              .setPlaceholder("월 (1~12)")
              .setValue(String(monthOfYear))
              .onChange((v) => {
                const num = Number(v);
                if (num >= 1 && num <= 12) monthOfYear = num;
              })
          )
          .addText((t) =>
            t
              .setPlaceholder("일 (1~31)")
              .setValue(String(dayOfMonth))
              .onChange((v) => {
                const num = Number(v);
                if (num >= 1 && num <= 31) dayOfMonth = num;
              })
          );
      } else if (frequency === "businessDay") {
        new Setting(dynamicArea)
          .setName("영업일 규칙")
          .setDesc("토·일요일과 한국 법정·대체공휴일, 커스텀 공휴일을 자동 제외합니다.")
          .addDropdown((dd) =>
            dd
              .addOption("every", "매 영업일 (평일 중 공휴일 제외)")
              .addOption("nth", "매월 N번째 영업일")
              .addOption("last", "매월 마지막 영업일")
              .setValue(businessDayMode)
              .onChange((v) => {
                businessDayMode = v as "every" | "nth" | "last";
                renderDynamicFields();
              })
          );

        if (businessDayMode === "nth") {
          new Setting(dynamicArea)
            .setName("N번째 영업일 (1~23)")
            .addText((t) =>
              t.setValue(String(businessDayNth)).onChange((v) => {
                const n = Number(v);
                if (n >= 1 && n <= 23) businessDayNth = n;
              })
            );
        }
      }
    };

    new Setting(formBox).setName("반복 주기").addDropdown((dd) =>
      dd
        .addOption("daily", "매일")
        .addOption("weekly", "매주 (요일 지정)")
        .addOption("monthly", "매월 (일자 지정)")
        .addOption("yearly", "매년 (월·일 지정)")
        .addOption("businessDay", "영업일 기준")
        .setValue(frequency)
        .onChange((v) => {
          frequency = v as RecurringFrequency;
          renderDynamicFields();
        })
    );

    renderDynamicFields();

    const scopeSetting = new Setting(formBox)
      .setName("표시 범위")
      .addDropdown((dd) =>
        dd
          .addOption("tab", "현재 탭 전용")
          .addOption("all", "모든 탭 공통")
          .setValue(scope)
          .onChange((v) => {
            scope = v as "all" | "tab";
            tabDropdownWrap.style.display = scope === "tab" ? "" : "none";
          })
      );
    void scopeSetting;

    const tabDropdownWrap = formBox.createDiv();
    tabDropdownWrap.style.display = scope === "tab" ? "" : "none";
    new Setting(tabDropdownWrap).setName("대상 폴더 탭").addDropdown((dd) => {
      for (const tab of this.plugin.settings.tabs) {
        dd.addOption(tab.id, tab.name);
      }
      dd.setValue(tabId).onChange((v) => {
        tabId = v;
      });
    });

    new Setting(formBox)
      .setName("시작일 / 종료일 (선택)")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(startDate).onChange((v) => {
          if (v) startDate = v;
        });
      })
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(endDate).onChange((v) => {
          endDate = v;
        });
      });

    new Setting(formBox).setName("배지 색상").addDropdown((dd) => {
      for (const preset of CELL_COLOR_PRESETS.filter((p) => p.id !== "")) {
        dd.addOption(preset.id, preset.label);
      }
      dd.setValue(color).onChange((v) => {
        color = v;
      });
    });

    const btnRow = formBox.createDiv({ cls: "cm-modal-footer" });
    if (editing) {
      const cancelEditBtn = btnRow.createEl("button", { text: "편집 취소" });
      cancelEditBtn.addEventListener("click", () => {
        this.editingEvent = null;
        this.render();
      });
    }

    const submitBtn = btnRow.createEl("button", {
      text: editing ? "수정 저장" : "반복 일정 추가",
      cls: "mod-cta",
    });
    submitBtn.addEventListener("click", async () => {
      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        new Notice("일정 제목을 입력해 주세요.");
        return;
      }
      if (frequency === "weekly" && weekdays.size === 0) {
        new Notice("반복 요일을 하나 이상 선택해 주세요.");
        return;
      }

      const resolvedBusinessNth =
        frequency === "businessDay"
          ? businessDayMode === "every"
            ? 0
            : businessDayMode === "last"
              ? -1
              : businessDayNth
          : undefined;

      const payload: RecurringEvent = {
        id: editing?.id ?? generateId("rec"),
        title: trimmedTitle,
        frequency,
        weekdays: frequency === "weekly" ? Array.from(weekdays).sort() : undefined,
        monthOfYear: frequency === "yearly" ? monthOfYear : undefined,
        dayOfMonth:
          frequency === "monthly" || frequency === "yearly"
            ? dayOfMonth
            : undefined,
        businessDayNth: resolvedBusinessNth,
        startDate: startDate || getTodayKey(),
        endDate: endDate.trim() || undefined,
        scope,
        tabId: scope === "tab" ? tabId : undefined,
        color,
        completedDates: editing?.completedDates ?? [],
        excludedDates: editing?.excludedDates ?? [],
      };

      if (editing) {
        const idx = this.plugin.settings.recurringEvents.findIndex(
          (e) => e.id === editing.id
        );
        if (idx >= 0) {
          this.plugin.settings.recurringEvents[idx] = payload;
        }
        this.editingEvent = null;
      } else {
        this.plugin.settings.recurringEvents.push(payload);
      }

      await this.plugin.saveSettings();
      this.onUpdated();
      new Notice(editing ? "반복 일정을 수정했습니다." : "반복 일정을 추가했습니다.");
      this.render();
    });
  }
}

// ============================================================================
// [ID 8.4] 사용자 커스텀 휴일 / 기념일 관리 모달
// ============================================================================
export class CustomHolidaysModal extends Modal {
  private plugin: CalendarMemoPlugin;
  private onUpdated: () => void;

  constructor(plugin: CalendarMemoPlugin, onUpdated: () => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.onUpdated = onUpdated;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cm-modal");

    contentEl.createEl("h2", { text: "국가 공휴일 · 커스텀 휴일 관리" });

    // [ID 2.5.5] 캘린더 상단 '휴일' 버튼에서도 바로 국가를 전환할 수 있도록 단축 선택기 제공
    const countryBox = contentEl.createDiv({ cls: "cm-form-box" });
    const currentCountry = this.plugin.settings.holidayCountry || "KR";
    const cachedYears = Object.keys(
      this.plugin.settings.cachedCountryHolidays[currentCountry] ?? {}
    ).sort();

    new Setting(countryBox)
      .setName("공휴일 국가 (Holiday Country)")
      .setDesc(
        currentCountry === "KR"
          ? "대한민국 — 내장 오프라인 공휴일·음력 사용 중"
          : currentCountry === "NONE"
            ? "국가 공휴일 꺼짐 (아래 커스텀 휴일만 표시)"
            : `해외 공휴일 로컬 캐시 (${
                cachedYears.length > 0 ? cachedYears.join(", ") : "동기화 대기"
              })`
      )
      .addDropdown((dd) => {
        const hasCurrent = this.plugin.availableCountries.some(
          (c) => c.code === currentCountry
        );
        for (const c of this.plugin.availableCountries) {
          dd.addOption(c.code, c.name);
        }
        if (!hasCurrent) {
          dd.addOption(currentCountry, currentCountry);
        }
        dd.setValue(currentCountry).onChange(async (v) => {
          await this.plugin.setHolidayCountry(v);
          this.onUpdated();
          this.render();
        });
      })
      .addButton((btn) =>
        btn
          .setButtonText("110+ 국가")
          .setTooltip("전 세계 110개국 이상 전체 목록 불러오기")
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              const list = await this.plugin.loadAllCountriesFromNager();
              new Notice(`${list.length - 2}개 국가 목록을 불러왔습니다.`);
              this.render();
            } catch {
              new Notice("전체 국가 목록을 불러오지 못했습니다.");
              btn.setDisabled(false);
            }
          })
      );

    contentEl.createEl("h3", {
      text: "커스텀 휴일 · 기념일 추가",
      cls: "cm-section-heading",
    });

    const formBox = contentEl.createDiv({ cls: "cm-form-box" });
    let name = "";
    let month = 1;
    let day = 1;
    let yearStr = "";
    let isLunar = false;
    let isHoliday = true;

    new Setting(formBox).setName("이름").addText((t) =>
      t.setPlaceholder("예: 창립기념일, 어머니 생신").onChange((v) => {
        name = v;
      })
    );

    new Setting(formBox)
      .setName("월 / 일")
      .addText((t) =>
        t
          .setPlaceholder("월 (1~12)")
          .setValue("1")
          .onChange((v) => {
            const n = Number(v);
            if (n >= 1 && n <= 12) month = n;
          })
      )
      .addText((t) =>
        t
          .setPlaceholder("일 (1~31)")
          .setValue("1")
          .onChange((v) => {
            const n = Number(v);
            if (n >= 1 && n <= 31) day = n;
          })
      );

    new Setting(formBox)
      .setName("특정 연도 (선택)")
      .setDesc("비워두면 매년 반복 적용됩니다. 임시공휴일 등은 연도를 입력하세요.")
      .addText((t) =>
        t.setPlaceholder("예: 2026 (비워두면 매년)").onChange((v) => {
          yearStr = v.trim();
        })
      );

    new Setting(formBox).setName("음력 날짜").addToggle((tg) =>
      tg.setValue(isLunar).onChange((v) => {
        isLunar = v;
      })
    );

    new Setting(formBox)
      .setName("휴일(빨간 날)로 취급")
      .setDesc("끄면 기념일로 표시되며 영업일 계산에서 제외되지 않습니다.")
      .addToggle((tg) =>
        tg.setValue(isHoliday).onChange((v) => {
          isHoliday = v;
        })
      );

    const footer = formBox.createDiv({ cls: "cm-modal-footer" });
    const addBtn = footer.createEl("button", { text: "추가", cls: "mod-cta" });
    addBtn.addEventListener("click", async () => {
      if (!name.trim()) {
        new Notice("이름을 입력해 주세요.");
        return;
      }
      const parsedYear = yearStr ? Number(yearStr) : undefined;
      const item: CustomHoliday = {
        id: generateId("ch"),
        name: name.trim(),
        month,
        day,
        year: parsedYear && !Number.isNaN(parsedYear) ? parsedYear : undefined,
        isLunar,
        isHoliday,
      };
      this.plugin.settings.customHolidays.push(item);
      this.plugin.koreanCalendar.setCustomHolidays(
        this.plugin.settings.customHolidays
      );
      await this.plugin.saveSettings();
      this.onUpdated();
      this.render();
    });

    contentEl.createEl("h3", {
      text: `등록된 항목 (${this.plugin.settings.customHolidays.length})`,
      cls: "cm-section-heading",
    });

    const listEl = contentEl.createDiv({ cls: "cm-list-box" });
    if (this.plugin.settings.customHolidays.length === 0) {
      listEl.createDiv({
        cls: "cm-empty-hint",
        text: "등록된 커스텀 휴일/기념일이 없습니다.",
      });
      return;
    }

    for (const item of this.plugin.settings.customHolidays) {
      const row = listEl.createDiv({ cls: "cm-list-row" });
      const info = row.createDiv({ cls: "cm-list-info" });
      info.createDiv({ cls: "cm-list-title", text: item.name });
      const kind = item.isHoliday ? "휴일" : "기념일";
      const cal = item.isLunar ? "음력" : "양력";
      const yr = item.year ? `${item.year}년` : "매년";
      info.createDiv({
        cls: "cm-list-sub",
        text: `${yr} ${cal} ${item.month}월 ${item.day}일 · ${kind}`,
      });

      const delBtn = row.createEl("button", {
        text: "삭제",
        cls: "mod-warning",
      });
      delBtn.addEventListener("click", async () => {
        this.plugin.settings.customHolidays =
          this.plugin.settings.customHolidays.filter((c) => c.id !== item.id);
        this.plugin.koreanCalendar.setCustomHolidays(
          this.plugin.settings.customHolidays
        );
        await this.plugin.saveSettings();
        this.onUpdated();
        this.render();
      });
    }
  }
}

