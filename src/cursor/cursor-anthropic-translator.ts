import type { CursorTool } from './cursor-protobuf-schema';
import type {
  AnthropicContentBlock,
  CursorAnthropicRequest,
  CursorOpenAIMessage,
} from './cursor-anthropic-types';

export interface TranslatedAnthropicRequest {
  model?: string;
  stream: boolean;
  reasoning_effort?: string;
  tools?: CursorTool[];
  messages: CursorOpenAIMessage[];
}

const TOOL_RESULT_SERIALIZATION_FALLBACK = '[unserializable content]';
const TOOL_USE_ARGUMENTS_FALLBACK = '{}';

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeJsonStringify(value: unknown, fallback: string): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : fallback;
  } catch {
    return fallback;
  }
}

function createFallbackToolId(messageIndex: number, blockIndex: number): string {
  return `toolu_ccs_fallback_${messageIndex}_${blockIndex}`;
}

function flattenTextContent(content: unknown, label: string): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    throw new Error(`${label} must be a string or content block array`);
  }

  return content
    .map((block, index) => {
      const parsed = assertObject(block, `${label}[${index}]`);
      if (parsed.type !== 'text') {
        throw new Error(`${label}[${index}].type "${String(parsed.type)}" is not supported`);
      }
      return typeof parsed.text === 'string' ? parsed.text : '';
    })
    .join('\n');
}

function toToolResultContent(content: unknown, label: string): string {
  if (content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return flattenTextContent(content, label);
  }
  return safeJsonStringify(content, TOOL_RESULT_SERIALIZATION_FALLBACK);
}

function mapAdaptiveEffortToCursorReasoningEffort(effort: string | undefined): string | undefined {
  const normalized = effort?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return undefined;
  }
  if (normalized === 'minimal' || normalized === 'low') {
    return 'medium';
  }
  if (normalized === 'medium') {
    return 'medium';
  }
  return 'high';
}

function mapThinkingToReasoningEffort(request: CursorAnthropicRequest): string | undefined {
  const thinking = request.thinking;
  if (!thinking) {
    return undefined;
  }
  if (thinking.type === 'disabled') {
    return undefined;
  }
  if (thinking.type === 'adaptive') {
    return mapAdaptiveEffortToCursorReasoningEffort(request.output_config?.effort);
  }
  if (thinking.type !== 'enabled') {
    throw new Error('thinking.type must be "enabled", "adaptive", or "disabled"');
  }
  return typeof thinking.budget_tokens === 'number' && thinking.budget_tokens >= 8192
    ? 'high'
    : 'medium';
}

