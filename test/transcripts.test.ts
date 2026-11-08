import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Inventory, Measurement, Usage } from '../src/core/model';
import { ClaudePaths, slug } from '../src/core/paths';
import {
  collectUsage,
  isUnused,
  measureLatestSession,
  pluginUsed,
} from '../src/core/transcripts';
import { createTranscriptFixture, type TranscriptFixture } from './fixtures/transcripts/fixture';

function attributedTotal(measurement: Measurement): number {
  let total = measurement.builtinToolNames.tokens;
  for (const cost of Object.values(measurement.mcpTools)) {
    total += cost.tokens;
  }
  for (const cost of Object.values(measurement.mcpInstructions)) {
    total += cost.tokens;
  }
  for (const cost of Object.values(measurement.skillsByOwner)) {
    total += cost.tokens;
  }
  for (const cost of Object.values(measurement.agentsByOwner)) {
    total += cost.tokens;
  }
  for (const hook of measurement.hooks) {
    total += hook.tokens;
  }
  for (const file of measurement.instructions) {
    total += file.tokens;
  }
  return total;
}

describe('transcripts', () => {
  let fixture!: TranscriptFixture;
  let measurement: Measurement | undefined;
  let usage: Usage;

  beforeAll(async () => {
    fixture = await createTranscriptFixture();
    measurement = await measureLatestSession(
      fixture.projectPath,
      fixture.paths,
      fixture.inventory,
    );
    usage = await collectUsage(
      fixture.projectPath,
      fixture.paths,
      fixture.inventory,
      30,
      fixture.now,
    );
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.cleanup();
    }
  });

  describe('measureLatestSession', () => {
    it('picks the latest project session and reads the first assistant usage', () => {
      const m = measurement!;
      expect(m).toBeDefined();
      expect(m.sessionId).toBe(fixture.sessionIds.main);
      expect(m.sessionFile.endsWith(fixture.sessionIds.main + '.jsonl')).toBe(true);
      expect(m.startedAt).toBe(fixture.timestamps.main);
      expect(m.baselineTokens).toBe(60002);
    });

    it('groups MCP tool names by inventory id or by their prefix', () => {
      const m = measurement!;
      expect(m.mcpTools['plugin:vercel:vercel']).toMatchObject({ toolCount: 3 });
      // Disabled plugin with no scanned server: the sanitized prefix is rebuilt
      // into the plugin's inventory id, not kept as a raw prefix.
      expect(m.mcpTools['plugin:supabase:supabase']).toMatchObject({ toolCount: 1 });
      expect(m.mcpTools['plugin_supabase_supabase']).toBeUndefined();
      expect(Object.keys(m.mcpTools)).toContain('claude-in-chrome');
      expect(m.mcpTools['claude-in-chrome']?.toolCount).toBe(1);
      expect(m.builtinToolNames).toMatchObject({ count: 3 });
      expect(m.mcpInstructions['plugin:vercel:vercel']?.tokens).toBeGreaterThan(0);
    });

    it('attributes skills, agents and hooks to their owners', () => {
      const m = measurement!;
      // `- vercel:ai-sdk` has no description and must not become standalone.
      expect(m.skillsByOwner['vercel']).toMatchObject({ count: 2 });
      // `- claude-seo:seo-geo` keeps its whole name as the plugin prefix.
      expect(m.skillsByOwner['claude-seo']).toMatchObject({ count: 1 });
      expect(m.skillsByOwner['(standalone)']).toMatchObject({ count: 1 });
      expect(m.agentsByOwner['ads']).toMatchObject({ count: 1 });
      expect(m.agentsByOwner['vercel']).toMatchObject({ count: 1 });
      expect(m.hooks).toHaveLength(4);
      expect(m.hooks[0]).toMatchObject({ event: 'SessionStart', owner: 'vercel' });
      expect(m.hooks[1]).toMatchObject({
        event: 'UserPromptSubmit',
        command: 'Checking i-have-adhd always-on flag...',
        owner: 'vercel',
      });
      expect(m.hooks[2]).toMatchObject({ owner: 'vercel' });
      expect(m.hooks[3]).toMatchObject({ owner: '(settings)', command: 'echo user-hook' });
      expect(m.instructions).toHaveLength(1);
      expect(m.instructions[0].path.endsWith('CLAUDE.md')).toBe(true);
    });

    it('ignores attachments that appear after the first assistant record', () => {
      const m = measurement!;
      expect(m.mcpTools['plugin:vercel:vercel']?.toolCount).toBe(3);
      expect(m.builtinToolNames.count).toBe(3);
      expect(m.skillsByOwner['vercel']?.count).toBe(2);
      expect(m.agentsByOwner['ads']?.count).toBe(1);
      expect(m.hooks).toHaveLength(4);
      expect(m.instructions).toHaveLength(1);
    });

    it('computes otherTokens as the unattributed remainder of the baseline', () => {
      const m = measurement!;
      expect(m.otherTokens).toBe(m.baselineTokens - attributedTotal(m));
      expect(m.otherTokens).toBeGreaterThan(0);
    });
  });

  describe('collectUsage', () => {
    it('counts MCP, skill, command and agent uses', () => {
      expect(usage.mcp['plugin:vercel:vercel']).toMatchObject({ count: 2 });
      expect(usage.skills['vercel:s1']).toMatchObject({ count: 1 });
      expect(usage.skills['myskill']).toMatchObject({ count: 1 });
      expect(usage.agents['ads:a2']).toMatchObject({ count: 1 });
      expect(usage.skills['myskill']?.lastUsed).toBe(fixture.timestamps.usage);
      expect(usage.mcp['plugin:vercel:vercel']?.lastUsed).toBe(fixture.timestamps.usage);
    });

    it('skips corrupted lines, out-of-window sessions and other projects', () => {
      expect(usage.sessionCount).toBe(2);
      expect(usage.skills['old-skill']).toBeUndefined();
      expect(usage.agents['old:agent']).toBeUndefined();
      expect(usage.skills['other-skill']).toBeUndefined();
      expect(usage.agents['other:agent']).toBeUndefined();
    });
  });

  describe('pluginUsed / isUnused', () => {
    it('sums usage across a plugin and keeps the latest timestamp', () => {
      const vercel = fixture.inventory.plugins.find((plugin) => plugin.name === 'vercel');
      expect(vercel).toBeDefined();
      const entry = pluginUsed(vercel!, usage, fixture.inventory);
      expect(entry.count).toBeGreaterThanOrEqual(3);
      expect(entry.lastUsed).toBe(fixture.timestamps.usage);
    });

    it('flags an item as unused only in a window with at least three sessions', () => {
      const base: Usage = {
        windowDays: 30,
        sessionCount: 2,
        mcp: {},
        skills: {},
        agents: {},
      };
      expect(isUnused({ count: 0 }, base)).toBe(false);
      expect(isUnused(undefined, base)).toBe(false);
      expect(isUnused(undefined, { ...base, sessionCount: 3 })).toBe(true);
      expect(isUnused({ count: 0 }, { ...base, sessionCount: 3 })).toBe(true);
      expect(isUnused({ count: 1 }, { ...base, sessionCount: 3 })).toBe(false);
    });
  });
});

