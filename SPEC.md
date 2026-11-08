# Claude Context Inventory — VS Code extension spec

Shows, for the open workspace folder, everything Claude Code loads into context
(MCP servers, plugins, skills, agents, hooks, CLAUDE.md), how many tokens each
costs (measured from the last real session), whether it was actually used
recently, and lets the user disable/enable MCP servers and plugins **for this
project only**.

All facts below were verified against Claude Code 2.1.319 on Windows. Formats
are undocumented: every parser must tolerate missing fields / unknown values and
never throw to the UI (return partial data + a `warnings: string[]`).

## 1. Stack and layout

- TypeScript (strict), Node 20 APIs only, no runtime dependencies.
- Bundle with esbuild to `dist/extension.js` (vscode external). Also bundle
  `src/cli.ts` to `dist/cli.js` (debug tool, not shipped in the vsix).
- Tests: vitest. `engines.vscode: ^1.90.0`. Package with `@vscode/vsce`.
- npm scripts: `build`, `watch`, `typecheck` (`tsc --noEmit`), `test`
  (`vitest run`), `package` (`vsce package --no-dependencies`).

```
src/core/      pure Node, MUST NOT import 'vscode' (unit-tested)
  model.ts       shared types (section 6)
  tokens.ts      estimateTokens(text)
  paths.ts       ClaudePaths, project key matching, transcript dir lookup
  json.ts        readJson(path) -> {data, error}; tolerant
  scanner.ts     buildInventory(projectPath, paths) -> Inventory
  transcripts.ts measureLatestSession(...), collectUsage(...)
  writer.ts      setMcpDisabled(...), setPluginOverride(...)
src/extension.ts activate/deactivate, wiring
src/tree.ts      TreeDataProvider
src/statusBar.ts
src/cli.ts       `node dist/cli.js <projectPath> [--days N]` prints JSON of
                 {inventory, measurement, usage}
test/            vitest specs + test/fixtures/** (synthetic data only; never
                 copy real files from the user's home)
```

`ClaudePaths` is built from a `home` dir (default `os.homedir()`) so tests can
point at a fixture home:
- `claudeJson` = `<home>/.claude.json`
- `claudeDir` = `<home>/.claude`
- `userSettings` = `<claudeDir>/settings.json`
- `installedPlugins` = `<claudeDir>/plugins/installed_plugins.json`
- `transcriptsRoot` = `<claudeDir>/projects`

## 2. Data sources (static scan)

### 2.1 Project key in `~/.claude.json`
`projects` is an object keyed by project path. Keys are inconsistent:
`d:/Projects/x`, `D:/Projects/x`, `C:\Users\x` all occur. Match with
`normKey(p) = p.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()`.
Several keys may match the same folder: when reading, union their
`disabledMcpServers`; when writing, update every matching key. If none
matches, create key `projectPath.replace(/\\/g,'/')`.

### 2.2 MCP servers — ids and sources
Each server has an **id** (the string stored in `disabledMcpServers`):

| scope | where defined | id |
|---|---|---|
| user | `~/.claude.json` top-level `mcpServers` keys | `<name>` |
| local | `~/.claude.json` `projects[key].mcpServers` keys | `<name>` |
| project | `<project>/.mcp.json` `mcpServers` keys | `<name>` |
| plugin | `<installPath>/.mcp.json` (`mcpServers` object, or a top-level object of servers) of an **enabled** plugin; plugin name = `name` in `<installPath>/.claude-plugin/plugin.json` (fallback: part before `@` of the plugin key) | `plugin:<pluginName>:<serverName>` |
| claudeai | `~/.claude.json` `claudeAiMcpEverConnected` (array of strings like `claude.ai Gmail`) | the string itself |

Disabled for this project = id is in the union of `disabledMcpServers` of the
matching project keys. For `project` scope also treat it as disabled if listed
in that project's `disabledMcpjsonServers`.
`needsAuth` = id is a key in `<claudeDir>/mcp-needs-auth-cache.json`.

