/**
 * Map Cursor / Claude Code / Hermes tool names to the client's registered tools.
 */

export type ToolClientProfile = 'claude_code' | 'hermes';
export type ToolFamily = 'read' | 'glob' | 'grep' | 'shell' | 'write' | 'edit' | 'task';

const HERMES_TOOL_MARKERS = new Set([
  'read_file',
  'write_file',
  'search_files',
  'terminal',
  'patch',
  'delegate_task',
]);

const CLAUDE_CODE_TOOL_MARKERS = new Set([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'Task',
  'WebFetch',
  'WebSearch',
]);

const TOOL_NAME_BY_PROFILE: Record<ToolFamily, Record<ToolClientProfile, string>> = {
  read: { claude_code: 'Read', hermes: 'read_file' },
  glob: { claude_code: 'Glob', hermes: 'search_files' },
  grep: { claude_code: 'Grep', hermes: 'search_files' },
  shell: { claude_code: 'Bash', hermes: 'terminal' },
  write: { claude_code: 'Write', hermes: 'write_file' },
  edit: { claude_code: 'Edit', hermes: 'patch' },
  task: { claude_code: 'Task', hermes: 'delegate_task' },
};

export const TOOL_NAME_TO_FAMILY: Record<string, ToolFamily> = {
  Read: 'read',
  read_file: 'read',
  read: 'read',
  Glob: 'glob',
  Grep: 'grep',
  grep: 'grep',
  Bash: 'shell',
  bash: 'shell',
  terminal: 'shell',
  run_terminal_cmd: 'shell',
  Write: 'write',
  write_file: 'write',
  write: 'write',
  Edit: 'edit',
  patch: 'edit',
  search_replace: 'edit',
  edit_file: 'edit',
  Task: 'task',
  task: 'task',
  run_task: 'task',
  Agent: 'task',
  delegate_task: 'task',
  list_dir: 'glob',
  glob_file_search: 'glob',
  ripgrep_search: 'grep',
  codebase_search: 'grep',
  file_search: 'grep',
};

