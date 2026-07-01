/**
 * Cursor Protobuf Decoder
 * Implements ConnectRPC protobuf wire format decoding
 */

import * as zlib from 'zlib';
import {
  WIRE_TYPE,
  FIELD,
  isCompressedConnectFrame,
  type WireType,
} from './cursor-protobuf-schema.js';

/**
 * Decode a varint from buffer
 * Returns [value, newOffset]
 */
export function decodeVarint(buffer: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  const maxBytes = 5;

  while (pos < buffer.length && pos - offset < maxBytes) {
    const b = buffer[pos];
    result |= (b & 0x7f) << shift;
    pos++;
    if (!(b & 0x80)) break;
    shift += 7;
  }

  return [result >>> 0, pos]; // Ensure unsigned
}

/**
 * Decode a single protobuf field
 * Returns [fieldNum, wireType, value, newOffset]
 */
export function decodeField(
  buffer: Uint8Array,
  offset: number
): [number | null, WireType | null, Uint8Array | number | null, number] {
  if (offset >= buffer.length) {
    return [null, null, null, offset];
  }

  const [tag, pos1] = decodeVarint(buffer, offset);
  const fieldNum = tag >> 3;
  const wireType = (tag & 0x07) as WireType;

  let value: Uint8Array | number | null;
  let pos = pos1;

  if (wireType === WIRE_TYPE.VARINT) {
    [value, pos] = decodeVarint(buffer, pos);
  } else if (wireType === WIRE_TYPE.LEN) {
    const [length, pos2] = decodeVarint(buffer, pos);
    if (pos2 + length > buffer.length) {
      return [null, null, null, buffer.length];
    }
    value = buffer.slice(pos2, pos2 + length);
    pos = pos2 + length;
  } else if (wireType === WIRE_TYPE.FIXED64) {
    if (pos + 8 > buffer.length) {
      return [null, null, null, buffer.length];
    }
    value = buffer.slice(pos, pos + 8);
    pos += 8;
  } else if (wireType === WIRE_TYPE.FIXED32) {
    if (pos + 4 > buffer.length) {
      return [null, null, null, buffer.length];
    }
    value = buffer.slice(pos, pos + 4);
    pos += 4;
  } else {
    value = null;
  }

  return [fieldNum, wireType, value, pos];
}

/**
 * Decode a protobuf message into a map of fields
 */
export function decodeMessage(
  data: Uint8Array
): Map<number, Array<{ wireType: WireType; value: Uint8Array | number }>> {
  const fields = new Map<number, Array<{ wireType: WireType; value: Uint8Array | number }>>();
  let pos = 0;

  // NOTE: If two fields share the same field number but different wire types, later values overwrite earlier ones.
  while (pos < data.length) {
    const [fieldNum, wireType, value, newPos] = decodeField(data, pos);
    if (fieldNum === null || wireType === null || value === null) break;

    if (!fields.has(fieldNum)) {
      fields.set(fieldNum, []);
    }
    const fieldArray = fields.get(fieldNum);
    if (fieldArray) {
      fieldArray.push({ wireType, value: value as Uint8Array | number });
    }
    pos = newPos;
  }

  return fields;
}

/**
 * Parse ConnectRPC frame from buffer
 * Returns frame data or null if incomplete
 */
export function parseConnectRPCFrame(buffer: Buffer): {
  flags: number;
  length: number;
  payload: Uint8Array;
  consumed: number;
} | null {
  if (buffer.length < 5) return null;

  const flags = buffer[0];
  const length = (buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];

  if (buffer.length < 5 + length) return null;

  let payload = buffer.slice(5, 5 + length);

  // Decompress if gzip
  if (isCompressedConnectFrame(flags)) {
    try {
      payload = Buffer.from(zlib.gunzipSync(payload));
    } catch (err) {
      if (process.env.CCS_DEBUG) {
        console.error('[cursor] parseConnectRPCFrame decompression failed:', err);
      }
      // Decompression failed, use raw payload
    }
  }

  return {
    flags,
    length,
    payload: new Uint8Array(payload),
    consumed: 5 + length,
  };
}

