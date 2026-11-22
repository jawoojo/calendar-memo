import { DateKey, RecurringEvent } from "../types";
import {
  getDayOfWeek,
  getDaysInMonth,
  parseDateKey,
  toDateKey,
} from "./dateUtils";

// [ID 3.1] 반복 일정 매칭 및 영업일 산술 엔진
// -> 매일/매주(요일)/매월(일자)/영업일(매 영업일, N번째 영업일, 마지막 영업일) 규칙을 계산하며,
//    .md 파일을 생성하지 않고 캘린더 셀 상단 오버레이로 표시할 일정을 순수 함수로 산출함.

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

export type IsBusinessDayFn = (dateKey: DateKey) => boolean;

/**
 * 특정 연·월의 모든 영업일 목록(정렬된 DateKey[])을 반환함.
 */
export function getMonthlyBusinessDays(
  year: number,
  month: number,
  isBusinessDay: IsBusinessDayFn
): DateKey[] {
  const totalDays = getDaysInMonth(year, month);
  const days: DateKey[] = [];
  for (let d = 1; d <= totalDays; d++) {
    const key = toDateKey(year, month, d);
    if (isBusinessDay(key)) {
      days.push(key);
    }
  }
  return days;
}

/**
 * 특정 반복 일정이 주어진 날짜(dateKey)와 탭(tabId)에 표시되어야 하는지 판별함.
 */
export function doesRecurringEventOccurOn(
  event: RecurringEvent,
  dateKey: DateKey,
  activeTabId: string,
  isBusinessDay: IsBusinessDayFn
): boolean {
  // 탭 범위 필터링 (모든 탭 공통 또는 현재 탭 전용)
  if (event.scope === "tab" && event.tabId !== activeTabId) {
    return false;
  }

  // 시작일 / 종료일 범위 검사 (YYYY-MM-DD 문자열 사전순 비교가 날짜순과 일치)
  if (dateKey < event.startDate) return false;
  if (event.endDate && dateKey > event.endDate) return false;

  // 특정 날짜 숨김(제외) 처리
  if (event.excludedDates.includes(dateKey)) return false;

  const { year, month, day } = parseDateKey(dateKey);

  switch (event.frequency) {
    case "daily":
      return true;

    case "weekly": {
      const dow = getDayOfWeek(dateKey);
      return (event.weekdays ?? []).includes(dow);
    }

    case "monthly": {
      const targetDay = event.dayOfMonth ?? 1;
      const lastDay = getDaysInMonth(year, month);
      // 31일 설정 시 2월·4월 등 짧은 달에서는 해당 월의 말일에 표시
      const effectiveDay = Math.min(targetDay, lastDay);
      return day === effectiveDay;
    }

    // [ID 3.1.1] 매년 반복 (월·일 지정, 윤년 2/29는 평년 2/28로 안전 보정)
    case "yearly": {
      const targetMonth = event.monthOfYear ?? 1;
      if (month !== targetMonth) return false;
      const targetDay = event.dayOfMonth ?? 1;
      const lastDay = getDaysInMonth(year, month);
      const effectiveDay = Math.min(targetDay, lastDay);
      return day === effectiveDay;
    }

    case "businessDay": {
      if (!isBusinessDay(dateKey)) return false;
      const nth = event.businessDayNth ?? 0;
      if (nth === 0) {
        // 매 영업일
        return true;
      }
      const bDays = getMonthlyBusinessDays(year, month, isBusinessDay);
      if (bDays.length === 0) return false;
      if (nth > 0) {
        const idx = Math.min(nth - 1, bDays.length - 1);
        return bDays[idx] === dateKey;
      }
      // nth < 0: 예) -1은 마지막 영업일, -2는 끝에서 두 번째 영업일
      const idxFromEnd = Math.max(0, bDays.length + nth);
      return bDays[idxFromEnd] === dateKey;
    }

    default:
      return false;
  }
}

export interface ResolvedRecurringOccurrence {
  event: RecurringEvent;
  dateKey: DateKey;
  completed: boolean;
}

export function getRecurringEventsForDate(
  events: RecurringEvent[],
  dateKey: DateKey,
  activeTabId: string,
  isBusinessDay: IsBusinessDayFn
): ResolvedRecurringOccurrence[] {
  const matched: ResolvedRecurringOccurrence[] = [];
  for (const event of events) {
    if (doesRecurringEventOccurOn(event, dateKey, activeTabId, isBusinessDay)) {
      matched.push({
        event,
        dateKey,
        completed: event.completedDates.includes(dateKey),
      });
    }
  }
  return matched;
}

export function toggleRecurringCompletion(
  event: RecurringEvent,
  dateKey: DateKey
): boolean {
  const idx = event.completedDates.indexOf(dateKey);
  if (idx >= 0) {
    event.completedDates.splice(idx, 1);
    return false;
  }
  event.completedDates.push(dateKey);
  return true;
}

export function excludeRecurringOccurrence(
  event: RecurringEvent,
  dateKey: DateKey
): void {
  if (!event.excludedDates.includes(dateKey)) {
    event.excludedDates.push(dateKey);
  }
}

export function describeRecurringEvent(event: RecurringEvent): string {
  switch (event.frequency) {
    case "daily":
      return "매일";
    case "weekly": {
      const days = [...(event.weekdays ?? [])]
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_LABELS[d] ?? "")
        .filter(Boolean);
      return days.length > 0 ? `매주 ${days.join("·")}` : "매주";
    }
    case "monthly":
      return `매월 ${event.dayOfMonth ?? 1}일`;
    case "yearly":
      return `매년 ${event.monthOfYear ?? 1}월 ${event.dayOfMonth ?? 1}일`;
    case "businessDay": {
      const nth = event.businessDayNth ?? 0;
      if (nth === 0) return "매 영업일";
      if (nth === -1) return "매월 마지막 영업일";
      if (nth < 0) return `매월 끝에서 ${Math.abs(nth)}번째 영업일`;
      return `매월 ${nth}번째 영업일`;
    }
  }
}

