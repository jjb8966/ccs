import { describe, expect, it } from 'bun:test';
import { createAnthropicProxyResponse } from '../../../src/cursor/cursor-anthropic-response';
import { translateAnthropicRequest } from '../../../src/cursor/cursor-anthropic-translator';

describe('translateAnthropicRequest', () => {
  it('maps Anthropic system, tool use, and tool result blocks into Cursor OpenAI messages', () => {
    const translated = translateAnthropicRequest({
      model: 'claude-sonnet-4.5',
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 9000 },
      tools: [{ name: 'search', description: 'Search docs', input_schema: { type: 'object' } }],
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Find release notes' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'release' } }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'v7.53.0' }],
            },
            { type: 'text', text: 'Summarize it.' },
          ],
        },
      ],
    });

    expect(translated.model).toBe('claude-sonnet-4.5');
    expect(translated.stream).toBe(true);
    expect(translated.reasoning_effort).toBe('high');
    expect(translated.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Find release notes' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"release"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'v7.53.0' },
      { role: 'user', content: 'Summarize it.' },
    ]);
  });

  it('rejects unsupported content blocks', () => {
    expect(() =>
      translateAnthropicRequest({
        messages: [{ role: 'user', content: [{ type: 'image' }] }],
      })
    ).toThrow('is not supported');
  });

  it('does not append an empty user message after tool_result-only turns', () => {
    const translated = translateAnthropicRequest({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
        },
      ],
    });

    expect(translated.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'done' },
    ]);
  });

  it('maps adaptive anthropic thinking into Cursor reasoning effort', () => {
    const translated = translateAnthropicRequest({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(translated.reasoning_effort).toBe('high');
  });

  it('omits reasoning effort for adaptive auto thinking', () => {
    const translated = translateAnthropicRequest({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'auto' },
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(translated.reasoning_effort).toBeUndefined();
  });

  it('preserves mixed user text around tool_result blocks in order', () => {
    const translated = translateAnthropicRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' },
            { type: 'text', text: 'after' },
          ],
        },
      ],
    });

    expect(translated.messages).toEqual([
      { role: 'user', content: 'before' },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'done' },
      { role: 'user', content: 'after' },
    ]);
  });

  it('handles empty messages arrays', () => {
    const translated = translateAnthropicRequest({ messages: [] });

    expect(translated.messages).toEqual([]);
  });

  it('uses a distinct fallback prefix for missing tool_use ids', () => {
    const translated = translateAnthropicRequest({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'search', input: { q: 'x' } }],
        },
      ],
    });

    expect(translated.messages[0]?.tool_calls?.[0]?.id).toBe('toolu_ccs_fallback_0_0');
  });

  it('falls back when tool_result content cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const translated = translateAnthropicRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: circular }],
        },
      ],
    });

    expect(translated.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: '[unserializable content]',
      },
    ]);
  });

  it('returns empty string for tool_result blocks without content', () => {
    const translated = translateAnthropicRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }],
        },
      ],
    });

    expect(translated.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: '',
      },
    ]);
  });

  it('rejects tool_result blocks without a non-empty tool_use_id', () => {
    expect(() =>
      translateAnthropicRequest({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: '   ', content: 'done' }],
          },
        ],
      })
    ).toThrow('tool_use_id must be a non-empty string');
  });

  it('falls back when tool_use input cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const translated = translateAnthropicRequest({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'search', input: circular }],
        },
      ],
    });

    expect(translated.messages[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'toolu_ccs_fallback_0_0',
          type: 'function',
          function: { name: 'search', arguments: '{}' },
        },
      ],
    });
  });
});

