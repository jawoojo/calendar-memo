import { describe, expect, it } from "vitest";
import {
  addDays,
  buildNotePath,
  coordToDateKey,
  dateKeyToCoord,
  diffDays,
  getWeekStart,
  parseNotePathToDateKey,
  parseObsidianUriToFilePath,
  remapTabFolderPath,
} from "../src/calendar/dateUtils";
import { KoreanCalendarService } from "../src/calendar/koreanCalendar";
import {
  describeRecurringEvent,
  getRecurringEventsForDate,
  toggleRecurringCompletion,
} from "../src/calendar/recurringEvents";
import {
  GridUndoHistory,
  computePasteTargets,
  extractIncompleteTasks,
  formatExternalClipboardText,
  getSelectedCells,
  mergeMemoContentForAppend,
} from "../src/editor/clipboardAndHistory";
import { ALL_TABS_ID, RecurringEvent } from "../src/types";
import { getStrings } from "../src/i18n";
import { matchEmojiHighlightPrefix } from "../src/ui/highlightHelper";

describe("dateUtils & custom Daily Notes date formats", () => {
  it("handles local date arithmetic without timezone drift", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(diffDays("2026-11-21", "2026-11-28")).toBe(7);
    expect(getWeekStart("2026-11-21", 0)).toBe("2026-11-15");
    expect(getWeekStart("2026-11-21", 1)).toBe("2026-11-16");
  });

  it("maps dates to 2D coordinates and back accurately", () => {
    const origin = getWeekStart("2026-11-21", 0); // 2026-11-15 (Sun)
    const coord = dateKeyToCoord("2026-11-21", origin);
    expect(coord).toEqual({ row: 0, col: 6 });
    expect(coordToDateKey(coord.row, coord.col, origin)).toBe("2026-11-21");

    const prevCoord = dateKeyToCoord("2026-11-14", origin);
    expect(prevCoord).toEqual({ row: -1, col: 6 });
    expect(coordToDateKey(prevCoord.row, prevCoord.col, origin)).toBe("2026-11-14");
  });

  it("builds and reverse-parses custom date format paths including nested folders", () => {
    const path1 = buildNotePath("Daily", "YYYY/MM/YYYY-MM-DD", "2026-11-21");
    expect(path1).toBe("Daily/2026/11/2026-11-21.md");
    expect(
      parseNotePathToDateKey(path1, "Daily", "YYYY/MM/YYYY-MM-DD")
    ).toBe("2026-11-21");

    const path2 = buildNotePath("Work", "YYYY-MM-DD (ddd)", "2026-11-21");
    expect(path2).toBe("Work/2026-11-21 (토).md");
    expect(
      parseNotePathToDateKey(path2, "Work", "YYYY-MM-DD (ddd)")
    ).toBe("2026-11-21");
    // 잘못된 요일 파일명은 매칭되지 않아야 함
    expect(
      parseNotePathToDateKey("Work/2026-11-21 (일).md", "Work", "YYYY-MM-DD (ddd)")
    ).toBeNull();
  });
});

describe("KoreanCalendarService (holidays, substitute holidays, lunar, custom)", () => {
  it("loads 2026 statutory & substitute holidays from @hangukit/holidays-core", () => {
    const cal = new KoreanCalendarService();
    const samilSub = cal.getDayMeta("2026-03-02", "periodic", true);
    expect(samilSub.isHoliday).toBe(true);
    expect(cal.isBusinessDay("2026-03-02")).toBe(false);
    expect(cal.isBusinessDay("2026-03-03")).toBe(true);
  });

  it("computes 2027+ holidays & substitute holidays offline via korean-lunar-calendar", () => {
    const cal = new KoreanCalendarService();
    // 2027년 광복절(8/15)은 일요일 -> 8/16 월요일 대체공휴일
    const aug15 = cal.getDayMeta("2027-08-15", "periodic", true);
    const aug16 = cal.getDayMeta("2027-08-16", "periodic", true);
    expect(aug15.isHoliday).toBe(true);
    expect(aug16.isHoliday).toBe(true);
    expect(aug16.holidayNames.some((n) => n.includes("대체공휴일"))).toBe(true);
    expect(cal.isBusinessDay("2027-08-16")).toBe(false);
  });

  it("supports custom solar and lunar holidays", () => {
    const cal = new KoreanCalendarService();
    cal.setCustomHolidays([
      {
        id: "ch-1",
        name: "창립기념일",
        month: 11,
        day: 24,
        isHoliday: true,
      },
      {
        id: "ch-2",
        name: "기념일테스트",
        month: 11,
        day: 25,
        isHoliday: false,
      },
    ]);
    expect(cal.isBusinessDay("2026-11-24")).toBe(false);
    expect(cal.getDayMeta("2026-11-24", "off", true).holidayNames).toContain(
      "창립기념일"
    );
    expect(cal.isBusinessDay("2026-11-25")).toBe(true);
    expect(cal.getDayMeta("2026-11-25", "off", true).anniversaryNames).toContain(
      "기념일테스트"
    );
  });
});

