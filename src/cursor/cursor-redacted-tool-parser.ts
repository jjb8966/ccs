/**
 * Parse Cursor composer redacted tool-call text blocks into OpenAI tool_calls.
 *
 * Example:
 * <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>
 * list_dir<｜tool▁sep｜>relative_workspace_path
 * /path/to/dir<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 */

export const REDACTED_TOOL_CALLS_BEGIN = '<｜tool▁calls▁begin｜>';
export const REDACTED_TOOL_CALLS_END = '<｜tool▁calls▁end｜>';
export const REDACTED_TOOL_CALL_BEGIN = '<｜tool▁call▁begin｜>';
export const REDACTED_TOOL_CALL_END = '<｜tool▁call▁end｜>';
import { FINAL_CONTENT_MARKERS, THINKING_END_MARKER } from './cursor-assistant-text-normalizer.js';
export { THINKING_END_MARKER } from './cursor-assistant-text-normalizer.js';
import { stripLeakedToolMarkup } from './cursor-assistant-text-normalizer.js';
import { detectToolClientProfile, remapToolCallForProfile } from './cursor-tool-profile.js';

const TOOL_SEP_PATTERN = /<\|redacted_tool_sep\|>|<｜tool[^｜|]*sep[^｜|]*｜>/gi;

const BRACKET_TOOL_USE_PATTERN = /\[tool_use\s+([A-Za-z0-9_-]+)\s+(\{[\s\S]*?\})\]/g;

export const TOOL_CALL_RESULT_BEGIN = '[tool_call_result';

const TOOL_CALL_RESULT_SUFFIX_PATTERN = /\s*->\s*/g;

const PARTIAL_MARKER_PREFIXES = [
  ...FINAL_CONTENT_MARKERS,
  REDACTED_TOOL_CALLS_BEGIN,
  REDACTED_TOOL_CALLS_END,
  REDACTED_TOOL_CALL_BEGIN,
  REDACTED_TOOL_CALL_END,
  '<|redacted_tool',
  '<|redacted',
  '<|red',
  '<|re',
  '<|',
  '<',
];

const BRACKET_TOOL_PARTIAL_PREFIXES = [
  '[tool_call_result',
  '[tool_call_resul',
  '[tool_call_resu',
  '[tool_call_res',
  '[tool_call_re',
  '[tool_call_r',
  '[tool_call_',
  '[tool_call',
  '[tool_cal',
  '[tool_ca',
  '[tool_c',
  '[tool_',
  '[tool_use',
  '[tool_us',
  '[tool_u',
  '[tool_',
  '[tool',
  '[too',
  '[to',
  '[',
  ...PARTIAL_MARKER_PREFIXES,
];

export interface ParsedOpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export function extractAvailableToolNames(
  tools?: Array<{ function?: { name?: string }; name?: string }>
): string[] {
  if (!tools) {
    return [];
  }

  return tools
    .map((tool) => tool.function?.name ?? tool.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

export function remapCursorInternalToolCall(
  toolCall: ParsedOpenAIToolCall,
  availableTools?: Iterable<string>
): ParsedOpenAIToolCall {
  const profile = detectToolClientProfile(availableTools);

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
  } catch {
    args = {};
  }

  const remapped = remapToolCallForProfile(toolCall.function.name, args, profile);
  if (!remapped) {
    return toolCall;
  }

  return {
    ...toolCall,
    function: {
      name: remapped.name,
      arguments: JSON.stringify(remapped.args),
    },
  };
}

export function remapCursorInternalToolCalls(
  toolCalls: ParsedOpenAIToolCall[],
  availableTools?: Iterable<string>
): ParsedOpenAIToolCall[] {
  return toolCalls.map((toolCall) => remapCursorInternalToolCall(toolCall, availableTools));
}

export interface RedactedToolParseResult {
  text: string;
  toolCalls: ParsedOpenAIToolCall[];
}

let toolCallSequence = 0;

function coerceArgValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  return trimmed;
}

function createToolCallId(index: number): string {
  toolCallSequence += 1;
  return `toolu_cursor_${Date.now()}_${index}_${toolCallSequence}`;
}