Tool-name prefix of a server (used in transcripts):
`mcpPrefix(id) = 'mcp__' + id.replace(/[^A-Za-z0-9_-]/g,'_') + '__'`
(e.g. `plugin:vercel:vercel` → `mcp__plugin_vercel_vercel__`,
`claude.ai Gmail` → `mcp__claude_ai_Gmail__`).
Tool names with an `mcp__` prefix matching no known server are reported as
servers of scope `builtin` (e.g. `claude-in-chrome`, `claude-vscode`), named by
the prefix text.

### 2.3 Plugins
- Installed: `installed_plugins.json` → `{version:2, plugins: {"<name>@<marketplace>": [ {scope:"user"|"local"|"project", projectPath?, installPath, version} ]}}`.
  Use the entry whose scope is `local`/`project` with `projectPath` matching
  this project (normKey), else the `user` entry. No usable entry → skip.
- Enabled state: merge `enabledPlugins` (object key → boolean) in this order,
  later wins: `~/.claude/settings.json`, `<project>/.claude/settings.json`,
  `<project>/.claude/settings.local.json`. Record which file decided
  (`enabledSource`: `user` | `project` | `local` | `default`). Not mentioned
  anywhere → disabled (`default`). (Verified: `false` in project
  `settings.local.json` overrides `true` in user settings.)
- Contents (scan even if disabled, so the user sees what enabling costs):
  - skills: `<installPath>/skills/*/SKILL.md` → qualified name
    `<pluginName>:<frontmatter name or dir name>`
  - agents: `plugin.json` `agents` (array of relative paths) if present, else
    `<installPath>/agents/*.md` → `<pluginName>:<frontmatter name or file stem>`
  - commands: `<installPath>/commands/*.md` (names only)
  - hooks: `<installPath>/hooks/hooks.json` → `{hooks: {<Event>: [{matcher?, hooks:[{type, command}]}]}}`
  - mcp: per 2.2

### 2.4 Standalone skills, agents, hooks, instructions
- Skills: `<claudeDir>/skills/*/SKILL.md` (scope user),
  `<project>/.claude/skills/*/SKILL.md` (scope project).
- Agents: `<claudeDir>/agents/**/*.md` and `<project>/.claude/agents/**/*.md`,
  recursive; only files with frontmatter containing `name:`.
- Frontmatter: text between the first two `---` lines; read `name` and
  `description` (single-line values; strip quotes). Tolerate missing.