describe('createAnthropicProxyResponse', () => {
  it('converts OpenAI JSON into Anthropic message JSON', async () => {
    const response = new Response(
      JSON.stringify({
        id: 'chatcmpl_1',
        model: 'claude-sonnet-4.5',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Here is the result.',
              reasoning_content: 'Need to call the tool first.',
              tool_calls: [
                {
                  id: 'toolu_2',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":"cursor daemon"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const transformed = await createAnthropicProxyResponse(response);
    const body = (await transformed.json()) as {
      type: string;
      model: string;
      stop_reason: string;
      content: Array<{
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
    };

    expect(body.type).toBe('message');
    expect(body.model).toBe('claude-sonnet-4.5');
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content.map((block) => block.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(body.content[0]?.thinking).toContain('Need to call the tool first');
    expect(body.content[2]?.name).toBe('search');
    expect(body.content[2]?.input).toEqual({ q: 'cursor daemon' });
  });

  it('returns 502 when Cursor returns invalid JSON', async () => {
    const transformed = await createAnthropicProxyResponse(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    expect(transformed.status).toBe(502);
    const body = (await transformed.json()) as {
      type?: string;
      error?: { type?: string; message?: string };
    };
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('api_error');
    expect(body.error?.message).toBe('Failed to translate OpenAI-compatible JSON response');
  });

  it('returns 502 when Cursor response is missing choices', async () => {
    const transformed = await createAnthropicProxyResponse(
      new Response(
        JSON.stringify({
          id: 'chatcmpl_missing_choices',
          model: 'claude-sonnet-4.5',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    expect(transformed.status).toBe(502);
    const body = (await transformed.json()) as {
      type?: string;
      error?: { type?: string; message?: string };
    };
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('api_error');
    expect(body.error?.message).toBe('Failed to translate OpenAI-compatible JSON response');
  });

  it('returns 502 when Cursor response has empty choices', async () => {
    const transformed = await createAnthropicProxyResponse(
      new Response(
        JSON.stringify({
          id: 'chatcmpl_empty_choices',
          model: 'claude-sonnet-4.5',
          choices: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    expect(transformed.status).toBe(502);
    const body = (await transformed.json()) as {
      type?: string;
      error?: { type?: string; message?: string };
    };
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('api_error');
    expect(body.error?.message).toBe('Failed to translate OpenAI-compatible JSON response');
  });

  it('returns Anthropic error envelopes for non-OK upstream JSON errors', async () => {
    const transformed = await createAnthropicProxyResponse(
      new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: '[400]: upstream rejected request',
          },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '7' },
        }
      )
    );

    expect(transformed.status).toBe(400);
    expect(transformed.headers.get('retry-after')).toBe('7');
    const body = (await transformed.json()) as {
      type?: string;
      error?: { type?: string; message?: string };
    };
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('invalid_request_error');
    expect(body.error?.message).toBe('[400]: upstream rejected request');
  });

  it('returns 502 when Cursor response choices are malformed', async () => {
    const transformed = await createAnthropicProxyResponse(
      new Response(
        JSON.stringify({
          id: 'chatcmpl_missing_message',
          model: 'claude-sonnet-4.5',
          choices: [{ index: 0 }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    expect(transformed.status).toBe(502);
    const body = (await transformed.json()) as {
      type?: string;
      error?: { type?: string; message?: string };
    };
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('api_error');
    expect(body.error?.message).toBe('Failed to translate OpenAI-compatible JSON response');
  });

  it('converts OpenAI SSE chunks into Anthropic SSE events', async () => {
    const openAiSse = [
      'data: {"id":"chatcmpl_2","object":"chat.completion.chunk","created":1,"model":"claude-sonnet-4.5","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl_2","object":"chat.completion.chunk","created":1,"model":"claude-sonnet-4.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const transformed = await createAnthropicProxyResponse(
      new Response(openAiSse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const body = await transformed.text();
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_start');
    expect(body).toContain('"type":"text_delta"');
    expect(body).toContain('event: message_stop');
  });

  it('emits Anthropic-style error events when SSE translation fails', async () => {
    const oversizedChunk = `data: ${'x'.repeat(1024 * 1024 + 32)}`;

    const transformed = await createAnthropicProxyResponse(
      new Response(oversizedChunk, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const body = await transformed.text();
    expect(body).toContain('event: error');
    expect(body).toContain('"type":"error"');
    expect(body).toContain('"error":{"type":"api_error"');
    expect(body).toContain('Failed to translate OpenAI-compatible SSE response');
  });

  it('emits Anthropic-style error events when SSE JSON is malformed', async () => {
    const transformed = await createAnthropicProxyResponse(
      new Response('data: {not-json}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      })
    );

    const body = await transformed.text();
    expect(body).toContain('event: error');
    expect(body).toContain('"type":"error"');
    expect(body).toContain('"error":{"type":"api_error"');
    expect(body).toContain('Failed to translate OpenAI-compatible SSE response');
  });
});
