import type {
  Inventory,
  Measurement,
  Usage,
  UsageEntry,
} from './core/model';
import type { ClaudePaths } from './core/paths';
import { buildInventory } from './core/scanner';
import { formatTokens } from './core/tokens';
import { collectUsage, isUnused, measureLatestSession, pluginUsed } from './core/transcripts';

/** Everything the UI needs for one workspace folder. */
export interface InventoryState {
  inventory: Inventory;
  measurement?: Measurement;
  usage: Usage;
}

/**
 * Scan the static inventory, then measure the latest session and collect usage
 * in parallel. Both transcript passes share the finished inventory.
 */
export async function loadState(
  projectPath: string,
  paths: ClaudePaths,
  windowDays = 30,
): Promise<InventoryState> {
  const inventory = await buildInventory(projectPath, paths);
  const [measurement, usage] = await Promise.all([
    measureLatestSession(projectPath, paths, inventory),
    collectUsage(projectPath, paths, inventory, windowDays),
  ]);
  return { inventory, measurement, usage };
}

export type ConsumerKind = 'mcp' | 'skill' | 'agent' | 'hook' | 'instructions';

export interface Consumer {
  label: string;
  tokens: number;
  kind: ConsumerKind;
}

/** Resolve an owner key from the measurement to a stable plugin label. */
function ownerLabel(owner: string, inventory: Inventory): string {
  for (const plugin of inventory.plugins) {
    if (plugin.name === owner || plugin.key === owner) {
      return plugin.key;
    }
  }
  return owner;
}

/** Tokens a single MCP server costs: its tool names plus instruction blocks. */
export function measuredTokensForServer(id: string, measurement: Measurement): number {
  return (
    (measurement.mcpTools[id]?.tokens ?? 0) +
    (measurement.mcpInstructions[id]?.tokens ?? 0)
  );
}

/**
 * Tokens a plugin costs: its skills and agents owner entries, its hooks and
 * all of its MCP servers.
 */
export function measuredTokensForPlugin(
  plugin: { name: string; mcpServerIds: string[] },
  measurement: Measurement,
): number {
  let total =
    (measurement.skillsByOwner[plugin.name]?.tokens ?? 0) +
    (measurement.agentsByOwner[plugin.name]?.tokens ?? 0);
  for (const hook of measurement.hooks) {
    if (hook.owner === plugin.name) {
      total += hook.tokens;
    }
  }
  for (const id of plugin.mcpServerIds) {
    total += measuredTokensForServer(id, measurement);
  }
  return total;
}

interface HookOwnerTotal {
  tokens: number;
}

/**
 * Largest context consumers of the measured session, biggest first. MCP tool
 * names and instruction blocks are combined per server; skills, agents and
 * hooks are aggregated per owner; instruction files stay separate.
 */
export function topConsumers(
  measurement: Measurement,
  inventory: Inventory,
  n: number,
): Consumer[] {
  const consumers: Consumer[] = [];

  const serverIds = new Set<string>([
    ...Object.keys(measurement.mcpTools),
    ...Object.keys(measurement.mcpInstructions),
  ]);
  for (const id of serverIds) {
    consumers.push({
      label: id,
      tokens: measuredTokensForServer(id, measurement),
      kind: 'mcp',
    });
  }

  for (const [owner, cost] of Object.entries(measurement.skillsByOwner)) {
    consumers.push({
      label: ownerLabel(owner, inventory),
      tokens: cost.tokens,
      kind: 'skill',
    });
  }

  for (const [owner, cost] of Object.entries(measurement.agentsByOwner)) {
    consumers.push({
      label: ownerLabel(owner, inventory),
      tokens: cost.tokens,
      kind: 'agent',
    });
  }

  const hookOwners = new Map<string, HookOwnerTotal>();
  for (const hook of measurement.hooks) {
    const owner = hookOwners.get(hook.owner) ?? { tokens: 0 };
    owner.tokens += hook.tokens;
    hookOwners.set(hook.owner, owner);
  }
  for (const [owner, total] of hookOwners) {
    consumers.push({
      label: ownerLabel(owner, inventory),
      tokens: total.tokens,
      kind: 'hook',
    });
  }

  for (const file of measurement.instructions) {
    consumers.push({ label: file.path, tokens: file.tokens, kind: 'instructions' });
  }

  consumers.sort((a, b) => {
    if (a.tokens !== b.tokens) {
      return b.tokens - a.tokens;
    }
    if (a.label !== b.label) {
      return a.label < b.label ? -1 : 1;
    }
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  return n > 0 ? consumers.slice(0, n) : [];
}

export interface DescribeItemOptions {
  tokens?: number;
  usage?: UsageEntry;
  unused: boolean;
  disabled: boolean;
  windowDays: number;
}

/**
 * Item description per the UI spec:
 * Compact so it survives a narrow sidebar: `1.2k · 3×`, `1.2k · unused`, `off`.
 * Unknown token counts are shown as `?`.
 */
export function describeItem(options: DescribeItemOptions): string {
  if (options.disabled) {
    return 'off';
  }
  const tokens =
    options.tokens !== undefined && Number.isFinite(options.tokens)
      ? formatTokens(options.tokens)
      : '?';
  if (options.unused) {
    return `${tokens} · unused`;
  }
  const count = options.usage?.count ?? 0;
  if (count > 0) {
    return `${tokens} · ${count}×`;
  }
  return tokens;
}

/** Enabled MCP servers and plugins that had no recorded use in the window. */
export function unusedEnabledCount(state: InventoryState): number {
  const { inventory, usage } = state;
  let count = 0;
  for (const server of inventory.mcpServers) {
    if (!server.disabled && isUnused(usage.mcp[server.id], usage)) {
      count += 1;
    }
  }
  for (const plugin of inventory.plugins) {
    if (!plugin.enabled) {
      continue;
    }
    const entry = pluginUsed(plugin, usage, inventory);
    if (entry.count === 0 && isUnused(entry, usage)) {
      count += 1;
    }
  }
  return count;
}