/**
 * Extract tool call from protobuf data
 */
function extractToolCall(toolCallData: Uint8Array): {
  id: string;
  type: string;
  function: { name: string; arguments: string };
  isLast: boolean;
} | null {
  const toolCall = decodeMessage(toolCallData);
  let toolCallId = '';
  let toolName = '';
  let rawArgs = '';
  let isLast = false;

  // Extract tool call ID
  if (toolCall.has(FIELD.ToolCall.ID)) {
    const idField = toolCall.get(FIELD.ToolCall.ID);
    if (idField && idField[0]) {
      const fullId = new TextDecoder().decode(idField[0].value as Uint8Array);
      toolCallId = fullId.split('\n')[0]; // Take first line
    }
  }

  // Extract tool name
  if (toolCall.has(FIELD.ToolCall.NAME)) {
    const nameField = toolCall.get(FIELD.ToolCall.NAME);
    if (nameField && nameField[0]) {
      toolName = new TextDecoder().decode(nameField[0].value as Uint8Array);
    }
  }

  // Extract is_last flag
  if (toolCall.has(FIELD.ToolCall.IS_LAST)) {
    const lastField = toolCall.get(FIELD.ToolCall.IS_LAST);
    if (lastField && lastField[0]) {
      isLast = (lastField[0].value as number) !== 0;
    }
  }

  // Extract MCP params - nested real tool info
  if (toolCall.has(FIELD.ToolCall.MCP_PARAMS)) {
    try {
      const mcpField = toolCall.get(FIELD.ToolCall.MCP_PARAMS);
      if (!mcpField || !mcpField[0]) return null;

      const mcpParams = decodeMessage(mcpField[0].value as Uint8Array);

      if (mcpParams.has(FIELD.McpParams.TOOLS_LIST)) {
        const toolsList = mcpParams.get(FIELD.McpParams.TOOLS_LIST);
        if (!toolsList || !toolsList[0]) return null;

        const tool = decodeMessage(toolsList[0].value as Uint8Array);

        if (tool.has(FIELD.McpNested.NAME)) {
          const nestedName = tool.get(FIELD.McpNested.NAME);
          if (nestedName && nestedName[0]) {
            toolName = new TextDecoder().decode(nestedName[0].value as Uint8Array);
          }
        }

        if (tool.has(FIELD.McpNested.PARAMS)) {
          const nestedParams = tool.get(FIELD.McpNested.PARAMS);
          if (nestedParams && nestedParams[0]) {
            rawArgs = new TextDecoder().decode(nestedParams[0].value as Uint8Array);
          }
        }
      }
    } catch (err) {
      if (process.env.CCS_DEBUG) {
        console.error('[cursor] extractToolCall MCP parsing failed:', err);
      }
      // MCP parse error, continue
    }
  }

  // Fallback to raw_args
  if (!rawArgs && toolCall.has(FIELD.ToolCall.RAW_ARGS)) {
    const rawArgsField = toolCall.get(FIELD.ToolCall.RAW_ARGS);
    if (rawArgsField && rawArgsField[0]) {
      rawArgs = new TextDecoder().decode(rawArgsField[0].value as Uint8Array);
    }
  }

  if (toolCallId && toolName) {
    return {
      id: toolCallId,
      type: 'function',
      function: {
        name: toolName,
        arguments: rawArgs || '{}',
      },
      isLast,
    };
  }

  return null;
}

/**
 * Extract text and thinking from response data
 */
function decodeLenString(value: Uint8Array): string | null {
  try {
    const nested = decodeMessage(value);
    const direct = nested.get(1)?.[0]?.value;
    if (direct instanceof Uint8Array) {
      return new TextDecoder().decode(direct);
    }
    return new TextDecoder().decode(value);
  } catch {
    return new TextDecoder().decode(value);
  }
}

