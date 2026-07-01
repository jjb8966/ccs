/**
 * Cursor Protobuf Schema Constants
 * Field definitions and wire types for ConnectRPC protocol
 */

/** Wire types for protobuf encoding */
export const WIRE_TYPE = {
  VARINT: 0,
  FIXED64: 1,
  LEN: 2,
  FIXED32: 5,
} as const;

/** Message role constants */
export const ROLE = {
  USER: 1,
  ASSISTANT: 2,
} as const;

/** Unified mode constants */
export const UNIFIED_MODE = {
  UNSPECIFIED: 0,
  NORMAL: 1,
  AGENT: 2,
} as const;

/** ClientSideToolV2 enum subset used for agent-mode capability advertisement */
export const CLIENT_SIDE_TOOL_V2 = {
  READ_FILE: 5,
  LIST_DIR: 6,
  EDIT_FILE: 7,
  FILE_SEARCH: 8,
  RIPGREP_SEARCH: 3,
  RUN_TERMINAL_COMMAND_V2: 15,
  GLOB_FILE_SEARCH: 42,
} as const;

export const DEFAULT_SUPPORTED_CLIENT_TOOLS = [
  CLIENT_SIDE_TOOL_V2.READ_FILE,
  CLIENT_SIDE_TOOL_V2.LIST_DIR,
  CLIENT_SIDE_TOOL_V2.RIPGREP_SEARCH,
  CLIENT_SIDE_TOOL_V2.RUN_TERMINAL_COMMAND_V2,
  CLIENT_SIDE_TOOL_V2.EDIT_FILE,
  CLIENT_SIDE_TOOL_V2.FILE_SEARCH,
  CLIENT_SIDE_TOOL_V2.GLOB_FILE_SEARCH,
] as const;

/** Thinking level constants */
export const THINKING_LEVEL = {
  UNSPECIFIED: 0,
  MEDIUM: 1,
  HIGH: 2,
} as const;

/** Field numbers namespaced by protobuf message type */
export const FIELD = {
  /** StreamUnifiedChatRequestWithTools (top level) */
  Request: { REQUEST: 1 },

  /** StreamUnifiedChatRequest */
  Chat: {
    MESSAGES: 1,
    UNKNOWN_2: 2,
    INSTRUCTION: 3,
    UNKNOWN_4: 4,
    MODEL: 5,
    WEB_TOOL: 8,
    UNKNOWN_13: 13,
    CURSOR_SETTING: 15,
    UNKNOWN_19: 19,
    CONVERSATION_ID: 23,
    METADATA: 26,
    IS_AGENTIC: 27,
    SUPPORTED_TOOLS: 29,
    MESSAGE_IDS: 30,
    MCP_TOOLS: 34,
    LARGE_CONTEXT: 35,
    UNKNOWN_38: 38,
    UNIFIED_MODE: 46,
    UNKNOWN_47: 47,
    SHOULD_DISABLE_TOOLS: 48,
    THINKING_LEVEL: 49,
    UNKNOWN_51: 51,
    UNKNOWN_53: 53,
    UNIFIED_MODE_NAME: 54,
  },

  /** ConversationMessage */
  Message: {
    CONTENT: 1,
    ROLE: 2,
    ID: 13,
    TOOL_RESULTS: 18,
    CHAT_MODE_ENUM: 47,
  },

  /** ConversationMessage.ToolResult */
  ToolResult: {
    CALL_ID: 1,
    NAME: 2,
    INDEX: 3,
    RAW_ARGS: 5,
    RESULT: 8,
  },

  /** Model */
  Model: { NAME: 1, EMPTY: 4 },

  /** Instruction */
  Instruction: { TEXT: 1 },

  /** CursorSetting (U6_FIELD_* are sub-fields of Unknown6 nested message) */
  Setting: {
    PATH: 1,
    UNKNOWN_3: 3,
    UNKNOWN_6: 6,
    UNKNOWN_8: 8,
    UNKNOWN_9: 9,
    U6_FIELD_1: 1,
    U6_FIELD_2: 2,
  },

  /** Metadata */
  Metadata: { PLATFORM: 1, ARCH: 2, VERSION: 3, CWD: 4, TIMESTAMP: 5 },

  /** MessageId */
  MessageId: { ID: 1, SUMMARY: 2, ROLE: 3 },

  /** MCPTool */
  McpTool: { NAME: 1, DESC: 2, PARAMS: 3, SERVER: 4 },

  /** StreamUnifiedChatResponseWithTools (response top-level) */
  Response: { TOOL_CALL: 1, RESPONSE: 2 },

  /** ClientSideToolV2Call */
  ToolCall: { ID: 3, NAME: 9, RAW_ARGS: 10, IS_LAST: 11, MCP_PARAMS: 27 },

  /** MCPParams */
  McpParams: { TOOLS_LIST: 1 },

  /** MCPParams.Tool (nested) */
  McpNested: { NAME: 1, PARAMS: 3 },

  /** StreamUnifiedChatResponse */
  ChatResponse: {
    TEXT: 1,
    ERROR_TEXT: 20,
    STREAM_DELTA: 25,
    THINKING: 25,
    STREAM_FLAG: 37,
  },

  /** Thinking */
  Thinking: { TEXT: 1 },
} as const;

