import { UiLanguage } from "./types";

// [ID 1.4] 다국어(한국어 / 영어) UI 번역 테이블 및 로케일 리졸버
// -> 설정에서 '자동(옵시디언 언어 따라감) / 한국어 / English'를 선택할 수 있도록 모든 UI 문자열을 중앙 관리함.

export type ResolvedLang = "ko" | "en";

export function resolveUiLanguage(pref: UiLanguage): ResolvedLang {
  if (pref === "ko" || pref === "en") return pref;
  try {
    const g = globalThis as unknown as {
      moment?: { locale?: () => string };
      localStorage?: Storage;
    };
    const obsLang = g.localStorage?.getItem("language");
    if (obsLang) {
      return obsLang.toLowerCase().startsWith("ko") ? "ko" : "en";
    }
    const mLocale = g.moment?.locale?.();
    if (mLocale) {
      return mLocale.toLowerCase().startsWith("ko") ? "ko" : "en";
    }
  } catch {
    // 테스트 환경 폴백
  }
  return "ko";
}

export interface UiStrings {
  lang: ResolvedLang;
  weekdaysSunFirst: string[];
  weekdaysMonFirst: string[];
  weekdaysShortByDow: string[];
  formatYearMonth: (year: number, month: number) => string;
  formatMonthFirst: (month: number) => string;
  formatPopoverDate: (year: number, month: number, day: number, dow: number) => string;
  // 탭 바 & 툴바
  allTabsLabel: string;
  allTabsTooltip: string;
  addFolderBtn: string;
  addFolderAria: string;
  editTabAria: string;
  prevMonthAria: string;
  nextMonthAria: string;
  todayBtn: string;
  todayTooltip: string;
  searchPlaceholder: string;
  searchTooltip: string;
  searchNoMatches: string;
  colorPaletteTooltip: string;
  undoLabel: string;
  redoLabel: string;
  recurringBtn: string;
  recurringTooltip: string;
  holidayBtn: string;
  holidayTooltip: string;
  // 색상 이름
  colorLabels: Record<string, string>;
  // 컨텍스트 메뉴
  ctxEditPopover: string;
  ctxBatchEdit: (count: number) => string;
  ctxOpenAsNote: string;
  ctxCopy: string;
  ctxCut: string;
  ctxPaste: string;
  ctxDelete: string;
  ctxCarryTomorrow: string;
  ctxCarryNextBizDay: string;
  ctxBgColorPrefix: string;
  ctxAddRecurringFromDate: string;
  ctxEditTab: string;
  ctxDeleteTab: string;
  ctxMarkDone: string;
  ctxMarkUndone: string;
  ctxHideThisDate: string;
  ctxEditRecurring: string;
  // 팝오버 & 일괄 입력
  sizeSmall: string;
  sizeMedium: string;
  sizeLarge: string;
  saveHintMac: string;
  saveHintWin: string;
  applyHintMac: string;
  applyHintWin: string;
  openInTabAria: string;
  saveCloseAria: string;
  closeAria: string;
  fmtTask: string;
  fmtTaskTip: string;
  fmtBulletTip: string;
  fmtTimeTip: string;
  fmtLinkTip: string;
  fmtDividerTip: string;
  fmtHighlightTip: string;
  batchTitle: (count: number) => string;
  batchApplyBtn: (dateCount: number, tabCount: number) => string;
  batchCancelBtn: string;
  batchColorKeep: string;
  batchTargetCalendars: string;
  batchSelectAllCalendars: string;
  batchMultiCalendarBtn: string;
  batchMultiCalendarTip: string;
  batchSelectOneNotice: string;
  batchPlaceholder: string;
  batchAppliedNotice: (dateCount: number, tabCount: number) => string;
  ctxMultiCalendarInput: string;
  // 알림(Notice)
  noticeCopied: (total: number, nonEmpty: number) => string;
  noticeCut: (count: number) => string;
  noticePasted: (count: number) => string;
  noticeDeleted: (count: number) => string;
  noticeUndo: (label: string) => string;
  noticeRedo: (label: string) => string;
  noticeNoIncompleteTasks: string;
  noticeCarriedTasks: (count: number, targetDate: string) => string;
  noticeDroppedSingle: (date: string, link: string) => string;
  noticeDroppedMulti: (date: string, count: number) => string;
  noticeTabAdded: (name: string) => string;
  // 설정
  settingsTitle: string;
  settingLangName: string;
  settingLangDesc: string;
  settingLangAuto: string;
  settingWeekStartName: string;
  settingWeekStartDesc: string;
  settingWeekStartSun: string;
  settingWeekStartMon: string;
  settingWeeksPerViewName: string;
  settingWeeksPerViewDesc: string;
  settingLunarName: string;
  settingLunarDesc: string;
  settingLunarPeriodic: string;
  settingLunarAlways: string;
  settingLunarOff: string;
  settingAnnivName: string;
  settingAnnivDesc: string;
  settingHolidaySection: string;
  settingCountryName: string;
  settingLoadAllCountries: string;
  settingLocalHolidayName: string;
  settingLocalHolidayDesc: string;
  settingCacheManage: (country: string) => string;
  settingResyncBtn: string;
  settingClearCacheBtn: string;
  settingTabsSection: string;
  settingEditBtn: string;
  settingAddTabName: string;
  settingAddTabDesc: string;
  settingAddTabBtn: string;
  settingRecurringSection: string;
  settingOpenBtn: string;
  // 모달 공통
  modalSave: string;
  modalCancel: string;
  modalDelete: string;
  modalAdd: string;
  modalTabAddTitle: string;
  modalTabEditTitle: string;
  modalRecurringTitle: string;
  modalHolidayTitle: string;
}

