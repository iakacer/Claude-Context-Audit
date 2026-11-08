import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  Hook,
  InstructionFile,
  McpServer,
  Plugin,
  SkillOrAgent,
  UsageEntry,
} from './core/model';
import { formatTokens } from './core/tokens';
import { isUnused, pluginUsed } from './core/transcripts';
import type { InventoryState } from './state';
import {
  describeItem,
  measuredTokensForPlugin,
  measuredTokensForServer,
  topConsumers,
  type ConsumerKind,
} from './state';

export type NodeKind =
  | 'context'
  | 'consumer'
  | 'other'
  | 'section'
  | 'mcp'
  | 'plugin'
  | 'group'
  | 'command'
  | 'skill'
  | 'agent'
  | 'hook'
  | 'instructions'
  | 'open-folder';

export interface InventoryNodeOptions {
  kind: NodeKind;
  label: string;
  description?: string;
  tooltip?: vscode.MarkdownString;
  icon?: vscode.ThemeIcon;
  contextValue?: string;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  children?: InventoryNode[];
  /** Source file opened by `claudeInventory.openSource`. */
  file?: string;
  mcpId?: string;
  mcpDisabled?: boolean;
  pluginKey?: string;
  pluginEnabled?: boolean;
  hasLocalOverride?: boolean;
  /** 1-2 letter scope badge shown at the right edge, even when the row is truncated. */
  badge?: string;
  /** Whole-row tone: `off` greys the row out, `warn` colours it as a warning. */
  tone?: 'off' | 'warn';
}

export const DECORATION_SCHEME = 'claude-inv';

/**
 * Badge and tone ride in the URI so the decoration provider is stateless.
 * The explicit `label` stays the visible text; the URI is never opened.
 */
function decorationUri(badge?: string, tone?: 'off' | 'warn'): vscode.Uri | undefined {
  if (badge === undefined && tone === undefined) {
    return undefined;
  }
  const query = new URLSearchParams();
  if (badge) {
    query.set('b', badge);
  }
  if (tone) {
    query.set('t', tone);
  }
  return vscode.Uri.from({ scheme: DECORATION_SCHEME, path: '/item', query: query.toString() });
}

export class InventoryDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME) {
      return undefined;
    }
    const query = new URLSearchParams(uri.query);
    const badge = query.get('b') ?? undefined;
    const tone = query.get('t');
    const color =
      tone === 'off'
        ? new vscode.ThemeColor('disabledForeground')
        : tone === 'warn'
          ? new vscode.ThemeColor('list.warningForeground')
          : undefined;
    const decoration = new vscode.FileDecoration(badge, undefined, color);
    decoration.propagate = false;
    return decoration;
  }
}

/**
 * A tree item that also carries the data the commands need (which server id to
 * toggle, which plugin key to override, which file to open). No `resourceUri`
 * is set; opening a file goes through the explicit command instead.
 */
export class InventoryNode extends vscode.TreeItem {
  readonly kind: NodeKind;
  readonly childrenNodes: InventoryNode[];
  readonly file?: string;
  readonly mcpId?: string;
  readonly mcpDisabled?: boolean;
  readonly pluginKey?: string;
  readonly pluginEnabled?: boolean;
  readonly hasLocalOverride?: boolean;

  constructor(options: InventoryNodeOptions) {
    super(
      options.label,
      options.collapsibleState ?? vscode.TreeItemCollapsibleState.None,
    );
    this.kind = options.kind;
    this.childrenNodes = options.children ?? [];
    this.file = options.file;
    this.mcpId = options.mcpId;
    this.mcpDisabled = options.mcpDisabled;
    this.pluginKey = options.pluginKey;
    this.pluginEnabled = options.pluginEnabled;
    this.hasLocalOverride = options.hasLocalOverride;
    const uri = decorationUri(options.badge, options.tone);
    if (uri) {
      this.resourceUri = uri;
    }
    if (options.description !== undefined) {
      this.description = options.description;
    }
    if (options.tooltip !== undefined) {
      this.tooltip = options.tooltip;
    }
    if (options.icon !== undefined) {
      this.iconPath = options.icon;
    }
    if (options.contextValue !== undefined) {
      this.contextValue = options.contextValue;
    }
  }
}

