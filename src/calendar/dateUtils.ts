import { DateKey } from "../types";

// [ID 2.1] 로컬 타임존 안전 날짜 연산 및 그리드 좌표 변환 유틸리티
// -> UTC 변환(toISOString) 시 KST(+09:00)에서 하루 밀리는 버그를 원천 차단하기 위해 순수 로컬 정수 연산만 사용함.

const KOREAN_WEEKDAYS_SHORT = ["일", "월", "화", "수", "목", "금", "토"];
const KOREAN_WEEKDAYS_LONG = [
  "일요일",
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
];

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function toDateKey(year: number, month: number, day: number): DateKey {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function parseDateKey(dateKey: DateKey): {
  year: number;
  month: number;
  day: number;
} {
  const parts = dateKey.split("-");
  return {
    year: Number(parts[0]),
    month: Number(parts[1]),
    day: Number(parts[2]),
  };
}

export function isValidDateKey(dateKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  const { year, month, day } = parseDateKey(dateKey);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}

export function getTodayKey(): DateKey {
  const now = new Date();
  return toDateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function addDays(dateKey: DateKey, deltaDays: number): DateKey {
  const { year, month, day } = parseDateKey(dateKey);
  const d = new Date(year, month - 1, day + deltaDays);
  return toDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function diffDays(fromKey: DateKey, toKey: DateKey): number {
  const a = parseDateKey(fromKey);
  const b = parseDateKey(toKey);
  // UTC 자정 타임스탬프 차이를 사용해 서머타임(DST)으로 인한 ±1시간 오차를 방지함
  const utcA = Date.UTC(a.year, a.month - 1, a.day);
  const utcB = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((utcB - utcA) / 86400000);
}

/** 0=일요일 ~ 6=토요일 */
export function getDayOfWeek(dateKey: DateKey): number {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(year, month - 1, day).getDay();
}

export function getWeekStart(dateKey: DateKey, weekStartsOn: 0 | 1): DateKey {
  const dow = getDayOfWeek(dateKey);
  const offset = (dow - weekStartsOn + 7) % 7;
  return addDays(dateKey, -offset);
}

// [ID 2.2] 무한 스크롤 그리드 좌표 <-> 날짜 변환
// -> 기준 주 시작일(originWeekStart)을 원점으로 하여 모든 날짜를 (row, col) 2D 좌표로 일관되게 매핑함.
export function dateKeyToCoord(
  dateKey: DateKey,
  originWeekStart: DateKey
): { row: number; col: number } {
  const days = diffDays(originWeekStart, dateKey);
  const row = Math.floor(days / 7);
  const col = ((days % 7) + 7) % 7;
  return { row, col };
}

export function coordToDateKey(
  row: number,
  col: number,
  originWeekStart: DateKey
): DateKey {
  return addDays(originWeekStart, row * 7 + col);
}

export function getWeekdayHeaders(weekStartsOn: 0 | 1): string[] {
  return weekStartsOn === 0
    ? ["일", "월", "화", "수", "목", "금", "토"]
    : ["월", "화", "수", "목", "금", "토", "일"];
}

// [ID 4.1] 커스텀 날짜 포맷 기반 볼트 파일 경로 생성 및 역파싱
// -> 옵시디언 데일리 노트 포맷(예: YYYY-MM-DD, YYYY/MM/YYYY-MM-DD, YYYY-MM-DD (ddd))을 모두 지원하며,
//    옵시디언 런타임의 window.moment가 있으면 우선 활용하고 테스트 환경에서는 순수 폴백 파서로 동작함.

interface MomentLike {
  format(fmt: string): string;
  isValid(): boolean;
  year(): number;
  month(): number;
  date(): number;
}

type MomentFactory = (
  input: string | number[],
  format?: string,
  strict?: boolean
) => MomentLike;

function getWindowMoment(): MomentFactory | null {
  const g = globalThis as unknown as { moment?: MomentFactory };
  return typeof g.moment === "function" ? g.moment : null;
}

export function normalizeFolderPath(folderPath: string): string {
  return folderPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

// [ID 4.6] 탐색기 폴더 이동/이름 변경 시 탭 연결 경로 자동 재매핑 유틸리티
// -> 탭이 가리키는 폴더 자체 또는 그 상위 폴더가 이동/이름 변경되었을 때 새 경로를 계산하며,
//    볼트 루트("") 탭은 영향을 받지 않도록 제외함.
export function remapTabFolderPath(
  tabFolderPath: string,
  oldFolderPath: string,
  newFolderPath: string
): string | null {
  const current = normalizeFolderPath(tabFolderPath);
  const oldNorm = normalizeFolderPath(oldFolderPath);
  const newNorm = normalizeFolderPath(newFolderPath);

  if (!current || !oldNorm || oldNorm === newNorm) return null;

  if (current === oldNorm) {
    return newNorm;
  }

  const prefix = `${oldNorm}/`;
  if (current.startsWith(prefix)) {
    const suffix = current.slice(prefix.length);
    return newNorm ? `${newNorm}/${suffix}` : suffix;
  }

  return null;
}

/**
 * 순수 토큰 포맷터 (window.moment 부재 시 폴백).
 * Moment의 [리터럴], YYYY, YY, MM, M, DD, D, dddd, ddd 토큰을 지원함.
 */
export function formatDateFallback(dateKey: DateKey, format: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  const dow = getDayOfWeek(dateKey);
  const tokenRegex = /\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|dddd|ddd/g;
  return format.replace(tokenRegex, (match, escaped: string | undefined) => {
    if (escaped !== undefined) return escaped;
    switch (match) {
      case "YYYY":
        return String(year).padStart(4, "0");
      case "YY":
        return String(year % 100).padStart(2, "0");
      case "MM":
        return pad2(month);
      case "M":
        return String(month);
      case "DD":
        return pad2(day);
      case "D":
        return String(day);
      case "dddd":
        return KOREAN_WEEKDAYS_LONG[dow];
      case "ddd":
        return KOREAN_WEEKDAYS_SHORT[dow];
      default:
        return match;
    }
  });
}

export function formatDateForPath(dateKey: DateKey, dateFormat: string): string {
  const fmt = dateFormat.trim() || "YYYY-MM-DD";
  const momentFn = getWindowMoment();
  if (momentFn) {
    const { year, month, day } = parseDateKey(dateKey);
    const m = momentFn([year, month - 1, day]);
    if (m.isValid()) {
      return m.format(fmt);
    }
  }
  return formatDateFallback(dateKey, fmt);
}

/**
 * 탭의 폴더 경로 + 커스텀 날짜 포맷을 조합하여 볼트 내 최종 .md 파일 경로를 반환함.
 */
export function buildNotePath(
  folderPath: string,
  dateFormat: string,
  dateKey: DateKey
): string {
  const normalizedFolder = normalizeFolderPath(folderPath);
  const formatted = formatDateForPath(dateKey, dateFormat)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const relWithExt = formatted.endsWith(".md") ? formatted : `${formatted}.md`;
  return normalizedFolder ? `${normalizedFolder}/${relWithExt}` : relWithExt;
}

/**
 * 순수 정규식 기반 역파서 (window.moment 부재 시 및 보조 검증용).
 */
export function parseFormattedDateFallback(
  relativeNoExt: string,
  dateFormat: string
): DateKey | null {
  const fmt = dateFormat.trim() || "YYYY-MM-DD";
  const tokenRegex = /\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|dddd|ddd/g;
  const groups: string[] = [];
  let regexStr = "^";
  let lastIndex = 0;

  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(fmt)) !== null) {
    if (match.index > lastIndex) {
      regexStr += escapeRegex(fmt.slice(lastIndex, match.index));
    }
    const full = match[0];
    const escaped = match[1];
    if (escaped !== undefined) {
      regexStr += escapeRegex(escaped);
    } else {
      switch (full) {
        case "YYYY":
          groups.push("YYYY");
          regexStr += "(\\d{4})";
          break;
        case "YY":
          groups.push("YY");
          regexStr += "(\\d{2})";
          break;
        case "MM":
          groups.push("MM");
          regexStr += "(\\d{2})";
          break;
        case "M":
          groups.push("M");
          regexStr += "(\\d{1,2})";
          break;
        case "DD":
          groups.push("DD");
          regexStr += "(\\d{2})";
          break;
        case "D":
          groups.push("D");
          regexStr += "(\\d{1,2})";
          break;
        case "dddd":
        case "ddd":
          groups.push(full);
          regexStr += "([^/]+?)";
          break;
      }
    }
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex < fmt.length) {
    regexStr += escapeRegex(fmt.slice(lastIndex));
  }
  regexStr += "$";

  const m = new RegExp(regexStr).exec(relativeNoExt);
  if (!m) return null;

  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  for (let i = 0; i < groups.length; i++) {
    const val = m[i + 1];
    const tok = groups[i];
    if (tok === "YYYY") year = Number(val);
    else if (tok === "YY") year = 2000 + Number(val);
    else if (tok === "MM" || tok === "M") month = Number(val);
    else if (tok === "DD" || tok === "D") day = Number(val);
  }

  if (year === null || month === null || day === null) return null;
  const candidate = toDateKey(year, month, day);
  if (!isValidDateKey(candidate)) return null;

  // 요일 토큰(ddd 등)까지 포함한 파일명이 실제 해당 날짜의 포맷 결과와 일치하는지 교차 검증
  if (formatDateFallback(candidate, fmt) !== relativeNoExt) {
    return null;
  }
  return candidate;
}

/**
 * 볼트 파일 경로가 특정 탭(folderPath + dateFormat)에 속한 날짜 노트인지 역파싱함.
 */
export function parseNotePathToDateKey(
  filePath: string,
  folderPath: string,
  dateFormat: string
): DateKey | null {
  const normalizedFile = filePath.replace(/\\/g, "/");
  if (!normalizedFile.endsWith(".md")) return null;

  const normalizedFolder = normalizeFolderPath(folderPath);
  let relative = normalizedFile;
  if (normalizedFolder) {
    const prefix = `${normalizedFolder}/`;
    if (!normalizedFile.startsWith(prefix)) return null;
    relative = normalizedFile.slice(prefix.length);
  }

  const relativeNoExt = relative.slice(0, -3);
  const fmt = dateFormat.trim() || "YYYY-MM-DD";

  const momentFn = getWindowMoment();
  if (momentFn) {
    const parsed = momentFn(relativeNoExt, fmt, true);
    if (parsed.isValid()) {
      const dateKey = toDateKey(
        parsed.year(),
        parsed.month() + 1,
        parsed.date()
      );
      // 생성 경로와 완전 일치할 때만 해당 탭의 날짜 노트로 인정
      if (formatDateForPath(dateKey, fmt) === relativeNoExt) {
        return dateKey;
      }
    }
  }

  return parseFormattedDateFallback(relativeNoExt, fmt);
}