const EN_MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const KO_STRINGS: UiStrings = {
  lang: "ko",
  weekdaysSunFirst: ["일", "월", "화", "수", "목", "금", "토"],
  weekdaysMonFirst: ["월", "화", "수", "목", "금", "토", "일"],
  weekdaysShortByDow: ["일", "월", "화", "수", "목", "금", "토"],
  formatYearMonth: (y, m) => `${y}년 ${m}월`,
  formatMonthFirst: (m) => `${m}월 1일`,
  formatPopoverDate: (y, m, d, dow) =>
    `${y}년 ${m}월 ${d}일 (${["일", "월", "화", "수", "목", "금", "토"][dow]})`,
  allTabsLabel: "전체",
  allTabsTooltip: "모든 폴더 탭의 메모를 한 화면에 합쳐 보기",
  addFolderBtn: "폴더 추가",
  addFolderAria: "새 폴더 탭 추가",
  editTabAria: "탭 설정 편집",
  prevMonthAria: "이전 달",
  nextMonthAria: "다음 달",
  todayBtn: "오늘",
  todayTooltip: "오늘 날짜로 이동 (T)",
  searchPlaceholder: "메모 검색... (Enter 다음 · Esc 닫기)",
  searchTooltip: "캘린더 메모 검색 (Cmd/Ctrl + F)",
  searchNoMatches: "결과 없음",
  colorPaletteTooltip: "선택된 셀 배경색 변경",
  undoLabel: "실행 취소",
  redoLabel: "다시 실행",
  recurringBtn: "반복 일정",
  recurringTooltip: "반복 일정 등록 및 관리",
  holidayBtn: "휴일",
  holidayTooltip: "국가 공휴일 · 커스텀 휴일 관리",
  colorLabels: {
    "": "색상 없음",
    rose: "로즈",
    amber: "앰버",
    yellow: "옐로우",
    green: "그린",
    teal: "틸",
    blue: "블루",
    purple: "퍼플",
    gray: "그레이",
  },
  ctxEditPopover: "팝오버로 편집 (Enter)",
  ctxBatchEdit: (n) => `선택한 ${n}개 날짜 공통 입력 (Enter)`,
  ctxOpenAsNote: "노트 탭으로 열기",
  ctxCopy: "선택 셀 복사",
  ctxCut: "선택 셀 잘라내기 (Cut)",
  ctxPaste: "선택 셀에 이어붙이기",
  ctxDelete: "선택 셀 내용 삭제",
  ctxCarryTomorrow: "미완료 할 일 내일로 이월",
  ctxCarryNextBizDay: "미완료 할 일 다음 영업일로 이월",
  ctxBgColorPrefix: "배경색",
  ctxAddRecurringFromDate: "이 날짜부터 반복 일정 추가",
  ctxEditTab: "탭 편집",
  ctxDeleteTab: "탭 삭제",
  ctxMarkDone: "완료 표시",
  ctxMarkUndone: "완료 해제",
  ctxHideThisDate: "이 날짜에서만 숨기기",
  ctxEditRecurring: "반복 일정 편집",
  sizeSmall: "소",
  sizeMedium: "중",
  sizeLarge: "대",
  saveHintMac: "⌘+Enter 저장",
  saveHintWin: "Ctrl+Enter 저장",
  applyHintMac: "⌘+Enter 적용 · 바깥 클릭 취소",
  applyHintWin: "Ctrl+Enter 적용 · 바깥 클릭 취소",
  openInTabAria: "노트 탭으로 열기",
  saveCloseAria: "저장 후 닫기",
  closeAria: "닫기",
  fmtTask: "할 일",
  fmtTaskTip: "체크박스 추가/전환 (- [ ] )",
  fmtBulletTip: "글머리 기호 추가/해제 (- )",
  fmtTimeTip: "현재 시간 삽입 (HH:MM )",
  fmtLinkTip: "위키링크 삽입 ([[ ]])",
  fmtDividerTip: "구분선 삽입 (---)",
  fmtHighlightTip: "선택 텍스트 하이라이트 감싸기",
  batchTitle: (n) => (n === 1 ? "여러 달력 동시 입력" : `${n}개 날짜 공통 입력`),
  batchApplyBtn: (d, t) =>
    t > 1 ? `${d}일 · ${t}개 달력에 적용` : `${d}개 날짜에 적용`,
  batchCancelBtn: "취소",
  batchColorKeep: "배경색 유지",
  batchTargetCalendars: "대상 달력",
  batchSelectAllCalendars: "전체",
  batchMultiCalendarBtn: "동시 입력",
  batchMultiCalendarTip: "여러 달력에 같은 내용을 한 번에 추가",
  batchSelectOneNotice: "적용할 달력을 하나 이상 선택해 주세요.",
  batchPlaceholder: "선택한 날짜·달력들에 공통으로 추가할 내용을 입력하세요...",
  batchAppliedNotice: (d, t) =>
    t > 1
      ? `${d}개 날짜 · ${t}개 달력에 공통 내용을 적용했습니다.`
      : `${d}개 날짜에 공통 내용을 적용했습니다.`,
  ctxMultiCalendarInput: "여러 달력에 동시 입력",
  noticeCopied: (total, nonEmpty) =>
    nonEmpty > 0
      ? `${total}개 셀(메모 ${nonEmpty}개) 복사됨`
      : `${total}개 빈 셀 복사됨`,
  noticeCut: (n) => `${n}개 날짜 내용 잘라내기 완료`,
  noticePasted: (n) => `${n}개 날짜에 내용 추가 완료`,
  noticeDeleted: (n) => `${n}개 날짜 메모 삭제됨`,
  noticeUndo: (label) => `실행 취소: ${label}`,
  noticeRedo: (label) => `다시 실행: ${label}`,
  noticeNoIncompleteTasks: "이월할 미완료 체크박스(- [ ])가 없습니다.",
  noticeCarriedTasks: (n, target) =>
    `미완료 할 일 ${n}개를 ${target}(으)로 이월했습니다.`,
  noticeDroppedSingle: (date, link) => `${date}에 ${link} 링크 추가됨`,
  noticeDroppedMulti: (date, n) => `${date}에 ${n}개 노트 링크 추가됨`,
  noticeTabAdded: (name) => `"${name}" 캘린더 탭이 추가되었습니다.`,
  settingsTitle: "Calendar Memo 설정",
  settingLangName: "표시 언어 (Language)",
  settingLangDesc: "플러그인 UI 언어를 선택합니다.",
  settingLangAuto: "자동 (옵시디언 언어 따라감)",
  settingWeekStartName: "주 시작 요일",
  settingWeekStartDesc: "달력의 첫 번째 열에 표시할 요일을 선택합니다.",
  settingWeekStartSun: "일요일 시작 (일~토)",
  settingWeekStartMon: "월요일 시작 (월~일)",
  settingWeeksPerViewName: "한 화면에 표시할 주(Row) 수",
  settingWeeksPerViewDesc: "연속 스크롤 캘린더 뷰포트 높이에 맞춰 표시되는 기본 주 수입니다.",
  settingLunarName: "음력 날짜 표시",
  settingLunarDesc: "오프라인 내장 음력 엔진으로 음력 날짜를 셀 상단에 표시합니다.",
  settingLunarPeriodic: "매월 음력 1일 · 15일 표시 (권장)",
  settingLunarAlways: "매일 표시",
  settingLunarOff: "표시 안 함",
  settingAnnivName: "한국 주요 기념일 표시",
  settingAnnivDesc: "공휴일 국가가 대한민국(KR)일 때 어버이날, 스승의날 등 주요 기념일을 표시합니다.",
  settingHolidaySection: "국가별 공휴일 (Holidays by Country)",
  settingCountryName: "공휴일 국가 선택",
  settingLoadAllCountries: "전체 국가(110+) 불러오기",
  settingLocalHolidayName: "해외 공휴일 현지어 이름 사용",
  settingLocalHolidayDesc: "켜면 현지어(예: 元日), 끄면 영문명(예: New Year's Day)으로 표시합니다.",
  settingCacheManage: (c) => `${c} 공휴일 캐시 관리`,
  settingResyncBtn: "지금 다시 동기화",
  settingClearCacheBtn: "캐시 비우기",
  settingTabsSection: "캘린더 폴더 탭",
  settingEditBtn: "편집",
  settingAddTabName: "새 폴더 탭 추가",
  settingAddTabDesc: "다른 폴더의 날짜 노트들을 별도 탭으로 전환해 볼 수 있습니다.",
  settingAddTabBtn: "폴더 탭 추가",
  settingRecurringSection: "반복 일정 및 커스텀 휴일",
  settingOpenBtn: "열기",
  modalSave: "저장",
  modalCancel: "취소",
  modalDelete: "삭제",
  modalAdd: "추가",
  modalTabAddTitle: "새 폴더 탭 추가",
  modalTabEditTitle: "캘린더 폴더 탭 편집",
  modalRecurringTitle: "반복 일정 관리",
  modalHolidayTitle: "국가 공휴일 · 커스텀 휴일 관리",
};

