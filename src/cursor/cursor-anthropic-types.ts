import type { CursorTool } from './cursor-protobuf-schema';

export interface CursorOpenAIMessage {
  role: string;
  content:
    | string
    | Array<
        | { type: 'text'; text?: string }
        | { type: 'image_url'; image_url?: { url?: string; detail?: string } }
      >;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

export interface AnthropicTextBlock {
  type: 'text';
  text?: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content?: unknown;
}

export interface AnthropicImageBlock {
  type: 'image';
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock;

export interface CursorAnthropicRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: string | AnthropicContentBlock[] }>;
  system?: string | AnthropicTextBlock[];
  stream?: boolean;
  tools?: CursorTool[];
  output_config?: {
    effort?: string;
  };
  thinking?: {
    type?: string;
    budget_tokens?: number;
  };
}
