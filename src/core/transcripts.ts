import { createReadStream, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { readJsonFile } from './json';
import type {
  Cost,
  Inventory,
  Measurement,
  Plugin,
  Usage,
  UsageEntry,
} from './model';
import { ClaudePaths, findTranscriptDir, mcpPrefix, normKey } from './paths';
import { estimateTokens } from './tokens';

type JsonObject = Record<string, any>;

const COMMAND_RE = /<command-name>\s*\/?([^<]*?)\s*<\/command-name>/g;
const USER_RECORD_RE = /"type"\s*:\s*"user"/;
const DAY_MS = 24 * 60 * 60 * 1000;
const STANDALONE = '(standalone)';
const SETTINGS_OWNER = '(settings)';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface SessionFile {
  file: string;
  mtimeMs: number;
}

/** All `*.jsonl` files in a transcript dir, newest mtime first. */
async function listSessionFiles(dir: string): Promise<SessionFile[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const files: SessionFile[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.jsonl')) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.isFile()) {
        files.push({ file, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Unreadable / broken link: skip.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

/**
 * Stream a JSONL file line by line, skipping unparsable lines. The callback may
 * return `'stop'` to end the scan early (used to stop at the first assistant
 * record).
 */
async function readRecords(
  file: string,
  onRecord: (record: JsonObject) => 'stop' | void,
  filter?: (line: string) => boolean,
): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line || !line.trim()) {
        continue;
      }
      const text = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      if (filter && !filter(text)) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isObject(parsed)) {
        continue;
      }
      if (onRecord(parsed) === 'stop') {
        break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

type McpToolResolver = (toolName: string) => { id: string; prefix: string } | undefined;

/**
 * Rebuild a `plugin:<name>:<server>` id from a sanitized tool prefix using
 * every installed plugin name (enabled or not), so a plugin-scoped server is
 * keyed by its inventory id even when the server itself was not scanned.
 */
function pluginIdForPrefix(prefix: string, pluginNames: string[]): string | undefined {
  if (!prefix.startsWith('mcp__') || !prefix.endsWith('__')) {
    return undefined;
  }
  const body = prefix.slice('mcp__'.length, -'__'.length);
  if (!body.startsWith('plugin_')) {
    return undefined;
  }
  for (const name of pluginNames) {
    const sanitized = name.replace(/[^A-Za-z0-9_-]/g, '_');
    if (sanitized === '') {
      continue;
    }
    const namePart = `plugin_${sanitized}_`;
    if (!body.startsWith(namePart)) {
      continue;
    }
    const server = body.slice(namePart.length);
    if (server === '') {
      continue;
    }
    const id = `plugin:${name}:${server}`;
    if (mcpPrefix(id) === prefix) {
      return id;
    }
  }
  return undefined;
}

/**
 * Names from the installed-plugin inventory plus the scanned plugins, so the
 * prefix fallback also works for plugins the scanner had to skip (no usable
 * install entry, no `.mcp.json`).
 */
async function installedPluginNames(
  paths: ClaudePaths,
  inventory: Inventory,
): Promise<string[]> {
  const names = new Set<string>();
  for (const plugin of inventory.plugins) {
    if (plugin.name !== '') {
      names.add(plugin.name);
    }
  }
  const result = await readJsonFile<unknown>(paths.installedPlugins);
  const data = result.data;
  const plugins = isObject(data) ? data.plugins : undefined;
  if (isObject(plugins)) {
    for (const key of Object.keys(plugins)) {
      const at = key.indexOf('@');
      const name = at === -1 ? key : key.slice(0, at);
      if (name !== '') {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Map a transcript tool name to an inventory MCP server id. Known server
 * prefixes win; then a sanitized plugin prefix is rebuilt into a
 * `plugin:<name>:<server>` id; unknown `mcp__` names fall back to the text
 * between `mcp__` and the next `__`.
 */
function createMcpToolResolver(
  inventory: Inventory,
  pluginNames: string[],
): McpToolResolver {
  const ids = new Set(inventory.mcpServers.map((server) => server.id));
  for (const plugin of inventory.plugins) {
    for (const id of plugin.mcpServerIds) {
      ids.add(id);
    }
  }
  const known = [...ids]
    .map((id) => ({ id, prefix: mcpPrefix(id) }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return (toolName: string) => {
    if (!toolName.startsWith('mcp__')) {
      return undefined;
    }
    const match = known.find((server) => toolName.startsWith(server.prefix));
    if (match) {
      return match;
    }
    const rest = toolName.slice('mcp__'.length);
    const separator = rest.indexOf('__');
    const serverPart = separator === -1 ? rest : rest.slice(0, separator);
    if (serverPart === '') {
      return undefined;
    }
    const prefix = `mcp__${serverPart}__`;
    const pluginId = pluginIdForPrefix(prefix, pluginNames);
    if (pluginId !== undefined) {
      return { id: pluginId, prefix };
    }
    return { id: serverPart, prefix };
  };
}

function resolveMcpServerId(
  value: string,
  inventory: Inventory,
  resolveTool: McpToolResolver,
): string {
  if (inventory.mcpServers.some((server) => server.id === value)) {
    return value;
  }
  if (value.startsWith('mcp__')) {
    const resolved = resolveTool(value);
    if (resolved) {
      return resolved.id;
    }
  }
  return value;
}

function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/** Plugin name whose hook command/status message or install path matches. */
function hookOwner(transcriptCommand: string, inventory: Inventory): string {
  const trimmed = transcriptCommand.trim();
  for (const plugin of inventory.plugins) {
    for (const hook of plugin.hooks) {
      if (hook.command.trim() === trimmed) {
        return plugin.name;
      }
      if (hook.statusMessage !== undefined && hook.statusMessage.trim() === trimmed) {
        return plugin.name;
      }
    }
  }

  const normalized = normalizeForMatch(transcriptCommand);
  let bestName: string | undefined;
  let bestLength = -1;
  for (const plugin of inventory.plugins) {
    const installPath = normalizeForMatch(plugin.installPath).replace(/\/+$/, '');
    if (installPath !== '' && normalized.includes(installPath) && installPath.length > bestLength) {
      bestName = plugin.name;
      bestLength = installPath.length;
    }
  }
  return bestName ?? SETTINGS_OWNER;
}

interface ListingLine {
  name: string;
  description: string;
  text: string;
}

/** Parse a `- name: description` listing line (names may contain a colon). */
function parseListingLine(line: string): ListingLine | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('- ')) {
    return undefined;
  }
  const body = trimmed.slice(2).trim();
  if (body === '') {
    return undefined;
  }
  const colonSpace = body.indexOf(': ');
  let name: string;
  let description = '';
  if (colonSpace !== -1) {
    name = body.slice(0, colonSpace).trim();
    description = body.slice(colonSpace + 2).trim();
  } else {
    // A bare colon is part of the name (e.g. `- vercel:ai-sdk`).
    name = body;
  }
  if (name === '') {
    return undefined;
  }
  return { name, description, text: `- ${name}: ${description}` };
}

function ownerOfName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? STANDALONE : name.slice(0, colon);
}

interface OwnerTotal {
  tokens: number;
  count: number;
}

interface MeasurementAccumulator {
  toolNames: Map<string, string[]>;
  builtinNames: string[];
  mcpInstructionTokens: Map<string, number>;
  skillsByOwner: Map<string, OwnerTotal>;
  agentsByOwner: Map<string, OwnerTotal>;
  hooks: Array<Cost & { event: string; command: string; owner: string }>;
  instructions: Array<Cost & { path: string }>;
  baselineTokens: number;
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function addOwner(list: Map<string, OwnerTotal>, owner: string, tokens: number): void {
  const total = list.get(owner) ?? { tokens: 0, count: 0 };
  total.tokens += tokens;
  total.count += 1;
  list.set(owner, total);
}

function applyAttachment(
  attachment: JsonObject,
  owner: MeasurementAccumulator,
  inventory: Inventory,
  resolveTool: McpToolResolver,
): void {
  const type = attachment.type;
  if (type === 'deferred_tools_delta') {
    for (const name of stringArray(attachment.addedNames)) {
      const server = resolveTool(name);
      if (server) {
        const names = owner.toolNames.get(server.id) ?? [];
        addUnique(names, name);
        owner.toolNames.set(server.id, names);
      } else {
        addUnique(owner.builtinNames, name);
      }
    }
    return;
  }

  if (type === 'mcp_instructions_delta') {
    const names = stringArray(attachment.addedNames);
    const blocks = stringArray(attachment.addedBlocks);
    const count = Math.min(names.length, blocks.length);
    for (let i = 0; i < count; i += 1) {
      const id = resolveMcpServerId(names[i], inventory, resolveTool);
      const tokens = estimateTokens(blocks[i]);
      owner.mcpInstructionTokens.set(id, (owner.mcpInstructionTokens.get(id) ?? 0) + tokens);
    }
    return;
  }

  if (type === 'skill_listing') {
    const content = asString(attachment.content);
    if (content === undefined) {
      return;
    }
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseListingLine(line);
      if (!parsed) {
        continue;
      }
      addOwner(owner.skillsByOwner, ownerOfName(parsed.name), estimateTokens(parsed.text));
    }
    return;
  }

  if (type === 'agent_listing_delta') {
    const types = stringArray(attachment.addedTypes);
    const lines = stringArray(attachment.addedLines);
    const count = Math.max(types.length, lines.length);
    for (let i = 0; i < count; i += 1) {
      const name = types[i];
      const line = lines[i];
      const parsed = line === undefined ? undefined : parseListingLine(line);
      const ownerName = name !== undefined && name !== '' ? name : parsed?.name;
      if (ownerName === undefined) {
        continue;
      }
      const tokens = line === undefined ? 0 : estimateTokens(line);
      addOwner(owner.agentsByOwner, ownerOfName(ownerName), tokens);
    }
    return;
  }

  if (type === 'hook_success') {
    const command = asString(attachment.command) ?? '';
    const content = asString(attachment.content) ?? '';
    owner.hooks.push({
      tokens: estimateTokens(content),
      event: asString(attachment.hookEvent) ?? '',
      command,
      owner: hookOwner(command, inventory),
    });
    return;
  }

  if (type === 'instructions') {
    const files = attachment.files;
    if (!Array.isArray(files)) {
      return;
    }
    for (const file of files) {
      if (!isObject(file) || typeof file.path !== 'string') {
        continue;
      }
      owner.instructions.push({
        tokens: estimateTokens(asString(file.content) ?? ''),
        path: file.path,
      });
    }
  }
}

function applyAssistantUsage(record: JsonObject, owner: MeasurementAccumulator): void {
  const message = record.message;
  if (!isObject(message)) {
    return;
  }
  const usage = message.usage;
  if (!isObject(usage)) {
    return;
  }
  owner.baselineTokens =
    toNumber(usage.input_tokens) +
    toNumber(usage.cache_creation_input_tokens) +
    toNumber(usage.cache_read_input_tokens);
}

function totalAttributed(measurement: Measurement): number {
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

function finishMeasurement(
  sessionId: string,
  sessionFile: string,
  startedAt: string | undefined,
  owner: MeasurementAccumulator,
  inventory: Inventory,
): Measurement {
  const mcpTools: Measurement['mcpTools'] = {};
  for (const [id, names] of owner.toolNames) {
    mcpTools[id] = { tokens: estimateTokens(names.join('\n')), toolCount: names.length };
  }

  const mcpInstructions: Measurement['mcpInstructions'] = {};
  for (const [id, tokens] of owner.mcpInstructionTokens) {
    mcpInstructions[id] = { tokens };
  }

  const skillsByOwner: Measurement['skillsByOwner'] = {};
  for (const [ownerName, total] of owner.skillsByOwner) {
    skillsByOwner[ownerName] = { tokens: total.tokens, count: total.count };
  }

  const agentsByOwner: Measurement['agentsByOwner'] = {};
  for (const [ownerName, total] of owner.agentsByOwner) {
    agentsByOwner[ownerName] = { tokens: total.tokens, count: total.count };
  }

  const measurement: Measurement = {
    sessionId,
    sessionFile,
    baselineTokens: owner.baselineTokens,
    otherTokens: 0,
    mcpTools,
    mcpInstructions,
    skillsByOwner,
    agentsByOwner,
    hooks: owner.hooks,
    instructions: owner.instructions,
    builtinToolNames: {
      tokens: estimateTokens(owner.builtinNames.join('\n')),
      count: owner.builtinNames.length,
    },
    needsAuthMcpServers: [
      ...new Set(inventory.mcpServers.filter((server) => server.needsAuth).map((server) => server.id)),
    ].sort(),
    warnings: [],
  };
  if (startedAt !== undefined) {
    measurement.startedAt = startedAt;
  }
  measurement.otherTokens = Math.max(0, measurement.baselineTokens - totalAttributed(measurement));
  return measurement;
}

/**
 * Measure the fixed starting context of the newest session that has an
 * assistant record and belongs to this project.
 */
export async function measureLatestSession(
  projectPath: string,
  paths: ClaudePaths,
  inventory: Inventory,
): Promise<Measurement | undefined> {
  const dir = findTranscriptDir(paths, projectPath);
  if (!dir) {
    return undefined;
  }
  const sessions = await listSessionFiles(dir);
  if (sessions.length === 0) {
    return undefined;
  }
  const wantedProject = normKey(projectPath);
  const resolveTool = createMcpToolResolver(
    inventory,
    await installedPluginNames(paths, inventory),
  );

  for (const session of sessions) {
    const sessionId = path.basename(session.file).replace(/\.jsonl$/i, '');
    const owner: MeasurementAccumulator = {
      toolNames: new Map(),
      builtinNames: [],
      mcpInstructionTokens: new Map(),
      skillsByOwner: new Map(),
      agentsByOwner: new Map(),
      hooks: [],
      instructions: [],
      baselineTokens: 0,
    };
    let startedAt: string | undefined;
    let hasAssistant = false;
    let firstCwdSeen = false;
    let mismatchedCwd = false;

    try {
      await readRecords(session.file, (record) => {
        if (startedAt === undefined) {
          const timestamp = asString(record.timestamp);
          if (timestamp !== undefined && timestamp !== '') {
            startedAt = timestamp;
          }
        }
        if (record.type === 'user') {
          const cwd = asString(record.cwd);
          // Only the first user record that carries a cwd decides membership;
          // later cwd values (the user cd'd elsewhere) are ignored.
          if (cwd !== undefined && !firstCwdSeen) {
            firstCwdSeen = true;
            if (normKey(cwd) !== wantedProject) {
              mismatchedCwd = true;
              return 'stop';
            }
          }
          return;
        }
        if (record.type === 'attachment') {
          if (isObject(record.attachment)) {
            applyAttachment(record.attachment, owner, inventory, resolveTool);
          }
          return;
        }
        if (record.type === 'assistant') {
          applyAssistantUsage(record, owner);
          hasAssistant = true;
          return 'stop';
        }
        return;
      });
    } catch {
      continue;
    }

    if (hasAssistant && !mismatchedCwd) {
      return finishMeasurement(sessionId, session.file, startedAt, owner, inventory);
    }
  }
  return undefined;
}

interface SessionUsage {
  mcp: Record<string, UsageEntry>;
  skills: Record<string, UsageEntry>;
  agents: Record<string, UsageEntry>;
}

function addUse(
  target: Record<string, UsageEntry>,
  name: string,
  timestamp: string | undefined,
): void {
  if (name === '') {
    return;
  }
  const entry = target[name] ?? { count: 0 };
  entry.count += 1;
  if (timestamp !== undefined && isLater(timestamp, entry.lastUsed)) {
    entry.lastUsed = timestamp;
  }
  target[name] = entry;
}

function isLater(candidate: string, current: string | undefined): boolean {
  if (current === undefined) {
    return true;
  }
  const candidateTime = Date.parse(candidate);
  const currentTime = Date.parse(current);
  if (Number.isNaN(candidateTime)) {
    return false;
  }
  if (Number.isNaN(currentTime)) {
    return true;
  }
  return candidateTime > currentTime;
}

function messageTexts(record: JsonObject): string[] {
  const message = record.message;
  if (!isObject(message)) {
    return [];
  }
  const content = message.content;
  if (typeof content === 'string') {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      texts.push(item);
    } else if (isObject(item) && typeof item.text === 'string') {
      texts.push(item.text);
    }
  }
  return texts;
}

/** Tool uses and slash commands of one session, or undefined for another cwd. */
async function scanSessionUsage(
  file: string,
  wantedProject: string,
  resolveTool: McpToolResolver,
): Promise<SessionUsage | undefined> {
  const session: SessionUsage = { mcp: {}, skills: {}, agents: {} };
  let firstCwdSeen = false;
  let mismatchedCwd = false;

  await readRecords(
    file,
    (record) => {
      const timestamp = asString(record.timestamp);
      if (record.type === 'user') {
        const cwd = asString(record.cwd);
        // Membership is decided once, by the first user record with a cwd.
        if (cwd !== undefined && !firstCwdSeen) {
          firstCwdSeen = true;
          if (normKey(cwd) !== wantedProject) {
            mismatchedCwd = true;
            return 'stop';
          }
        }
        for (const text of messageTexts(record)) {
          COMMAND_RE.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = COMMAND_RE.exec(text)) !== null) {
            const name = match[1].trim();
            if (name !== '') {
              addUse(session.skills, name, timestamp);
            }
          }
        }
        return;
      }
      if (record.type !== 'assistant') {
        return;
      }
      const message = record.message;
      if (!isObject(message) || !Array.isArray(message.content)) {
        return;
      }
      for (const item of message.content) {
        if (!isObject(item) || item.type !== 'tool_use') {
          continue;
        }
        const name = asString(item.name);
        if (name === undefined) {
          continue;
        }
        const input = isObject(item.input) ? item.input : {};
        if (name.startsWith('mcp__')) {
          const server = resolveTool(name);
          if (server) {
            addUse(session.mcp, server.id, timestamp);
          }
        } else if (name === 'Skill') {
          const skill = asString(input.skill);
          if (skill !== undefined) {
            addUse(session.skills, skill, timestamp);
          }
        } else if (name === 'Agent' || name === 'Task') {
          const agent = asString(input.subagent_type);
          if (agent !== undefined) {
            addUse(session.agents, agent, timestamp);
          }
        }
      }
    },
    (line) =>
      line.includes('"tool_use"') ||
      line.includes('<command-name>') ||
      USER_RECORD_RE.test(line),
  );

  return mismatchedCwd ? undefined : session;
}

function mergeUsage(
  target: SessionUsage,
  source: SessionUsage,
): void {
  for (const key of ['mcp', 'skills', 'agents'] as const) {
    for (const [name, entry] of Object.entries(source[key])) {
      const existing = target[key][name] ?? { count: 0 };
      existing.count += entry.count;
      if (entry.lastUsed !== undefined && isLater(entry.lastUsed, existing.lastUsed)) {
        existing.lastUsed = entry.lastUsed;
      }
      target[key][name] = existing;
    }
  }
}

/**
 * Collect tool/command usage over recent sessions that belong to this project.
 */
export async function collectUsage(
  projectPath: string,
  paths: ClaudePaths,
  inventory: Inventory,
  windowDays: number,
  now: number = Date.now(),
): Promise<Usage> {
  const usage: Usage = {
    windowDays,
    sessionCount: 0,
    mcp: {},
    skills: {},
    agents: {},
  };
  const dir = findTranscriptDir(paths, projectPath);
  if (!dir) {
    return usage;
  }
  const cutoff = now - windowDays * DAY_MS;
  const wantedProject = normKey(projectPath);
  const resolveTool = createMcpToolResolver(
    inventory,
    await installedPluginNames(paths, inventory),
  );

  for (const session of await listSessionFiles(dir)) {
    if (session.mtimeMs < cutoff) {
      continue;
    }
    let delta: SessionUsage | undefined;
    try {
      delta = await scanSessionUsage(session.file, wantedProject, resolveTool);
    } catch {
      continue;
    }
    if (delta === undefined) {
      continue;
    }
    usage.sessionCount += 1;
    mergeUsage(usage, delta);
  }
  return usage;
}

/** Sum all usage that belongs to a plugin (skills, agents, commands, MCP). */
export function pluginUsed(
  plugin: Plugin,
  usage: Usage,
  inventory: Inventory,
): UsageEntry {
  const names = new Set<string>([
    ...plugin.skills.map((skill) => skill.name),
    ...plugin.agents.map((agent) => agent.name),
  ]);
  const mcpIds = new Set<string>([
    ...plugin.mcpServerIds,
    ...inventory.mcpServers
      .filter((server) => server.pluginKey === plugin.key)
      .map((server) => server.id),
  ]);

  let count = 0;
  let lastUsed: string | undefined;

  const addEntry = (entry: UsageEntry | undefined): void => {
    if (!entry) {
      return;
    }
    count += entry.count;
    if (entry.lastUsed !== undefined && isLater(entry.lastUsed, lastUsed)) {
      lastUsed = entry.lastUsed;
    }
  };

  for (const name of names) {
    addEntry(usage.skills[name]);
    addEntry(usage.agents[name]);
  }
  for (const command of plugin.commands) {
    addEntry(usage.skills[command]);
    addEntry(usage.skills[`${plugin.name}:${command}`]);
  }
  for (const id of mcpIds) {
    addEntry(usage.mcp[id]);
  }

  return lastUsed === undefined ? { count } : { count, lastUsed };
}

/** "Unused" = no recorded use in a window with enough sessions to judge. */
export function isUnused(
  entry: UsageEntry | undefined,
  usage: Usage,
): boolean {
  return (entry?.count ?? 0) === 0 && usage.sessionCount >= 3;
}
