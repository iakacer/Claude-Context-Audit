import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Measurement, Usage } from '../src/core/model';
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
      expect(Object.keys(m.mcpTools)).toContain('claude-in-chrome');
      expect(m.mcpTools['claude-in-chrome']?.toolCount).toBe(1);
      expect(m.builtinToolNames).toMatchObject({ count: 3 });
      expect(m.mcpInstructions['plugin:vercel:vercel']?.tokens).toBeGreaterThan(0);
    });

    it('attributes skills, agents and hooks to their owners', () => {
      const m = measurement!;
      expect(m.skillsByOwner['vercel']).toMatchObject({ count: 1 });
      expect(m.skillsByOwner['(standalone)']).toMatchObject({ count: 1 });
      expect(m.agentsByOwner['ads']).toMatchObject({ count: 1 });
      expect(m.hooks).toHaveLength(1);
      expect(m.hooks[0]).toMatchObject({ event: 'SessionStart', owner: 'vercel' });
      expect(m.instructions).toHaveLength(1);
      expect(m.instructions[0].path.endsWith('CLAUDE.md')).toBe(true);
    });

    it('ignores attachments that appear after the first assistant record', () => {
      const m = measurement!;
      expect(m.mcpTools['plugin:vercel:vercel']?.toolCount).toBe(3);
      expect(m.builtinToolNames.count).toBe(3);
      expect(m.skillsByOwner['vercel']?.count).toBe(1);
      expect(m.agentsByOwner['ads']?.count).toBe(1);
      expect(m.hooks).toHaveLength(1);
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
