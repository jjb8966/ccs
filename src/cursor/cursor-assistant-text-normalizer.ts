export const THINKING_END_MARKER = '</think>';

export const FINAL_CONTENT_MARKERS = ['<｜final｜>', '<|final|>'];

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const LATIN_ALNUM = /[A-Za-z0-9]/;
const MARKDOWN_BOUNDARY = /[#`|]/;

function isCjkChar(char: string): boolean {
  return CJK_CHAR.test(char);
}

function needsSpaceBetween(previous: string, next: string): boolean {
  if (!previous || !next) {
    return false;
  }

  const prev = previous.slice(-1);
  const nextChar = next[0];
  if (prev === ' ' || prev === '\n' || nextChar === ' ' || nextChar === '\n') {
    return false;
  }

  if (MARKDOWN_BOUNDARY.test(prev) || MARKDOWN_BOUNDARY.test(nextChar)) {
    return false;
  }

  return (
    (isCjkChar(prev) && LATIN_ALNUM.test(nextChar)) ||
    (LATIN_ALNUM.test(prev) && isCjkChar(nextChar))
  );
}

const REDACTED_TOOL_MARKERS = [
  '<｜tool▁calls▁begin｜>',
  '<｜tool▁calls▁end｜>',
  '<｜tool▁call▁begin｜>',
  '<｜tool▁call▁end｜>',
  '<｜tool▁sep｜>',
];

const BRACKET_TOOL_USE_PATTERN = /\[tool_use\s+([A-Za-z0-9_-]+)\s+(\{[\s\S]*?\})\]/g;

export function stripControlMarkers(text: string): string {
  let normalized = text;
  for (const marker of [...FINAL_CONTENT_MARKERS, THINKING_END_MARKER]) {
    normalized = normalized.split(marker).join('');
  }
  return normalized;
}

const REDACTED_THINKING_PATTERN = /<\/?redacted_thinking>/gi;

/** Remove Cursor tool-call markup that leaked into visible assistant text. */
export function stripLeakedToolMarkup(text: string): string {
  let normalized = stripControlMarkers(text);
  normalized = normalized.replace(REDACTED_THINKING_PATTERN, '');
  for (const marker of REDACTED_TOOL_MARKERS) {
    normalized = normalized.split(marker).join('');
  }
  normalized = normalized.replace(/<\|redacted[^>|]*[>|]?/gi, '');
  normalized = normalized.replace(BRACKET_TOOL_USE_PATTERN, '');
  return normalized;
}

export function normalizeAssistantVisibleText(text: string, previousChar = ''): string {
  if (!text) {
    return '';
  }

  let normalized = stripLeakedToolMarkup(text);

  if (needsSpaceBetween(previousChar, normalized)) {
    normalized = ` ${normalized}`;
  }

  normalized = normalized
    .replace(/([^\n])##(?![\s#])/g, '$1\n\n## ')
    .replace(/([^\n])###(?![\s#])/g, '$1\n\n### ')
    .replace(/\|\|(?=\S)/g, '|\n|')
    .replace(/([.!?])(?=[가-힣A-Z#`])/g, '$1\n\n')
    .replace(/([가-힣])(?=[A-Za-z0-9])/g, '$1 ')
    .replace(/([A-Za-z0-9`])(?=[가-힣])/g, '$1 ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  return normalized;
}

export class AssistantVisibleTextNormalizer {
  private lastChar = '';

  push(delta: string): string {
    const normalized = normalizeAssistantVisibleText(delta, this.lastChar);
    if (normalized) {
      this.lastChar = normalized[normalized.length - 1];
    }
    return normalized;
  }

  finish(): string {
    return '';
  }

  reset(): void {
    this.lastChar = '';
  }
}
