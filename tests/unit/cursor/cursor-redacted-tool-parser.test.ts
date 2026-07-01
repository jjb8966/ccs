import { describe, expect, it } from 'bun:test';
import {
  AssistantResponseStreamParser,
  extractAvailableToolNames,
  extractBracketToolUseCalls,
  extractRedactedToolCalls,
  parseRedactedToolBlock,
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
});
