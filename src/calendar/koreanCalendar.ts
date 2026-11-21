import KoreanLunarCalendar from "korean-lunar-calendar";
import {
  getHolidays as getCoreHolidays,
  hasYear as coreHasYear,
} from "@hangukit/holidays-core";
import {
  CustomHoliday,
  DateKey,
  DayCalendarMeta,
  LunarDisplayMode,
} from "../types";
import {
  addDays,
  getDayOfWeek,
  parseDateKey,
  toDateKey,
} from "./dateUtils";

// [ID 2.3] 오프라인 한국형 캘린더 엔진 (공휴일·대체공휴일·기념일·음력·커스텀 휴일)
// -> 2021~2026년은 관보 검증된 @hangukit/holidays-core 데이터를 사용하고,
//    미수록 연도(2027년 이후 등)는 korean-lunar-calendar와 「공휴일에 관한 법률」 규칙으로
//    법정·음력·대체공휴일을 오프라인 자체 산출하여 영구 동작을 보장함.

interface YearHolidayMap {
  /** dateKey -> 공휴일명 목록 */
  holidays: Map<DateKey, string[]>;
  /** dateKey -> 기념일명 목록 */
  anniversaries: Map<DateKey, string[]>;
}

const SOLAR_ANNIVERSARIES: Array<{ month: number; day: number; name: string }> = [
  { month: 4, day: 5, name: "식목일" },
  { month: 4, day: 19, name: "4·19혁명" },
  { month: 5, day: 8, name: "어버이날" },
  { month: 5, day: 15, name: "스승의날" },
  { month: 6, day: 25, name: "6·25" },
  { month: 10, day: 1, name: "국군의날" },
  { month: 10, day: 25, name: "독도의날" },
];

const LUNAR_ANNIVERSARIES: Array<{ month: number; day: number; name: string }> = [
  { month: 1, day: 15, name: "정월대보름" },
  { month: 5, day: 5, name: "단오" },
  { month: 7, day: 7, name: "칠석" },
];

function pushUnique(map: Map<DateKey, string[]>, key: DateKey, label: string): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [label]);
  } else if (!list.includes(label)) {
    list.push(label);
  }
}

export class KoreanCalendarService {
  private lunarInstance = new KoreanLunarCalendar();
  private yearCache = new Map<number, YearHolidayMap>();
  private lunarCache = new Map<
    DateKey,
    { year: number; month: number; day: number; isLeap: boolean }
  >();
  private customHolidays: CustomHoliday[] = [];

  setCustomHolidays(customHolidays: CustomHoliday[]): void {
    this.customHolidays = customHolidays;
    // 커스텀 휴일 변경 시 연도 캐시를 비워 즉시 반영
    this.yearCache.clear();
  }

  /**
   * 양력 날짜 -> 음력 날짜 변환 (메모이제이션 적용).
   */
  getLunarDate(dateKey: DateKey): {
    year: number;
    month: number;
    day: number;
    isLeap: boolean;
  } {
    const cached = this.lunarCache.get(dateKey);
    if (cached) return cached;

    const { year, month, day } = parseDateKey(dateKey);
    const valid = this.lunarInstance.setSolarDate(year, month, day);
    if (!valid) {
      const fallback = { year, month, day, isLeap: false };
      this.lunarCache.set(dateKey, fallback);
      return fallback;
    }

    const lunar = this.lunarInstance.getLunarCalendar();
    const res = {
      year: lunar.year,
      month: lunar.month,
      day: lunar.day,
      isLeap: Boolean(lunar.intercalation),
    };
    this.lunarCache.set(dateKey, res);
    return res;
  }

  /**
   * 음력 (연, 월, 일) -> 양력 DateKey 변환.
   */
  private lunarToSolarKey(
    lunarYear: number,
    lunarMonth: number,
    lunarDay: number,
    isIntercalation = false
  ): DateKey | null {
    const ok = this.lunarInstance.setLunarDate(
      lunarYear,
      lunarMonth,
      lunarDay,
      isIntercalation
    );
    if (!ok) return null;
    const solar = this.lunarInstance.getSolarCalendar();
    return toDateKey(solar.year, solar.month, solar.day);
  }

