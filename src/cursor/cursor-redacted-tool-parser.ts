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

const TOOL_SEP_PATTERN = /<\|redacted_tool_sep\|>|<｜tool[^｜|]*sep[^｜|]*｜>/gi;

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

export interface ParsedOpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

const CURSOR_INTERNAL_TOOL_MAP: Record<
  string,
  {
    name: string;
    remapArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  }
> = {
  list_dir: {
    name: 'Glob',
    remapArgs: (args) => ({
      target_directory: args.relative_workspace_path ?? args.target_directory ?? '.',
      glob_pattern: args.glob_pattern ?? '*',
    }),
  },
  read_file: {
    name: 'Read',
    remapArgs: (args) => {
      const remapped: Record<string, unknown> = {};
      const filePath = args.target_file ?? args.file_path ?? args.path;
      if (filePath) {
        remapped.file_path = filePath;
      }
      if (args.limit !== undefined) {
        remapped.limit = args.limit;
      }
      if (args.offset !== undefined) {
        remapped.offset = args.offset;
      }
      return remapped;
    },
  },
  glob_file_search: {
    name: 'Glob',
    remapArgs: (args) => ({
      target_directory: args.target_directory ?? args.relative_workspace_path ?? '.',
      glob_pattern: args.glob_pattern ?? '**/*',
    }),
  },
  run_terminal_cmd: {
    name: 'Bash',
    remapArgs: (args) => {
      const remapped: Record<string, unknown> = {};
      if (args.command) {
        remapped.command = args.command;
      }
      const description = args.explanation ?? args.description;
      if (description) {
        remapped.description = description;
      }
      return remapped;
    },
  },
};

export function remapCursorInternalToolCall(
  toolCall: ParsedOpenAIToolCall,
  availableTools?: Iterable<string>
): ParsedOpenAIToolCall {
  const mapping = CURSOR_INTERNAL_TOOL_MAP[toolCall.function.name];
  if (!mapping) {
    return toolCall;
  }

  const available = availableTools ? new Set(availableTools) : null;
  const targetName =
    !available || available.has(mapping.name) ? mapping.name : toolCall.function.name;

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
  } catch {
    args = {};
  }

  return {
    ...toolCall,
    function: {
      name: targetName,
      arguments: JSON.stringify(mapping.remapArgs(args)),
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

function createToolCallId(index: number): string {
  toolCallSequence += 1;
  return `call_cursor_${Date.now()}_${index}_${toolCallSequence}`;
}

function coerceArgValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  return trimmed;
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

export function extractRedactedToolCalls(raw: string): RedactedToolParseResult {
  const beginIndex = raw.indexOf(REDACTED_TOOL_CALLS_BEGIN);
  if (beginIndex === -1) {
    return { text: raw, toolCalls: [] };
  }

  const endIndex = raw.indexOf(REDACTED_TOOL_CALLS_END, beginIndex);
  const prefix = raw.slice(0, beginIndex);
  if (endIndex === -1) {
    return { text: prefix.trim(), toolCalls: [] };
  }

  const block = raw.slice(beginIndex + REDACTED_TOOL_CALLS_BEGIN.length, endIndex);
  const suffix = raw.slice(endIndex + REDACTED_TOOL_CALLS_END.length);
  const toolCalls = parseRedactedToolBlock(block);

  return {
    text: `${prefix}${suffix}`.trim(),
    toolCalls,
  };
}

export type AssistantStreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'tool_calls'; toolCalls: ParsedOpenAIToolCall[] };

function takeSafePrefix(buffer: string): { flushed: string; remainder: string } {
  let safeLength = buffer.length;
  for (const marker of PARTIAL_MARKER_PREFIXES) {
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
      const parsed = parseRedactedToolBlock(this.toolBlockBuffer);
      if (parsed.length > 0) {
        this.emittedToolCalls.push(...parsed);
        events.push({ kind: 'tool_calls', toolCalls: parsed });
      }
      this.inToolBlock = false;
      this.toolBlockBuffer = '';
    } else if (this.pendingText.trim()) {
      events.push({ kind: 'content', text: this.pendingText.trim() });
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

  private pushVisibleContent(delta: string): AssistantStreamEvent[] {
    if (this.inToolBlock) {
      return this.consumeToolBlock(delta);
    }

    this.pendingText += delta;
    const beginIndex = this.pendingText.indexOf(REDACTED_TOOL_CALLS_BEGIN);
    if (beginIndex === -1) {
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
    const parsed = parseRedactedToolBlock(block);
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
