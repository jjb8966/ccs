import { describe, expect, it } from 'bun:test';
import {
  AssistantResponseStreamParser,
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

  it('passes through simple responses without thinking markers', () => {
    const parser = new AssistantResponseStreamParser();
    const events = [...parser.push('OK'), ...parser.finish()];

    expect(events).toEqual([{ kind: 'content', text: 'OK' }]);
  });
});
