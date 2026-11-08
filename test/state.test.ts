import { describe, expect, it } from 'vitest';
import type {
  Inventory,
  McpServer,
  Measurement,
  Plugin,
  Usage,
} from '../src/core/model';
import {
  describeItem,
  measuredTokensForPlugin,
  measuredTokensForServer,
  topConsumers,
  unusedEnabledCount,
  type InventoryState,
} from '../src/state';

function makeMeasurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    sessionId: 'session',
    sessionFile: '/home/.claude/projects/p/session.jsonl',
    baselineTokens: 1000,
    otherTokens: 100,
    mcpTools: {},
    mcpInstructions: {},
    skillsByOwner: {},
    agentsByOwner: {},
    hooks: [],
    instructions: [],
    builtinToolNames: { tokens: 0, count: 0 },
    needsAuthMcpServers: [],
    warnings: [],
    ...overrides,
  };
}

function makeInventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    projectPath: '/project',
    mcpServers: [],
    plugins: [],
    skills: [],
    agents: [],
    hooks: [],
    instructions: [],
    warnings: [],
    ...overrides,
  };
}

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    key: 'vercel-plugin@vercel',
    name: 'vercel',
    marketplace: 'vercel',
    installPath: '/plugins/vercel',
    enabled: true,
    enabledSource: 'user',
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    mcpServerIds: ['plugin:vercel:vercel'],
    ...overrides,
  };
}

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'blender',
    name: 'blender',
    scope: 'user',
    disabled: false,
    needsAuth: false,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    windowDays: 30,
    sessionCount: 3,
    mcp: {},
    skills: {},
    agents: {},
    ...overrides,
  };
}

describe('topConsumers', () => {
  const inventory = makeInventory({
    plugins: [makePlugin()],
    mcpServers: [makeServer({ id: 'plugin:vercel:vercel', name: 'vercel' })],
  });
  const measurement = makeMeasurement({
    mcpTools: {
      'plugin:vercel:vercel': { tokens: 300, toolCount: 3 },
      blender: { tokens: 50, toolCount: 1 },
    },
    mcpInstructions: {
      'plugin:vercel:vercel': { tokens: 20 },
      blender: { tokens: 10 },
    },
    skillsByOwner: {
      vercel: { tokens: 100, count: 2 },
      '(standalone)': { tokens: 40, count: 1 },
    },
    agentsByOwner: {
      vercel: { tokens: 30, count: 1 },
    },
    hooks: [
      { tokens: 15, event: 'SessionStart', command: 'start', owner: 'vercel' },
      { tokens: 5, event: 'UserPromptSubmit', command: 'echo', owner: '(settings)' },
    ],
    instructions: [{ tokens: 25, path: '/project/CLAUDE.md' }],
  });

  it('combines MCP tools and instructions per server', () => {
    const consumers = topConsumers(measurement, inventory, 10);
    const mcp = consumers.filter((consumer) => consumer.kind === 'mcp');
    expect(mcp).toHaveLength(2);
    expect(mcp[0]).toEqual({
      label: 'plugin:vercel:vercel',
      tokens: 320,
      kind: 'mcp',
    });
    expect(mcp[1]).toEqual({ label: 'blender', tokens: 60, kind: 'mcp' });
  });

  it('aggregates skills, agents and hooks per owner', () => {
    const consumers = topConsumers(measurement, inventory, 10);
    const ownerEntries = consumers.filter(
      (consumer) =>
        consumer.kind === 'skill' ||
        consumer.kind === 'agent' ||
        consumer.kind === 'hook',
    );
    expect(ownerEntries).toContainEqual({
      label: 'vercel-plugin@vercel',
      tokens: 100,
      kind: 'skill',
    });
    expect(ownerEntries).toContainEqual({
      label: 'vercel-plugin@vercel',
      tokens: 30,
      kind: 'agent',
    });
    expect(ownerEntries).toContainEqual({
      label: 'vercel-plugin@vercel',
      tokens: 15,
      kind: 'hook',
    });
    expect(ownerEntries).toContainEqual({
      label: '(settings)',
      tokens: 5,
      kind: 'hook',
    });
  });

  it('sorts descending and keeps instruction files separate', () => {
    const consumers = topConsumers(measurement, inventory, 10);
    expect(consumers.map((consumer) => consumer.tokens)).toEqual([
      320, 100, 60, 40, 30, 25, 15, 5,
    ]);
    expect(consumers).toContainEqual({
      label: '/project/CLAUDE.md',
      tokens: 25,
      kind: 'instructions',
    });
  });

  it('respects the limit and handles non-positive limits', () => {
    expect(topConsumers(measurement, inventory, 3)).toHaveLength(3);
    expect(topConsumers(measurement, inventory, 3)[0].tokens).toBe(320);
    expect(topConsumers(measurement, inventory, 0)).toEqual([]);
  });
});

