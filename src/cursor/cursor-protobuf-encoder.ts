/**
 * Cursor Protobuf Encoder
 * Implements ConnectRPC protobuf wire format encoding
 */

import * as zlib from 'zlib';
import * as os from 'os';
import {
  WIRE_TYPE,
  FIELD,
  COMPRESS_FLAG,
  type WireType,
  type RoleType,
  type CursorTool,
  type CursorToolResult,
} from './cursor-protobuf-schema.js';

/**
 * Encode a varint (variable-length integer)
 */
export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let val = value >>> 0; // Ensure unsigned
  while (val >= 0x80) {
    bytes.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  bytes.push(val & 0x7f);
  return new Uint8Array(bytes);
}

/**
 * Encode a protobuf field (tag + value)
 */
export function encodeField(
  fieldNum: number,
  wireType: WireType,
  value: number | string | Uint8Array
): Uint8Array {
  const tag = (fieldNum << 3) | wireType;
  const tagBytes = encodeVarint(tag);

  if (wireType === WIRE_TYPE.VARINT) {
    const valueBytes = encodeVarint(value as number);
    return concatArrays(tagBytes, valueBytes);
  }

  if (wireType === WIRE_TYPE.LEN) {
    const dataBytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(0);

    const lengthBytes = encodeVarint(dataBytes.length);
    return concatArrays(tagBytes, lengthBytes, dataBytes);
  }

  return new Uint8Array(0);
}

/**
 * Concatenate multiple Uint8Arrays
 */
