// [ID 5.4.1] 이모지 접두어 하이라이트(==🔵내용== 등) 경량 셀 미리보기 후처리기
// -> Live Preview 전용 이모지 하이라이트 플러그인/스니펫 사용 시, 읽기 뷰(MarkdownRenderer) 기반인
//    캘린더 셀에서도 무거운 에디터 마운트 없이 <mark> 요소만 경량 스캔하여 동일한 색상을 표시함.

const EMOJI_COLOR_MAP: Array<[string, string]> = [
  ["🔴", "red"],
  ["🟥", "red"],
  ["❤️", "red"],
  ["❤", "red"],
  ["🟠", "orange"],
  ["🟧", "orange"],
  ["🧡", "orange"],
  ["🟡", "yellow"],
  ["🟨", "yellow"],
  ["💛", "yellow"],
  ["🟢", "green"],
  ["🟩", "green"],
  ["💚", "green"],
  ["🩵", "cyan"],
  ["🔵", "blue"],
  ["🟦", "blue"],
  ["💙", "blue"],
  ["🟣", "purple"],
  ["🟪", "purple"],
  ["💜", "purple"],
  ["🩷", "pink"],
  ["💖", "pink"],
  ["🌸", "pink"],
  ["🟤", "brown"],
  ["🟫", "brown"],
  ["🤎", "brown"],
  ["⚫", "gray"],
  ["⬛", "gray"],
  ["🖤", "gray"],
  ["🩶", "gray"],
  ["⚪", "gray"],
];

export interface EmojiHighlightMatch {
  color: string;
  /** 이모지 접두어(및 직후 단일 공백)를 제거한 표시 텍스트 */
  strippedText: string;
  /** 원본 텍스트에서 제거할 문자 길이 */
  prefixLength: number;
}

/**
 * 하이라이트 텍스트 앞부분의 색상 이모지 접두어를 판별함.
 */
export function matchEmojiHighlightPrefix(
  text: string
): EmojiHighlightMatch | null {
  for (const [emoji, color] of EMOJI_COLOR_MAP) {
    if (text.startsWith(emoji)) {
      let prefixLength = emoji.length;
      // 이모지 바로 뒤 공백 1칸이 있다면 함께 정리 (내용이 비어버리지 않을 때만)
      if (text[prefixLength] === " " && text.length > prefixLength + 1) {
        prefixLength += 1;
      }
      const strippedText = text.slice(prefixLength);
      return {
        color,
        strippedText,
        prefixLength,
      };
    }
  }
  return null;
}

/**
 * 셀 미리보기 DOM 내부의 <mark> 태그만 경량 순회하여 이모지 접두어 색상을 적용함.
 * (<mark>가 없는 일반 셀에서는 querySelectorAll 빈 결과로 즉시 종료되어 성능 부담이 0에 가까움)
 */
export function applyEmojiHighlightsToPreview(previewEl: HTMLElement): void {
  const marks = previewEl.querySelectorAll<HTMLElement>("mark");
  if (marks.length === 0) return;

  marks.forEach((mark) => {
    // 다른 읽기 뷰 플러그인이 이미 인라인 배경색을 지정했다면 덮어쓰지 않음
    if (mark.style.backgroundColor) return;

    const firstTextNode = findFirstTextNode(mark);
    if (!firstTextNode || !firstTextNode.nodeValue) return;

    const matched = matchEmojiHighlightPrefix(firstTextNode.nodeValue);
    if (!matched) return;

    mark.classList.add("cm-hl", `cm-hl-${matched.color}`);

    // 이모지만 단독으로 있는 하이라이트가 아니라면 접두어 이모지를 숨겨 노트와 동일하게 표시
    const remainingTotal = (mark.textContent ?? "").slice(matched.prefixLength);
    if (remainingTotal.trim().length > 0) {
      firstTextNode.nodeValue = matched.strippedText;
    }
  });
}

function findFirstTextNode(root: Node): Text | null {
  let node: Node | null = root.firstChild;
  while (node) {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
      return node as Text;
    }
    if (node.firstChild) {
      const nested = findFirstTextNode(node);
      if (nested) return nested;
    }
    node = node.nextSibling;
  }
  return null;
}

