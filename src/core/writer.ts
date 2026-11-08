import { promises as fsp, renameSync } from 'node:fs';
import * as path from 'node:path';
import { readJsonFile } from './json';
import type { ClaudePaths } from './paths';
import { matchingProjectKeys } from './scanner';

type JsonObject = Record<string, unknown>;

let backupDone = false;

/** Test hook: forget that the one-time `~/.claude.json` backup was made. */
export function _resetBackupFlagForTests(): void {
  backupDone = false;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadClaudeJson(file: string): Promise<JsonObject> {
  const result = await readJsonFile<unknown>(file);
  if (result.missing) {
    throw new Error(`Cannot update ${file}: file not found.`);
  }
  if (result.error !== undefined) {
    throw new Error(`Cannot update ${file}: invalid JSON (${result.error}).`);
  }
  if (!isObject(result.data)) {
    throw new Error(`Cannot update ${file}: expected a JSON object.`);
  }
  return result.data;
}

async function ensureBackup(file: string): Promise<void> {
  if (backupDone) {
    return;
  }
  try {
    await fsp.copyFile(file, `${file}.bak-context-inventory`);
  } catch (err) {
    throw new Error(`Cannot back up ${file}: ${errorMessage(err)}.`);
  }
  backupDone = true;
}

/**
 * Add or remove one id in a `disabledMcpServers` value without disturbing the
 * other entries or introducing duplicates. `changed` is false when the list
 * already had the wanted state.
 */
function applyDisabled(
  current: unknown,
  id: string,
  disabled: boolean,
): { next: unknown[]; changed: boolean } {
  const values = Array.isArray(current) ? [...current] : [];
  const matches = values
    .map((value, index) => (value === id ? index : -1))
    .filter((index) => index !== -1);

  if (disabled) {
    if (matches.length === 0) {
      return { next: [...values, id], changed: true };
    }
    if (matches.length === 1) {
      return { next: values, changed: false };
    }
    // Already disabled but duplicated: keep the first occurrence only.
    let kept = false;
    const deduped: unknown[] = [];
    for (const value of values) {
      if (value === id) {
        if (kept) {
          continue;
        }
        kept = true;
      }
      deduped.push(value);
    }
    return { next: deduped, changed: true };
  }

  if (matches.length === 0) {
    return { next: values, changed: false };
  }
  return { next: values.filter((value) => value !== id), changed: true };
}

export interface McpDisabledResult {
  changedKeys: string[];
  createdKey?: string;
}

/**
 * Enable or disable one MCP server id for a project in `~/.claude.json`:
 * every project key that matches the folder is updated, and a key is created
 * when none exists. The backup is written once per process.
 */
export async function setMcpDisabled(
  paths: ClaudePaths,
  projectPath: string,
  id: string,
  disabled: boolean,
): Promise<McpDisabledResult> {
  const file = paths.claudeJson;

  // Validate before touching anything: a missing/invalid file writes nothing.
  await loadClaudeJson(file);

  // Re-read right before writing; Claude Code may have rewritten the file.
  const data = await loadClaudeJson(file);

  let projects: JsonObject;
  if (isObject(data.projects)) {
    projects = data.projects;
  } else {
    projects = {};
    data.projects = projects;
  }

  let keys = matchingProjectKeys(data, projectPath);
  let createdKey: string | undefined;
  if (keys.length === 0) {
    createdKey = projectPath.replace(/\\/g, '/');
    projects[createdKey] = {};
    keys = [createdKey];
  }

  const changedKeys: string[] = [];
  for (const key of keys) {
    let entry: JsonObject;
    if (isObject(projects[key])) {
      entry = projects[key] as JsonObject;
    } else {
      entry = {};
      projects[key] = entry;
    }
    const { next, changed } = applyDisabled(entry.disabledMcpServers, id, disabled);
    if (changed) {
      entry.disabledMcpServers = next;
      changedKeys.push(key);
    }
  }

  if (createdKey !== undefined && !changedKeys.includes(createdKey)) {
    // The folder key itself is new even when there was nothing to remove.
    changedKeys.push(createdKey);
  }

  if (changedKeys.length > 0) {
    // One-time backup, made just before the first actual write.
    await ensureBackup(file);
    const tmp = `${file}.tmp-${process.pid}`;
    const text = JSON.stringify(data, null, 2);
    try {
      await fsp.writeFile(tmp, text, 'utf8');
      renameSync(tmp, file);
    } catch (err) {
      try {
        await fsp.rm(tmp, { force: true });
      } catch {
        // Best effort cleanup only.
      }
      throw new Error(`Cannot write ${file}: ${errorMessage(err)}.`);
    }
  }

  return createdKey === undefined ? { changedKeys } : { changedKeys, createdKey };
}

/**
 * Set or clear a per-project plugin override in
 * `<project>/.claude/settings.local.json`, creating the file when needed.
 */
export async function setPluginOverride(
  projectPath: string,
  pluginKey: string,
  value: boolean | null,
): Promise<void> {
  const claudeDir = path.join(projectPath, '.claude');
  const file = path.join(claudeDir, 'settings.local.json');

  const existing = await readJsonFile<unknown>(file);
  let settings: JsonObject;
  if (existing.missing) {
    settings = {};
  } else if (existing.error !== undefined) {
    throw new Error(`Cannot update ${file}: invalid JSON (${existing.error}).`);
  } else if (!isObject(existing.data)) {
    throw new Error(`Cannot update ${file}: expected a JSON object.`);
  } else {
    settings = existing.data;
  }

  if (value === null) {
    const enabledPlugins = settings.enabledPlugins;
    if (isObject(enabledPlugins)) {
      delete enabledPlugins[pluginKey];
      if (Object.keys(enabledPlugins).length === 0) {
        delete settings.enabledPlugins;
      }
    }
  } else {
    let enabledPlugins: JsonObject;
    if (isObject(settings.enabledPlugins)) {
      enabledPlugins = settings.enabledPlugins;
    } else {
      enabledPlugins = {};
      settings.enabledPlugins = enabledPlugins;
    }
    enabledPlugins[pluginKey] = value;
  }

  try {
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  } catch (err) {
    throw new Error(`Cannot write ${file}: ${errorMessage(err)}.`);
  }
}

async function writeJsonAtomic(file: string, data: unknown, trailingNewline: boolean): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  const text = JSON.stringify(data, null, 2) + (trailingNewline ? '\n' : '');
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw new Error(`Cannot write ${file}: ${errorMessage(err)}.`);
  }
}