function mapAnthropicImageToOpenAIUrl(
  block: AnthropicContentBlock,
  label: string
): { type: 'image_url'; image_url: { url: string } } {
  if (block.type !== 'image') {
    throw new Error(`${label} is not an image block`);
  }

  const source = block.source;
  if (!source || typeof source !== 'object') {
    throw new Error(`${label}.source must be an object`);
  }

  if (source.type === 'base64') {
    if (typeof source.data !== 'string' || source.data.length === 0) {
      throw new Error(`${label}.source.data must be a non-empty base64 string`);
    }
    const mediaType =
      typeof source.media_type === 'string' && source.media_type.length > 0
        ? source.media_type
        : 'image/png';
    return {
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${source.data}` },
    };
  }

  if (source.type === 'url') {
    if (typeof source.url !== 'string' || source.url.length === 0) {
      throw new Error(`${label}.source.url must be a non-empty string`);
    }
    return {
      type: 'image_url',
      image_url: { url: source.url },
    };
  }

  throw new Error(`${label}.source.type must be "base64" or "url"`);
}

export function translateAnthropicRequest(raw: unknown): TranslatedAnthropicRequest {
  const request = assertObject(raw, 'request') as CursorAnthropicRequest;
  const translatedMessages: CursorOpenAIMessage[] = [];

  if (request.system !== undefined) {
    translatedMessages.push({
      role: 'system',
      content: flattenTextContent(request.system, 'system'),
    });
  }

  if (!Array.isArray(request.messages)) {
    throw new Error('messages must be an array');
  }

  request.messages.forEach((message, messageIndex) => {
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') {
      throw new Error(`messages[${messageIndex}].role must be "user" or "assistant"`);
    }

    const content = message.content;
    if (typeof content === 'string') {
      translatedMessages.push({ role, content });
      return;
    }

    if (!Array.isArray(content)) {
      throw new Error(`messages[${messageIndex}].content must be a string or array`);
    }

    const textParts: string[] = [];
    const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    const toolCalls: NonNullable<CursorOpenAIMessage['tool_calls']> = [];
    let sawToolResult = false;

    content.forEach((block, blockIndex) => {
      const parsed = assertObject(
        block,
        `messages[${messageIndex}].content[${blockIndex}]`
      ) as unknown as AnthropicContentBlock;

      if (parsed.type === 'text') {
        textParts.push(typeof parsed.text === 'string' ? parsed.text : '');
        return;
      }

      if (parsed.type === 'image') {
        if (role !== 'user') {
          throw new Error(
            `messages[${messageIndex}].content[${blockIndex}] image requires user role`
          );
        }
        imageParts.push(
          mapAnthropicImageToOpenAIUrl(parsed, `messages[${messageIndex}].content[${blockIndex}]`)
        );
        return;
      }

      if (parsed.type === 'tool_use') {
        if (role !== 'assistant') {
          throw new Error(
            `messages[${messageIndex}].content[${blockIndex}] tool_use requires assistant role`
          );
        }
        toolCalls.push({
          id:
            typeof parsed.id === 'string' && parsed.id.length > 0
              ? parsed.id
              : createFallbackToolId(messageIndex, blockIndex),
          type: 'function',
          function: {
            name: typeof parsed.name === 'string' ? parsed.name : 'tool',
            arguments: safeJsonStringify(parsed.input ?? {}, TOOL_USE_ARGUMENTS_FALLBACK),
          },
        });
        return;
      }

      if (parsed.type === 'tool_result') {
        if (role !== 'user') {
          throw new Error(
            `messages[${messageIndex}].content[${blockIndex}] tool_result requires user role`
          );
        }
        if (typeof parsed.tool_use_id !== 'string' || parsed.tool_use_id.trim().length === 0) {
          throw new Error(
            `messages[${messageIndex}].content[${blockIndex}].tool_use_id must be a non-empty string`
          );
        }
        sawToolResult = true;
        if (textParts.length > 0) {
          translatedMessages.push({
            role,
            content: textParts.join('\n'),
          });
          textParts.length = 0;
        }
        translatedMessages.push({
          role: 'tool',
          tool_call_id: parsed.tool_use_id,
          content: toToolResultContent(
            parsed.content,
            `messages[${messageIndex}].content[${blockIndex}].content`
          ),
        });
        return;
      }

      throw new Error(
        `messages[${messageIndex}].content[${blockIndex}].type "${String((parsed as { type?: unknown }).type)}" is not supported`
      );
    });

    if (role === 'assistant') {
      translatedMessages.push({
        role,
        content: textParts.join('\n'),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      return;
    }

    if (textParts.length > 0 || imageParts.length > 0 || !sawToolResult) {
      if (imageParts.length > 0) {
        translatedMessages.push({
          role,
          content: [...textParts.map((text) => ({ type: 'text' as const, text })), ...imageParts],
        });
      } else {
        translatedMessages.push({
          role,
          content: textParts.join('\n'),
        });
      }
    }
  });

  return {
    model:
      typeof request.model === 'string' && request.model.trim().length > 0
        ? request.model
        : undefined,
    stream: request.stream === true,
    reasoning_effort: mapThinkingToReasoningEffort(request),
    tools: Array.isArray(request.tools) ? request.tools : undefined,
    messages: translatedMessages,
  };
}