  private getYearData(year: number): YearHolidayMap {
    const cached = this.yearCache.get(year);
    if (cached) return cached;

    const holidays = new Map<DateKey, string[]>();
    const anniversaries = new Map<DateKey, string[]>();

    // 1) 법정 공휴일 및 대체공휴일 계산
    if (coreHasYear(year)) {
      for (const entry of getCoreHolidays(year)) {
        pushUnique(holidays, entry.date, entry.name);
      }
    } else {
      this.computeFallbackHolidaysForYear(year, holidays);
    }

    // 2) 주요 양력 기념일
    for (const item of SOLAR_ANNIVERSARIES) {
      pushUnique(anniversaries, toDateKey(year, item.month, item.day), item.name);
    }

    // 3) 주요 음력 기념일
    for (const item of LUNAR_ANNIVERSARIES) {
      const solarKey = this.lunarToSolarKey(year, item.month, item.day, false);
      if (solarKey && parseDateKey(solarKey).year === year) {
        pushUnique(anniversaries, solarKey, item.name);
      }
    }

    // 4) 사용자 커스텀 휴일 / 기념일 반영
    for (const ch of this.customHolidays) {
      if (ch.year !== undefined && ch.year !== year) continue;
      let targetKey: DateKey | null = null;
      if (ch.isLunar) {
        // 음력 연말(12월)은 양력 다음 해 1~2월에 걸칠 수 있으므로 year-1과 year 둘 다 검사
        for (const ly of [year - 1, year]) {
          const candidate = this.lunarToSolarKey(ly, ch.month, ch.day, false);
          if (candidate && parseDateKey(candidate).year === year) {
            targetKey = candidate;
            break;
          }
        }
      } else {
        targetKey = toDateKey(year, ch.month, ch.day);
      }

      if (targetKey) {
        if (ch.isHoliday) {
          pushUnique(holidays, targetKey, ch.name);
        } else {
          pushUnique(anniversaries, targetKey, ch.name);
        }
      }
    }

    const result: YearHolidayMap = { holidays, anniversaries };
    this.yearCache.set(year, result);
    return result;
  }