function filePathFromArgs(args: Record<string, unknown>): string | undefined {
  const value = args.file_path ?? args.target_file ?? args.path;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function remapReadArgs(
  args: Record<string, unknown>,
  profile: ToolClientProfile
): Record<string, unknown> {
  const filePath = filePathFromArgs(args);
  if (profile === 'hermes') {
    const remapped: Record<string, unknown> = {};
    if (filePath) {
      remapped.path = filePath;
    }
    if (args.limit !== undefined) {
      remapped.limit = args.limit;
    }
    if (args.offset !== undefined) {
      remapped.offset = args.offset;
    }
    return remapped;
  }

  const remapped: Record<string, unknown> = {};
  if (filePath) {
    remapped.file_path = filePath;
  }
  if (args.limit !== undefined) {
    remapped.limit = args.limit;
  }
  if (args.offset !== undefined) {
    remapped.offset = args.offset;
  }
  return remapped;
}

function remapGlobArgs(
  args: Record<string, unknown>,
  profile: ToolClientProfile,
  sourceToolName?: string
): Record<string, unknown> {
  const directory = args.target_directory ?? args.relative_workspace_path ?? args.path ?? '.';
  const defaultPattern = sourceToolName === 'glob_file_search' ? '**/*' : '*';
  const globPattern = args.glob_pattern ?? defaultPattern;

  if (profile === 'hermes') {
    return {
      pattern: globPattern,
      target: 'files',
      path: directory,
    };
  }

  return {
    target_directory: directory,
    glob_pattern: globPattern,
  };
}

function remapGrepArgs(
  args: Record<string, unknown>,
  profile: ToolClientProfile
): Record<string, unknown> {
  const pattern = args.pattern ?? args.query ?? args.search_term ?? '';
  const path = args.path ?? args.relative_workspace_path ?? args.target_directory ?? '.';

  if (profile === 'hermes') {
    const remapped: Record<string, unknown> = {
      pattern,
      target: 'content',
      path,
    };
    const fileGlob = args.glob ?? args.glob_pattern ?? args.file_glob;
    if (fileGlob !== undefined) {
      remapped.file_glob = fileGlob;
    }
    return remapped;
  }

  return {
    pattern,
    path,
    glob: args.glob ?? args.glob_pattern,
  };
}

function remapShellArgs(
  args: Record<string, unknown>,
  profile: ToolClientProfile
): Record<string, unknown> {
  const remapped: Record<string, unknown> = {};
  if (args.command) {
    remapped.command = args.command;
  }
  if (profile === 'claude_code') {
    const description = args.explanation ?? args.description;
    if (description) {
      remapped.description = description;
    }
  }
  return remapped;
}

function remapWriteArgs(
  args: Record<string, unknown>,
  profile: ToolClientProfile
): Record<string, unknown> {
  const filePath = filePathFromArgs(args);
  const content = args.contents ?? args.content;

  if (profile === 'hermes') {
    const remapped: Record<string, unknown> = {};
    if (filePath) {
      remapped.path = filePath;
    }
    if (content !== undefined) {
      remapped.content = content;
    }
    return remapped;
  }

  const remapped: Record<string, unknown> = {};
  if (filePath) {
    remapped.file_path = filePath;
  }
  if (content !== undefined) {
    remapped.content = content;
  }
  return remapped;
}

function remapEditArgs(
  args: Record<string, unknown>,
  profile: ToolClientProfile
): Record<string, unknown> {
  const filePath = filePathFromArgs(args);

  if (profile === 'hermes') {
    const remapped: Record<string, unknown> = { mode: 'replace' };
    if (filePath) {
      remapped.path = filePath;
    }
    if (args.old_string !== undefined) {
      remapped.old_string = args.old_string;
    }
    if (args.new_string !== undefined) {
      remapped.new_string = args.new_string;
    }
    if (args.replace_all !== undefined) {
      remapped.replace_all = args.replace_all;
    }
    return remapped;
  }

  const remapped: Record<string, unknown> = {};
  if (filePath) {
    remapped.file_path = filePath;
  }
  if (args.old_string !== undefined) {
    remapped.old_string = args.old_string;
  }
  if (args.new_string !== undefined) {
    remapped.new_string = args.new_string;
  }
  if (args.replace_all !== undefined) {
    remapped.replace_all = args.replace_all;
  }
  return remapped;
}

function remapTaskArgs(
  args: Record<string, unknown>,
  profile: ToolClientProfile
): Record<string, unknown> {
  const prompt = args.prompt ?? args.description ?? args.goal ?? '';
  if (profile === 'hermes') {
    const remapped: Record<string, unknown> = { goal: prompt };
    if (args.context) {
      remapped.context = args.context;
    } else if (args.subagent_type ?? args.agent_type) {
      remapped.context = `subagent_type: ${args.subagent_type ?? args.agent_type}`;
    }
    return remapped;
  }

  return {
    description: prompt,
    prompt,
    subagent_type: args.subagent_type ?? args.agent_type ?? 'generalPurpose',
    model: args.model,
  };
}

const FAMILY_ARG_REMAPPERS: Record<
  ToolFamily,
  (args: Record<string, unknown>, profile: ToolClientProfile) => Record<string, unknown>
> = {
  read: remapReadArgs,
  glob: remapGlobArgs,
  grep: remapGrepArgs,
  shell: remapShellArgs,
  write: remapWriteArgs,
  edit: remapEditArgs,
  task: remapTaskArgs,
};

export function detectToolClientProfile(availableTools?: Iterable<string>): ToolClientProfile {
  const names = availableTools ? [...availableTools] : [];
  if (names.some((name) => HERMES_TOOL_MARKERS.has(name))) {
    return 'hermes';
  }
  if (names.some((name) => CLAUDE_CODE_TOOL_MARKERS.has(name))) {
    return 'claude_code';
  }
  return 'claude_code';
}

export function resolveToolFamily(toolName: string): ToolFamily | undefined {
  return TOOL_NAME_TO_FAMILY[toolName];
}

export function resolveToolNameForProfile(
  toolName: string,
  profile: ToolClientProfile
): string | undefined {
  const family = resolveToolFamily(toolName);
  if (!family) {
    return undefined;
  }
  return TOOL_NAME_BY_PROFILE[family][profile];
}

export function remapToolArgsForProfile(
  family: ToolFamily,
  args: Record<string, unknown>,
  profile: ToolClientProfile,
  sourceToolName?: string
): Record<string, unknown> {
  if (family === 'glob') {
    return remapGlobArgs(args, profile, sourceToolName);
  }
  return FAMILY_ARG_REMAPPERS[family](args, profile);
}

export function remapToolCallForProfile(
  toolName: string,
  args: Record<string, unknown>,
  profile: ToolClientProfile
): { name: string; args: Record<string, unknown> } | null {
  const family = resolveToolFamily(toolName);
  if (!family) {
    return null;
  }

  const fullFileContent = args.contents ?? args.content;
  if (
    family === 'edit' &&
    profile === 'claude_code' &&
    fullFileContent !== undefined &&
    args.old_string === undefined &&
    args.new_string === undefined
  ) {
    return {
      name: 'Write',
      args: remapWriteArgs(args, profile),
    };
  }

  return {
    name: TOOL_NAME_BY_PROFILE[family][profile],
    args: remapToolArgsForProfile(family, args, profile, toolName),
  };
}