const EN_STRINGS: UiStrings = {
  lang: "en",
  weekdaysSunFirst: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  weekdaysMonFirst: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  weekdaysShortByDow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  formatYearMonth: (y, m) => `${EN_MONTHS_SHORT[m - 1]} ${y}`,
  formatMonthFirst: (m) => `${EN_MONTHS_SHORT[m - 1]} 1`,
  formatPopoverDate: (y, m, d, dow) =>
    `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow]}, ${EN_MONTHS_SHORT[m - 1]} ${d}, ${y}`,
  allTabsLabel: "All",
  allTabsTooltip: "Show memos from all folder tabs combined",
  addFolderBtn: "Add Folder",
  addFolderAria: "Add new folder tab",
  editTabAria: "Edit tab settings",
  prevMonthAria: "Previous month",
  nextMonthAria: "Next month",
  todayBtn: "Today",
  todayTooltip: "Jump to today (T)",
  searchPlaceholder: "Search memos... (Enter next · Esc close)",
  searchTooltip: "Search calendar memos (Cmd/Ctrl + F)",
  searchNoMatches: "No matches",
  colorPaletteTooltip: "Set background color for selected cells",
  undoLabel: "Undo",
  redoLabel: "Redo",
  recurringBtn: "Recurring",
  recurringTooltip: "Manage recurring schedules",
  holidayBtn: "Holidays",
  holidayTooltip: "Country & custom holidays",
  colorLabels: {
    "": "None",
    rose: "Rose",
    amber: "Amber",
    yellow: "Yellow",
    green: "Green",
    teal: "Teal",
    blue: "Blue",
    purple: "Purple",
    gray: "Gray",
  },
  ctxEditPopover: "Edit in Popover (Enter)",
  ctxBatchEdit: (n) => `Batch edit ${n} selected dates (Enter)`,
  ctxOpenAsNote: "Open as Note Tab",
  ctxCopy: "Copy Selected Cells",
  ctxCut: "Cut Selected Cells",
  ctxPaste: "Paste (Append) to Selection",
  ctxDelete: "Clear Selected Cells",
  ctxCarryTomorrow: "Move Incomplete Tasks to Tomorrow",
  ctxCarryNextBizDay: "Move Incomplete Tasks to Next Business Day",
  ctxBgColorPrefix: "Color",
  ctxAddRecurringFromDate: "Add Recurring Event from Here",
  ctxEditTab: "Edit Tab",
  ctxDeleteTab: "Delete Tab",
  ctxMarkDone: "Mark Completed",
  ctxMarkUndone: "Mark Incomplete",
  ctxHideThisDate: "Hide on This Date Only",
  ctxEditRecurring: "Edit Recurring Event",
  sizeSmall: "S",
  sizeMedium: "M",
  sizeLarge: "L",
  saveHintMac: "⌘+Enter Save",
  saveHintWin: "Ctrl+Enter Save",
  applyHintMac: "⌘+Enter Apply · Click outside to cancel",
  applyHintWin: "Ctrl+Enter Apply · Click outside to cancel",
  openInTabAria: "Open in note tab",
  saveCloseAria: "Save and close",
  closeAria: "Close",
  fmtTask: "Task",
  fmtTaskTip: "Toggle task checkbox (- [ ] )",
  fmtBulletTip: "Toggle bullet list (- )",
  fmtTimeTip: "Insert current time (HH:MM )",
  fmtLinkTip: "Insert wikilink ([[ ]])",
  fmtDividerTip: "Insert divider (---)",
  fmtHighlightTip: "Wrap selection with color highlight",
  batchTitle: (n) =>
    n === 1 ? "Multi-Calendar Entry" : `Batch Edit (${n} dates)`,
  batchApplyBtn: (d, t) =>
    t > 1 ? `Apply (${d}d · ${t} cal)` : `Apply to ${d} dates`,
  batchCancelBtn: "Cancel",
  batchColorKeep: "Keep color",
  batchTargetCalendars: "Calendars",
  batchSelectAllCalendars: "All",
  batchMultiCalendarBtn: "Multi-Cal",
  batchMultiCalendarTip: "Add the same memo to multiple calendars at once",
  batchSelectOneNotice: "Please select at least one calendar.",
  batchPlaceholder: "Write common memo to append to selected dates & calendars...",
  batchAppliedNotice: (d, t) =>
    t > 1
      ? `Applied memo to ${d} date(s) across ${t} calendars.`
      : `Applied common memo to ${d} date(s).`,
  ctxMultiCalendarInput: "Add to Multiple Calendars",
  noticeCopied: (total, nonEmpty) =>
    nonEmpty > 0
      ? `Copied ${total} cells (${nonEmpty} with notes)`
      : `Copied ${total} empty cells`,
  noticeCut: (n) => `Cut content from ${n} dates`,
  noticePasted: (n) => `Appended content to ${n} dates`,
  noticeDeleted: (n) => `Cleared ${n} dates`,
  noticeUndo: (label) => `Undo: ${label}`,
  noticeRedo: (label) => `Redo: ${label}`,
  noticeNoIncompleteTasks: "No incomplete tasks (- [ ]) to move.",
  noticeCarriedTasks: (n, target) => `Moved ${n} incomplete task(s) to ${target}.`,
  noticeDroppedSingle: (date, link) => `Linked ${link} to ${date}`,
  noticeDroppedMulti: (date, n) => `Linked ${n} notes to ${date}`,
  noticeTabAdded: (name) => `Added calendar tab "${name}".`,
  settingsTitle: "Calendar Memo Settings",
  settingLangName: "Interface Language",
  settingLangDesc: "Choose the language for Calendar Memo UI.",
  settingLangAuto: "Auto (Follow Obsidian)",
  settingWeekStartName: "First Day of Week",
  settingWeekStartDesc: "Choose which weekday appears in the first column.",
  settingWeekStartSun: "Sunday (Sun–Sat)",
  settingWeekStartMon: "Monday (Mon–Sun)",
  settingWeeksPerViewName: "Visible Weeks per Screen",
  settingWeeksPerViewDesc: "Number of week rows sized to fit the viewport height.",
  settingLunarName: "Lunar Calendar Display",
  settingLunarDesc: "Display Korean lunar dates offline in cell headers.",
  settingLunarPeriodic: "1st & 15th of Lunar Month",
  settingLunarAlways: "Every Day",
  settingLunarOff: "Off",
  settingAnnivName: "Korean Observances",
  settingAnnivDesc: "Show major Korean observances when country is set to South Korea (KR).",
  settingHolidaySection: "Holidays by Country",
  settingCountryName: "Holiday Country",
  settingLoadAllCountries: "Load All (110+)",
  settingLocalHolidayName: "Use Local Holiday Names",
  settingLocalHolidayDesc: "Show native names (e.g. 元日) instead of English names.",
  settingCacheManage: (c) => `${c} Holiday Cache`,
  settingResyncBtn: "Re-sync Now",
  settingClearCacheBtn: "Clear Cache",
  settingTabsSection: "Calendar Folder Tabs",
  settingEditBtn: "Edit",
  settingAddTabName: "Add Folder Tab",
  settingAddTabDesc: "Connect another vault folder as a switchable calendar tab.",
  settingAddTabBtn: "Add Tab",
  settingRecurringSection: "Recurring Events & Custom Holidays",
  settingOpenBtn: "Open",
  modalSave: "Save",
  modalCancel: "Cancel",
  modalDelete: "Delete",
  modalAdd: "Add",
  modalTabAddTitle: "Add Folder Tab",
  modalTabEditTitle: "Edit Folder Tab",
  modalRecurringTitle: "Recurring Events",
  modalHolidayTitle: "Country & Custom Holidays",
};

export function getStrings(pref: UiLanguage): UiStrings {
  return resolveUiLanguage(pref) === "en" ? EN_STRINGS : KO_STRINGS;
}

