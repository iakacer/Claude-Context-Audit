import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Inventory,
  McpServer,
  Plugin,
  SkillOrAgent,
} from '../../../src/core/model';
import { ClaudePaths, slug } from '../../../src/core/paths';

export interface TranscriptFixture {
  root: string;
  projectPath: string;
  paths: ClaudePaths;
  inventory: Inventory;
  now: number;
  sessionIds: {
    main: string;
    usage: string;
    outsideWindow: string;
    otherProject: string;
  };
  timestamps: {
    main: string;
    usage: string;
    otherProject: string;
    outsideWindow: string;
  };
  cleanup: () => Promise<void>;
}

type FixtureRecord = Record<string, unknown> | string;

function writeSession(file: string, records: FixtureRecord[]): void {
  const lines = records.map((record) =>
    typeof record === 'string' ? record : JSON.stringify(record),
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function pluginSkill(name: string, pluginKey: string, file: string): SkillOrAgent {
  return {
    kind: 'skill',
    name,
    description: 'd',
    scope: 'plugin',
    pluginKey,
    file,
    estTokens: 3,
  };
}

function mcpServer(id: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    id,
    name: overrides.name ?? id,
    scope: overrides.scope ?? 'plugin',
    pluginKey: overrides.pluginKey,
    sourceFile: overrides.sourceFile,
    transport: overrides.transport,
    disabled: overrides.disabled ?? false,
    needsAuth: overrides.needsAuth ?? false,
  };
}

/**
 * Build a temporary fixture home with synthetic transcripts. The JSONL files
 * are written from objects so every line stays valid JSON.
 */
export async function createTranscriptFixture(): Promise<TranscriptFixture> {
  const now = Date.now();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cci-transcripts-'));
  const home = path.join(root, 'home');
  const projectPath = path.join(root, 'project');
  const paths = ClaudePaths(home);
  const transcriptDir = path.join(paths.transcriptsRoot, slug(projectPath));
  await fsp.mkdir(transcriptDir, { recursive: true });
  await fsp.mkdir(projectPath, { recursive: true });

  const installPath = path.join(root, 'plugins', 'vercel-plugin');
  const vercelPlugin: Plugin = {
    key: 'vercel-plugin@vercel',
    name: 'vercel',
    marketplace: 'vercel',
    version: '1.0.0',
    installPath,
    enabled: true,
    enabledSource: 'user',
    skills: [
      pluginSkill('vercel:s1', 'vercel-plugin@vercel', path.join(installPath, 'skills', 's1', 'SKILL.md')),
    ],
    agents: [],
    commands: [],
    hooks: [],
    mcpServerIds: ['plugin:vercel:vercel'],
  };

  const inventory: Inventory = {
    projectPath,
    mcpServers: [
      mcpServer('plugin:vercel:vercel', {
        name: 'vercel',
        pluginKey: 'vercel-plugin@vercel',
        sourceFile: path.join(installPath, '.mcp.json'),
      }),
      mcpServer('claude.ai Gmail', { name: 'claude.ai Gmail', scope: 'claudeai' }),
    ],
    plugins: [vercelPlugin],
    skills: [
      {
        kind: 'skill',
        name: 'myskill',
        description: 'd',
        scope: 'user',
        file: path.join(paths.claudeDir, 'skills', 'myskill', 'SKILL.md'),
        estTokens: 3,
      },
    ],
    agents: [],
    hooks: [],
    instructions: [],
    warnings: [],
  };

  const mainTimestamp = iso(now - 60 * 60 * 1000);
  const usageTimestamp = iso(now - 2 * 60 * 60 * 1000);
  const otherTimestamp = iso(now - 10 * 60 * 1000);
  const outsideTimestamp = iso(now - 40 * 24 * 60 * 60 * 1000);

  const mainSession = 'main-session.jsonl';
  const usageSession = 'usage-session.jsonl';
  const outsideSession = 'outside-window-session.jsonl';
  const otherSession = 'other-project-session.jsonl';

  writeSession(path.join(transcriptDir, mainSession), [
    {
      type: 'user',
      cwd: projectPath,
      timestamp: mainTimestamp,
      message: { role: 'user', content: 'hello' },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: [
          'mcp__plugin_vercel_vercel__a',
          'mcp__plugin_vercel_vercel__b',
          'mcp__plugin_vercel_vercel__c',
          'mcp__claude-in-chrome__x',
          'Read',
          'Bash',
          'Edit',
        ],
      },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'mcp_instructions_delta',
        addedNames: ['plugin:vercel:vercel'],
        addedBlocks: ['Use the vercel tools.'],
      },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'skill_listing',
        content: '- vercel:s1: d\n- myskill: d',
      },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'agent_listing_delta',
        addedTypes: ['ads:a2'],
        addedLines: ['- ads:a2: d'],
      },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'hook_success',
        hookEvent: 'SessionStart',
        command: `node "${path.join(installPath, 'hooks', 'run.js')}"`,
        content: 'hook says hi',
      },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'instructions',
        files: [
          {
            path: path.join(projectPath, 'CLAUDE.md'),
            type: 'text',
            content: 'project instructions',
          },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: mainTimestamp,
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 40000,
          cache_read_input_tokens: 20000,
        },
        content: [],
      },
    },
    // Everything below happens after the first assistant record and must not
    // contribute to the starting-context measurement.
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: ['mcp__plugin_vercel_vercel__d', 'Write'],
      },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: { type: 'skill_listing', content: '- vercel:s2: d' },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'agent_listing_delta',
        addedTypes: ['ads:a9'],
        addedLines: ['- ads:a9: d'],
      },
    },
    {
      type: 'attachment',
      timestamp: mainTimestamp,
      attachment: {
        type: 'hook_success',
        hookEvent: 'PostToolUse',
        command: `node "${path.join(installPath, 'hooks', 'late.js')}"`,
        content: 'late hook',
      },
    },
  ]);

  writeSession(path.join(transcriptDir, usageSession), [
    {
      type: 'user',
      cwd: projectPath,
      timestamp: usageTimestamp,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<command-name>/myskill</command-name>' }],
      },
    },
    '{ this line is intentionally corrupted json',
    {
      type: 'assistant',
      timestamp: usageTimestamp,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'mcp__plugin_vercel_vercel__a', input: {} },
          { type: 'tool_use', id: 't2', name: 'mcp__plugin_vercel_vercel__a', input: {} },
          { type: 'tool_use', id: 't3', name: 'Skill', input: { skill: 'vercel:s1' } },
          { type: 'tool_use', id: 't4', name: 'Agent', input: { subagent_type: 'ads:a2' } },
        ],
      },
    },
  ]);

  writeSession(path.join(transcriptDir, otherSession), [
    {
      type: 'user',
      cwd: 'D:\\Other\\Project',
      timestamp: otherTimestamp,
      message: { role: 'user', content: 'not this project' },
    },
    {
      type: 'assistant',
      timestamp: otherTimestamp,
      message: {
        role: 'assistant',
        usage: { input_tokens: 999 },
        content: [
          { type: 'tool_use', id: 'o1', name: 'mcp__plugin_vercel_vercel__a', input: {} },
          { type: 'tool_use', id: 'o2', name: 'Skill', input: { skill: 'other-skill' } },
          { type: 'tool_use', id: 'o3', name: 'Task', input: { subagent_type: 'other:agent' } },
        ],
      },
    },
  ]);

  writeSession(path.join(transcriptDir, outsideSession), [
    {
      type: 'user',
      cwd: projectPath,
      timestamp: outsideTimestamp,
      message: { role: 'user', content: 'old session' },
    },
    {
      type: 'assistant',
      timestamp: outsideTimestamp,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'x1', name: 'Skill', input: { skill: 'old-skill' } },
          { type: 'tool_use', id: 'x2', name: 'Agent', input: { subagent_type: 'old:agent' } },
        ],
      },
    },
  ]);

  // Newest first: other-project (skipped by cwd), main, usage, out of window.
  const setMtime = (name: string, mtime: number): void => {
    const file = path.join(transcriptDir, name);
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  };
  setMtime(otherSession, now - 10 * 60 * 1000);
  setMtime(mainSession, now - 60 * 60 * 1000);
  setMtime(usageSession, now - 2 * 60 * 60 * 1000);
  setMtime(outsideSession, now - 40 * 24 * 60 * 60 * 1000);

  return {
    root,
    projectPath,
    paths,
    inventory,
    now,
    sessionIds: {
      main: path.basename(mainSession, '.jsonl'),
      usage: path.basename(usageSession, '.jsonl'),
      outsideWindow: path.basename(outsideSession, '.jsonl'),
      otherProject: path.basename(otherSession, '.jsonl'),
    },
    timestamps: {
      main: mainTimestamp,
      usage: usageTimestamp,
      otherProject: otherTimestamp,
      outsideWindow: outsideTimestamp,
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}
