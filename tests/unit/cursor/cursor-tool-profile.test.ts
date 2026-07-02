import { describe, expect, it } from 'bun:test';
import {
  detectToolClientProfile,
  remapToolCallForProfile,
} from '../../../src/cursor/cursor-tool-profile.js';

describe('cursor-tool-profile', () => {
  it('detects hermes profile from registered tool names', () => {
    expect(detectToolClientProfile(['read_file', 'terminal'])).toBe('hermes');
    expect(detectToolClientProfile(['Read', 'Bash'])).toBe('claude_code');
    expect(detectToolClientProfile([])).toBe('claude_code');
  });

  it('maps cursor internal tools to Claude Code names', () => {
    const remapped = remapToolCallForProfile(
      'list_dir',
      { relative_workspace_path: '/tmp' },
      'claude_code'
    );
    expect(remapped?.name).toBe('Glob');
    expect(remapped?.args).toEqual({
      target_directory: '/tmp',
      glob_pattern: '*',
    });
  });

  it('maps cursor internal tools to Hermes names and args', () => {
    const remapped = remapToolCallForProfile(
      'list_dir',
      { relative_workspace_path: '/tmp' },
      'hermes'
    );
    expect(remapped?.name).toBe('search_files');
    expect(remapped?.args).toEqual({
      pattern: '*',
      target: 'files',
      path: '/tmp',
    });
  });

  it('maps Claude Code Read to Hermes read_file', () => {
    const remapped = remapToolCallForProfile(
      'Read',
      { file_path: '/tmp/a.txt', limit: 10 },
      'hermes'
    );
    expect(remapped?.name).toBe('read_file');
    expect(remapped?.args).toEqual({
      path: '/tmp/a.txt',
      limit: 10,
    });
  });

  it('maps Claude Code Bash to Hermes terminal', () => {
    const remapped = remapToolCallForProfile(
      'Bash',
      { command: 'ls -la', description: 'list files' },
      'hermes'
    );
    expect(remapped?.name).toBe('terminal');
    expect(remapped?.args).toEqual({ command: 'ls -la' });
  });

  it('maps cursor write tools to Claude Code Write with content param', () => {
    const fromWriteFile = remapToolCallForProfile(
      'write_file',
      { target_file: '/tmp/a.java', contents: 'class A {}' },
      'claude_code'
    );
    expect(fromWriteFile?.name).toBe('Write');
    expect(fromWriteFile?.args).toEqual({
      file_path: '/tmp/a.java',
      content: 'class A {}',
    });

    const fromWrite = remapToolCallForProfile(
      'Write',
      { file_path: '/tmp/b.java', content: 'class B {}' },
      'claude_code'
    );
    expect(fromWrite?.args).toEqual({
      file_path: '/tmp/b.java',
      content: 'class B {}',
    });
  });

  it('maps cursor edit_file full-file writes to Claude Code Write', () => {
    const remapped = remapToolCallForProfile(
      'edit_file',
      { target_file: '/tmp/NewDto.java', contents: 'package dto;' },
      'claude_code'
    );
    expect(remapped?.name).toBe('Write');
    expect(remapped?.args).toEqual({
      file_path: '/tmp/NewDto.java',
      content: 'package dto;',
    });
  });
});
