# Context Audit for Claude Code

See everything Claude Code loads into context for the project you have open, what each item costs in tokens, and switch off what you never use.

MCP servers, plugins, skills, agents, hooks and `CLAUDE.md` files all add tokens to every session. This view lists them with a measured cost and how often each was used in the last 30 days, so unused weight is easy to spot.

[中文说明](README.zh-CN.md) · [Issues](https://github.com/iakacer/Claude-Context-Audit/issues)

## What you see

Open the **Context Audit** icon in the activity bar. The status bar also shows `Claude ≈65.6k` (the starting context of your latest session).

- **Starting context**: tokens loaded at the start of the latest session, with the top 10 consumers.
- **MCP servers**, **Plugins** (with their skills, agents, commands, hooks, MCP), **Skills**, **Agents**, **Hooks**, **CLAUDE.md**.

Each row, left to right:

| Part | Meaning |
|---|---|
| Icon colour | green = enabled, grey circle = disabled, yellow warning = enabled but unused, yellow key = needs login |
| Description | `1.2k · 3×` = about 1.2k tokens, used 3 times in the window. `1.2k · unused` = no use. `off` = disabled |
| Badge | where it comes from: `U` user, `P` project, `L` local (this machine, this project), `PG` from a plugin, `C` claude.ai connector, `B` built in |

Disabled rows are greyed out. Hover a row for the full name, source file and details.

## Switching things off

- **This project only** (inline icon): MCP servers are added to the project's `disabledMcpServers` in `~/.claude.json`; plugins get an override in `<project>/.claude/settings.local.json`.
- **All projects** (right-click, "Disable in All Projects"): plugins are switched off in `~/.claude/settings.json`. User-level MCP servers move to `~/.claude/mcp-disabled-stash.json` and can be restored from the view. Plugin-provided MCP servers follow their plugin; claude.ai connectors are managed on claude.ai.

Changes apply to new Claude Code sessions. `~/.claude.json` is backed up once per session as `~/.claude.json.bak-context-inventory` before the first write.

## Limits

- Claude Code's config and transcript formats are not documented. This extension follows Claude Code 2.1.x behaviour and may need updates when formats change.
- Token numbers are estimates. The total comes from the latest session's first assistant record; the split per item is derived from that session's records. MCP tool schemas load on demand and are not counted in the starting context.
- Usage comes from local session transcripts, which Claude Code keeps for about 30 days.
- Everything stays on your machine. The extension reads files under `~/.claude*` and the open project and sends nothing anywhere.

## Settings

- `claudeInventory.usageWindowDays` (default 30): days of sessions to scan for usage.

Requires VS Code 1.90 or newer.