describe("RecurringEvents (daily, weekly, monthly, businessDay, scope)", () => {
  const cal = new KoreanCalendarService();
  const isBiz = (dk: string) => cal.isBusinessDay(dk);

  it("matches weekly, monthly clamped, and Nth/last business day rules", () => {
    const events: RecurringEvent[] = [
      {
        id: "r1",
        title: "월말 정산",
        frequency: "businessDay",
        businessDayNth: -1,
        startDate: "2026-01-01",
        scope: "tab",
        tabId: "work",
        completedDates: [],
        excludedDates: [],
      },
      {
        id: "r2",
        title: "첫 영업일 점검",
        frequency: "businessDay",
        businessDayNth: 1,
        startDate: "2026-01-01",
        scope: "all",
        completedDates: [],
        excludedDates: [],
      },
      {
        id: "r3",
        title: "말일 루틴",
        frequency: "monthly",
        dayOfMonth: 31,
        startDate: "2026-01-01",
        scope: "all",
        completedDates: [],
        excludedDates: [],
      },
      {
        id: "r4",
        title: "연간 갱신",
        frequency: "yearly",
        monthOfYear: 2,
        dayOfMonth: 29,
        startDate: "2024-01-01",
        scope: "all",
        completedDates: [],
        excludedDates: [],
      },
    ];

    // 2026-03-01(일) 삼일절, 2026-03-02(월) 대체공휴일 -> 첫 영업일은 2026-03-03(화)!
    const mar2 = getRecurringEventsForDate(events, "2026-03-02", "work", isBiz);
    const mar3 = getRecurringEventsForDate(events, "2026-03-03", "work", isBiz);
    expect(mar2.map((x) => x.event.id)).not.toContain("r2");
    expect(mar3.map((x) => x.event.id)).toContain("r2");

    // 2026-02-28(토) 말일 루틴(31일 설정) & 윤년 2/29 매년 반복 모두 2/28에 보정 표시됨
    const feb28 = getRecurringEventsForDate(events, "2026-02-28", "default", isBiz);
    expect(feb28.map((x) => x.event.id)).toContain("r3");
    expect(feb28.map((x) => x.event.id)).toContain("r4");
    expect(
      getRecurringEventsForDate(events, "2028-02-29", "default", isBiz).map(
        (x) => x.event.id
      )
    ).toContain("r4");
    expect(describeRecurringEvent(events[3])).toBe("매년 2월 29일");

    // 2026-11 마지막 영업일은 2026-11-30(월) — work 탭에서만 보이고 default 탭엔 안 보임
    expect(
      getRecurringEventsForDate(events, "2026-11-30", "work", isBiz).map(
        (x) => x.event.id
      )
    ).toContain("r1");
    expect(
      getRecurringEventsForDate(events, "2026-11-30", "default", isBiz).map(
        (x) => x.event.id
      )
    ).not.toContain("r1");

    expect(describeRecurringEvent(events[0])).toBe("매월 마지막 영업일");
    expect(toggleRecurringCompletion(events[0], "2026-11-30")).toBe(true);
    expect(toggleRecurringCompletion(events[0], "2026-11-30")).toBe(false);
  });
});