/** Type definitions */
export type WireType = (typeof WIRE_TYPE)[keyof typeof WIRE_TYPE];
export type RoleType = (typeof ROLE)[keyof typeof ROLE];
export type UnifiedModeType = (typeof UNIFIED_MODE)[keyof typeof UNIFIED_MODE];
export type ThinkingLevelType = (typeof THINKING_LEVEL)[keyof typeof THINKING_LEVEL];

/** Cursor credentials structure */
export interface CursorApiCredentials {
  accessToken: string;
  machineId: string;
  ghostMode?: boolean;
}

/** Cursor tool definition */
export interface CursorTool {
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/** Cursor tool result */
export interface CursorToolResult {
  tool_call_id?: string;
  name?: string;
  index?: number;
  raw_args?: string;
}

/** Cursor message format */
export interface CursorMessage {
  role: string;
  content: string;
  tool_results?: CursorToolResult[];
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/** Formatted message for encoding */
export interface FormattedMessage {
  content: string;
  role: RoleType;
  messageId: string;
  isLast: boolean;
  hasTools: boolean;
  toolResults: CursorToolResult[];
}

/** Message ID structure */
export interface MessageId {
  messageId: string;
  role: RoleType;
}

/** Bit flags for ConnectRPC envelopes. */
export const CONNECT_FRAME_FLAG = {
  COMPRESSED: 0x01,
  END_STREAM: 0x02,
} as const;

/** ConnectRPC frame flag presets. */
export const COMPRESS_FLAG = {
  NONE: 0x00,
  GZIP: CONNECT_FRAME_FLAG.COMPRESSED,
  END_STREAM: CONNECT_FRAME_FLAG.END_STREAM,
  GZIP_END_STREAM: CONNECT_FRAME_FLAG.COMPRESSED | CONNECT_FRAME_FLAG.END_STREAM,
} as const;

export const CONNECT_FRAME_FLAG_MASK =
  CONNECT_FRAME_FLAG.COMPRESSED | CONNECT_FRAME_FLAG.END_STREAM;

export function isCompressedConnectFrame(flags: number): boolean {
  return (flags & CONNECT_FRAME_FLAG.COMPRESSED) === CONNECT_FRAME_FLAG.COMPRESSED;
}

export function isEndStreamConnectFrame(flags: number): boolean {
  return (flags & CONNECT_FRAME_FLAG.END_STREAM) === CONNECT_FRAME_FLAG.END_STREAM;
}

export function hasUnknownConnectFrameFlags(flags: number): boolean {
  return (flags & ~CONNECT_FRAME_FLAG_MASK) !== 0;
}
