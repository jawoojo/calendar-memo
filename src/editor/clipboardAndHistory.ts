import { DateKey } from "../types";
import { coordToDateKey } from "../calendar/dateUtils";

// [ID 7.1] 엑셀형 2D 직사각형 선택, 복붙(내부 2D + 외부 클립보드), 그리드 Undo/Redo 엔진
// -> 캘린더 내부에서는 2D 상대 좌표를 유지해 붙여넣고, 외부 메모장 등에서는 비어있는 날짜를 제외한
//    [YYYY-MM-DD]\n내용 형식으로 자연스럽게 붙여넣기 되도록 이중 클립보드 구조를 설계함.

export interface GridCoord {
  row: number;
  col: number;
}

export interface SelectionRange {
  anchor: GridCoord;
  focus: GridCoord;
}

export interface RectBounds {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface SelectedCellInfo {
  dateKey: DateKey;
  row: number;
  col: number;
  relRow: number;
  relCol: number;
}

export function getRectBounds(range: SelectionRange): RectBounds {
  return {
    minRow: Math.min(range.anchor.row, range.focus.row),
    maxRow: Math.max(range.anchor.row, range.focus.row),
    minCol: Math.min(range.anchor.col, range.focus.col),
    maxCol: Math.max(range.anchor.col, range.focus.col),
  };
}

export function isCoordInRange(
  coord: GridCoord,
  range: SelectionRange | null
): boolean {
  if (!range) return false;
  const b = getRectBounds(range);
  return (
    coord.row >= b.minRow &&
    coord.row <= b.maxRow &&
    coord.col >= b.minCol &&
    coord.col <= b.maxCol
  );
}

/**
 * 선택된 직사각형 영역 내의 모든 셀을 행 우선(시간순)으로 반환함.
 */
export function getSelectedCells(
  range: SelectionRange,
  originWeekStart: DateKey
): SelectedCellInfo[] {
  const b = getRectBounds(range);
  const result: SelectedCellInfo[] = [];
  for (let r = b.minRow; r <= b.maxRow; r++) {
    for (let c = b.minCol; c <= b.maxCol; c++) {
      result.push({
        dateKey: coordToDateKey(r, c, originWeekStart),
        row: r,
        col: c,
        relRow: r - b.minRow,
        relCol: c - b.minCol,
      });
    }
  }
  return result;
}

// [ID 7.1.1] 외부 앱 붙여넣기용 텍스트 포맷터
// -> 요구사항: 여러 셀 복사 후 메모장 등에 붙여넣기 시 비어있는 날짜는 제외하고
//    [YYYY-MM-DD]\n내용 형태로 주르륵 출력함.
export function formatExternalClipboardText(
  entries: Array<{ dateKey: DateKey; content: string }>
): string {
  const nonEmpty = entries.filter((e) => e.content.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  return nonEmpty
    .map((e) => `[${e.dateKey}]\n${e.content.replace(/\s+$/, "")}`)
    .join("\n\n");
}

export interface InternalClipboardCell {
  relRow: number;
  relCol: number;
  content: string;
}

export interface InternalClipboardData {
  width: number;
  height: number;
  cells: InternalClipboardCell[];
  externalText: string;
}

/**
 * 복사된 2D 셀 데이터와 대상 선택 영역을 기반으로 붙여넣기 대상(날짜 -> 새 내용) 목록을 계산함.
 * - 단일 셀 복사 후 여러 셀 선택 붙여넣기: 엑셀처럼 선택된 모든 셀에 동일 내용 채우기.
 * - 2D 영역 복사 후 붙여넣기: 선택 영역 좌상단(minRow, minCol)을 기준으로 상대 좌표 그대로 덮어쓰기.
 */
export function computePasteTargets(
  clipboard: InternalClipboardData | null,
  externalTextFromOS: string | null,
  targetRange: SelectionRange,
  originWeekStart: DateKey
): Array<{ dateKey: DateKey; content: string }> {
  const bounds = getRectBounds(targetRange);
  const selectedCells = getSelectedCells(targetRange, originWeekStart);

  // OS 클립보드가 내부 복사 텍스트와 다르면 외부에서 복사한 일반 텍스트로 간주함
  const useInternal =
    clipboard !== null &&
    (externalTextFromOS === null ||
      externalTextFromOS === clipboard.externalText);

  if (!useInternal) {
    const text = externalTextFromOS ?? "";
    if (!text) return [];
    return selectedCells.map((cell) => ({
      dateKey: cell.dateKey,
      content: text,
    }));
  }

  // 내부 단일 셀 복사 -> 다중 선택 영역 전체에 채우기 (엑셀 Fill 동작)
  if (clipboard.width === 1 && clipboard.height === 1) {
    const singleContent = clipboard.cells[0]?.content ?? "";
    return selectedCells.map((cell) => ({
      dateKey: cell.dateKey,
      content: singleContent,
    }));
  }

  // 내부 2D 영역 복사 -> 좌상단 기준 상대 오프셋 유지하며 대상 셀 계산
  return clipboard.cells.map((cell) => {
    const targetRow = bounds.minRow + cell.relRow;
    const targetCol = bounds.minCol + cell.relCol;
    // col이 7을 넘어가면 다음 주로 자연스럽게 래핑되도록 coordToDateKey가 row*7+col 계산 수행
    const dateKey = coordToDateKey(targetRow, targetCol, originWeekStart);
    return {
      dateKey,
      content: cell.content,
    };
  });
}

// [ID 7.1.2] 붙여넣기 이어붙이기(Append) 병합 규칙
// -> 캘린더에 기존 메모를 유지한 채 행사/일정을 추가할 수 있도록 덮어쓰기 대신 아래 줄에 이어붙이며,
//    복사 영역에 포함된 빈 셀은 대상 날짜의 기존 메모를 지우지 않고 보존함.
export function mergeMemoContentForAppend(
  existing: string,
  incoming: string
): string {
  if (incoming.trim().length === 0) {
    return existing;
  }
  if (existing.trim().length === 0) {
    return incoming;
  }
  const trimmedExisting = existing.replace(/\s+$/, "");
  const trimmedIncoming = incoming.replace(/^\n+/, "");
  return `${trimmedExisting}\n${trimmedIncoming}`;
}

// [ID 7.3] 그리드 레벨 Undo / Redo 히스토리 스택
// -> 셀 복붙, 일괄 삭제, 셀 배경색 변경을 하나의 배치 단위로 기록하여 Ctrl/Cmd+Z, Y로 원자적 되돌리기를 지원함.
export type HistoryChange =
  | {
      type: "content";
      tabId: string;
      dateKey: DateKey;
      before: string;
      after: string;
    }
  | {
      type: "color";
      tabId: string;
      dateKey: DateKey;
      before: string;
      after: string;
    };

export interface HistoryBatch {
  label: string;
  changes: HistoryChange[];
}

export class GridUndoHistory {
  private undoStack: HistoryBatch[] = [];
  private redoStack: HistoryBatch[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  push(batch: HistoryBatch): void {
    const meaningful = batch.changes.filter((c) => c.before !== c.after);
    if (meaningful.length === 0) return;
    this.undoStack.push({ label: batch.label, changes: meaningful });
    if (this.undoStack.length > this.maxEntries) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  popUndo(): HistoryBatch | null {
    const batch = this.undoStack.pop();
    if (!batch) return null;
    this.redoStack.push(batch);
    return batch;
  }

  popRedo(): HistoryBatch | null {
    const batch = this.redoStack.pop();
    if (!batch) return null;
    this.undoStack.push(batch);
    return batch;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

