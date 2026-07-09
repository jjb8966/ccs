import { describe, expect, it } from 'bun:test';
import {
  AssistantResponseStreamParser,
  extractAvailableToolNames,
  extractBracketToolUseCalls,
  extractRedactedToolCalls,
  extractToolCallResultCalls,
  parseRedactedToolBlock,
  parseToolCallResultAttributes,
  remapCursorInternalToolCalls,
} from '../../../src/cursor/cursor-redacted-tool-parser.js';

const SAMPLE_BLOCK = `<｜tool▁call▁begin｜>
list_dir
<｜tool▁sep｜>relative_workspace_path
/Users/jbj/agent
<｜tool▁call▁end｜><｜tool▁call▁begin｜>
read_file
<｜tool▁sep｜>target_file
/Users/jbj/agent/prompts/AGENTS.md
<｜tool▁sep｜>should_read_entire_file
false
<｜tool▁call▁end｜>`;

describe('cursor-redacted-tool-parser', () => {
  it('parses multiple redacted tool calls into OpenAI tool_calls', () => {
    const calls = parseRedactedToolBlock(SAMPLE_BLOCK);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.function.name).toBe('list_dir');
    expect(JSON.parse(calls[0]?.function.arguments || '{}')).toEqual({
      relative_workspace_path: '/Users/jbj/agent',
    });
    expect(calls[1]?.function.name).toBe('read_file');
    expect(JSON.parse(calls[1]?.function.arguments || '{}')).toEqual({
      target_file: '/Users/jbj/agent/prompts/AGENTS.md',
      should_read_entire_file: false,
    });
  });

  it('remaps cursor internal tool names to Claude Code tools', () => {
    const calls = remapCursorInternalToolCalls(parseRedactedToolBlock(SAMPLE_BLOCK), [
      'Glob',
      'Read',
      'Bash',
    ]);

    expect(calls[0]?.function.name).toBe('Glob');
    expect(JSON.parse(calls[0]?.function.arguments || '{}')).toEqual({
      target_directory: '/Users/jbj/agent',
      glob_pattern: '*',
    });
    expect(calls[1]?.function.name).toBe('Read');
    expect(JSON.parse(calls[1]?.function.arguments || '{}')).toEqual({
      file_path: '/Users/jbj/agent/prompts/AGENTS.md',
    });
  });

  it('remaps cursor internal tool names even when the available tool list is empty', () => {
    const calls = remapCursorInternalToolCalls(parseRedactedToolBlock(SAMPLE_BLOCK), []);

    expect(calls[0]?.function.name).toBe('Glob');
    expect(calls[1]?.function.name).toBe('Read');
  });

  it('remaps cursor task tool calls to Claude Code Task', () => {
    const block = `<｜tool▁call▁begin｜>
task
<｜tool▁sep｜>description
Explore auth flow
<｜tool▁sep｜>subagent_type
generalPurpose
<｜tool▁call▁end｜>`;
    const [call] = remapCursorInternalToolCalls(parseRedactedToolBlock(block), ['Task']);

    expect(call?.function.name).toBe('Task');
    expect(JSON.parse(call?.function.arguments || '{}')).toEqual({
      description: 'Explore auth flow',
      prompt: 'Explore auth flow',
      subagent_type: 'generalPurpose',
    });
  });

  it('extracts available tool names from OpenAI and Anthropic tool shapes', () => {
    expect(
      extractAvailableToolNames([
        { type: 'function', function: { name: 'Task' } },
        { name: 'Bash', description: 'shell' },
      ] as never)
    ).toEqual(['Task', 'Bash']);
  });

  it('extracts tool calls and strips markup from assistant text', () => {
    const raw =
      '조사합니다.\n<｜tool▁calls▁begin｜>' +
      SAMPLE_BLOCK +
      '<｜tool▁calls▁end｜>';

    const parsed = extractRedactedToolCalls(raw);
    expect(parsed.text).toBe('조사합니다.');
    expect(parsed.toolCalls).toHaveLength(2);
  });

  it('streams intro text then tool_calls after the thinking marker', () => {
    const parser = new AssistantResponseStreamParser();
    const events = [
      ...parser.push('폴더를 조사합니다.</think>\n\n조사합니다.\n'),
      ...parser.push('<｜tool▁calls▁begin｜>'),
      ...parser.push(SAMPLE_BLOCK),
      ...parser.push('<｜tool▁calls▁end｜>'),
      ...parser.finish(),
    ];

    expect(events.some((event) => event.kind === 'content' && event.text.includes('조사합니다'))).toBe(
      true
    );
    const toolEvents = events.filter((event) => event.kind === 'tool_calls');
    expect(toolEvents).toHaveLength(1);
    if (toolEvents[0]?.kind === 'tool_calls') {
      expect(toolEvents[0].toolCalls).toHaveLength(2);
    }
  });

  it('buffers until </think> and emits nothing mid-thinking (live SSE must bypass this)', () => {
    // Legacy streams without <think> still buffer until </think>.
    // Streams WITH <think> flush reasoning progressively (see next test).
    const parser = new AssistantResponseStreamParser();
    expect(parser.push('long internal reasoning without end marker yet')).toEqual([]);
    expect(parser.push(' still more reasoning')).toEqual([]);
  });

  it('streams reasoning progressively after <think> without waiting for </think>', () => {
    const parser = new AssistantResponseStreamParser();
    const mid = parser.push('<think>step one of reasoning');
    expect(mid.some((e) => e.kind === 'reasoning' && e.text.includes('step one'))).toBe(true);

    const more = parser.push(' and step two');
    expect(more.some((e) => e.kind === 'reasoning' && e.text.includes('step two'))).toBe(true);

    const after = [
      ...parser.push('</think>\nfinal answer'),
      ...parser.finish(),
    ];
    expect(after.some((e) => e.kind === 'content' && e.text.includes('final answer'))).toBe(true);
    expect(after.every((e) => e.kind !== 'content' || !String(e.text).includes('step one'))).toBe(
      true
    );
  });

  it('extracts bracket-style tool_use text into tool calls', () => {
    const raw =
      '검색합니다.\n[tool_use Bash {"command":"mysql -e \\"show tables\\"","description":"list tables"}]';
    const parsed = extractRedactedToolCalls(raw);

    expect(parsed.text).toBe('검색합니다.');
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.function.name).toBe('Bash');
  });

  it('strips leaked redacted tool markers from visible text', () => {
    const raw = '요약입니다.\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const parsed = extractRedactedToolCalls(raw);
    expect(parsed.text).toBe('요약입니다.');
  });

  it('uses toolu_ ids for parsed tool calls', () => {
    const [call] = parseRedactedToolBlock(SAMPLE_BLOCK);
    expect(call?.id).toMatch(/^toolu_cursor_/);
  });

  it('streams bracket tool_use text into tool_calls during visible content', () => {
    const parser = new AssistantResponseStreamParser();
    const events = [
      ...parser.push('</think>\n\n검색합니다.\n'),
      ...parser.push('[tool_use Bash {"command":"ls -la","description":"list files"}]'),
      ...parser.finish(),
    ];

    const toolEvents = events.filter((event) => event.kind === 'tool_calls');
    expect(toolEvents).toHaveLength(1);
    if (toolEvents[0]?.kind === 'tool_calls') {
      expect(toolEvents[0].toolCalls[0]?.function.name).toBe('Bash');
      expect(toolEvents[0].toolCalls[0]?.id).toMatch(/^toolu_cursor_/);
    }
    expect(events.some((event) => event.kind === 'content' && event.text.includes('검색합니다'))).toBe(
      true
    );
  });

  it('remaps file_search to Grep', () => {
    const raw =
      '[tool_use file_search {"query":"sc_supply_chain_mapping","explanation":"find table"}]';
    const [call] = remapCursorInternalToolCalls(extractBracketToolUseCalls(raw), ['Grep']);

    expect(call?.function.name).toBe('Grep');
    expect(JSON.parse(call?.function.arguments || '{}')).toEqual({
      pattern: 'sc_supply_chain_mapping',
      path: '.',
    });
  });

  it('remaps cursor internal tools to Hermes when read_file is registered', () => {
    const calls = remapCursorInternalToolCalls(parseRedactedToolBlock(SAMPLE_BLOCK), [
      'read_file',
      'search_files',
      'terminal',
    ]);

    expect(calls[0]?.function.name).toBe('search_files');
    expect(JSON.parse(calls[0]?.function.arguments || '{}')).toEqual({
      pattern: '*',
      target: 'files',
      path: '/Users/jbj/agent',
    });
    expect(calls[1]?.function.name).toBe('read_file');
    expect(JSON.parse(calls[1]?.function.arguments || '{}')).toEqual({
      path: '/Users/jbj/agent/prompts/AGENTS.md',
    });
  });

  it('remaps bracket Bash to Hermes terminal', () => {
    const raw = '[tool_use Bash {"command":"hermes cron list","description":"list jobs"}]';
    const [call] = remapCursorInternalToolCalls(extractBracketToolUseCalls(raw), [
      'terminal',
      'read_file',
    ]);

    expect(call?.function.name).toBe('terminal');
    expect(JSON.parse(call?.function.arguments || '{}')).toEqual({
      command: 'hermes cron list',
    });
  });

  it('parses tool_call_result attribute blocks into tool calls', () => {
    const raw =
      '코드베이스와 DB 관련 문서를 검색합니다.\n' +
      '[tool_call_result name="Bash" command="grep -r supply_stable_name /tmp/project 2>/dev/null | head -80" description="mapping search"]\n' +
      '[tool_call_result name="Read" file_path="/tmp/project/docs/refactor.md" limit=200] ->';

    const parsed = extractRedactedToolCalls(raw);
    expect(parsed.text).toBe('코드베이스와 DB 관련 문서를 검색합니다.');
    expect(parsed.toolCalls).toHaveLength(2);

    const [bashCall, readCall] = remapCursorInternalToolCalls(parsed.toolCalls, ['Bash', 'Read']);
    expect(bashCall?.function.name).toBe('Bash');
    expect(JSON.parse(bashCall?.function.arguments || '{}')).toEqual({
      command: 'grep -r supply_stable_name /tmp/project 2>/dev/null | head -80',
      description: 'mapping search',
    });
    expect(readCall?.function.name).toBe('Read');
    expect(JSON.parse(readCall?.function.arguments || '{}')).toEqual({
      file_path: '/tmp/project/docs/refactor.md',
      limit: 200,
    });
  });

  it('parses tool_call_result attributes with escaped quotes', () => {
    const parsed = parseToolCallResultAttributes(
      'tool_call_result name="Bash" command="mysql -e \\"show tables\\"" description="list tables"'
    );

    expect(parsed).toEqual({
      name: 'Bash',
      args: {
        command: 'mysql -e "show tables"',
        description: 'list tables',
      },
    });
  });

  it('streams tool_call_result text into tool_calls during visible content', () => {
    const parser = new AssistantResponseStreamParser();
    const events = [
      ...parser.push('</think>\n\n검색합니다.\n'),
      ...parser.push(
        '[tool_call_result name="Bash" command="ls -la" description="list files"]'
      ),
      ...parser.finish(),
    ];

    const toolEvents = events.filter((event) => event.kind === 'tool_calls');
    expect(toolEvents).toHaveLength(1);
    if (toolEvents[0]?.kind === 'tool_calls') {
      expect(toolEvents[0].toolCalls[0]?.function.name).toBe('Bash');
    }
    expect(events.some((event) => event.kind === 'content' && event.text.includes('검색합니다'))).toBe(
      true
    );
  });

  it('extracts tool_call_result calls directly', () => {
    const raw =
      '[tool_call_result name="Grep" pattern="sc_supply_chain_mapping" path="."]';
    const calls = extractToolCallResultCalls(raw);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function.name).toBe('Grep');
  });
});