  /**
   * [ID 2.4] 미수록 연도(2027년 이후 등) 오프라인 한국 법정/대체공휴일 자동 산출
   * -> 「공휴일에 관한 법률」 현행 규정(삼일절·어린이날·부처님오신날·제헌절·광복절·개천절·한글날·성탄절
   *    주말/타공휴일 겹침 대체공휴일, 설날·추석 일요일/타공휴일 겹침 대체공휴일)을 적용함.
   */
  private computeFallbackHolidaysForYear(
    year: number,
    holidays: Map<DateKey, string[]>
  ): void {
    const fixedHolidays: Array<{
      month: number;
      day: number;
      name: string;
      substituteOnWeekend: boolean;
    }> = [
      { month: 1, day: 1, name: "신정", substituteOnWeekend: false },
      { month: 3, day: 1, name: "삼일절", substituteOnWeekend: true },
      { month: 5, day: 5, name: "어린이날", substituteOnWeekend: true },
      { month: 6, day: 6, name: "현충일", substituteOnWeekend: false },
      { month: 8, day: 15, name: "광복절", substituteOnWeekend: true },
      { month: 10, day: 3, name: "개천절", substituteOnWeekend: true },
      { month: 10, day: 9, name: "한글날", substituteOnWeekend: true },
      { month: 12, day: 25, name: "기독탄신일", substituteOnWeekend: true },
    ];

    if (year >= 2026) {
      fixedHolidays.push({
        month: 5,
        day: 1,
        name: "근로자의날",
        substituteOnWeekend: false,
      });
      fixedHolidays.push({
        month: 7,
        day: 17,
        name: "제헌절",
        substituteOnWeekend: true,
      });
    }

    const substituteCandidates: Array<{
      dateKey: DateKey;
      name: string;
      includeSaturday: boolean;
    }> = [];

    for (const item of fixedHolidays) {
      const key = toDateKey(year, item.month, item.day);
      pushUnique(holidays, key, item.name);
      if (item.substituteOnWeekend) {
        substituteCandidates.push({
          dateKey: key,
          name: item.name,
          includeSaturday: true,
        });
      }
    }

    // 음력 설날(1/1 전날·당일·다음날), 부처님오신날(4/8), 추석(8/14·15·16)
    const seollal = this.lunarToSolarKey(year, 1, 1, false);
    if (seollal) {
      const seolDays = [addDays(seollal, -1), seollal, addDays(seollal, 1)];
      for (const dk of seolDays) {
        if (parseDateKey(dk).year === year) {
          pushUnique(holidays, dk, "설날");
          substituteCandidates.push({
            dateKey: dk,
            name: "설날",
            includeSaturday: false,
          });
        }
      }
    }

    const buddha = this.lunarToSolarKey(year, 4, 8, false);
    if (buddha && parseDateKey(buddha).year === year) {
      pushUnique(holidays, buddha, "부처님오신날");
      substituteCandidates.push({
        dateKey: buddha,
        name: "부처님오신날",
        includeSaturday: true,
      });
    }

    const chuseok = this.lunarToSolarKey(year, 8, 15, false);
    if (chuseok) {
      const chuseokDays = [addDays(chuseok, -1), chuseok, addDays(chuseok, 1)];
      for (const dk of chuseokDays) {
        if (parseDateKey(dk).year === year) {
          pushUnique(holidays, dk, "추석");
          substituteCandidates.push({
            dateKey: dk,
            name: "추석",
            includeSaturday: false,
          });
        }
      }
    }

    // 대체공휴일 배정 (날짜 오름차순으로 처리해 연휴 겹침 시 순차 배치)
    substituteCandidates.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    const grantedForEvent = new Set<string>();

    for (const cand of substituteCandidates) {
      const dow = getDayOfWeek(cand.dateKey);
      const existingCount = holidays.get(cand.dateKey)?.length ?? 0;
      const overlapsAnotherHoliday = existingCount > 1;
      const overlapsSunday = dow === 0;
      const overlapsSaturday = cand.includeSaturday && dow === 6;

      if (!overlapsSunday && !overlapsSaturday && !overlapsAnotherHoliday) {
        continue;
      }

      // 설날/추석 연휴 내 중복 부여 방지
      const eventKey = `${cand.name}-${cand.dateKey.slice(0, 7)}`;
      if (
        (cand.name === "설날" || cand.name === "추석") &&
        grantedForEvent.has(eventKey)
      ) {
        continue;
      }
      grantedForEvent.add(eventKey);

      let next = addDays(cand.dateKey, 1);
      while (
        getDayOfWeek(next) === 0 ||
        getDayOfWeek(next) === 6 ||
        holidays.has(next)
      ) {
        next = addDays(next, 1);
      }
      if (parseDateKey(next).year === year) {
        pushUnique(holidays, next, `대체공휴일(${cand.name})`);
      }
    }
  }

  /**
   * 영업일 여부 판별 (토·일, 법정/대체공휴일, 사용자 커스텀 공휴일 제외).
   */
  isBusinessDay(dateKey: DateKey): boolean {
    const dow = getDayOfWeek(dateKey);
    if (dow === 0 || dow === 6) return false;
    const { year } = parseDateKey(dateKey);
    const data = this.getYearData(year);
    return !data.holidays.has(dateKey);
  }

  /**
   * 캘린더 셀 렌더링에 필요한 공휴일·기념일·음력 메타데이터 일괄 조회.
   */
  getDayMeta(
    dateKey: DateKey,
    lunarDisplay: LunarDisplayMode,
    showAnniversaries: boolean
  ): DayCalendarMeta {
    const { year } = parseDateKey(dateKey);
    const yearData = this.getYearData(year);
    const holidayNames = yearData.holidays.get(dateKey) ?? [];
    const anniversaryNames = showAnniversaries
      ? yearData.anniversaries.get(dateKey) ?? []
      : [];

    const lunar = this.getLunarDate(dateKey);
    let lunarLabel: string | null = null;
    if (lunarDisplay === "always") {
      lunarLabel = `${lunar.isLeap ? "윤" : ""}${lunar.month}.${lunar.day}`;
    } else if (
      lunarDisplay === "periodic" &&
      (lunar.day === 1 || lunar.day === 15)
    ) {
      lunarLabel = `${lunar.isLeap ? "윤" : ""}${lunar.month}.${lunar.day}`;
    }

    return {
      dateKey,
      isHoliday: holidayNames.length > 0,
      holidayNames,
      anniversaryNames,
      lunarLabel,
      lunarMonth: lunar.month,
      lunarDay: lunar.day,
      lunarIsLeap: lunar.isLeap,
    };
  }
}

