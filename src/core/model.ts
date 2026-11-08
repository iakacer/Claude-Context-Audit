export type Scope = 'user'|'local'|'project'|'plugin'|'claudeai'|'builtin';
export interface McpServer { id: string; name: string; scope: Scope; pluginKey?: string;
  sourceFile?: string; transport?: string; disabled: boolean; needsAuth: boolean;
  /** Switched off for all projects: config parked in the stash file, not in ~/.claude.json. */
  stashed?: boolean; }
export interface SkillOrAgent { kind: 'skill'|'agent'; name: string; description: string;
  scope: Scope; pluginKey?: string; file: string; estTokens: number; }
export interface Hook { event: string; matcher?: string; command: string; statusMessage?: string;
  scope: Scope; pluginKey?: string; sourceFile: string; }
export interface Plugin { key: string; name: string; marketplace: string; version?: string;
  installPath: string; enabled: boolean; enabledSource: 'user'|'project'|'local'|'default';
  skills: SkillOrAgent[]; agents: SkillOrAgent[]; commands: string[]; hooks: Hook[];
  mcpServerIds: string[]; }
export interface InstructionFile { path: string; estTokens: number; }
export interface Inventory { projectPath: string; mcpServers: McpServer[]; plugins: Plugin[];
  skills: SkillOrAgent[]; agents: SkillOrAgent[]; hooks: Hook[];
  instructions: InstructionFile[]; warnings: string[]; }
export interface Cost { tokens: number; detail?: string; }
export interface Measurement { sessionId: string; sessionFile: string; startedAt?: string;
  baselineTokens: number; otherTokens: number;
  mcpTools: Record<string, Cost & {toolCount: number}>;   // key: server id or prefix
  mcpInstructions: Record<string, Cost>;
  skillsByOwner: Record<string, Cost & {count: number}>;  // key: pluginName or '(standalone)'
  agentsByOwner: Record<string, Cost & {count: number}>;
  hooks: Array<Cost & {event: string; command: string; owner: string}>; // owner: pluginName or '(settings)'
  instructions: Array<Cost & {path: string}>;
  builtinToolNames: Cost & {count: number};
  needsAuthMcpServers: string[]; warnings: string[]; }
export interface UsageEntry { count: number; lastUsed?: string; }
export interface Usage { windowDays: number; sessionCount: number;
  mcp: Record<string, UsageEntry>; skills: Record<string, UsageEntry>;
  agents: Record<string, UsageEntry>; }