describe("2D Excel selection, external clipboard format, and Undo/Redo", () => {
  it("selects 2D rectangular cells and formats non-empty dates for external paste", () => {
    const origin = "2026-11-15"; // Sun
    // 2x2 rect: (row 0..1, col 1..2) -> Mon/Tue of two consecutive weeks
    const cells = getSelectedCells(
      { anchor: { row: 0, col: 1 }, focus: { row: 1, col: 2 } },
      origin
    );
    expect(cells.map((c) => c.dateKey)).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-23",
      "2026-11-24",
    ]);

    const external = formatExternalClipboardText([
      { dateKey: "2026-11-16", content: "월요일 메모\n둘째 줄" },
      { dateKey: "2026-11-17", content: "   " }, // 비어있는 날짜 제외!
      { dateKey: "2026-11-23", content: "다음주 월요일" },
    ]);

    expect(external).toBe(
      "[2026-11-16]\n월요일 메모\n둘째 줄\n\n[2026-11-23]\n다음주 월요일"
    );
  });

  it("pastes 2D clipboard preserving relative layout and supports external text paste", () => {
    const origin = "2026-11-15";
    const externalText = "[2026-11-16]\nA\n\n[2026-11-24]\nB";
    const internal = {
      width: 2,
      height: 2,
      cells: [
        { relRow: 0, relCol: 0, content: "A" },
        { relRow: 0, relCol: 1, content: "" },
        { relRow: 1, relCol: 0, content: "" },
        { relRow: 1, relCol: 1, content: "B" },
      ],
      externalText,
    };

    // 내부 2D 붙여넣기: (row 0, col 3) = 2026-11-18 기준
    const pastedInternal = computePasteTargets(
      internal,
      externalText,
      { anchor: { row: 0, col: 3 }, focus: { row: 0, col: 3 } },
      origin
    );
    expect(pastedInternal).toEqual([
      { dateKey: "2026-11-18", content: "A" },
      { dateKey: "2026-11-19", content: "" },
      { dateKey: "2026-11-25", content: "" },
      { dateKey: "2026-11-26", content: "B" },
    ]);

    // 외부 앱에서 다른 텍스트를 복사해 붙여넣은 경우
    const pastedExternal = computePasteTargets(
      internal,
      "외부 복사 텍스트",
      { anchor: { row: 0, col: 3 }, focus: { row: 0, col: 4 } },
      origin
    );
    expect(pastedExternal).toEqual([
      { dateKey: "2026-11-18", content: "외부 복사 텍스트" },
      { dateKey: "2026-11-19", content: "외부 복사 텍스트" },
    ]);
  });

  it("tracks Undo/Redo batches cleanly", () => {
    const history = new GridUndoHistory();
    history.push({
      label: "색상 변경",
      changes: [
        { type: "color", tabId: "default", dateKey: "2026-11-21", before: "", after: "blue" },
      ],
    });
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);

    const undone = history.popUndo();
    expect(undone?.label).toBe("색상 변경");
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    const redone = history.popRedo();
    expect(redone?.label).toBe("색상 변경");
  });
});

describe("Emoji-prefix highlight helper", () => {
  it("matches color emoji prefixes and strips prefix cleanly", () => {
    expect(matchEmojiHighlightPrefix("🔵파란색 내용")).toEqual({
      color: "blue",
      strippedText: "파란색 내용",
      prefixLength: "🔵".length,
    });
    expect(matchEmojiHighlightPrefix("🟠 주황색 내용")).toEqual({
      color: "orange",
      strippedText: "주황색 내용",
      prefixLength: "🟠".length + 1,
    });
    expect(matchEmojiHighlightPrefix("🟢ㅏㅡ,,ㅡ")).toEqual({
      color: "green",
      strippedText: "ㅏㅡ,,ㅡ",
      prefixLength: "🟢".length,
    });
    expect(matchEmojiHighlightPrefix("일반 노란 하이라이트")).toBeNull();
  });
});

describe("Append paste merge & folder rename remapping", () => {
  it("appends incoming memo below existing content and preserves existing when incoming is blank", () => {
    expect(mergeMemoContentForAppend("", "신규 행사")).toBe("신규 행사");
    expect(mergeMemoContentForAppend("기존 메모\n", "추가 행사")).toBe(
      "기존 메모\n추가 행사"
    );
    expect(mergeMemoContentForAppend("기존 메모", "   ")).toBe("기존 메모");
  });

  it("remaps exact and nested tab folder paths on folder move/rename", () => {
    expect(remapTabFolderPath("수능업무", "수능업무", "2026/수능업무")).toBe(
      "2026/수능업무"
    );
    expect(
      remapTabFolderPath("업무/프로젝트A", "업무", "아카이브/업무")
    ).toBe("아카이브/업무/프로젝트A");
    // 다른 폴더나 볼트 루트는 변경되지 않아야 함
    expect(remapTabFolderPath("업무2", "업무", "아카이브/업무")).toBeNull();
    expect(remapTabFolderPath("", "업무", "아카이브/업무")).toBeNull();
  });
});

