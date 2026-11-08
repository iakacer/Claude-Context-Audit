import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from './frontmatter';
import { readJsonFile } from './json';
import type {
  Hook,
  InstructionFile,
  Inventory,
  McpServer,
  Plugin,
  Scope,
  SkillOrAgent,
} from './model';
import { ClaudePaths, normKey } from './paths';
import { estimateTokens } from './tokens';

type JsonObject = Record<string, unknown>;

interface ServerDef {
  name: string;
  config: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

async function loadJson(file: string, warnings: string[]): Promise<unknown> {
  const result = await readJsonFile(file);
  if (result.missing) {
    return undefined;
  }
  if (result.error !== undefined) {
    warnings.push(`Invalid JSON in ${file}: ${result.error}`);
    return undefined;
  }
  return result.data ?? undefined;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function readDir(dir: string, warnings: string[]): Promise<Dirent[] | undefined> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warnings.push(`Cannot read ${dir}: ${errorMessage(err)}`);
    }
    return undefined;
  }
}

function listingTokens(name: string, description: string): number {
  return estimateTokens(`- ${name}: ${description}`);
}

function fileStem(file: string): string {
  const base = path.basename(file);
  return base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;
}

function transportOf(config: unknown): string | undefined {
  return isObject(config) && typeof config.type === 'string' ? config.type : undefined;
}

/** Extract servers from a `.mcp.json` that uses the `{mcpServers: {...}}` shape. */
function namedMcpServers(data: unknown): ServerDef[] {
  if (!isObject(data)) {
    return [];
  }
  const container = data.mcpServers;
  if (!isObject(container)) {
    return [];
  }
  return Object.keys(container).map((name) => ({ name, config: container[name] }));
}

/** Extract servers from a plugin `.mcp.json`, allowing the flat form too. */
function pluginMcpServers(data: unknown): ServerDef[] {
  if (!isObject(data)) {
    return [];
  }
  if ('mcpServers' in data) {
    return namedMcpServers(data);
  }
  return Object.keys(data).map((name) => ({ name, config: data[name] }));
}

function collectStringSet(entries: JsonObject[], key: string): Set<string> {
  const result = new Set<string>();
  for (const entry of entries) {
    const values = entry[key];
    if (!Array.isArray(values)) {
      continue;
    }
    for (const value of values) {
      if (typeof value === 'string') {
        result.add(value);
      }
    }
  }
  return result;
}

/**
 * Return every `~/.claude.json` project key that normalizes to `projectPath`.
 * Several keys can point at the same folder because Claude Code writes them
 * with inconsistent case and slash direction.
 */
export function matchingProjectKeys(claudeJson: any, projectPath: string): string[] {
  if (!isObject(claudeJson)) {
    return [];
  }
  const projects = claudeJson.projects;
  if (!isObject(projects)) {
    return [];
  }
  const wanted = normKey(projectPath);
  return Object.keys(projects)
    .filter((key) => normKey(key) === wanted)
    .sort(compareStrings);
}

function hooksFromContainer(
  container: unknown,
  scope: Scope,
  sourceFile: string,
  pluginKey?: string,
): Hook[] {
  if (!isObject(container)) {
    return [];
  }
  const hooks: Hook[] = [];
  for (const event of Object.keys(container)) {
    const groups = container[event];
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      if (!isObject(group)) {
        continue;
      }
      const groupHooks = group.hooks;
      if (!Array.isArray(groupHooks)) {
        continue;
      }
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;
      for (const item of groupHooks) {
        if (!isObject(item)) {
          continue;
        }
        const command = item.command;
        if (typeof command !== 'string' || command === '') {
          continue;
        }
        hooks.push({ event, matcher, command, scope, pluginKey, sourceFile });
      }
    }
  }
  return hooks;
}

function settingsHooks(data: unknown, scope: Scope, sourceFile: string): Hook[] {
  if (!isObject(data)) {
    return [];
  }
  return hooksFromContainer(data.hooks, scope, sourceFile);
}

async function scanStandaloneSkills(
  dir: string,
  scope: Scope,
  warnings: string[],
): Promise<SkillOrAgent[]> {
  const entries = await readDir(dir, warnings);
  if (!entries) {
    return [];
  }
  const skills: SkillOrAgent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(dir, entry.name, 'SKILL.md');
    const text = await readText(file);
    if (text === undefined) {
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    const name = frontmatter.name || entry.name;
    const description = frontmatter.description ?? '';
    skills.push({
      kind: 'skill',
      name,
      description,
      scope,
      file,
      estTokens: listingTokens(name, description),
    });
  }
  skills.sort((a, b) => compareStrings(a.name, b.name));
  return skills;
}