describe('session membership uses the first user cwd', () => {
  let root!: string;
  let projectPath!: string;
  let paths!: ClaudePaths;
  let inventory!: Inventory;
  let measurement: Measurement | undefined;
  let usage: Usage;

  function writeJsonl(file: string, records: Array<Record<string, unknown>>): void {
    const text = records.map((record) => JSON.stringify(record)).join('\n');
    fs.writeFileSync(file, `${text}\n`, 'utf8');
  }

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cci-cwd-'));
    const home = path.join(root, 'home');
    projectPath = path.join(root, 'project');
    paths = ClaudePaths(home);
    const transcriptDir = path.join(paths.transcriptsRoot, slug(projectPath));
    await fsp.mkdir(transcriptDir, { recursive: true });
    await fsp.mkdir(projectPath, { recursive: true });

    inventory = {
      projectPath,
      mcpServers: [],
      plugins: [],
      skills: [],
      agents: [],
      hooks: [],
      instructions: [],
      warnings: [],
    };

    const timestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const driftFile = path.join(transcriptDir, 'cwd-drift.jsonl');
    writeJsonl(driftFile, [
      {
        type: 'user',
        cwd: projectPath,
        timestamp,
        message: { role: 'user', content: 'hello' },
      },
      {
        // First cwd already matched; this later value must be ignored.
        type: 'user',
        cwd: 'D:\\tmp\\ptest',
        timestamp,
        message: { role: 'user', content: 'somewhere else now' },
      },
      {
        type: 'attachment',
        timestamp,
        attachment: { type: 'skill_listing', content: '- drift:skill: d' },
      },
      {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 2000,
          },
          content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'drift-skill' } }],
        },
      },
      {
        type: 'user',
        cwd: 'D:\\tmp\\ptest',
        timestamp,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<command-name>/drift-command</command-name>' }],
        },
      },
      {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'drift-after' } }],
        },
      },
    ]);

    const reverseFile = path.join(transcriptDir, 'cwd-reverse.jsonl');
    writeJsonl(reverseFile, [
      {
        type: 'user',
        cwd: 'D:\\Other\\Project',
        timestamp,
        message: { role: 'user', content: 'not mine' },
      },
      {
        type: 'user',
        cwd: projectPath,
        timestamp,
        message: { role: 'user', content: 'now here' },
      },
      {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          usage: { input_tokens: 999 },
          content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'reverse-skill' } }],
        },
      },
    ]);

    // Drift is the newest session; reverse is older but still in the window.
    const now = Date.now();
    fs.utimesSync(driftFile, new Date(now - 60 * 1000), new Date(now - 60 * 1000));
    fs.utimesSync(reverseFile, new Date(now - 10 * 60 * 1000), new Date(now - 10 * 60 * 1000));

    measurement = await measureLatestSession(projectPath, paths, inventory);
    usage = await collectUsage(projectPath, paths, inventory, 30);
  });

  afterAll(async () => {
    if (root) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('does not exclude a session when a later record changes cwd', () => {
    expect(measurement).toBeDefined();
    expect(measurement!.sessionId).toBe('cwd-drift');
    expect(measurement!.baselineTokens).toBe(3010);
    expect(measurement!.skillsByOwner['drift']).toMatchObject({ count: 1 });
  });

  it('keeps counting usage after a later cwd change', () => {
    expect(usage.sessionCount).toBe(1);
    expect(usage.skills['drift-skill']).toMatchObject({ count: 1 });
    expect(usage.skills['drift-command']).toMatchObject({ count: 1 });
    expect(usage.skills['drift-after']).toMatchObject({ count: 1 });
  });

  it('still excludes a session whose first cwd is another project', () => {
    expect(usage.skills['reverse-skill']).toBeUndefined();
  });
});