/**
 * Enable or disable a plugin for every project by editing the user-level
 * `~/.claude/settings.json`. A project-level override still wins over this.
 */
export async function setPluginGlobal(
  paths: ClaudePaths,
  pluginKey: string,
  value: boolean,
): Promise<void> {
  const existing = await readJsonFile<unknown>(paths.userSettings);
  let settings: JsonObject;
  if (existing.missing) {
    settings = {};
  } else if (existing.error !== undefined) {
    throw new Error(`Cannot update ${paths.userSettings}: invalid JSON (${existing.error}).`);
  } else if (!isObject(existing.data)) {
    throw new Error(`Cannot update ${paths.userSettings}: expected a JSON object.`);
  } else {
    settings = existing.data;
  }
  let enabledPlugins: JsonObject;
  if (isObject(settings.enabledPlugins)) {
    enabledPlugins = settings.enabledPlugins;
  } else {
    enabledPlugins = {};
    settings.enabledPlugins = enabledPlugins;
  }
  enabledPlugins[pluginKey] = value;
  if (!existing.missing) {
    await fsp.copyFile(paths.userSettings, `${paths.userSettings}.bak-context-inventory`);
  }
  await writeJsonAtomic(paths.userSettings, settings, true);
}

async function loadStash(file: string): Promise<JsonObject> {
  const result = await readJsonFile<unknown>(file);
  if (result.missing) {
    return {};
  }
  if (result.error !== undefined || !isObject(result.data)) {
    throw new Error(`Cannot update ${file}: not a valid JSON object.`);
  }
  return result.data;
}

/**
 * Switch a user-level MCP server off for every project: its config moves from
 * `~/.claude.json` into the stash file, so nothing is lost and it can be put
 * back. The stash is written first so a failure never drops the config.
 */
export async function stashUserMcp(paths: ClaudePaths, id: string): Promise<void> {
  const data = await loadClaudeJson(paths.claudeJson);
  if (!isObject(data.mcpServers) || !(id in data.mcpServers)) {
    throw new Error(`"${id}" is not a user-level MCP server in ${paths.claudeJson}.`);
  }
  const stash = await loadStash(paths.mcpStash);
  const servers = isObject(stash.servers) ? stash.servers : {};
  servers[id] = data.mcpServers[id];
  stash.servers = servers;
  await writeJsonAtomic(paths.mcpStash, stash, false);

  await ensureBackup(paths.claudeJson);
  delete data.mcpServers[id];
  await writeJsonAtomic(paths.claudeJson, data, false);
}

/** Undo `stashUserMcp`: put the config back into `~/.claude.json`. */
export async function restoreUserMcp(paths: ClaudePaths, id: string): Promise<void> {
  const stash = await loadStash(paths.mcpStash);
  if (!isObject(stash.servers) || !(id in stash.servers)) {
    throw new Error(`"${id}" is not in ${paths.mcpStash}.`);
  }
  const data = await loadClaudeJson(paths.claudeJson);
  let servers: JsonObject;
  if (isObject(data.mcpServers)) {
    servers = data.mcpServers;
  } else {
    servers = {};
    data.mcpServers = servers;
  }
  servers[id] = stash.servers[id];
  await ensureBackup(paths.claudeJson);
  await writeJsonAtomic(paths.claudeJson, data, false);

  delete stash.servers[id];
  await writeJsonAtomic(paths.mcpStash, stash, false);
}