function extractTextAndThinking(responseData: Uint8Array): {
  text: string | null;
  thinking: string | null;
  error: string | null;
} {
  const nested = decodeMessage(responseData);
  let text: string | null = null;
  let thinking: string | null = null;
  let error: string | null = null;

  if (nested.has(FIELD.ChatResponse.ERROR_TEXT)) {
    const errorField = nested.get(FIELD.ChatResponse.ERROR_TEXT);
    if (errorField?.[0]?.value instanceof Uint8Array) {
      error = new TextDecoder().decode(errorField[0].value as Uint8Array);
    }
  }

  if (nested.has(FIELD.ChatResponse.TEXT)) {
    const textField = nested.get(FIELD.ChatResponse.TEXT);
    if (textField?.[0]?.value instanceof Uint8Array) {
      text = new TextDecoder().decode(textField[0].value as Uint8Array);
    }
  }

  if (nested.has(FIELD.ChatResponse.STREAM_DELTA)) {
    const deltaField = nested.get(FIELD.ChatResponse.STREAM_DELTA);
    if (deltaField?.[0]?.value instanceof Uint8Array) {
      const raw = deltaField[0].value as Uint8Array;
      const inner = decodeMessage(raw);
      if (inner.has(FIELD.ChatResponse.STREAM_FLAG)) {
        const delta = decodeLenString(raw);
        if (delta) {
          text = (text || '') + delta;
        }
      } else if (inner.has(FIELD.Thinking.TEXT)) {
        const thinkingTextField = inner.get(FIELD.Thinking.TEXT);
        if (thinkingTextField?.[0]?.value instanceof Uint8Array) {
          thinking = new TextDecoder().decode(thinkingTextField[0].value as Uint8Array);
        }
      } else {
        const delta = decodeLenString(raw);
        if (delta) {
          text = (text || '') + delta;
        }
      }
    }
  }

  if (!thinking && nested.has(FIELD.ChatResponse.THINKING)) {
    try {
      const thinkingField = nested.get(FIELD.ChatResponse.THINKING);
      if (thinkingField?.[0]?.value instanceof Uint8Array) {
        const thinkingMsg = decodeMessage(thinkingField[0].value as Uint8Array);
        if (thinkingMsg.has(FIELD.Thinking.TEXT)) {
          const thinkingTextField = thinkingMsg.get(FIELD.Thinking.TEXT);
          if (thinkingTextField?.[0]?.value instanceof Uint8Array) {
            thinking = new TextDecoder().decode(thinkingTextField[0].value as Uint8Array);
          }
        }
      }
    } catch {
      // ignore nested thinking parse errors
    }
  }

  return { text, thinking, error };
}

/**
 * Extract text and tool calls from response payload
 */
export function extractTextFromResponse(payload: Uint8Array): {
  text: string | null;
  error: string | null;
  toolCall: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
    isLast: boolean;
  } | null;
  thinking: string | null;
} {
  try {
    const fields = decodeMessage(payload);

    // Field 1: ClientSideToolV2Call
    if (fields.has(FIELD.Response.TOOL_CALL)) {
      const toolCallField = fields.get(FIELD.Response.TOOL_CALL);
      if (toolCallField && toolCallField[0]) {
        const toolCall = extractToolCall(toolCallField[0].value as Uint8Array);
        if (toolCall) {
          return { text: null, error: null, toolCall, thinking: null };
        }
      }
    }

    // Field 2: StreamUnifiedChatResponse
    if (fields.has(FIELD.Response.RESPONSE)) {
      const responseField = fields.get(FIELD.Response.RESPONSE);
      if (responseField?.[0]?.value instanceof Uint8Array) {
        const { text, thinking, error } = extractTextAndThinking(
          responseField[0].value as Uint8Array
        );

        if (error) {
          return { text: null, error, toolCall: null, thinking: null };
        }

        if (text || thinking) {
          return { text, error: null, toolCall: null, thinking };
        }
      }
    }

    if (payload.length > 0) {
      return { text: null, error: null, toolCall: null, thinking: null };
    }

    return { text: null, error: null, toolCall: null, thinking: null };
  } catch (err) {
    if (process.env.CCS_DEBUG) {
      console.error('[cursor] extractTextFromResponse parsing failed:', err);
    }
    return { text: null, error: 'Malformed protobuf response', toolCall: null, thinking: null };
  }
}
