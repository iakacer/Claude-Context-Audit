import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudePaths } from '../src/core/paths';
import {
  _resetBackupFlagForTests,
  restoreUserMcp,
  setMcpDisabled,
  setPluginGlobal,
  setPluginOverride,
  stashUserMcp,
} from '../src/core/writer';

const forwardKey = 'D:/Work/Proj';
const backwardKey = 'd:\\work\\proj';

type JsonObject = Record<string, any>;

describe('setMcpDisabled', () => {
  let root!: string;
  let home!: string;
  let paths!: ClaudePaths;
  let claudeJsonPath!: string;
  let backupPath!: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cci-writer-mcp-'));
    home = path.join(root, 'home');
    await fsp.mkdir(home, { recursive: true });
    paths = ClaudePaths(home);
    claudeJsonPath = paths.claudeJson;
    backupPath = `${claudeJsonPath}.bak-context-inventory`;
    _resetBackupFlagForTests();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  function initialData(): JsonObject {
    return {
      mcpServers: { drawio: { command: 'drawio' } },
      projects: {
        [forwardKey]: { allowedTools: ['Read'], disabledMcpServers: [] },
        [backwardKey]: { mcpServers: { localsrv: { command: 'localsrv' } } },
        'D:/Other/Proj': { disabledMcpServers: ['other'] },
      },
      unrelated: { keep: true },
    };
  }

  async function writeData(data: unknown): Promise<void> {
    await fsp.writeFile(claudeJsonPath, JSON.stringify(data, null, 2), 'utf8');
  }

  async function readData(): Promise<JsonObject> {
    return JSON.parse(await fsp.readFile(claudeJsonPath, 'utf8')) as JsonObject;
  }

  async function readBackup(): Promise<JsonObject> {
    return JSON.parse(await fsp.readFile(backupPath, 'utf8')) as JsonObject;
  }

  it('adds then removes an id across every matching key and backs up once', async () => {
    const initial = initialData();
    await writeData(initial);

    const added = await setMcpDisabled(paths, 'D:\\WORK\\Proj\\', 'drawio', true);
    expect(added.createdKey).toBeUndefined();
    expect(added.changedKeys.sort()).toEqual([backwardKey, forwardKey].sort());

    let data = await readData();
    expect(data.projects[forwardKey].disabledMcpServers).toEqual(['drawio']);
    expect(data.projects[backwardKey].disabledMcpServers).toEqual(['drawio']);
    expect(data.projects['D:/Other/Proj']).toEqual({ disabledMcpServers: ['other'] });
    expect(data.mcpServers).toEqual(initial.mcpServers);
    expect(data.unrelated).toEqual(initial.unrelated);
    expect(Object.keys(data.projects)).toEqual(Object.keys(initial.projects));

    const text = await fsp.readFile(claudeJsonPath, 'utf8');
    expect(text.startsWith('{\n  "')).toBe(true);

    // The backup keeps the pre-write contents.
    let backup = await readBackup();
    expect(backup.projects[forwardKey].disabledMcpServers).toEqual([]);
    expect(backup.projects[backwardKey].disabledMcpServers).toBeUndefined();

    // Adding again is a no-op and must not duplicate the id.
    const second = await setMcpDisabled(paths, 'D:\\Work\\Proj', 'drawio', true);
    expect(second.changedKeys).toEqual([]);
    data = await readData();
    expect(data.projects[forwardKey].disabledMcpServers).toEqual(['drawio']);
    expect(data.projects[backwardKey].disabledMcpServers).toEqual(['drawio']);

    const removed = await setMcpDisabled(paths, 'D:\\Work\\Proj', 'drawio', false);
    expect(removed.changedKeys.sort()).toEqual([backwardKey, forwardKey].sort());
    data = await readData();
    expect(data.projects[forwardKey].disabledMcpServers).toEqual([]);
    expect(data.projects[backwardKey].disabledMcpServers).toEqual([]);

    // Still the original backup after three writes.
    backup = await readBackup();
    expect(backup.projects[forwardKey].disabledMcpServers).toEqual([]);
    expect(backup.projects[backwardKey].disabledMcpServers).toBeUndefined();
  });

  it('creates a forward-slash key when no project key matches', async () => {
    await writeData({ projects: {}, top: 1 });

    const result = await setMcpDisabled(paths, 'D:\\New\\Project', 'srv', true);
    expect(result.createdKey).toBe('D:/New/Project');
    expect(result.changedKeys).toEqual(['D:/New/Project']);

    const data = await readData();
    expect(data.projects['D:/New/Project']).toEqual({ disabledMcpServers: ['srv'] });
    expect(data.top).toBe(1);
  });

  it('throws on invalid JSON and leaves the file untouched', async () => {
    const invalid = '{ this is not json';
    await fsp.writeFile(claudeJsonPath, invalid, 'utf8');

    await expect(setMcpDisabled(paths, 'D:\\Work\\Proj', 'srv', true)).rejects.toThrow(
      /invalid JSON/i,
    );
    expect(await fsp.readFile(claudeJsonPath, 'utf8')).toBe(invalid);
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it('throws when ~/.claude.json is missing and writes nothing', async () => {
    await expect(setMcpDisabled(paths, 'D:\\Work\\Proj', 'srv', true)).rejects.toThrow(
      /not found/i,
    );
    expect(fs.existsSync(claudeJsonPath)).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(false);
  });
});

describe('setPluginOverride', () => {
  let root!: string;
  let projectPath!: string;
  let settingsFile!: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cci-writer-plugin-'));
    projectPath = path.join(root, 'project');
    settingsFile = path.join(projectPath, '.claude', 'settings.local.json');
    _resetBackupFlagForTests();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function readSettings(): Promise<JsonObject> {
    return JSON.parse(await fsp.readFile(settingsFile, 'utf8')) as JsonObject;
  }

  it('sets true and false, then resets while preserving other settings', async () => {
    await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
    const permissions = { allow: ['Read'] };
    await fsp.writeFile(
      settingsFile,
      JSON.stringify({ permissions, enabledPlugins: { 'other@mk': true } }, null, 2),
      'utf8',
    );

    await setPluginOverride(projectPath, 'p@mk', true);
    let text = await fsp.readFile(settingsFile, 'utf8');
    let data = JSON.parse(text) as JsonObject;
    expect(data.enabledPlugins).toEqual({ 'other@mk': true, 'p@mk': true });
    expect(data.permissions).toEqual(permissions);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.startsWith('{\n  "')).toBe(true);

    await setPluginOverride(projectPath, 'p@mk', false);
    data = await readSettings();
    expect(data.enabledPlugins['p@mk']).toBe(false);
    expect(data.permissions).toEqual(permissions);

    await setPluginOverride(projectPath, 'p@mk', null);
    data = await readSettings();
    expect(data.enabledPlugins).toEqual({ 'other@mk': true });

    await setPluginOverride(projectPath, 'other@mk', null);
    data = await readSettings();
    expect('enabledPlugins' in data).toBe(false);
    expect(data.permissions).toEqual(permissions);
  });

  it('creates the .claude directory and settings file when missing', async () => {
    expect(fs.existsSync(path.join(projectPath, '.claude'))).toBe(false);

    await setPluginOverride(projectPath, 'p@mk', true);

    expect(fs.existsSync(settingsFile)).toBe(true);
    expect(await readSettings()).toEqual({ enabledPlugins: { 'p@mk': true } });
  });

  it('throws on invalid JSON and leaves the file untouched', async () => {
    await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
    const invalid = '{ broken json';
    await fsp.writeFile(settingsFile, invalid, 'utf8');

    await expect(setPluginOverride(projectPath, 'p@mk', true)).rejects.toThrow(
      /invalid JSON/i,
    );
    expect(await fsp.readFile(settingsFile, 'utf8')).toBe(invalid);
  });
});

describe('global toggles', () => {
  let root!: string;
  let paths!: ClaudePaths;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cci-writer-global-'));
    paths = ClaudePaths(path.join(root, 'home'));
    await fsp.mkdir(paths.claudeDir, { recursive: true });
    _resetBackupFlagForTests();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('setPluginGlobal edits only enabledPlugins in user settings and backs up', async () => {
    await fsp.writeFile(
      paths.userSettings,
      JSON.stringify({ model: 'sonnet', enabledPlugins: { 'a@m': true, 'b@m': true } }),
    );
    await setPluginGlobal(paths, 'a@m', false);
    const data = JSON.parse(await fsp.readFile(paths.userSettings, 'utf8'));
    expect(data).toEqual({ model: 'sonnet', enabledPlugins: { 'a@m': false, 'b@m': true } });
    expect(fs.existsSync(`${paths.userSettings}.bak-context-inventory`)).toBe(true);
  });

  it('stash then restore moves an MCP config without loss', async () => {
    const config = { type: 'stdio', command: 'x', args: ['1'] };
    await fsp.writeFile(
      paths.claudeJson,
      JSON.stringify({ other: 1, mcpServers: { a: config, b: { type: 'http', url: 'u' } } }),
    );
    await stashUserMcp(paths, 'a');
    let main = JSON.parse(await fsp.readFile(paths.claudeJson, 'utf8'));
    let stash = JSON.parse(await fsp.readFile(paths.mcpStash, 'utf8'));
    expect(Object.keys(main.mcpServers)).toEqual(['b']);
    expect(main.other).toBe(1);
    expect(stash.servers.a).toEqual(config);

    await restoreUserMcp(paths, 'a');
    main = JSON.parse(await fsp.readFile(paths.claudeJson, 'utf8'));
    stash = JSON.parse(await fsp.readFile(paths.mcpStash, 'utf8'));
    expect(main.mcpServers.a).toEqual(config);
    expect(stash.servers).toEqual({});
  });

  it('stash keeps unrelated keys of an existing stash file', async () => {
    await fsp.writeFile(paths.claudeJson, JSON.stringify({ mcpServers: { a: { type: 'stdio' } } }));
    await fsp.writeFile(paths.mcpStash, JSON.stringify({ note: 'hi', servers: { z: { type: 'http' } } }));
    await stashUserMcp(paths, 'a');
    const stash = JSON.parse(await fsp.readFile(paths.mcpStash, 'utf8'));
    expect(stash.note).toBe('hi');
    expect(Object.keys(stash.servers).sort()).toEqual(['a', 'z']);
  });

  it('stash rejects an id that is not a user-level server and writes nothing', async () => {
    const text = JSON.stringify({ mcpServers: { a: { type: 'stdio' } } });
    await fsp.writeFile(paths.claudeJson, text);
    await expect(stashUserMcp(paths, 'nope')).rejects.toThrow();
    expect(await fsp.readFile(paths.claudeJson, 'utf8')).toBe(text);
    expect(fs.existsSync(paths.mcpStash)).toBe(false);
  });
});