export function concatArrays(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Encode a tool result
 */
export function encodeToolResult(toolResult: CursorToolResult): Uint8Array {
  const toolCallId = toolResult.tool_call_id || '';
  const toolName = toolResult.name || '';
  const toolIndex = toolResult.index || 0;
  const rawArgs = toolResult.raw_args || '{}';

  return concatArrays(
    encodeField(FIELD.ToolResult.CALL_ID, WIRE_TYPE.LEN, toolCallId),
    encodeField(FIELD.ToolResult.NAME, WIRE_TYPE.LEN, toolName),
    encodeField(FIELD.ToolResult.INDEX, WIRE_TYPE.VARINT, toolIndex),
    encodeField(FIELD.ToolResult.RAW_ARGS, WIRE_TYPE.LEN, rawArgs)
  );
}

/**
 * Encode a conversation message
 */
export function encodeMessage(
  content: string,
  role: RoleType,
  messageId: string,
  chatModeEnum?: number,
  toolResults: CursorToolResult[] = []
): Uint8Array {
  return concatArrays(
    encodeField(FIELD.Message.CONTENT, WIRE_TYPE.LEN, content),
    encodeField(FIELD.Message.ROLE, WIRE_TYPE.VARINT, role),
    encodeField(FIELD.Message.ID, WIRE_TYPE.LEN, messageId),
    ...(toolResults.length > 0
      ? toolResults.map((tr) =>
          encodeField(FIELD.Message.TOOL_RESULTS, WIRE_TYPE.LEN, encodeToolResult(tr))
        )
      : []),
    ...(chatModeEnum !== undefined
      ? [encodeField(FIELD.Message.CHAT_MODE_ENUM, WIRE_TYPE.VARINT, chatModeEnum)]
      : [])
  );
}

/**
 * Encode instruction text
 */
export function encodeInstruction(text: string): Uint8Array {
  return text ? encodeField(FIELD.Instruction.TEXT, WIRE_TYPE.LEN, text) : new Uint8Array(0);
}

/**
 * Encode model information
 */
export function encodeModel(modelName: string): Uint8Array {
  return concatArrays(
    encodeField(FIELD.Model.NAME, WIRE_TYPE.LEN, modelName),
    encodeField(FIELD.Model.EMPTY, WIRE_TYPE.LEN, new Uint8Array(0))
  );
}

/**
 * Encode cursor settings
 */
export function encodeCursorSetting(): Uint8Array {
  const unknown6 = concatArrays(
    encodeField(FIELD.Setting.U6_FIELD_1, WIRE_TYPE.LEN, new Uint8Array(0)),
    encodeField(FIELD.Setting.U6_FIELD_2, WIRE_TYPE.LEN, new Uint8Array(0))
  );

  return concatArrays(
    encodeField(FIELD.Setting.PATH, WIRE_TYPE.LEN, 'cursor\\aisettings'),
    encodeField(FIELD.Setting.UNKNOWN_3, WIRE_TYPE.LEN, new Uint8Array(0)),
    encodeField(FIELD.Setting.UNKNOWN_6, WIRE_TYPE.LEN, unknown6),
    encodeField(FIELD.Setting.UNKNOWN_8, WIRE_TYPE.VARINT, 1),
    encodeField(FIELD.Setting.UNKNOWN_9, WIRE_TYPE.VARINT, 1)
  );
}

/**
 * Encode metadata
 */
export function encodeMetadata(): Uint8Array {
  return concatArrays(
    encodeField(FIELD.Metadata.PLATFORM, WIRE_TYPE.LEN, process.platform || 'linux'),
    encodeField(FIELD.Metadata.ARCH, WIRE_TYPE.LEN, process.arch || 'x64'),
    encodeField(FIELD.Metadata.VERSION, WIRE_TYPE.LEN, os.release() || 'unknown'),
    encodeField(FIELD.Metadata.CWD, WIRE_TYPE.LEN, process.execPath || process.cwd() || '/'),
    encodeField(FIELD.Metadata.TIMESTAMP, WIRE_TYPE.LEN, new Date().toISOString())
  );
}

/**
 * Encode message ID
 */
export function encodeMessageId(messageId: string, role: RoleType, summaryId?: string): Uint8Array {
  return concatArrays(
    encodeField(FIELD.MessageId.ID, WIRE_TYPE.LEN, messageId),
    ...(summaryId ? [encodeField(FIELD.MessageId.SUMMARY, WIRE_TYPE.LEN, summaryId)] : []),
    encodeField(FIELD.MessageId.ROLE, WIRE_TYPE.VARINT, role)
  );
}

/**
 * Encode MCP tool
 */
export function encodeMcpTool(tool: CursorTool): Uint8Array {
  const toolName = tool.function?.name || tool.name || '';
  const toolDesc = tool.function?.description || tool.description || '';
  const inputSchema = tool.function?.parameters || tool.input_schema || {};

  return concatArrays(
    ...(toolName ? [encodeField(FIELD.McpTool.NAME, WIRE_TYPE.LEN, toolName)] : []),
    ...(toolDesc ? [encodeField(FIELD.McpTool.DESC, WIRE_TYPE.LEN, toolDesc)] : []),
    ...(Object.keys(inputSchema).length > 0
      ? [encodeField(FIELD.McpTool.PARAMS, WIRE_TYPE.LEN, JSON.stringify(inputSchema))]
      : []),
    encodeField(FIELD.McpTool.SERVER, WIRE_TYPE.LEN, 'custom')
  );
}

/**
 * Wrap payload in ConnectRPC frame (5-byte header + payload)
 */
export function wrapConnectRPCFrame(payload: Uint8Array, compress = false): Uint8Array {
  let finalPayload = payload;
  let flags: number = COMPRESS_FLAG.NONE;

  if (compress) {
    finalPayload = new Uint8Array(zlib.gzipSync(Buffer.from(payload)));
    flags = COMPRESS_FLAG.GZIP;
  }

  const frame = new Uint8Array(5 + finalPayload.length);
  frame[0] = flags;
  frame[1] = (finalPayload.length >> 24) & 0xff;
  frame[2] = (finalPayload.length >> 16) & 0xff;
  frame[3] = (finalPayload.length >> 8) & 0xff;
  frame[4] = finalPayload.length & 0xff;
  frame.set(finalPayload, 5);

  return frame;
}
