# pi-styles

Pi Coding Agent 的**输出风格 + 工具策略护栏 + 会话蒸馏闭环**扩展包。

一句话：兼容 Claude Code 存量输出风格 → 自动补齐成本标签 → 执行工具策略护栏并采集摩擦行为 → 从历史会话（对话纠偏 + 工具异常/打断）中蒸馏生成新风格或增强旧风格。

## 安装

```bash
pi install ./pi-styles          # 本地目录
# 或开发期快速试用：
pi -e ./pi-styles/src/index.ts
```

宿主依赖 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 声明在 `peerDependencies`（由 Pi 运行时提供，不重复安装、不破坏宿主 OAuth 封装）。

## 命令

| 命令 | 说明 |
|---|---|
| `/style` | 交互菜单：来源、策略徽章、成本标签、简介 |
| `/style <name>` | 激活风格（切换工具集 + 注入 prompt + 状态栏） |
| `/style off` | 关闭风格，完整还原原始工具列表 |
| `/style inspect [name]` | 查看风格详情（文件、策略、解析警告） |
| `/style create [--limit 20] [--cwd]` | 从最近 N 个历史会话蒸馏全新个性化风格 |
| `/style enhance <name> [--limit 20]` | 为任意已有纯文本风格（如导入的 Claude Code 风格）自动补充 policy 护栏 + cost 配置，另存为可执行 Pi 风格 |

状态栏：`🎭 <name> (+<N> tok | <verbosity> | <policyBadge>)`；无风格时清除。

## 风格文件规范（100% 兼容 Claude Code frontmatter + 扩展策略/成本）

```yaml
---
name: safety-first
description: 谨慎分析影响面，并在底层拦截高危命令与敏感文件写入
keep-coding-instructions: true
cost:
  verbosity: medium              # low | medium | high；省略时按正文关键词自动推断
policy:
  disabled_tools: []             # 黑名单隐藏工具（优先于 active_tools，不误伤 MCP/其他扩展工具）
  active_tools: []               # 可选显式白名单
  require_plan_confirm_before_write: false  # true：首次 write/edit 前弹窗确认，确认后本会话放开
  deny_write_globs: [".env*", "**/*secret*", "**/*.pem"]
  allow_write_globs: []          # 非空时只允许修改匹配路径
  confirm_bash_patterns: ["\\brm\\s+.*-[a-zA-Z]*r", "\\bgit\\s+push\\b.*(--force|-f)"]
  deny_bash_patterns: []
  confirm_overwrite_existing: false
  max_files_per_turn: 0          # >0 时单轮改动文件超限弹窗确认
  truncate_tool_output:
    max_lines: 120
    keep_head: 30
    keep_tail: 80
---
注入 System Prompt 的风格正文...
```

**YAML 容错**：社区存量 Claude Code 风格常见不带引号且含冒号的 `description`、多行块状文本、缺失 frontmatter。`src/loader.ts` 的容错解析器只按每行第一个冒号切分，解析失败单个文件只记录 warning（`/style inspect` 可见），绝不导致扩展崩溃。

## 三级作用域与热加载

优先级（高 → 低，按归一化 name 去重）：

```
项目  <cwd>/.pi/styles/*.md        > <cwd>/.claude/output-styles/*.md
用户  ~/.pi/agent/styles/*.md      > ~/.claude/output-styles/*.md
内置  <pkg>/styles/*.md
```

每次执行 `/style` 或 `session_start` 时重新扫描目录——编辑器里改完 `.md` 无需重启 Pi。

## 从 Claude Code 存量风格导入

1. 把 Claude Code 的 output styles（`~/.claude/output-styles/*.md` 或别处收集的 `.md`）直接放进
   `~/.claude/output-styles/` 或 `~/.pi/agent/styles/`，pi-styles 自动发现（来源标记 `claude-user` / `claude-project`）。
2. `/style inspect` 查看解析结果与成本标签（自动计算 `promptTokens` + verbosity 推断 + `💬 纯文本(Claude兼容)` 徽章）。
3. `/style enhance <name>` 一键为它补齐 policy 护栏与 cost 配置（基于你近期会话摩擦数据，后台 LLM 生成，证据确认后备份为可执行 Pi 风格）。

## 蒸馏闭环（/style create 与 /style enhance）

- **双通道数据采样**：按 `id/parentId` 回溯每个 JSONL 会话的当前主分支（废弃分支自动排除），提取
  ① 文本通道：用户纠偏/打断、长度抱怨、语气抱怨；
  ② 工具摩擦通道：tool_call 后紧跟用户否定/报错修复、`isError` 工具结果、超长工具输出（上下文膨胀信号）。
- **独立后台 LLM 调用**：用当前 `ctx.model` + `ctx.modelRegistry.complete()` 发起，不污染当前会话；
  仅当没有可用模型/无凭据时才报错降级，平时不做正则假蒸馏。
- **成本预警 + 证据确认 + 一键落盘**：生成后先展示 promptTokens、输出倾向、推荐 policy 与 3~6 条带时间戳的用户原话证据；
  超过 400 tokens 主动询问是否压缩一版；确认后写入 `<!-- Evidence from sessions: ... -->` 注释，
  刷新风格列表并询问是否立刻激活。

## 运行时机制（Pi 坑点规避）

- **`setActiveTools` 绝不在 `before_agent_start` 中调用**（Pi Issue #9932）：工具集切换只在 `/style` 命令、`session_start`、`session_tree` 中同步完成；首次启用带工具限制的风格前快照原始工具集，`/style off` 时完整还原。
- **Prompt Cache 友好**：`before_agent_start` 通过 `systemPromptOptions.sections["output_style"]` 注入（Pi 按 section diff 增量补丁），同风格激活期间逐字节静态；`keep-coding-instructions: false` 时精准替换默认编码指导段（`preamble`），未匹配到默认段才回退为精简覆盖指令。已有消息的会话中途切换风格会用 `ctx.ui.notify` 提示可能触发 Prompt Cache 重建。
- **策略执行**：`require_plan_confirm_before_write`、glob 白/黑名单、覆盖确认、单轮文件数上限、bash 确认/禁止正则全部在 `tool_call` 中拦截；非交互模式（`!ctx.hasUI`）下 confirm 安全降级为 `{ block: true }`。
- **tool_result 瘦身**：`truncate_tool_output` 超行裁剪并附 `[pi-styles truncated X lines]` 标记。
- **会话持久化**：激活/关闭状态经 `pi.appendEntry("pi-styles", ...)` 写入会话，resume 后自动恢复。

## 内置 8 风格

| 风格 | 特性 |
|---|---|
| `caveman` | 极简电报体 + `truncate_tool_output` |
| `ponytail` | 反过度设计 + `max_files_per_turn: 4` |
| `diagrams-first` | 先画图再写代码 + `require_plan_confirm_before_write` |
| `teaching` | 分步教学 + `disabled_tools: [write, edit]` |
| `exec-brief` | 结论先行简报 |
| `pair-programmer` | 结对小步推进 + `confirm_overwrite_existing` |
| `safety-first` | 高危命令确认 + 禁写 `.env*`/密钥 |
| `chinese-tech-doc` | 中文技术文档 + `allow_write_globs` 只限 markdown |

## 开发

```bash
npm install        # 安装 dev 依赖（含宿主包类型）
npm test           # vitest 单元测试
npm run typecheck  # tsc --noEmit
```
