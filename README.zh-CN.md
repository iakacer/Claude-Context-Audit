# Context Audit for Claude Code

这个 VS Code 扩展显示当前工作区里 Claude Code 会加载进上下文的全部内容：MCP 服务器、插件、技能、agent、hook 和 CLAUDE.md。每一项都给出令牌开销和最近的使用情况。你可以只针对这个项目关掉不用的 MCP 服务器和插件。

## 能看到什么

侧边栏的 Context Audit 视图按下面的分组显示。状态栏左侧显示 `$(pulse) Claude ≈65.6k`，点击打开这个视图。

- `Starting context ≈ 65.6k tokens`：最近一次会话开始时加载的上下文总量。展开后是占用最多的 10 项，加上 `Other (system prompt, built-in tools)`（系统提示、内置工具 schema 等无法归到具体条目的部分）。这个文件夹还没有带 assistant 记录的会话时，显示 `No Claude Code session in this folder yet`。
- `MCP servers (A active / T total)`：用户级、项目级（含本地）、插件和 claude.ai 的 MCP 服务器。
- `Plugins (A enabled / T installed)`：展开后分 Skills、Agents、Commands、Hooks、MCP 五组。
- `Skills`、`Agents`：独立于插件的用户级和项目级条目。
- `Hooks`：来自 settings 文件的 hook。
- `CLAUDE.md`：会被加载的说明文件。

条目右侧的说明：

- `≈1.2k tok`：令牌数的估算值。1000 以下原样显示，否则保留一位小数加 `k`。没有会话数据时，MCP 服务器显示 `? tok`，因为它的静态开销无法确定。
- `3× in 30d`：最近 30 天里使用了 3 次。窗口天数可以在设置 `claudeInventory.usageWindowDays` 里改。
- `unused 30d`：最近 30 天 0 次使用，并且窗口内至少有 3 次会话（样本太少时不标记）。
- `disabled here`：已经在这个项目里关掉。

带 `≈` 的数字是估算。`Starting context` 的总量来自最近一次会话第一条 assistant 记录的 usage，各条目的拆分数按这次会话的记录估算。技能和 agent 始终显示按名称和描述算出的静态估算；CLAUDE.md 在会话记录里有对应条目时显示会话中注入内容的估算值，否则显示文件本身的估算值。

## 怎么关掉不用的东西

MCP 服务器：用条目上的内联图标或右键菜单禁用、启用。扩展会改写 `~/.claude.json` 中这个文件夹对应项目的 `disabledMcpServers`，只影响这个文件夹。第一次写入前会把原文件备份为 `~/.claude.json.bak-context-inventory`（每次扩展会话只备份一次）。同一个文件夹可能对应多个项目 key，写入时全部更新；没有对应 key 时会新建一个。

插件：在插件条目上禁用或启用，扩展写入 `<项目>/.claude/settings.local.json` 的 `enabledPlugins`。选 Reset 会删掉这条覆盖，回到继承来的状态。

改动对新开的 Claude Code 会话生效。正在运行的会话可能在退出时重写 `~/.claude.json`，覆盖掉 MCP 的改动；如果改了没生效，关掉那个会话再切换一次。

## 限制

- Claude Code 的这些文件格式没有公开文档。实现按 Claude Code 2.1.319 的行为编写，升级后格式变化可能导致某些条目缺失或数字不准。
- `claude.ai` 连接器列出的是曾经连接过的（`claudeAiMcpEverConnected`），不一定现在还在使用。
- MCP 工具的 token 数只计算工具名列表的开销。工具 schema 按需加载，不计入起始上下文。

## 安装

```powershell
code --install-extension claude-context-audit.vsix
```

需要 VS Code 1.90 或更新版本。

## 开发

```powershell
npm install
npm run build        # 打包 dist/extension.js 和 dist/cli.js
npm run watch        # 监听源码改动
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run package      # 生成 claude-context-audit.vsix
```

调试用 CLI 打印 inventory、measurement 和 usage 的 JSON：

```powershell
node dist/cli.js "D:\Projects\项目\VSCodePlugin" --days 30
```

## 更新（0.2.0）

- 每行：彩色状态图标、右侧来源徽章（U 用户、P 项目、L 本地、PG 插件、C claude.ai、B 内置）、紧凑说明（`1.2k · 3×`、`1.2k · unused`、`off`）。
- 右键菜单新增 "Disable in All Projects"：插件写入 `~/.claude/settings.json`；用户级 MCP 的配置移到 `~/.claude/mcp-disabled-stash.json`，可在视图里恢复。