function findToolCallResultBlocks(
  raw: string
): Array<{ start: number; end: number; inner: string }> {
  const blocks: Array<{ start: number; end: number; inner: string }> = [];
  let searchFrom = 0;

  while (searchFrom < raw.length) {
    const begin = raw.indexOf(TOOL_CALL_RESULT_BEGIN, searchFrom);
    if (begin === -1) {
      break;
    }

    const bracketStart = begin;
    let pos = begin + 1;
    let inQuote = false;
    let escaped = false;

    while (pos < raw.length) {
      const ch = raw[pos];
      if (escaped) {
        escaped = false;
        pos += 1;
        continue;
      }
      if (ch === '\\' && inQuote) {
        escaped = true;
        pos += 1;
        continue;
      }
      if (ch === '"') {
        inQuote = !inQuote;
        pos += 1;
        continue;
      }
      if (ch === ']' && !inQuote) {
        blocks.push({
          start: bracketStart,
          end: pos + 1,
          inner: raw.slice(bracketStart + 1, pos),
        });
        searchFrom = pos + 1;
        break;
      }
      pos += 1;
    }

    if (pos >= raw.length) {
      break;
    }
  }

  return blocks;
}

export function parseToolCallResultAttributes(
  inner: string
): { name: string; args: Record<string, unknown> } | null {
  const trimmed = inner.trim();
  if (!trimmed.startsWith('tool_call_result')) {
    return null;
  }

  let pos = 'tool_call_result'.length;
  const args: Record<string, unknown> = {};
  let name: string | undefined;

  while (pos < trimmed.length) {
    while (pos < trimmed.length && /\s/.test(trimmed[pos] ?? '')) {
      pos += 1;
    }
    if (pos >= trimmed.length) {
      break;
    }

    const keyStart = pos;
    while (pos < trimmed.length && /[A-Za-z0-9_-]/.test(trimmed[pos] ?? '')) {
      pos += 1;
    }
    const key = trimmed.slice(keyStart, pos);
    if (!key) {
      break;
    }

    while (pos < trimmed.length && /\s/.test(trimmed[pos] ?? '')) {
      pos += 1;
    }
    if (trimmed[pos] !== '=') {
      break;
    }
    pos += 1;
    while (pos < trimmed.length && /\s/.test(trimmed[pos] ?? '')) {
      pos += 1;
    }

    let value: unknown;
    if (trimmed[pos] === '"') {
      pos += 1;
      let valueStr = '';
      while (pos < trimmed.length) {
        const ch = trimmed[pos];
        if (ch === '\\' && pos + 1 < trimmed.length) {
          valueStr += trimmed[pos + 1];
          pos += 2;
          continue;
        }
        if (ch === '"') {
          pos += 1;
          break;
        }
        valueStr += ch;
        pos += 1;
      }
      value = valueStr;
    } else {
      const valueStart = pos;
      while (pos < trimmed.length && !/\s/.test(trimmed[pos] ?? '')) {
        pos += 1;
      }
      value = coerceArgValue(trimmed.slice(valueStart, pos));
    }

    if (key === 'name') {
      name = String(value);
    } else {
      args[key] = value;
    }
  }

  if (!name) {
    return null;
  }

  return { name, args };
}

export function extractToolCallResultCallsWithRemainder(raw: string): {
  toolCalls: ParsedOpenAIToolCall[];
  remainder: string;
} {
  const blocks = findToolCallResultBlocks(raw);
  if (blocks.length === 0) {
    return { toolCalls: [], remainder: raw };
  }

  const toolCalls: ParsedOpenAIToolCall[] = [];
  let remainder = raw;

  for (const block of blocks) {
    const parsed = parseToolCallResultAttributes(block.inner);
    if (!parsed) {
      continue;
    }

    toolCalls.push({
      id: createToolCallId(toolCalls.length),
      type: 'function',
      function: {
        name: parsed.name,
        arguments: JSON.stringify(parsed.args),
      },
    });

    let blockEnd = block.end;
    const trailing = raw.slice(block.end);
    const suffixMatch = trailing.match(/^\s*->/);
    if (suffixMatch) {
      blockEnd += suffixMatch[0].length;
    }
    remainder = remainder.replace(raw.slice(block.start, blockEnd), '');
  }

  return {
    toolCalls,
    remainder: stripLeakedToolMarkup(
      remainder.replace(TOOL_CALL_RESULT_SUFFIX_PATTERN, ' ')
    ).trim(),
  };
}

export function extractToolCallResultCalls(raw: string): ParsedOpenAIToolCall[] {
  return extractToolCallResultCallsWithRemainder(raw).toolCalls;
}