const ICONS = {
  mcp: 'plug',
  plugin: 'extensions',
  skill: 'lightbulb',
  agent: 'hubot',
  hook: 'zap',
  instructions: 'book',
  disabled: 'circle-slash',
  unused: 'warning',
  auth: 'key',
  context: 'pulse',
  other: 'server-process',
  command: 'terminal',
  openFolder: 'folder-opened',
} as const;

function baseIconId(kind: NodeKind | ConsumerKind): string {
  switch (kind) {
    case 'mcp':
      return ICONS.mcp;
    case 'plugin':
      return ICONS.plugin;
    case 'skill':
      return ICONS.skill;
    case 'agent':
      return ICONS.agent;
    case 'hook':
      return ICONS.hook;
    case 'instructions':
      return ICONS.instructions;
    case 'other':
      return ICONS.other;
    case 'open-folder':
      return ICONS.openFolder;
    case 'command':
      return ICONS.command;
    default:
      return ICONS.context;
  }
}

interface IconFlags {
  disabled?: boolean;
  unused?: boolean;
  needsAuth?: boolean;
  /** Enabled and in use (or at least not flagged): shown green. */
  active?: boolean;
}

function itemIcon(
  kind: NodeKind | ConsumerKind,
  flags: IconFlags = {},
): vscode.ThemeIcon {
  if (flags.disabled) {
    return new vscode.ThemeIcon(ICONS.disabled, new vscode.ThemeColor('disabledForeground'));
  }
  if (flags.needsAuth) {
    return new vscode.ThemeIcon(ICONS.auth, new vscode.ThemeColor('charts.yellow'));
  }
  if (flags.unused) {
    return new vscode.ThemeIcon(
      ICONS.unused,
      new vscode.ThemeColor('list.warningForeground'),
    );
  }
  if (flags.active) {
    return new vscode.ThemeIcon(baseIconId(kind), new vscode.ThemeColor('testing.iconPassed'));
  }
  return new vscode.ThemeIcon(baseIconId(kind));
}

type BadgeSource = 'user' | 'project' | 'local' | 'plugin' | 'claudeai' | 'builtin' | 'default';

/** Where an item comes from, as one or two letters (legend is in the tooltips). */
function scopeBadge(scope: BadgeSource): string | undefined {
  switch (scope) {
    case 'user':
      return 'U';
    case 'project':
      return 'P';
    case 'local':
      return 'L';
    case 'claudeai':
      return 'C';
    case 'builtin':
      return 'B';
    case 'plugin':
      return 'PG';
    default:
      return undefined;
  }
}

const SCOPE_LEGEND =
  'U = user · P = project · L = local (this machine, this project) · PG = from a plugin · C = claude.ai connector · B = built in';

/** `plugin:vercel:vercel` -> `vercel`, `plugin:a:b` -> `a/b`, `claude.ai Gmail` -> `Gmail`. */
function shortMcpLabel(id: string): string {
  const parts = /^plugin:([^:]+):(.+)$/.exec(id);
  if (parts) {
    return parts[1] === parts[2] ? parts[2] : `${parts[1]}/${parts[2]}`;
  }
  return id.replace(/^claude\.ai\s+/, '');
}

/** Drop the redundant `<plugin>:` prefix when the item is shown under its plugin. */
function stripPluginPrefix(name: string, pluginName: string | undefined): string {
  return pluginName && name.startsWith(`${pluginName}:`) ? name.slice(pluginName.length + 1) : name;
}

function markdown(lines: string[]): vscode.MarkdownString {
  return new vscode.MarkdownString(lines.filter((line) => line !== '').join('\n\n'));
}