describe("Multi-country cached holidays (preserving Korean offline engine)", () => {
  it("uses cached foreign country holidays, respects localName toggle, and triggers lazy fetch for uncached years", () => {
    const cal = new KoreanCalendarService();
    const missingCalls: Array<{ code: string; year: number }> = [];
    cal.setMissingYearHandler((code, year) => missingCalls.push({ code, year }));

    const cache = {
      JP: {
        "2026": [
          { date: "2026-01-01", name: "New Year's Day", localName: "元日" },
          { date: "2026-11-23", name: "Labour Thanksgiving Day", localName: "勤労感謝の日" },
        ],
      },
    };

    // 일본(현지어 우선) 모드
    cal.setHolidayCountryConfig("JP", true, cache);
    const jpNov23 = cal.getDayMeta("2026-11-23", "off", true);
    expect(jpNov23.isHoliday).toBe(true);
    expect(jpNov23.holidayNames).toEqual(["勤労感謝の日"]);
    expect(cal.isBusinessDay("2026-11-23")).toBe(false);
    // 한국 전용 기념일(어버이날 5/8)은 일본 모드에서 표시되지 않아야 함
    expect(cal.getDayMeta("2026-05-08", "off", true).anniversaryNames).toEqual([]);

    // 영문명 모드 전환
    cal.setHolidayCountryConfig("JP", false, cache);
    expect(cal.getDayMeta("2026-11-23", "off", true).holidayNames).toEqual([
      "Labour Thanksgiving Day",
    ]);

    // 미캐시 연도(2028) 조회 시 온디맨드 콜백 호출
    cal.getDayMeta("2028-01-01", "off", true);
    expect(missingCalls).toEqual([{ code: "JP", year: 2028 }]);

    // 다시 KR로 복귀하면 기존 한국 오프라인 엔진 그대로 동작
    cal.setHolidayCountryConfig("KR", true, cache);
    expect(cal.getDayMeta("2026-03-02", "periodic", true).isHoliday).toBe(true);
  });

  it("extracts vault file path from obsidian://open drag URI", () => {
    expect(
      parseObsidianUriToFilePath(
        "obsidian://open?vault=MyVault&file=%ED%9A%8C%EC%9D%98%EB%A1%9D%2F2026%20%EA%B3%84%ED%9A%8D"
      )
    ).toBe("회의록/2026 계획");
    expect(parseObsidianUriToFilePath("plain text")).toBeNull();
  });
});

describe("Carry-over incomplete tasks, All-tabs recurring, and i18n", () => {
  it("extracts unchecked tasks with indented children while keeping completed tasks and notes", () => {
    const md = [
      "회의 메모",
      "- [x] 완료된 할 일",
      "- [ ] 미완료 할 일 1",
      "  - 하위 참고사항",
      "- [ ] 미완료 할 일 2",
      "일반 문장",
    ].join("\n");

    const { remaining, movedTasks } = extractIncompleteTasks(md);
    expect(movedTasks).toEqual([
      "- [ ] 미완료 할 일 1\n  - 하위 참고사항",
      "- [ ] 미완료 할 일 2",
    ]);
    expect(remaining).toBe("회의 메모\n- [x] 완료된 할 일\n일반 문장");
  });

  it("returns recurring events from all tabs when ALL_TABS_ID is active", () => {
    const cal = new KoreanCalendarService();
    const events: RecurringEvent[] = [
      {
        id: "t1",
        title: "업무 루틴",
        frequency: "daily",
        startDate: "2026-01-01",
        scope: "tab",
        tabId: "work",
        completedDates: [],
        excludedDates: [],
      },
      {
        id: "t2",
        title: "개인 루틴",
        frequency: "daily",
        startDate: "2026-01-01",
        scope: "tab",
        tabId: "personal",
        completedDates: [],
        excludedDates: [],
      },
    ];
    const allMatched = getRecurringEventsForDate(
      events,
      "2026-11-22",
      ALL_TABS_ID,
      (dk) => cal.isBusinessDay(dk)
    );
    expect(allMatched.map((x) => x.event.id)).toEqual(["t1", "t2"]);
  });

  it("provides Korean and English UI string tables", () => {
    expect(getStrings("ko").todayBtn).toBe("오늘");
    expect(getStrings("en").todayBtn).toBe("Today");
    expect(getStrings("en").formatYearMonth(2026, 11)).toBe("Nov 2026");
  });
});