async function scanPluginSkills(
  installPath: string,
  pluginName: string,
  pluginKey: string,
  warnings: string[],
): Promise<SkillOrAgent[]> {
  const dir = path.join(installPath, 'skills');
  const entries = await readDir(dir, warnings);
  if (!entries) {
    return [];
  }
  const skills: SkillOrAgent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(dir, entry.name, 'SKILL.md');
    const text = await readText(file);
    if (text === undefined) {
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    const name = `${pluginName}:${frontmatter.name || entry.name}`;
    const description = frontmatter.description ?? '';
    skills.push({
      kind: 'skill',
      name,
      description,
      scope: 'plugin',
      pluginKey,
      file,
      estTokens: listingTokens(name, description),
    });
  }
  skills.sort((a, b) => compareStrings(a.name, b.name));
  return skills;
}

async function scanStandaloneAgents(
  dir: string,
  scope: Scope,
  out: SkillOrAgent[],
  warnings: string[],
): Promise<void> {
  const entries = await readDir(dir, warnings);
  if (!entries) {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanStandaloneAgents(file, scope, out, warnings);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      continue;
    }
    const text = await readText(file);
    if (text === undefined) {
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    if (!frontmatter.name) {
      continue;
    }
    const description = frontmatter.description ?? '';
    out.push({
      kind: 'agent',
      name: frontmatter.name,
      description,
      scope,
      file,
      estTokens: listingTokens(frontmatter.name, description),
    });
  }
}

async function agentFromFile(
  file: string,
  pluginName: string,
  pluginKey: string,
): Promise<SkillOrAgent | undefined> {
  const text = await readText(file);
  if (text === undefined) {
    return undefined;
  }
  const frontmatter = parseFrontmatter(text);
  const name = `${pluginName}:${frontmatter.name || fileStem(file)}`;
  const description = frontmatter.description ?? '';
  return {
    kind: 'agent',
    name,
    description,
    scope: 'plugin',
    pluginKey,
    file,
    estTokens: listingTokens(name, description),
  };
}

async function scanPluginAgents(
  installPath: string,
  pluginName: string,
  pluginKey: string,
  pluginJson: unknown,
  warnings: string[],
): Promise<SkillOrAgent[]> {
  const agents: SkillOrAgent[] = [];
  const manifestAgents = isObject(pluginJson) ? pluginJson.agents : undefined;
  if (Array.isArray(manifestAgents)) {
    for (const relative of manifestAgents) {
      if (typeof relative !== 'string') {
        continue;
      }
      const agent = await agentFromFile(path.resolve(installPath, relative), pluginName, pluginKey);
      if (agent) {
        agents.push(agent);
      }
    }
  } else {
    const dir = path.join(installPath, 'agents');
    const entries = await readDir(dir, warnings);
    if (entries) {
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
          continue;
        }
        const agent = await agentFromFile(path.join(dir, entry.name), pluginName, pluginKey);
        if (agent) {
          agents.push(agent);
        }
      }
    }
  }
  agents.sort((a, b) => compareStrings(a.name, b.name));
  return agents;
}

async function scanPluginCommands(
  installPath: string,
  warnings: string[],
): Promise<string[]> {
  const entries = await readDir(path.join(installPath, 'commands'), warnings);
  if (!entries) {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => fileStem(entry.name))
    .sort(compareStrings);
}

function pluginEnabled(
  pluginKey: string,
  layers: Array<{ source: 'user' | 'project' | 'local'; data: unknown }>,
): { enabled: boolean; enabledSource: 'user' | 'project' | 'local' | 'default' } {
  let enabled = false;
  let enabledSource: 'user' | 'project' | 'local' | 'default' = 'default';
  for (const layer of layers) {
    if (!isObject(layer.data)) {
      continue;
    }
    const enabledPlugins = layer.data.enabledPlugins;
    if (!isObject(enabledPlugins)) {
      continue;
    }
    const value = enabledPlugins[pluginKey];
    if (typeof value === 'boolean') {
      enabled = value;
      enabledSource = layer.source;
    }
  }
  return { enabled, enabledSource };
}

function pickPluginEntry(
  entries: unknown[],
  projectPath: string,
): JsonObject | undefined {
  const objects = entries.filter(isObject);
  const wanted = normKey(projectPath);
  const scoped = objects.find((entry) => {
    if (entry.scope !== 'local' && entry.scope !== 'project') {
      return false;
    }
    const entryPath = entry.projectPath;
    return typeof entryPath === 'string' && normKey(entryPath) === wanted;
  });
  return scoped ?? objects.find((entry) => entry.scope === 'user');
}