export function extractBracketToolUseCallsWithRemainder(raw: string): {
  toolCalls: ParsedOpenAIToolCall[];
  remainder: string;
} {
  const toolCalls: ParsedOpenAIToolCall[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  const pattern = new RegExp(BRACKET_TOOL_USE_PATTERN.source, BRACKET_TOOL_USE_PATTERN.flags);
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index < cursor) {
      continue;
    }
    cursor = match.index + match[0].length;
    const name = match[1]?.trim();
    const argsRaw = match[2]?.trim();
    if (!name || !argsRaw) {
      continue;
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsRaw) as Record<string, unknown>;
    } catch {
      continue;
    }

    toolCalls.push({
      id: createToolCallId(toolCalls.length),
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    });
  }

  if (toolCalls.length === 0) {
    return { toolCalls, remainder: raw };
  }

  let remainder = raw;
  for (const call of toolCalls) {
    const patternLiteral = `\\[tool_use\\s+${call.function.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\{[\\s\\S]*?\\}\\]`;
    remainder = remainder.replace(new RegExp(patternLiteral), '');
  }

  return { toolCalls, remainder: stripLeakedToolMarkup(remainder).trim() };
}

function parseToolCallBody(body: string): { name: string; args: Record<string, unknown> } | null {
  const normalized = body.replace(TOOL_SEP_PATTERN, '\u0000SEP\u0000').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('\u0000SEP\u0000');
  const name = segments.shift()?.trim();
  if (!name) {
    return null;
  }

  const args: Record<string, unknown> = {};
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index]?.trim();
    if (!segment) {
      index += 1;
      continue;
    }

    const newlineIndex = segment.indexOf('\n');
    if (newlineIndex === -1) {
      const key = segment;
      const next = segments[index + 1]?.trim() ?? '';
      if (next && !next.includes('\n') && index + 1 < segments.length) {
        args[key] = coerceArgValue(next);
        index += 2;
        continue;
      }
      args[key] = '';
      index += 1;
      continue;
    }

    const key = segment.slice(0, newlineIndex).trim();
    const value = segment.slice(newlineIndex + 1).trim();
    if (key) {
      args[key] = coerceArgValue(value);
    }
    index += 1;
  }

  return { name, args };
}

export function parseRedactedToolBlock(block: string): ParsedOpenAIToolCall[] {
  const calls: ParsedOpenAIToolCall[] = [];
  const body = block.trim();
  if (!body) {
    return calls;
  }

  const segments = body.split(REDACTED_TOOL_CALL_BEGIN);
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    const endIndex = segment.indexOf(REDACTED_TOOL_CALL_END);
    const callBody = endIndex === -1 ? segment : segment.slice(0, endIndex);
    const parsed = parseToolCallBody(callBody);
    if (!parsed) {
      continue;
    }

    calls.push({
      id: createToolCallId(calls.length),
      type: 'function',
      function: {
        name: parsed.name,
        arguments: JSON.stringify(parsed.args),
      },
    });
  }

  return calls;
}

export function extractBracketToolUseCalls(raw: string): ParsedOpenAIToolCall[] {
  return extractBracketToolUseCallsWithRemainder(raw).toolCalls;
}

function mergeEmbeddedToolCalls(raw: string): { text: string; toolCalls: ParsedOpenAIToolCall[] } {
  const toolCallResult = extractToolCallResultCallsWithRemainder(raw);
  const bracket = extractBracketToolUseCallsWithRemainder(toolCallResult.remainder);
  return {
    text: stripLeakedToolMarkup(bracket.remainder).trim(),
    toolCalls: [...toolCallResult.toolCalls, ...bracket.toolCalls],
  };
}

export function extractRedactedToolCalls(raw: string): RedactedToolParseResult {
  const beginIndex = raw.indexOf(REDACTED_TOOL_CALLS_BEGIN);
  if (beginIndex === -1) {
    const embedded = mergeEmbeddedToolCalls(raw);
    return {
      text: embedded.text,
      toolCalls: embedded.toolCalls,
    };
  }

  const endIndex = raw.indexOf(REDACTED_TOOL_CALLS_END, beginIndex);
  const prefix = raw.slice(0, beginIndex);
  if (endIndex === -1) {
    const embedded = mergeEmbeddedToolCalls(raw);
    return {
      text: stripLeakedToolMarkup(prefix).trim(),
      toolCalls: embedded.toolCalls,
    };
  }

  const block = raw.slice(beginIndex + REDACTED_TOOL_CALLS_BEGIN.length, endIndex);
  const suffix = raw.slice(endIndex + REDACTED_TOOL_CALLS_END.length);
  const embedded = mergeEmbeddedToolCalls(`${prefix}${suffix}`);
  const toolCalls = [...parseRedactedToolBlock(block), ...embedded.toolCalls];

  return {
    text: embedded.text,
    toolCalls,
  };
}

