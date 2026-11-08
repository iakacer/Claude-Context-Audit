import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Inventory } from '../src/core/model';
import { ClaudePaths } from '../src/core/paths';
import { buildInventory, matchingProjectKeys } from '../src/core/scanner';

const fixtureRoot = path.join(process.cwd(), 'test', 'fixtures', 'scan');

describe('buildInventory', () => {
  let tempRoot!: string;
  let projectPath!: string;
  let paths!: ClaudePaths;
  let inventory!: Inventory;
  let claudeJson: any;
  let forwardKey!: string;
  let backwardKey!: string;

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cci-scan-'));
    const copyRoot = path.join(tempRoot, 'fixture');
    await fsp.cp(fixtureRoot, copyRoot, { recursive: true });

    projectPath = path.join(copyRoot, 'project');
    paths = ClaudePaths(path.join(copyRoot, 'home'));

    forwardKey = projectPath.replace(/\\/g, '/');
    const rawBackward = projectPath.replace(/\//g, '\\');
    backwardKey = rawBackward.replace(/^[A-Za-z]/, (ch) =>
      ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(),
    );

    const claudeJsonPath = path.join(copyRoot, 'home', '.claude.json');
    claudeJson = JSON.parse(await fsp.readFile(claudeJsonPath, 'utf8'));
    const templateProjects = claudeJson.projects;
    claudeJson.projects = {
      [forwardKey]: templateProjects['D:/Work/demo'],
      [backwardKey]: templateProjects['d:\\Work\\demo'],
    };
    await fsp.writeFile(claudeJsonPath, JSON.stringify(claudeJson, null, 2));

    const installedPath = path.join(paths.claudeDir, 'plugins', 'installed_plugins.json');
    const installed = JSON.parse(await fsp.readFile(installedPath, 'utf8'));
    for (const entries of Object.values(installed.plugins) as Array<Array<Record<string, any>>>) {
      for (const entry of entries) {
        entry.installPath = path.resolve(copyRoot, entry.installPath);
      }
    }
    await fsp.writeFile(installedPath, JSON.stringify(installed, null, 2));

    inventory = await buildInventory(projectPath, paths);
  });

  afterAll(async () => {
    if (tempRoot) {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  function server(id: string) {
    return inventory.mcpServers.find((entry) => entry.id === id);
  }

  function plugin(key: string) {
    return inventory.plugins.find((entry) => entry.key === key);
  }

  it('finds every ~/.claude.json project key for the project', () => {
    const keys = matchingProjectKeys(claudeJson, projectPath);
    expect(keys.sort()).toEqual([forwardKey, backwardKey].sort());
  });

  it('scans MCP servers from all sources with the right scopes and flags', () => {
    expect(inventory.mcpServers.map((entry) => entry.id)).toEqual([
      'blender',
      'claude.ai Gmail',
      'drawio',
      'localsrv',
      'plugin:vercel:vercel',
      'projsrv',
    ]);

    expect(server('drawio')).toMatchObject({
      scope: 'user',
      disabled: true,
      needsAuth: false,
    });
    expect(server('blender')).toMatchObject({
      scope: 'user',
      disabled: false,
      needsAuth: true,
    });
    expect(server('claude.ai Gmail')).toMatchObject({
      scope: 'claudeai',
      disabled: false,
      needsAuth: false,
    });
    expect(server('localsrv')).toMatchObject({ scope: 'local', disabled: false });
    expect(server('projsrv')).toMatchObject({ scope: 'project', disabled: false });
    expect(server('plugin:vercel:vercel')).toMatchObject({
      scope: 'plugin',
      pluginKey: 'vercel-plugin@vercel',
      disabled: true,
      needsAuth: false,
      transport: 'http',
    });

    expect(server('plugin:ads:adsrv')).toBeUndefined();
    expect(inventory.warnings).toEqual([]);
  });

  it('scans installed plugins and merges enabled state by layer', () => {
    expect(inventory.plugins.map((entry) => entry.key)).toEqual([
      'ads@mk',
      'off@mk',
      'vercel-plugin@vercel',
    ]);

    const vercel = plugin('vercel-plugin@vercel');
    expect(vercel).toMatchObject({
      name: 'vercel',
      marketplace: 'vercel',
      version: '1.0.0',
      enabled: true,
      enabledSource: 'user',
    });
    expect(vercel?.mcpServerIds).toContain('plugin:vercel:vercel');

    const ads = plugin('ads@mk');
    expect(ads).toMatchObject({
      name: 'ads',
      marketplace: 'mk',
      enabled: false,
      enabledSource: 'local',
    });
    expect(ads?.mcpServerIds).toContain('plugin:ads:adsrv');

    expect(plugin('off@mk')).toMatchObject({
      name: 'off',
      marketplace: 'mk',
      enabled: false,
      enabledSource: 'user',
    });
  });

  it('scans standalone and plugin skills with qualified names', () => {
    expect(inventory.skills.map((entry) => entry.name)).toEqual(['myskill']);

    const skill = inventory.skills.find((entry) => entry.name === 'myskill');
    expect(skill).toMatchObject({ kind: 'skill', scope: 'user' });
    expect(skill?.description).toContain('中文');
    expect(skill?.estTokens ?? 0).toBeGreaterThan(0);

    expect(plugin('vercel-plugin@vercel')?.skills.map((entry) => entry.name)).toContain(
      'vercel:s1',
    );
    expect(inventory.skills.every((entry) => entry.scope === 'user' || entry.scope === 'project')).toBe(
      true,
    );
  });

  it('scans nested standalone agents and plugin agents', () => {
    const nested = inventory.agents.find((entry) => entry.name === 'nested-agent');
    expect(nested).toMatchObject({ kind: 'agent', scope: 'user' });
    expect(nested?.file.endsWith(path.join('sub', 'dir', 'agent1.md'))).toBe(true);

    expect(plugin('vercel-plugin@vercel')?.agents.map((entry) => entry.name)).toContain(
      'vercel:a1',
    );

    const adsAgents = plugin('ads@mk')?.agents ?? [];
    expect(adsAgents).toHaveLength(2);
    expect(adsAgents.every((entry) => entry.name.startsWith('ads:'))).toBe(true);
    expect(adsAgents.map((entry) => entry.name).sort()).toEqual(['ads:ads-three', 'ads:ads-two']);
  });

  it('collects settings hooks by scope and keeps plugin hooks on the plugin', () => {
    expect(inventory.hooks).toHaveLength(1);
    expect(inventory.hooks.filter((hook) => hook.scope === 'user')).toHaveLength(1);
    expect(inventory.hooks.filter((hook) => hook.scope === 'project')).toHaveLength(0);
    expect(inventory.hooks.filter((hook) => hook.scope === 'local')).toHaveLength(0);

    expect(inventory.hooks[0]).toMatchObject({
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'echo user-hook',
      scope: 'user',
      sourceFile: paths.userSettings,
    });

    const vercelHooks = plugin('vercel-plugin@vercel')?.hooks ?? [];
    expect(vercelHooks).toHaveLength(1);
    expect(vercelHooks[0]).toMatchObject({
      event: 'SessionStart',
      scope: 'plugin',
      pluginKey: 'vercel-plugin@vercel',
    });
  });

  it('collects project instructions with a token estimate', () => {
    expect(inventory.instructions.map((entry) => entry.path)).toEqual([
      path.join(projectPath, 'CLAUDE.md'),
    ]);
    expect(inventory.instructions[0].estTokens).toBeGreaterThan(0);
  });
});

describe('buildInventory tolerance', () => {
  it('warns about invalid settings JSON and never throws', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cci-scan-bad-'));
    try {
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      await fsp.mkdir(path.join(home, '.claude'), { recursive: true });
      await fsp.mkdir(project, { recursive: true });
      await fsp.writeFile(path.join(home, '.claude', 'settings.json'), '{ not valid json');

      const inventory = await buildInventory(project, ClaudePaths(home));

      expect(inventory.warnings.some((warning) => warning.includes('settings.json'))).toBe(true);
      expect(inventory.plugins).toEqual([]);
      expect(inventory.mcpServers).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