/**
 * Build the static inventory for one project. Missing files are ignored;
 * invalid JSON (and other unreadable files) are reported in `warnings`.
 */
export async function buildInventory(
  projectPath: string,
  paths: ClaudePaths,
): Promise<Inventory> {
  const warnings: string[] = [];

  const claudeJson = await loadJson(paths.claudeJson, warnings);
  const userSettings = await loadJson(paths.userSettings, warnings);
  const projectSettingsFile = path.join(projectPath, '.claude', 'settings.json');
  const projectLocalSettingsFile = path.join(projectPath, '.claude', 'settings.local.json');
  const projectSettings = await loadJson(projectSettingsFile, warnings);
  const projectLocalSettings = await loadJson(projectLocalSettingsFile, warnings);
  const installedPlugins = await loadJson(paths.installedPlugins, warnings);
  const authCache = await loadJson(
    path.join(paths.claudeDir, 'mcp-needs-auth-cache.json'),
    warnings,
  );
  const projectMcpJson = await loadJson(path.join(projectPath, '.mcp.json'), warnings);

  const needsAuth = new Set<string>();
  if (isObject(authCache)) {
    for (const id of Object.keys(authCache)) {
      needsAuth.add(id);
    }
  } else if (Array.isArray(authCache)) {
    for (const id of authCache) {
      if (typeof id === 'string') {
        needsAuth.add(id);
      }
    }
  }

  const matchingKeys = matchingProjectKeys(claudeJson, projectPath);
  const projectEntries: JsonObject[] = [];
  const projects = isObject(claudeJson) ? claudeJson.projects : undefined;
  if (isObject(projects)) {
    for (const key of matchingKeys) {
      const entry = projects[key];
      if (isObject(entry)) {
        projectEntries.push(entry);
      }
    }
  }
  const disabledMcp = collectStringSet(projectEntries, 'disabledMcpServers');
  const disabledMcpjson = collectStringSet(projectEntries, 'disabledMcpjsonServers');

  const mcpServers: McpServer[] = [];

  // User-scoped MCP servers live at the top level of ~/.claude.json.
  for (const server of namedMcpServers(claudeJson)) {
    mcpServers.push({
      id: server.name,
      name: server.name,
      scope: 'user',
      sourceFile: paths.claudeJson,
      transport: transportOf(server.config),
      disabled: disabledMcp.has(server.name),
      needsAuth: needsAuth.has(server.name),
    });
  }

  // Local MCP servers live on each matching project entry; union them.
  const localNames = new Set<string>();
  for (const entry of projectEntries) {
    for (const server of namedMcpServers(entry)) {
      if (localNames.has(server.name)) {
        continue;
      }
      localNames.add(server.name);
      mcpServers.push({
        id: server.name,
        name: server.name,
        scope: 'local',
        sourceFile: paths.claudeJson,
        transport: transportOf(server.config),
        disabled: disabledMcp.has(server.name),
        needsAuth: needsAuth.has(server.name),
      });
    }
  }

  const projectMcpFile = path.join(projectPath, '.mcp.json');
  for (const server of namedMcpServers(projectMcpJson)) {
    mcpServers.push({
      id: server.name,
      name: server.name,
      scope: 'project',
      sourceFile: projectMcpFile,
      transport: transportOf(server.config),
      disabled: disabledMcp.has(server.name) || disabledMcpjson.has(server.name),
      needsAuth: needsAuth.has(server.name),
    });
  }

  if (isObject(claudeJson)) {
    const everConnected = claudeJson.claudeAiMcpEverConnected;
    if (Array.isArray(everConnected)) {
      const claudeAiNames = new Set<string>();
      for (const value of everConnected) {
        if (typeof value !== 'string' || value === '' || claudeAiNames.has(value)) {
          continue;
        }
        claudeAiNames.add(value);
        mcpServers.push({
          id: value,
          name: value,
          scope: 'claudeai',
          sourceFile: paths.claudeJson,
          disabled: disabledMcp.has(value),
          needsAuth: needsAuth.has(value),
        });
      }
    }
  }

  const enabledLayers: Array<{ source: 'user' | 'project' | 'local'; data: unknown }> = [
    { source: 'user', data: userSettings },
    { source: 'project', data: projectSettings },
    { source: 'local', data: projectLocalSettings },
  ];

  const installedRoot = isObject(installedPlugins) ? installedPlugins.plugins : undefined;
  const installed: JsonObject | undefined = isObject(installedRoot) ? installedRoot : undefined;

  const plugins: Plugin[] = [];
  if (installed) {
    for (const pluginKey of Object.keys(installed)) {
      const entries = installed[pluginKey];
      if (!Array.isArray(entries)) {
        continue;
      }
      const entry = pickPluginEntry(entries, projectPath);
      if (!entry) {
        continue;
      }
      const installPath = entry.installPath;
      if (typeof installPath !== 'string' || installPath === '') {
        continue;
      }
      const atIndex = pluginKey.indexOf('@');
      const fallbackName = atIndex === -1 ? pluginKey : pluginKey.slice(0, atIndex);
      const marketplace = atIndex === -1 ? '' : pluginKey.slice(atIndex + 1);

      const pluginJsonFile = path.join(installPath, '.claude-plugin', 'plugin.json');
      const pluginJson = await loadJson(pluginJsonFile, warnings);
      const manifestName = isObject(pluginJson) ? pluginJson.name : undefined;
      const pluginName =
        typeof manifestName === 'string' && manifestName !== '' ? manifestName : fallbackName;

      const state = pluginEnabled(pluginKey, enabledLayers);
      const versionValue = entry.version;
      const version = typeof versionValue === 'string' ? versionValue : undefined;

      const skills = await scanPluginSkills(installPath, pluginName, pluginKey, warnings);
      const agents = await scanPluginAgents(
        installPath,
        pluginName,
        pluginKey,
        pluginJson,
        warnings,
      );
      const commands = await scanPluginCommands(installPath, warnings);

      const hooksFile = path.join(installPath, 'hooks', 'hooks.json');
      const hooksData = await loadJson(hooksFile, warnings);
      const hooksContainer = isObject(hooksData) ? hooksData.hooks : undefined;
      const hooks = hooksFromContainer(hooksContainer, 'plugin', hooksFile, pluginKey);

      const mcpFile = path.join(installPath, '.mcp.json');
      const pluginMcpData = await loadJson(mcpFile, warnings);
      const pluginServers = pluginMcpServers(pluginMcpData);
      const mcpServerIds = pluginServers.map(
        (server) => `plugin:${pluginName}:${server.name}`,
      );
      mcpServerIds.sort(compareStrings);

      if (state.enabled) {
        for (const server of pluginServers) {
          const id = `plugin:${pluginName}:${server.name}`;
          mcpServers.push({
            id,
            name: server.name,
            scope: 'plugin',
            pluginKey,
            sourceFile: mcpFile,
            transport: transportOf(server.config),
            disabled: disabledMcp.has(id),
            needsAuth: needsAuth.has(id),
          });
        }
      }

      plugins.push({
        key: pluginKey,
        name: pluginName,
        marketplace,
        version,
        installPath,
        enabled: state.enabled,
        enabledSource: state.enabledSource,
        skills,
        agents,
        commands,
        hooks,
        mcpServerIds,
      });
    }
  }
  plugins.sort((a, b) => compareStrings(a.key, b.key));

  const skills: SkillOrAgent[] = [];
  skills.push(
    ...(await scanStandaloneSkills(path.join(paths.claudeDir, 'skills'), 'user', warnings)),
    ...(await scanStandaloneSkills(
      path.join(projectPath, '.claude', 'skills'),
      'project',
      warnings,
    )),
  );
  skills.sort((a, b) => compareStrings(a.name, b.name));

  const agents: SkillOrAgent[] = [];
  await scanStandaloneAgents(path.join(paths.claudeDir, 'agents'), 'user', agents, warnings);
  await scanStandaloneAgents(
    path.join(projectPath, '.claude', 'agents'),
    'project',
    agents,
    warnings,
  );
  agents.sort((a, b) => compareStrings(a.name, b.name));

  const hooks: Hook[] = [
    ...settingsHooks(userSettings, 'user', paths.userSettings),
    ...settingsHooks(projectSettings, 'project', projectSettingsFile),
    ...settingsHooks(projectLocalSettings, 'local', projectLocalSettingsFile),
  ];

  const instructions: InstructionFile[] = [];
  const instructionSeen = new Set<string>();
  const instructionCandidates = [
    path.join(paths.claudeDir, 'CLAUDE.md'),
    path.join(projectPath, 'CLAUDE.md'),
    path.join(projectPath, '.claude', 'CLAUDE.md'),
    path.join(projectPath, 'CLAUDE.local.md'),
  ];
  for (const file of instructionCandidates) {
    if (instructionSeen.has(file)) {
      continue;
    }
    instructionSeen.add(file);
    const text = await readText(file);
    if (text === undefined) {
      continue;
    }
    instructions.push({ path: file, estTokens: estimateTokens(text) });
  }

  mcpServers.sort((a, b) => compareStrings(a.id, b.id));

  return {
    projectPath,
    mcpServers,
    plugins,
    skills,
    agents,
    hooks,
    instructions,
    warnings,
  };
}