export type AssistantStreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'tool_calls'; toolCalls: ParsedOpenAIToolCall[] };

function takeSafePrefix(buffer: string): { flushed: string; remainder: string } {
  let safeLength = buffer.length;
  for (const marker of BRACKET_TOOL_PARTIAL_PREFIXES) {
    for (let size = marker.length - 1; size > 0; size -= 1) {
      const prefix = marker.slice(0, size);
      if (buffer.endsWith(prefix)) {
        safeLength = Math.min(safeLength, buffer.length - size);
      }
    }
  }

  return {
    flushed: buffer.slice(0, safeLength),
    remainder: buffer.slice(safeLength),
  };
}

/**
 * Incrementally converts Cursor assistant stream text into visible content and tool_calls.
 */
export class AssistantResponseStreamParser {
  private preThinkingBuffer = '';
  private pastThinking = false;
  private preFinalBuffer = '';
  private pastFinal = false;
  private pendingText = '';
  private inToolBlock = false;
  private toolBlockBuffer = '';
  private emittedToolCalls: ParsedOpenAIToolCall[] = [];

  push(delta: string): AssistantStreamEvent[] {
    if (!delta) {
      return [];
    }

    if (!this.pastThinking) {
      this.preThinkingBuffer += delta;
      const markerIndex = this.preThinkingBuffer.indexOf(THINKING_END_MARKER);
      if (markerIndex === -1) {
        return [];
      }

      this.pastThinking = true;
      const remainder = this.preThinkingBuffer.slice(markerIndex + THINKING_END_MARKER.length);
      this.preThinkingBuffer = '';
      return this.pushPostThinking(remainder);
    }

    return this.pushPostThinking(delta);
  }

  finish(): AssistantStreamEvent[] {
    const events: AssistantStreamEvent[] = [];

    if (!this.pastThinking && this.preThinkingBuffer) {
      const markerIndex = this.preThinkingBuffer.indexOf(THINKING_END_MARKER);
      if (markerIndex !== -1) {
        this.pastThinking = true;
        const remainder = this.preThinkingBuffer.slice(markerIndex + THINKING_END_MARKER.length);
        this.preThinkingBuffer = '';
        events.push(...this.pushPostThinking(remainder));
      } else {
        this.pastThinking = true;
        this.pastFinal = true;
        const remainder = this.preThinkingBuffer;
        this.preThinkingBuffer = '';
        events.push(...this.pushVisibleContent(remainder));
      }
    }

    if (!this.pastFinal && this.preFinalBuffer.trim()) {
      this.pastFinal = true;
      const remainder = this.preFinalBuffer;
      this.preFinalBuffer = '';
      events.push(...this.pushVisibleContent(remainder));
    }

    if (this.inToolBlock && this.toolBlockBuffer.trim()) {
      const parsed = remapCursorInternalToolCalls(parseRedactedToolBlock(this.toolBlockBuffer));
      if (parsed.length > 0) {
        this.emittedToolCalls.push(...parsed);
        events.push({ kind: 'tool_calls', toolCalls: parsed });
      }
      this.inToolBlock = false;
      this.toolBlockBuffer = '';
    } else if (this.pendingText.trim()) {
      const embedded = extractRedactedToolCalls(this.pendingText);
      const remapped = remapCursorInternalToolCalls(embedded.toolCalls);
      if (remapped.length > 0) {
        this.emittedToolCalls.push(...remapped);
        events.push({ kind: 'tool_calls', toolCalls: remapped });
      }
      if (embedded.text.trim()) {
        events.push({ kind: 'content', text: embedded.text.trim() });
      }
      this.pendingText = '';
    }

    return events;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCalls.length;
  }

  private pushPostThinking(delta: string): AssistantStreamEvent[] {
    if (!this.pastFinal) {
      this.preFinalBuffer += delta;
      let markerIndex = -1;
      let markerLength = 0;
      for (const marker of FINAL_CONTENT_MARKERS) {
        const index = this.preFinalBuffer.indexOf(marker);
        if (index !== -1 && (markerIndex === -1 || index < markerIndex)) {
          markerIndex = index;
          markerLength = marker.length;
        }
      }

      if (markerIndex === -1) {
        return [];
      }

      this.pastFinal = true;
      const remainder = this.preFinalBuffer.slice(markerIndex + markerLength);
      this.preFinalBuffer = '';
      if (!remainder) {
        return [];
      }
      return this.pushVisibleContent(remainder);
    }

    return this.pushVisibleContent(delta);
  }

