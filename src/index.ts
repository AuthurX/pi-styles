import {
  CONFIG_DIR_NAME,
  getAgentDir,
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatStatus, getCostInfo } from "./cost.ts";
import {
  compressStyle,
  distillWithModel,
  extractSignals,
  findRecentSessions,
  loadBranch,
  saveStyle,
  type DistillOutput,
  type FrictionSignal,
  type SessionRef,
} from "./distiller.ts";
import { normalizeName, scanStyles } from "./loader.ts";
import { checkBash, checkWrite, createPolicyState, truncateToolText } from "./policy.ts";
import type { Style } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BUILTIN_STYLES_DIR = join(EXTENSION_DIR, "..", "styles");
const DEFAULT_PREAMBLE =
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";

export default function (pi: ExtensionAPI) {
  let activeStyle: Style | undefined;
  let originalTools: string[] | undefined;
  const state = createPolicyState();

  const rescan = (ctx: ExtensionContext) =>
    scanStyles({
      cwd: ctx.cwd,
      builtinStylesDir: BUILTIN_STYLES_DIR,
      configDirName: CONFIG_DIR_NAME,
      userStylesDir: join(getAgentDir(), "styles"),
      claudeUserStylesDir: join(homedir(), ".claude", "output-styles"),
    });

  function notify(ctx: ExtensionContext, msg: string, type: "info" | "warning" | "error" = "info") {
    try {
      ctx.ui.notify(msg, type);
    } catch {
      /* ignore */
    }
  }

  // ---------- 工具集切换（严禁在 before_agent_start 中调用） ----------

  function applyStyle(style: Style | undefined, ctx: ExtensionContext) {
    if (!originalTools) originalTools = pi.getActiveTools();
    if (!style) {
      pi.setActiveTools(originalTools);
    } else {
      const p = style.policy;
      let active: string[] = [...originalTools];
      if (p?.active_tools?.length) {
        const all = new Set(pi.getAllTools().map((t) => t.name));
        const whitelist = p.active_tools.filter((n) => all.has(n));
        active = [...new Set([...active.filter((n) => whitelist.includes(n)), ...whitelist])];
      }
      if (p?.disabled_tools?.length) {
        const disabled = p.disabled_tools;
        active = active.filter((n) => !disabled.includes(n));
      }
      pi.setActiveTools(active);
    }
    state.writeUnlocked = false;
    state.filesThisTurn = new Set();
    activeStyle = style;
    if (ctx.hasUI) ctx.ui.setStatus("pi-styles", style ? formatStatus(style) : undefined);
  }

  // ---------- 持久化 ----------

  function readPersistedStyle(ctx: ExtensionContext): string | null {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; customType?: string; data?: { name?: unknown } };
      if (e?.type === "custom" && e.customType === "pi-styles") {
        return typeof e.data?.name === "string" && e.data.name ? e.data.name : null;
      }
    }
    return null;
  }

  // ---------- 事件接线 ----------

  pi.on("session_start", (_event, ctx) => {
    originalTools = pi.getActiveTools();
    state.writeUnlocked = false;
    const { styles } = rescan(ctx);
    const persisted = readPersistedStyle(ctx);
    if (persisted) {
      const style = styles.find((s) => s.name === normalizeName(persisted));
      if (style) {
        applyStyle(style, ctx);
        notify(ctx, `已恢复输出风格 🎭 ${style.name}`, "info");
        return;
      }
    }
    applyStyle(undefined, ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (activeStyle) applyStyle(activeStyle, ctx);
  });

  pi.on("turn_start", () => {
    state.filesThisTurn = new Set();
  });

  // Prompt Cache 友好：同风格激活期间注入内容逐字节静态；
  // sections 增量补丁，不整体替换 system prompt。
  pi.on("before_agent_start", (event) => {
    const style = activeStyle;
    if (!style || !style.body) return undefined;
    if (style.keepCodingInstructions) {
      event.systemPromptOptions.sections["output_style"] = style.body;
      return undefined;
    }
    if (event.systemPrompt.includes(DEFAULT_PREAMBLE)) {
      // 精准替换默认编码指导段（preamble 为保留段名，无法经 sections 覆盖，改为返回替换后的 systemPrompt；内容静态则不反复触发 cache miss）
      return { systemPrompt: event.systemPrompt.replace(DEFAULT_PREAMBLE, style.body) };
    }
    // 未匹配到默认编码指导段（用户自定义 prompt）→ 精简覆盖指令
    event.systemPromptOptions.sections["output_style"] = `${style.body}\n\n(以上输出风格覆盖默认编码指导。)`;
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    const style = activeStyle;
    if (!style?.policy) return undefined;
    if (isToolCallEventType("write", event)) {
      return checkWrite(style, state, ctx, String(event.input.path ?? ""));
    }
    if (isToolCallEventType("edit", event)) {
      return checkWrite(style, state, ctx, String(event.input.path ?? ""));
    }
    if (isToolCallEventType("bash", event)) {
      return checkBash(style, ctx, String(event.input.command ?? ""));
    }
    if (isToolCallEventType("powershell", event)) {
      return checkBash(style, ctx, String((event.input as { command?: unknown }).command ?? ""));
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const t = activeStyle?.policy?.truncate_tool_output;
    if (!t) return undefined;
    let changed = false;
    const content = event.content.map((c) => {
      if (c.type !== "text") return c;
      const { text, removedLines } = truncateToolText(c.text, t);
      if (removedLines > 0) {
        changed = true;
        return { type: "text" as const, text };
      }
      return c;
    });
    return changed ? { content } : undefined;
  });

  // ---------- 命令 ----------

  function styleMenuLine(s: Style): string {
    const c = getCostInfo(s);
    const desc = s.description ? ` — ${s.description}` : "";
    return `${s.name} [${s.source}] ${c.policyBadge} +${c.promptTokens}tok${desc.slice(0, 80)}`;
  }

  async function cmdActivate(ctx: ExtensionCommandContext, rawName: string) {
    if (ctx.hasUI) ctx.ui.setWidget("pi-styles", undefined);
    const { styles } = rescan(ctx);
    const name = normalizeName(rawName);
    const style = styles.find((s) => s.name === name);
    if (!style) {
      notify(ctx, `找不到风格 "${rawName}"。可用: ${styles.map((s) => s.name).join(", ") || "(无)"}`, "error");
      return;
    }
    if (style.parseWarnings.length) {
      notify(ctx, `风格 ${style.name} 解析警告: ${style.parseWarnings.join("; ")}`, "warning");
    }
    const hasMessages = ctx.sessionManager.getEntries().some((e) => (e as { type?: string }).type === "message");
    if (hasMessages && ctx.hasUI) {
      notify(ctx, "已有会话中途切换风格：下一轮将重建 Prompt 前缀，可能触发 Prompt Cache 重建。", "warning");
    }
    applyStyle(style, ctx);
    pi.appendEntry("pi-styles", { name: style.name, at: Date.now() });
    const c = getCostInfo(style);
    notify(ctx, `已激活 🎭 ${style.name} (+${c.promptTokens} tok | ${c.verbosity} | ${c.policyBadge})`, "info");
  }

  function cmdOff(ctx: ExtensionCommandContext) {
    applyStyle(undefined, ctx);
    pi.appendEntry("pi-styles", { name: null, at: Date.now() });
    if (ctx.hasUI) ctx.ui.setWidget("pi-styles", undefined);
    notify(ctx, "已关闭输出风格，工具列表已还原。", "info");
  }

  async function cmdMenu(ctx: ExtensionCommandContext) {
    if (ctx.hasUI) ctx.ui.setWidget("pi-styles", undefined);
    const { styles } = rescan(ctx);
    if (!styles.length) {
      notify(ctx, "没有发现任何风格。", "info");
      return;
    }
    if (!ctx.hasUI) {
      for (const s of styles) notify(ctx, styleMenuLine(s), "info");
      return;
    }
    const labels = styles.map(styleMenuLine);
    const choice = await ctx.ui.select("选择输出风格", [...labels, "off (关闭)"]);
    if (!choice) return;
    if (choice.startsWith("off")) {
      cmdOff(ctx);
      return;
    }
    const idx = labels.indexOf(choice);
    if (idx >= 0) await cmdActivate(ctx, styles[idx].name);
  }

  async function cmdInspect(ctx: ExtensionCommandContext, rest: string[]) {
    const { styles, warnings } = rescan(ctx);
    const name = rest[0] ? normalizeName(rest[0]) : undefined;
    const targets = name ? styles.filter((s) => s.name === name) : styles;
    if (!targets.length) {
      notify(ctx, `找不到风格 ${rest[0] ?? ""}`, "error");
      return;
    }
    const lines: string[] = [];
    for (const s of targets) {
      const c = getCostInfo(s);
      lines.push(`🎭 ${s.name} [${s.source}] ${c.policyBadge}`);
      lines.push(`  文件: ${s.path}`);
      if (s.description) lines.push(`  简介: ${s.description}`);
      lines.push(`  成本: +${c.promptTokens} tok | verbosity: ${c.verbosity}`);
      if (s.policy) lines.push(`  策略: ${JSON.stringify(s.policy)}`);
      if (s.parseWarnings.length) lines.push(`  ⚠️ 解析警告: ${s.parseWarnings.join("; ")}`);
      lines.push(`  正文: ${s.body.slice(0, 120).replace(/\n/g, " ")}…`);
      lines.push("");
    }
    for (const w of warnings.slice(0, 5)) lines.push(`⚠️ ${w.path}: ${w.message}`);
    if (ctx.hasUI) {
      ctx.ui.setWidget("pi-styles", lines.slice(0, 30));
    } else {
      notify(ctx, lines.join("\n").slice(0, 2000), "info");
    }
  }

  function parseFlags(tokens: string[]): { limit: number; cwdFlag: boolean } {
    let limit = 20;
    let cwdFlag = false;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "--limit") limit = Math.max(1, parseInt(tokens[++i] ?? "20", 10) || 20);
      else if (tokens[i] === "--cwd") cwdFlag = true;
      else if (tokens[i] === "--global") cwdFlag = false;
    }
    return { limit, cwdFlag };
  }

  function collectSignals(sessions: SessionRef[]): FrictionSignal[] {
    const all: FrictionSignal[] = [];
    for (const s of sessions) {
      all.push(...extractSignals(loadBranch(s.file), s.file));
    }
    const seen = new Set<string>();
    const out: FrictionSignal[] = [];
    for (const sig of all) {
      const key = `${sig.kind}|${sig.toolName ?? ""}|${sig.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sig);
    }
    return out.slice(0, 60);
  }

  function requireModel(ctx: ExtensionCommandContext): boolean {
    if (!ctx.model) {
      notify(ctx, "当前没有可用模型，无法蒸馏。", "error");
      return false;
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
      notify(ctx, `模型 ${ctx.model.provider}/${ctx.model.id} 无可用凭据（API Key/OAuth），无法蒸馏。`, "error");
      return false;
    }
    return true;
  }

  async function cmdCreate(ctx: ExtensionCommandContext, rest: string[]) {
    if (ctx.hasUI) ctx.ui.setWidget("pi-styles", undefined);
    const { limit, cwdFlag } = parseFlags(rest);
    const agentDir = getAgentDir();
    const sessions = findRecentSessions(join(agentDir, "sessions"), limit);
    if (!sessions.length) {
      notify(ctx, "没有找到历史会话（~/.pi/agent/sessions）。", "error");
      return;
    }
    const signals = collectSignals(sessions);
    if (!signals.length) {
      notify(ctx, "历史会话中没有发现纠偏/工具摩擦信号，无法蒸馏。", "warning");
      return;
    }
    if (!requireModel(ctx)) return;
    notify(ctx, `已采样 ${sessions.length} 个会话、${signals.length} 条摩擦信号，后台蒸馏中…`, "info");
    let output: DistillOutput;
    try {
      output = await distillWithModel({
        model: ctx.model!,
        registry: ctx.modelRegistry,
        input: { signals, cwd: ctx.cwd },
        signal: ctx.signal,
      });
    } catch (e) {
      notify(ctx, `蒸馏失败: ${(e as Error).message}`, "error");
      return;
    }
    const style: Style = {
      name: output.name,
      source: cwdFlag ? "project" : "user",
      path: "",
      description: output.description,
      keepCodingInstructions: true,
      cost: output.cost,
      policy: output.policy,
      body: output.body,
      parseWarnings: [],
    };
    let cost = getCostInfo(style);
    const lines = [
      `推荐风格: ${output.name}`,
      `简介: ${output.description}`,
      `成本: +${cost.promptTokens} tok | ${cost.verbosity} | ${cost.policyBadge}`,
    ];
    if (output.policy) lines.push(`策略: ${JSON.stringify(output.policy)}`);
    lines.push("证据:");
    for (const ev of output.evidence) lines.push(`  [${ev.timestamp}] (${ev.kind}) ${ev.quote}`);

    if (cost.promptTokens > 400 && ctx.hasUI) {
      const wantCompress = await ctx.ui.confirm("风格较长", `正文约 ${cost.promptTokens} tokens（>400），是否让 LLM 压缩一版？`);
      if (wantCompress) {
        try {
          style.body = await compressStyle({ model: ctx.model!, registry: ctx.modelRegistry, body: style.body, signal: ctx.signal });
          cost = getCostInfo(style);
          lines[2] = `成本(压缩后): +${cost.promptTokens} tok | ${cost.verbosity} | ${cost.policyBadge}`;
        } catch (e) {
          notify(ctx, `压缩失败，使用原版本: ${(e as Error).message}`, "warning");
        }
      }
    }

    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm("确认保存新风格？", lines.join("\n"));
      if (!ok) {
        notify(ctx, "已取消保存。", "info");
        return;
      }
    }
    const dir = cwdFlag ? join(ctx.cwd, CONFIG_DIR_NAME, "styles") : join(agentDir, "styles");
    const path = saveStyle(style, dir, output.evidence);
    notify(ctx, `已保存新风格 → ${path}`, "info");
    if (ctx.hasUI) {
      const act = await ctx.ui.select("是否立刻激活？", [`激活 ${style.name}`, "暂不激活"]);
      if (act?.startsWith("激活")) await cmdActivate(ctx, style.name);
    }
  }

  async function cmdEnhance(ctx: ExtensionCommandContext, rest: string[]) {
    if (ctx.hasUI) ctx.ui.setWidget("pi-styles", undefined);
    const nameArg = rest[0];
    if (!nameArg) {
      notify(ctx, "用法: /style enhance <name> [--limit N]", "error");
      return;
    }
    const { limit } = parseFlags(rest.slice(1));
    const { styles } = rescan(ctx);
    const target = styles.find((s) => s.name === normalizeName(nameArg));
    if (!target) {
      notify(ctx, `找不到风格 "${nameArg}"。`, "error");
      return;
    }
    const agentDir = getAgentDir();
    const sessions = findRecentSessions(join(agentDir, "sessions"), limit);
    if (!sessions.length) {
      notify(ctx, "没有找到历史会话。", "error");
      return;
    }
    const signals = collectSignals(sessions);
    if (!signals.length) {
      notify(ctx, "没有摩擦信号，保持原风格不变。", "warning");
      return;
    }
    if (!requireModel(ctx)) return;
    notify(ctx, `正在为 ${target.name} 结合 ${signals.length} 条摩擦信号增强…`, "info");
    let output: DistillOutput;
    try {
      output = await distillWithModel({
        model: ctx.model!,
        registry: ctx.modelRegistry,
        signal: ctx.signal,
        input: {
          signals,
          cwd: ctx.cwd,
          existingStyle: { name: target.name, body: target.body, policy: target.policy, cost: target.cost },
        },
      });
    } catch (e) {
      notify(ctx, `增强失败: ${(e as Error).message}`, "error");
      return;
    }
    const enhanced: Style = {
      ...target,
      body: output.body,
      policy: output.policy,
      cost: output.cost,
      parseWarnings: [],
    };
    const cost = getCostInfo(enhanced);
    const lines = [`增强 ${target.name}:`, `成本: +${cost.promptTokens} tok | ${cost.verbosity} | ${cost.policyBadge}`];
    if (output.policy) lines.push(`策略: ${JSON.stringify(output.policy)}`);
    lines.push("证据:");
    for (const ev of output.evidence) lines.push(`  [${ev.timestamp}] (${ev.kind}) ${ev.quote}`);
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm("确认保存增强版风格？", lines.join("\n"));
      if (!ok) {
        notify(ctx, "已取消。", "info");
        return;
      }
    }
    const targetDir =
      target.source === "project" || target.source === "claude-project"
        ? join(ctx.cwd, CONFIG_DIR_NAME, "styles")
        : join(agentDir, "styles");
    const path = saveStyle(enhanced, targetDir, output.evidence);
    notify(ctx, `已保存增强版 → ${path}`, "info");
    if (ctx.hasUI) {
      const act = await ctx.ui.select("是否立刻激活增强版？", [`激活 ${enhanced.name}`, "暂不激活"]);
      if (act?.startsWith("激活")) await cmdActivate(ctx, enhanced.name);
    }
  }

  pi.registerCommand("style", {
    description:
      "输出风格：/style 菜单 | /style <name> 激活 | /style off | /style inspect [name] | /style create [--limit N] [--cwd] | /style enhance <name> [--limit N]",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];
      try {
        if (!sub) await cmdMenu(ctx);
        else if (sub === "off") cmdOff(ctx);
        else if (sub === "inspect") await cmdInspect(ctx, tokens.slice(1));
        else if (sub === "create") await cmdCreate(ctx, tokens.slice(1));
        else if (sub === "enhance") await cmdEnhance(ctx, tokens.slice(1));
        else await cmdActivate(ctx, sub);
      } catch (e) {
        notify(ctx, `pi-styles 错误: ${(e as Error).message}`, "error");
      }
    },
  });
}