describe('measuredTokensForServer', () => {
  it('sums tool and instruction tokens and defaults to zero', () => {
    const measurement = makeMeasurement({
      mcpTools: { blender: { tokens: 40, toolCount: 2 } },
      mcpInstructions: { blender: { tokens: 10 } },
    });
    expect(measuredTokensForServer('blender', measurement)).toBe(50);
    expect(measuredTokensForServer('missing', measurement)).toBe(0);
  });
});

describe('measuredTokensForPlugin', () => {
  it('adds skills, agents, its hooks and its MCP servers', () => {
    const measurement = makeMeasurement({
      mcpTools: { 'plugin:vercel:vercel': { tokens: 20, toolCount: 2 } },
      mcpInstructions: { 'plugin:vercel:vercel': { tokens: 5 } },
      skillsByOwner: { vercel: { tokens: 10, count: 1 } },
      agentsByOwner: { vercel: { tokens: 7, count: 1 } },
      hooks: [
        { tokens: 3, event: 'SessionStart', command: 'a', owner: 'vercel' },
        { tokens: 99, event: 'SessionStart', command: 'b', owner: '(settings)' },
      ],
    });
    expect(measuredTokensForPlugin(makePlugin(), measurement)).toBe(45);
  });

  it('ignores hooks and servers that belong to another plugin', () => {
    const measurement = makeMeasurement({
      mcpTools: { other: { tokens: 500, toolCount: 4 } },
      hooks: [{ tokens: 50, event: 'Stop', command: 'x', owner: 'other' }],
    });
    expect(
      measuredTokensForPlugin(
        makePlugin({ mcpServerIds: ['plugin:vercel:vercel'] }),
        measurement,
      ),
    ).toBe(0);
  });
});

describe('describeItem', () => {
  it('shows token cost and usage count', () => {
    expect(
      describeItem({
        tokens: 1234,
        usage: { count: 3 },
        unused: false,
        disabled: false,
        windowDays: 30,
      }),
    ).toBe('1.2k · 3×');
  });

  it('shows the unused flag', () => {
    expect(
      describeItem({
        tokens: 1234,
        usage: { count: 0 },
        unused: true,
        disabled: false,
        windowDays: 30,
      }),
    ).toBe('1.2k · unused');
  });

  it('shows disabled first', () => {
    expect(
      describeItem({
        tokens: 500,
        usage: { count: 4 },
        unused: true,
        disabled: true,
        windowDays: 30,
      }),
    ).toBe('off');
  });

  it('uses ? tok for unknown tokens', () => {
    expect(
      describeItem({
        usage: undefined,
        unused: false,
        disabled: false,
        windowDays: 30,
      }),
    ).toBe('?');
    expect(
      describeItem({
        usage: { count: 2 },
        unused: false,
        disabled: false,
        windowDays: 7,
      }),
    ).toBe('? · 2×');
  });

  it('omits the usage suffix when there is no use and no unused flag', () => {
    expect(
      describeItem({
        tokens: 800,
        usage: { count: 0 },
        unused: false,
        disabled: false,
        windowDays: 30,
      }),
    ).toBe('800');
  });
});

describe('unusedEnabledCount', () => {
  it('counts enabled servers and plugins with no use', () => {
    const inventory = makeInventory({
      mcpServers: [
        makeServer({ id: 'used' }),
        makeServer({ id: 'unused' }),
        makeServer({ id: 'off', disabled: true }),
      ],
      plugins: [
        makePlugin({
          key: 'used@market',
          name: 'used',
          mcpServerIds: ['used'],
        }),
        makePlugin({
          key: 'unused@market',
          name: 'unused',
          mcpServerIds: [],
        }),
        makePlugin({
          key: 'off@market',
          name: 'off',
          enabled: false,
          mcpServerIds: [],
        }),
      ],
    });
    const state: InventoryState = {
      inventory,
      measurement: makeMeasurement(),
      usage: makeUsage({ mcp: { used: { count: 2 } } }),
    };
    expect(unusedEnabledCount(state)).toBe(2);
  });

  it('does not judge with fewer than three sessions', () => {
    const inventory = makeInventory({
      mcpServers: [makeServer({ id: 'unused' })],
      plugins: [makePlugin()],
    });
    const state: InventoryState = {
      inventory,
      usage: makeUsage({ sessionCount: 2 }),
    };
    expect(unusedEnabledCount(state)).toBe(0);
  });
});