- Hooks: `hooks` key of user settings, project settings, project local settings
  (same shape as plugin hooks.json's `hooks`).
- Instructions: `<claudeDir>/CLAUDE.md`, `<project>/CLAUDE.md`,
  `<project>/.claude/CLAUDE.md`, `<project>/CLAUDE.local.md` if they exist.

### 2.5 Static token estimate
`estimateTokens(text)`: CJK chars (U+3000–U+9FFF, U+AC00–U+D7AF, U+FF00–U+FFEF)
count 1 each; everything else `ceil(len/4)`. Estimates use what Claude Code puts
in context: skills/agents → `"- " + name + ": " + description`; instructions →
whole file; MCP → unknown statically (0, shown as "?").

## 3. Measurement from the latest session transcript

Transcript dir for a project: the subdir of `transcriptsRoot` whose name equals
`slug(projectPath)` **case-insensitively**, where
`slug(p) = p.replace(/[^A-Za-z0-9]/g, '-')`
(`d:\Projects\项目\VSCodePlugin` → `d--Projects----VSCodePlugin`). Slugs can
collide; when reading a session, if its `user` records have a `cwd`, skip the
session unless `normKey(cwd) === normKey(projectPath)`.

Sessions are `*.jsonl` (one JSON object per line; skip unparsable lines).
Latest session = newest mtime that contains at least one `assistant` record.

Records used (`type` field):
- `attachment` with `attachment.type`:
  - `deferred_tools_delta`: `addedNames: string[]` (tool names). Group names by
    MCP prefix (2.2); names without `mcp__` are built-in tools. Tokens per
    server = estimateTokens of its names joined with `\n`.
  - `mcp_instructions_delta`: `addedNames[i]` (server id) ↔ `addedBlocks[i]` (text).
  - `skill_listing`: `content` (text, lines `- name: description`). Attribute
    each line to a plugin by `name` prefix before `:`; no prefix → standalone.
  - `agent_listing_delta`: `addedTypes[i]` ↔ `addedLines[i]`; same attribution.
  - `hook_success`: `hookEvent`, `command`, `content` (text injected). Attribute
    to a plugin when `command` contains the plugin's installPath (compare with
    `/` and `\` normalized, case-insensitive) or `plugins/cache/<marketplace>/<name>/`.
  - `instructions`: `files: [{path, type, content}]`.
  Only count attachments that appear **before the first `assistant` record**
  (that is the session's fixed starting context).
- First `assistant` record: `message.usage` → `baselineTokens =
  input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  (missing → 0). This is the real starting context size.
- `otherTokens = max(0, baselineTokens − sum of all attributed estimates)`
  (system prompt, built-in tool schemas).

## 4. Usage over the last N days (default 30)

Scan every session in the transcript dir with mtime in the window. Read
line-by-line (stream; files can be tens of MB) and JSON.parse only lines that
contain `"tool_use"` or `<command-name>`.
- `assistant` records: each `message.content[]` item with `type:"tool_use"`:
  - name starts with `mcp__` → usage of that MCP server (by prefix)
  - name `Skill` → `input.skill` (skill name, may be plugin-qualified)
  - name `Agent` or `Task` → `input.subagent_type`
- `user` records whose text content contains `<command-name>/xyz</command-name>`
  → usage of skill/command `xyz`.
Result: `{windowDays, sessionCount, mcp: Record<id,{count,lastUsed}>, skills: …, agents: …}`.
A plugin counts as used if any of its skills, agents, commands or MCP servers was used.
`unused` flag (shown in UI) = 0 uses AND `sessionCount >= 3`.

## 5. Writes (per-project toggles)

### 5.1 MCP server
`setMcpDisabled(paths, projectPath, id, disabled)`:
read `~/.claude.json` fresh → for every matching project key (create one if
none) add/remove `id` in `disabledMcpServers` (no duplicates) → write.
`~/.claude.json` is large and rewritten by running Claude Code processes:
- re-read immediately before writing; only change those keys
- once per extension session, copy it to `~/.claude.json.bak-context-inventory`
  before the first write
- write to `<file>.tmp-<pid>` in the same dir, then `fs.renameSync` over it
- keep 2-space indentation (Claude Code's own format)
After a write the UI says: "Applies to new Claude Code sessions in this folder.
A Claude Code session running right now may overwrite this; if the change does
not stick, close it and toggle again."

### 5.2 Plugin
`setPluginOverride(projectPath, pluginKey, value: boolean | null)`:
edit `<project>/.claude/settings.local.json` (create dir/file if needed),
`enabledPlugins[pluginKey] = value`, or delete the key when `null` (delete
`enabledPlugins` if it becomes empty). Preserve all other content, 2-space
indent, trailing newline. If the file exists but is not valid JSON → throw a
clear error and do not write.

## 6. Model (src/core/model.ts)

```ts
export type Scope = 'user'|'local'|'project'|'plugin'|'claudeai'|'builtin';
export interface McpServer { id: string; name: string; scope: Scope; pluginKey?: string;
  sourceFile?: string; transport?: string; disabled: boolean; needsAuth: boolean; }
export interface SkillOrAgent { kind: 'skill'|'agent'; name: string; description: string;
  scope: Scope; pluginKey?: string; file: string; estTokens: number; }
export interface Hook { event: string; matcher?: string; command: string;
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
```

## 7. VS Code UI

- `package.json`: name `claude-context-inventory`, displayName
  `Claude Context Inventory`, publisher `local`, activation `onStartupFinished`,
  view container in activity bar (id `claudeInventory`, codicon-based svg icon
  in `media/`), one tree view `claudeInventory.view`, setting
  `claudeInventory.usageWindowDays` (number, default 30).
- Tree, top level (workspace = first workspace folder; no folder → a single
  "Open a folder" item):
  1. `Starting context ≈ 65.6k tokens` (from Measurement; children: the top 10
     consumers sorted desc, plus "Other (system prompt, built-in tools)").
     No transcript → `No Claude Code session in this folder yet`.
  2. `MCP servers (A active / T total)` → servers sorted active first, then by
     measured tokens desc.
  3. `Plugins (A enabled / T installed)` → each plugin → children grouped
     Skills / Agents / Commands / Hooks / MCP.
  4. `Skills`, `Agents` (standalone, user + project).
  5. `Hooks` (from settings files).
  6. `CLAUDE.md` files.
- Item `description`: `≈1.2k tok · 3× in 30d`, or `≈1.2k tok · unused 30d`
  (unused flag), or `disabled here`. Token format: `<1000` as is, else one
  decimal + `k`.
- Icons (codicons): MCP `plug`, plugin `extensions`, skill `lightbulb`, agent
  `hubot`, hook `zap`, instructions `book`, disabled `circle-slash`, unused
  `warning` (ThemeColor `list.warningForeground`), needsAuth `key`.
- Tooltip: MarkdownString with id/key, scope, source file, enabledSource, usage.
- `contextValue`: `mcp:on`, `mcp:off`, `plugin:on`, `plugin:off`,
  `plugin:on:local`, `plugin:off:local` (`:local` = override exists in
  settings.local.json → enables "Reset to inherited").
- Commands (title-bar / inline / context menu via `menus` with `when` on
  `viewItem`):
  `claudeInventory.refresh` (view title, icon `refresh`),
  `claudeInventory.disableMcp` / `enableMcp`,
  `claudeInventory.disablePlugin` / `enablePlugin` / `resetPlugin`,
  `claudeInventory.openSource` (opens the item's file),
  `claudeInventory.openLatestTranscript`.
  After a toggle: run the writer, refresh, show the info message from 5.1
  (plugins: "Applies to new Claude Code sessions in this folder.").
  Errors → `showErrorMessage` with the error text; never crash.
- Status bar (left, priority 100): `$(pulse) Claude ≈65.6k`; tooltip lists the
  top 3 consumers and the count of unused-but-enabled items; click →
  `workbench.view.extension.claudeInventory`. Hidden when no folder.
- Refresh: on activation, on `claudeInventory.refresh`, and on file changes
  (debounced 800 ms) of: `~/.claude.json`, `~/.claude/settings.json`,
  `installed_plugins.json`, `<project>/.mcp.json`, `<project>/.claude/**`,
  the transcript dir. Use `vscode.workspace.createFileSystemWatcher` with
  `RelativePattern(Uri.file(dir), glob)` for out-of-workspace paths.
  All scanning is async and must not block the extension host for > 50 ms at a
  time on a home dir with ~100 skills and 30 days of transcripts.

## 8. Done criteria

1. `npm run typecheck`, `npm test`, `npm run build`, `npm run package` all pass.
2. `node dist/cli.js "D:\Projects\项目\VSCodePlugin"` against the real home
   prints: plugins incl. `vercel-plugin@vercel` enabled; MCP ids incl.
   `plugin:vercel:vercel`, `blender`, `drawio`, `claude.ai Gmail`; a
   measurement with `baselineTokens` > 50000 and `mcpTools` containing
   `plugin:vercel:vercel` with toolCount ≈ 246.
3. Installing the vsix and opening this folder shows the tree and status bar;
   disabling `drawio` writes `drawio` into this project's `disabledMcpServers`
   and re-enabling removes it.