function code(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function sectionNode(
  label: string,
  kind: NodeKind,
  icon: vscode.ThemeIcon,
  children: InventoryNode[],
): InventoryNode {
  return new InventoryNode({
    kind,
    label,
    icon,
    children,
    collapsibleState:
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
  });
}

function openFolderNode(): InventoryNode {
  return new InventoryNode({
    kind: 'open-folder',
    label: 'Open a folder',
    icon: new vscode.ThemeIcon(ICONS.openFolder),
    tooltip: markdown(['Open a workspace folder to inspect its Claude Code context.']),
  });
}

interface BuildContext {
  state: InventoryState;
}

function serverMeasuredTokens(ctx: BuildContext, id: string): number | undefined {
  const measurement = ctx.state.measurement;
  if (!measurement) {
    return undefined;
  }
  if (!(id in measurement.mcpTools) && !(id in measurement.mcpInstructions)) {
    return undefined;
  }
  return measuredTokensForServer(id, measurement);
}

function hookMeasuredTokens(ctx: BuildContext, hook: Hook): number | undefined {
  const measurement = ctx.state.measurement;
  if (!measurement) {
    return undefined;
  }
  const plugin = hook.pluginKey
    ? ctx.state.inventory.plugins.find((candidate) => candidate.key === hook.pluginKey)
    : undefined;
  const owner = plugin?.name ?? '(settings)';
  const matches = measurement.hooks.filter(
    (entry) => entry.owner === owner && entry.command === hook.command,
  );
  if (matches.length === 0) {
    return undefined;
  }
  return matches.reduce((total, entry) => total + entry.tokens, 0);
}

function instructionMeasuredTokens(
  ctx: BuildContext,
  file: InstructionFile,
): number | undefined {
  const measurement = ctx.state.measurement;
  if (!measurement) {
    return undefined;
  }
  const match = measurement.instructions.find((entry) => entry.path === file.path);
  return match?.tokens;
}

function buildContextNode(ctx: BuildContext): InventoryNode {
  const measurement = ctx.state.measurement;
  if (!measurement) {
    return new InventoryNode({
      kind: 'context',
      label: 'No Claude Code session in this folder yet',
      icon: new vscode.ThemeIcon(ICONS.context),
      tooltip: markdown([
        'No session transcript with an assistant record was found for this folder.',
      ]),
    });
  }

  const children: InventoryNode[] = topConsumers(
    measurement,
    ctx.state.inventory,
    10,
  ).map(
    (consumer) =>
      new InventoryNode({
        kind: 'consumer',
        label: consumer.label,
        description: `≈${formatTokens(consumer.tokens)} tok`,
        icon: itemIcon(consumer.kind),
        tooltip: markdown([
          `**${consumer.kind}** ${code(consumer.label)}`,
          `Measured: ≈${formatTokens(consumer.tokens)} tokens`,
        ]),
      }),
  );

  const otherTokens = measurement.otherTokens + measurement.builtinToolNames.tokens;
  children.push(
    new InventoryNode({
      kind: 'other',
      label: 'Other (system prompt, built-in tools)',
      description: `≈${formatTokens(otherTokens)} tok`,
      icon: new vscode.ThemeIcon(ICONS.other),
      tooltip: markdown([
        '**Other context**',
        `Unattributed remainder: ≈${formatTokens(measurement.otherTokens)} tokens`,
        `Built-in tool schemas: ≈${formatTokens(measurement.builtinToolNames.tokens)} tokens (${measurement.builtinToolNames.count} tools)`,
      ]),
    }),
  );

  return new InventoryNode({
    kind: 'context',
    label: `Starting context ≈ ${formatTokens(measurement.baselineTokens)} tokens`,
    icon: new vscode.ThemeIcon(ICONS.context),
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    children,
    tooltip: markdown([
      '**Starting context**',
      `Session: ${code(measurement.sessionId)}`,
      `File: ${code(measurement.sessionFile)}`,
      measurement.startedAt ? `Started: ${measurement.startedAt}` : '',
      `Baseline: ≈${formatTokens(measurement.baselineTokens)} tokens`,
      `Other: ≈${formatTokens(measurement.otherTokens)} tokens`,
    ]),
  });
}

function buildMcpNode(ctx: BuildContext, server: McpServer): InventoryNode {
  const measurement = ctx.state.measurement;
  const tokens = serverMeasuredTokens(ctx, server.id);
  const usageEntry = ctx.state.usage.mcp[server.id];
  const unused = !server.disabled && isUnused(usageEntry, ctx.state.usage);
  let base = server.disabled ? 'mcp:off' : 'mcp:on';
  if (server.stashed) {
    base = 'mcp:stashed';
  } else if (server.scope === 'user') {
    base += ':user';
  }
  const contextValue = server.sourceFile ? `${base}:source` : base;

  const tooltip: string[] = [
    `**MCP server** ${code(server.id)}`,
    `Scope: ${server.scope}`,
    SCOPE_LEGEND,
  ];
  if (server.pluginKey) {
    tooltip.push(`Plugin: ${code(server.pluginKey)}`);
  }
  if (server.sourceFile) {
    tooltip.push(`Source: ${code(server.sourceFile)}`);
  }
  if (server.transport) {
    tooltip.push(`Transport: ${server.transport}`);
  }
  tooltip.push(
    `State: ${server.stashed ? 'disabled for all projects (config parked in the stash file)' : server.disabled ? 'disabled for this project' : 'enabled'}`,
  );
  if (server.needsAuth) {
    tooltip.push('Needs authentication.');
  }
  if (tokens !== undefined) {
    tooltip.push(`Measured: ≈${formatTokens(tokens)} tokens`);
    const tools = measurement?.mcpTools[server.id];
    if (tools) {
      tooltip.push(`Tool names: ${tools.toolCount}`);
    }
  }
  if (usageEntry) {
    tooltip.push(
      `Usage: ${usageEntry.count}× in ${ctx.state.usage.windowDays}d${
        usageEntry.lastUsed ? ` (last ${usageEntry.lastUsed})` : ''
      }`,
    );
  }

  return new InventoryNode({
    kind: 'mcp',
    label: shortMcpLabel(server.id),
    badge: scopeBadge(server.scope),
    tone: server.disabled ? 'off' : unused ? 'warn' : undefined,
    description: server.stashed
      ? 'off · all projects'
      : describeItem({
          tokens,
          usage: usageEntry,
          unused,
          disabled: server.disabled,
          windowDays: ctx.state.usage.windowDays,
        }),
    icon: itemIcon('mcp', {
      disabled: server.disabled,
      unused,
      needsAuth: server.needsAuth,
      active: !server.disabled,
    }),
    contextValue,
    tooltip: markdown(tooltip),
    file: server.sourceFile,
    mcpId: server.id,
    mcpDisabled: server.disabled,
  });
}

/** Inventory servers plus transcript-only (`builtin`) servers, active first. */
function collectMcpServers(ctx: BuildContext): McpServer[] {
  const servers = [...ctx.state.inventory.mcpServers];
  const known = new Set(servers.map((server) => server.id));
  const measurement = ctx.state.measurement;
  if (measurement) {
    const measuredIds = new Set<string>([
      ...Object.keys(measurement.mcpTools),
      ...Object.keys(measurement.mcpInstructions),
    ]);
    for (const id of measuredIds) {
      if (known.has(id)) {
        continue;
      }
      known.add(id);
      servers.push({
        id,
        name: id,
        scope: 'builtin',
        disabled: false,
        needsAuth: measurement.needsAuthMcpServers.includes(id),
      });
    }
  }

  const tokensOf = (server: McpServer): number =>
    serverMeasuredTokens(ctx, server.id) ?? 0;
  servers.sort((a, b) => {
    if (a.disabled !== b.disabled) {
      return a.disabled ? 1 : -1;
    }
    const tokensA = tokensOf(a);
    const tokensB = tokensOf(b);
    if (tokensA !== tokensB) {
      return tokensB - tokensA;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return servers;
}

function buildMcpSection(ctx: BuildContext): InventoryNode {
  const servers = collectMcpServers(ctx);
  const active = servers.filter((server) => !server.disabled).length;
  return sectionNode(
    `MCP servers (${active} active / ${servers.length} total)`,
    'section',
    new vscode.ThemeIcon(ICONS.mcp),
    servers.map((server) => buildMcpNode(ctx, server)),
  );
}

function pluginSourceFile(plugin: Plugin): string {
  return path.join(plugin.installPath, '.claude-plugin', 'plugin.json');
}

function pluginMcpServers(ctx: BuildContext, plugin: Plugin): McpServer[] {
  const measurement = ctx.state.measurement;
  return plugin.mcpServerIds.map((id): McpServer => {
    const existing = ctx.state.inventory.mcpServers.find((server) => server.id === id);
    if (existing) {
      return plugin.enabled ? existing : { ...existing, disabled: true };
    }
    const prefix = `plugin:${plugin.name}:`;
    const name = id.startsWith(prefix) ? id.slice(prefix.length) : id;
    return {
      id,
      name,
      scope: 'plugin',
      pluginKey: plugin.key,
      disabled: !plugin.enabled,
      needsAuth: measurement?.needsAuthMcpServers.includes(id) ?? false,
    };
  });
}

function buildSkillAgentNode(
  ctx: BuildContext,
  item: SkillOrAgent,
  pluginName?: string,
): InventoryNode {
  const usageEntry: UsageEntry | undefined =
    item.kind === 'skill'
      ? ctx.state.usage.skills[item.name]
      : ctx.state.usage.agents[item.name];
  const unused = isUnused(usageEntry, ctx.state.usage);
  const kind: NodeKind = item.kind;

  const tooltip: string[] = [
    `**${item.kind === 'skill' ? 'Skill' : 'Agent'}** ${code(item.name)}`,
    `Scope: ${item.scope}`,
  ];
  if (item.pluginKey) {
    tooltip.push(`Plugin: ${code(item.pluginKey)}`);
  }
  tooltip.push(`Source: ${code(item.file)}`);
  if (item.description) {
    tooltip.push(item.description);
  }
  tooltip.push(`Static estimate: ≈${formatTokens(item.estTokens)} tokens`);
  if (usageEntry) {
    tooltip.push(
      `Usage: ${usageEntry.count}× in ${ctx.state.usage.windowDays}d${
        usageEntry.lastUsed ? ` (last ${usageEntry.lastUsed})` : ''
      }`,
    );
  }

  return new InventoryNode({
    kind,
    label: stripPluginPrefix(item.name, pluginName),
    badge: pluginName ? undefined : scopeBadge(item.scope),
    tone: unused ? 'warn' : undefined,
    description: describeItem({
      tokens: item.estTokens,
      usage: usageEntry,
      unused,
      disabled: false,
      windowDays: ctx.state.usage.windowDays,
    }),
    icon: itemIcon(kind, { unused, active: true }),
    contextValue: `${kind}:source`,
    tooltip: markdown(tooltip),
    file: item.file,
  });
}

function buildHookNode(ctx: BuildContext, hook: Hook): InventoryNode {
  const tokens = hookMeasuredTokens(ctx, hook);
  const tooltip: string[] = [
    `**Hook** ${code(hook.event)}`,
    `Scope: ${hook.scope}`,
  ];
  if (hook.matcher) {
    tooltip.push(`Matcher: ${code(hook.matcher)}`);
  }
  if (hook.pluginKey) {
    tooltip.push(`Plugin: ${code(hook.pluginKey)}`);
  }
  tooltip.push(`Source: ${code(hook.sourceFile)}`);
  tooltip.push(`Command: ${code(hook.command)}`);
  if (hook.statusMessage) {
    tooltip.push(`Status message: ${hook.statusMessage}`);
  }
  if (tokens !== undefined) {
    tooltip.push(`Measured: ≈${formatTokens(tokens)} tokens`);
  }

  return new InventoryNode({
    kind: 'hook',
    label: hook.event,
    badge: hook.pluginKey ? undefined : scopeBadge(hook.scope),
    description: describeItem({
      tokens,
      usage: undefined,
      unused: false,
      disabled: false,
      windowDays: ctx.state.usage.windowDays,
    }),
    icon: itemIcon('hook'),
    contextValue: 'hook:source',
    tooltip: markdown(tooltip),
    file: hook.sourceFile,
  });
}

function buildInstructionNode(
  ctx: BuildContext,
  file: InstructionFile,
): InventoryNode {
  const measured = instructionMeasuredTokens(ctx, file);
  return new InventoryNode({
    kind: 'instructions',
    label: file.path,
    description: describeItem({
      tokens: measured ?? file.estTokens,
      usage: undefined,
      unused: false,
      disabled: false,
      windowDays: ctx.state.usage.windowDays,
    }),
    icon: itemIcon('instructions'),
    contextValue: 'instructions:source',
    tooltip: markdown([
      '**CLAUDE.md**',
      `Source: ${code(file.path)}`,
      `Static estimate: ≈${formatTokens(file.estTokens)} tokens`,
      measured !== undefined
        ? `Measured: ≈${formatTokens(measured)} tokens`
        : '',
    ]),
    file: file.path,
  });
}

function buildPluginChildren(ctx: BuildContext, plugin: Plugin): InventoryNode[] {
  const groups: InventoryNode[] = [];

  if (plugin.skills.length > 0) {
    groups.push(
      sectionNode(
        'Skills',
        'group',
        itemIcon('skill'),
        plugin.skills.map((skill) => buildSkillAgentNode(ctx, skill, plugin.name)),
      ),
    );
  }
  if (plugin.agents.length > 0) {
    groups.push(
      sectionNode(
        'Agents',
        'group',
        itemIcon('agent'),
        plugin.agents.map((agent) => buildSkillAgentNode(ctx, agent, plugin.name)),
      ),
    );
  }
  if (plugin.commands.length > 0) {
    groups.push(
      sectionNode(
        'Commands',
        'group',
        itemIcon('command'),
        plugin.commands.map(
          (command) =>
            new InventoryNode({
              kind: 'command',
              label: command,
              icon: itemIcon('command'),
              tooltip: markdown([
                `**Command** ${code(command)}`,
                `Plugin: ${code(plugin.key)}`,
              ]),
            }),
        ),
      ),
    );
  }
  if (plugin.hooks.length > 0) {
    groups.push(
      sectionNode(
        'Hooks',
        'group',
        itemIcon('hook'),
        plugin.hooks.map((hook) => buildHookNode(ctx, hook)),
      ),
    );
  }
  const mcpServers = pluginMcpServers(ctx, plugin);
  if (mcpServers.length > 0) {
    groups.push(
      sectionNode(
        'MCP',
        'group',
        itemIcon('mcp'),
        mcpServers.map((server) => buildMcpNode(ctx, server)),
      ),
    );
  }

  return groups;
}

function buildPluginNode(ctx: BuildContext, plugin: Plugin): InventoryNode {
  const measurement = ctx.state.measurement;
  const entry = pluginUsed(plugin, ctx.state.usage, ctx.state.inventory);
  const unused = entry.count === 0 && isUnused(entry, ctx.state.usage);
  const tokens = measurement
    ? measuredTokensForPlugin(plugin, measurement)
    : undefined;
  const local = plugin.enabledSource === 'local';
  let contextValue = plugin.enabled ? 'plugin:on' : 'plugin:off';
  if (local) {
    contextValue += ':local';
  }
  contextValue += ':source';

  const tooltip: string[] = [
    `**Plugin** ${code(plugin.key)}`,
    `Name: ${plugin.name}`,
    `Marketplace: ${plugin.marketplace || '(unknown)'}`,
  ];
  if (plugin.version) {
    tooltip.push(`Version: ${plugin.version}`);
  }
  tooltip.push(`Install path: ${code(plugin.installPath)}`);
  tooltip.push(
    `Enabled: ${plugin.enabled ? 'yes' : 'no'} (set at: ${plugin.enabledSource})`,
  );
  tooltip.push(SCOPE_LEGEND);
  if (tokens !== undefined) {
    tooltip.push(`Measured: ≈${formatTokens(tokens)} tokens`);
  }
  tooltip.push(
    `Usage: ${entry.count}× in ${ctx.state.usage.windowDays}d${
      entry.lastUsed ? ` (last ${entry.lastUsed})` : ''
    }`,
  );

  const children = buildPluginChildren(ctx, plugin);

  return new InventoryNode({
    kind: 'plugin',
    label: plugin.name,
    badge: scopeBadge(plugin.enabledSource),
    tone: !plugin.enabled ? 'off' : unused ? 'warn' : undefined,
    description: describeItem({
      tokens,
      usage: entry,
      unused,
      disabled: !plugin.enabled,
      windowDays: ctx.state.usage.windowDays,
    }),
    icon: itemIcon('plugin', { disabled: !plugin.enabled, unused, active: plugin.enabled }),
    contextValue,
    tooltip: markdown(tooltip),
    file: pluginSourceFile(plugin),
    pluginKey: plugin.key,
    pluginEnabled: plugin.enabled,
    hasLocalOverride: local,
    children,
    collapsibleState:
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
  });
}

function buildPluginsSection(ctx: BuildContext): InventoryNode {
  const plugins = ctx.state.inventory.plugins;
  const enabled = plugins.filter((plugin) => plugin.enabled).length;
  return sectionNode(
    `Plugins (${enabled} enabled / ${plugins.length} installed)`,
    'section',
    new vscode.ThemeIcon(ICONS.plugin),
    plugins.map((plugin) => buildPluginNode(ctx, plugin)),
  );
}

function buildStandaloneSkillsSection(ctx: BuildContext): InventoryNode {
  return sectionNode(
    'Skills',
    'section',
    itemIcon('skill'),
    ctx.state.inventory.skills.map((skill) => buildSkillAgentNode(ctx, skill)),
  );
}

function buildStandaloneAgentsSection(ctx: BuildContext): InventoryNode {
  return sectionNode(
    'Agents',
    'section',
    itemIcon('agent'),
    ctx.state.inventory.agents.map((agent) => buildSkillAgentNode(ctx, agent)),
  );
}

function buildHooksSection(ctx: BuildContext): InventoryNode {
  return sectionNode(
    'Hooks',
    'section',
    itemIcon('hook'),
    ctx.state.inventory.hooks.map((hook) => buildHookNode(ctx, hook)),
  );
}

function buildInstructionsSection(ctx: BuildContext): InventoryNode {
  return sectionNode(
    'CLAUDE.md',
    'section',
    itemIcon('instructions'),
    ctx.state.inventory.instructions.map((file) =>
      buildInstructionNode(ctx, file),
    ),
  );
}

export function buildTree(state: InventoryState): InventoryNode[] {
  const ctx: BuildContext = { state };
  return [
    buildContextNode(ctx),
    buildMcpSection(ctx),
    buildPluginsSection(ctx),
    buildStandaloneSkillsSection(ctx),
    buildStandaloneAgentsSection(ctx),
    buildHooksSection(ctx),
    buildInstructionsSection(ctx),
  ];
}

function flatten(nodes: InventoryNode[], out: InventoryNode[]): void {
  for (const node of nodes) {
    out.push(node);
    flatten(node.childrenNodes, out);
  }
}

export class InventoryProvider implements vscode.TreeDataProvider<InventoryNode> {
  private readonly emitter = new vscode.EventEmitter<
    InventoryNode | undefined | void
  >();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: InventoryNode[] = [];
  private state: InventoryState | undefined;

  setState(state: InventoryState): void {
    this.state = state;
    this.roots = buildTree(state);
    this.emitter.fire(undefined);
  }

  setWorkspaceMissing(missing: boolean): void {
    if (missing) {
      this.state = undefined;
      this.roots = [openFolderNode()];
    } else if (this.state) {
      this.roots = buildTree(this.state);
    } else {
      this.roots = [];
    }
    this.emitter.fire(undefined);
  }

  getState(): InventoryState | undefined {
    return this.state;
  }

  getAllNodes(): InventoryNode[] {
    const nodes: InventoryNode[] = [];
    flatten(this.roots, nodes);
    return nodes;
  }

  getChildren(element?: InventoryNode): InventoryNode[] {
    return element ? element.childrenNodes : this.roots;
  }

  getTreeItem(element: InventoryNode): vscode.TreeItem {
    return element;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
