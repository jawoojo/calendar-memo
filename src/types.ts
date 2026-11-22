// [ID 1.1] 플러그인 전역 타입 및 기본 설정 모델
// -> 폴더 탭, 반복 일정, 셀 배경색, 한국형 캘린더 옵션 등 data.json에 영속화되는 스키마를 단일 지점에서 관리함.

export type DateKey = string; // YYYY-MM-DD (로컬 타임존 기준)

export type UiLanguage = "auto" | "ko" | "en";

export const ALL_TABS_ID = "__all__";

export type LunarDisplayMode = "off" | "periodic" | "always";

export type RecurringFrequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "businessDay";

export type PopoverSizePreset = "small" | "medium" | "large" | "custom";

export interface PopoverSizeConfig {
  preset: PopoverSizePreset;
  width: number;
  height: number;
}

// [ID 6.6] 편집 팝오버 소/중/대 크기 프리셋 정의
// -> 사용자가 클릭 한 번으로 전환하거나 드래그로 커스텀 조절한 크기를 data.json에 영속화함.
export const POPOVER_SIZE_PRESETS: Record<
  Exclude<PopoverSizePreset, "custom">,
  { label: string; width: number; height: number }
> = {
  small: { label: "소", width: 360, height: 260 },
  medium: { label: "중", width: 460, height: 360 },
  large: { label: "대", width: 640, height: 520 },
};

export interface CalendarTab {
  id: string;
  name: string;
  /** 볼트 루트 기준 폴더 경로 (빈 문자열이면 볼트 루트) */
  folderPath: string;
  /** Moment.js 호환 커스텀 날짜 파일명 포맷 (확장자 제외, 예: YYYY-MM-DD, YYYY/MM/YYYY-MM-DD) */
  dateFormat: string;
}

export interface RecurringEvent {
  id: string;
  title: string;
  frequency: RecurringFrequency;
  /** 매주 반복 시 요일 배열 (0=일 ~ 6=토) */
  weekdays?: number[];
  /** 매년 반복 시 월 (1~12) */
  monthOfYear?: number;
  /** 매월·매년 반복 시 일자 (1~31, 해당 월 말일 초과 시 말일로 보정) */
  dayOfMonth?: number;
  /**
   * 영업일 기준 반복 모드:
   * - 0 또는 undefined: 매 영업일 (주말·공휴일 제외)
   * - 1~23: 매월 N번째 영업일
   * - -1: 매월 마지막 영업일
   */
  businessDayNth?: number;
  /** 반복 시작일 (YYYY-MM-DD) */
  startDate: DateKey;
  /** 반복 종료일 (선택, YYYY-MM-DD) */
  endDate?: DateKey;
  /** 적용 범위: all(모든 탭 공통) | tab(특정 탭 전용) */
  scope: "all" | "tab";
  /** scope가 'tab'일 때 대상 탭 ID */
  tabId?: string;
  /** 오버레이 배지 색상 ID */
  color?: string;
  /** 날짜별 완료 체크 목록 */
  completedDates: DateKey[];
  /** 특정 날짜만 숨김/제외 목록 */
  excludedDates: DateKey[];
}

export interface CustomHoliday {
  id: string;
  name: string;
  month: number; // 1~12
  day: number; // 1~31
  /** 생략 시 매년 반복, 지정 시 해당 연도만 적용 */
  year?: number;
  /** true이면 음력 기준 월/일로 매칭 */
  isLunar?: boolean;
  /** true이면 빨간 날(공휴일·영업일 제외), false이면 기념일로 표시 */
  isHoliday: boolean;
}

// [ID 2.5] 해외 공휴일 로컬 캐시 엔트리 (국가 코드 -> 연도 -> 공휴일 배열)
export interface CachedHolidayEntry {
  date: DateKey;
  name: string;
  localName: string;
}

export interface CountryOption {
  code: string;
  name: string;
}