  private flushEmbeddedToolCallsFromPending(): AssistantStreamEvent[] {
    const events: AssistantStreamEvent[] = [];
    const toolUseIndex = this.pendingText.indexOf('[tool_use');
    const toolCallResultIndex = this.pendingText.indexOf(TOOL_CALL_RESULT_BEGIN);
    const bracketIndex =
      toolUseIndex === -1
        ? toolCallResultIndex
        : toolCallResultIndex === -1
          ? toolUseIndex
          : Math.min(toolUseIndex, toolCallResultIndex);

    if (bracketIndex === -1) {
      return events;
    }

    const prefix = this.pendingText.slice(0, bracketIndex).trim();
    const suffix = this.pendingText.slice(bracketIndex);
    const extracted =
      suffix.startsWith(TOOL_CALL_RESULT_BEGIN) ||
      suffix.startsWith('[tool_call_resul') ||
      suffix.startsWith('[tool_call_resu') ||
      suffix.startsWith('[tool_call_res') ||
      suffix.startsWith('[tool_call_re') ||
      suffix.startsWith('[tool_call_r') ||
      suffix.startsWith('[tool_call_') ||
      suffix.startsWith('[tool_call') ||
      suffix.startsWith('[tool_cal') ||
      suffix.startsWith('[tool_ca') ||
      suffix.startsWith('[tool_c')
        ? extractToolCallResultCallsWithRemainder(suffix)
        : extractBracketToolUseCallsWithRemainder(suffix);
    if (extracted.toolCalls.length === 0) {
      if (bracketIndex > 0) {
        const { flushed, remainder } = takeSafePrefix(this.pendingText);
        this.pendingText = remainder;
        if (flushed) {
          events.push({ kind: 'content', text: flushed });
        }
      }
      return events;
    }

    if (prefix) {
      events.push({ kind: 'content', text: prefix });
    }

    const remapped = remapCursorInternalToolCalls(extracted.toolCalls);
    this.emittedToolCalls.push(...remapped);
    events.push({ kind: 'tool_calls', toolCalls: remapped });
    this.pendingText = extracted.remainder;
    return events;
  }

  private pushVisibleContent(delta: string): AssistantStreamEvent[] {
    if (this.inToolBlock) {
      return this.consumeToolBlock(delta);
    }

    this.pendingText += delta;
    const beginIndex = this.pendingText.indexOf(REDACTED_TOOL_CALLS_BEGIN);
    if (beginIndex === -1) {
      const embeddedEvents = this.flushEmbeddedToolCallsFromPending();
      if (embeddedEvents.length > 0) {
        return embeddedEvents;
      }

      const { flushed, remainder } = takeSafePrefix(this.pendingText);
      this.pendingText = remainder;
      return flushed ? [{ kind: 'content', text: flushed }] : [];
    }

    const events: AssistantStreamEvent[] = [];
    const prefix = this.pendingText.slice(0, beginIndex).trim();
    if (prefix) {
      events.push({ kind: 'content', text: prefix });
    }

    const afterBegin = this.pendingText.slice(beginIndex + REDACTED_TOOL_CALLS_BEGIN.length);
    this.pendingText = '';
    this.inToolBlock = true;
    this.toolBlockBuffer = afterBegin;
    events.push(...this.consumeToolBlock(''));
    return events;
  }

  private consumeToolBlock(delta: string): AssistantStreamEvent[] {
    const events: AssistantStreamEvent[] = [];
    this.toolBlockBuffer += delta;

    const endIndex = this.toolBlockBuffer.indexOf(REDACTED_TOOL_CALLS_END);
    if (endIndex === -1) {
      return events;
    }

    const block = this.toolBlockBuffer.slice(0, endIndex);
    const suffix = this.toolBlockBuffer.slice(endIndex + REDACTED_TOOL_CALLS_END.length);
    const parsed = remapCursorInternalToolCalls(parseRedactedToolBlock(block));
    if (parsed.length > 0) {
      this.emittedToolCalls.push(...parsed);
      events.push({ kind: 'tool_calls', toolCalls: parsed });
    }

    this.inToolBlock = false;
    this.toolBlockBuffer = '';
    if (suffix) {
      events.push(...this.pushPostThinking(suffix));
    }

    return events;
  }
}