export interface CalendarMemoSettings {
  tabs: CalendarTab[];
  activeTabId: string;
  /** UI 표시 언어 ('auto' = 옵시디언 언어 감지, 'ko' = 한국어, 'en' = English) */
  uiLanguage: UiLanguage;
  /** 주 시작 요일: 0=일요일, 1=월요일 */
  weekStartsOn: 0 | 1;
  /** 음력 표시 모드: periodic(1일/15일) | always(매일) | off */
  lunarDisplay: LunarDisplayMode;
  /** 대한민국 주요 기념일 표시 여부 (KR 선택 시 적용) */
  showAnniversaries: boolean;
  /** 공휴일 국가 코드 ('KR' = 내장 한국 오프라인, 'NONE' = 끄기, 그 외 ISO 2자리 코드 = Nager.Date 캐시) */
  holidayCountry: string;
  /** 해외 공휴일 표기 시 현지어 이름 우선 사용 여부 (false이면 영문명 표시) */
  useLocalHolidayName: boolean;
  /** 해외 공휴일 로컬 캐시: cachedCountryHolidays[countryCode][year] */
  cachedCountryHolidays: Record<string, Record<string, CachedHolidayEntry[]>>;
  /** 한 화면(뷰포트)에 표시할 주(Row) 수 */
  visibleWeeksPerViewport: number;
  /** 편집 팝오버 크기 설정 (소/중/대 프리셋 또는 드래그 커스텀 크기) */
  popoverSize: PopoverSizeConfig;
  /**
   * 셀 배경색 저장소: cellColors[tabId][YYYY-MM-DD] = colorId
   * -> 빈 날짜에도 색칠할 수 있도록 .md 프론트매터 대신 data.json에 분리 저장함.
   */
  cellColors: Record<string, Record<DateKey, string>>;
  recurringEvents: RecurringEvent[];
  customHolidays: CustomHoliday[];
}

export interface CellColorPreset {
  id: string;
  label: string;
  /** CSS 클래스 접미사 및 팔레트 스와치 미리보기 색 */
  swatch: string;
}

// [ID 7.2] 다크/라이트 테마 공용 파스텔 셀 배경색 프리셋
// -> 반투명 알파 틴트를 CSS에서 적용하여 라이트·다크 모드 모두에서 텍스트 가독성을 유지함.
export const CELL_COLOR_PRESETS: CellColorPreset[] = [
  { id: "", label: "색상 없음", swatch: "transparent" },
  { id: "rose", label: "로즈", swatch: "#f43f5e" },
  { id: "amber", label: "앰버", swatch: "#f59e0b" },
  { id: "yellow", label: "옐로우", swatch: "#eab308" },
  { id: "green", label: "그린", swatch: "#22c55e" },
  { id: "teal", label: "틸", swatch: "#14b8a6" },
  { id: "blue", label: "블루", swatch: "#3b82f6" },
  { id: "purple", label: "퍼플", swatch: "#a855f7" },
  { id: "gray", label: "그레이", swatch: "#64748b" },
];

export const DEFAULT_TAB_ID = "default";

export const DEFAULT_SETTINGS: CalendarMemoSettings = {
  tabs: [
    {
      id: DEFAULT_TAB_ID,
      name: "기본",
      folderPath: "Calendar Memo",
      dateFormat: "YYYY-MM-DD",
    },
  ],
  activeTabId: DEFAULT_TAB_ID,
  uiLanguage: "auto",
  weekStartsOn: 0,
  lunarDisplay: "periodic",
  showAnniversaries: true,
  holidayCountry: "KR",
  useLocalHolidayName: true,
  cachedCountryHolidays: {},
  visibleWeeksPerViewport: 5,
  popoverSize: {
    preset: "medium",
    width: POPOVER_SIZE_PRESETS.medium.width,
    height: POPOVER_SIZE_PRESETS.medium.height,
  },
  cellColors: {},
  recurringEvents: [],
  customHolidays: [],
};

export interface DayCalendarMeta {
  dateKey: DateKey;
  isHoliday: boolean;
  holidayNames: string[];
  anniversaryNames: string[];
  lunarLabel: string | null;
  lunarMonth: number;
  lunarDay: number;
  lunarIsLeap: boolean;
}

