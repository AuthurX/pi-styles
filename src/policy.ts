import { existsSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import type { Style, TruncatePolicy } from "./types.ts";

// ---------- 会话内策略状态 ----------

export interface PolicyState {
  writeUnlocked: boolean;
  filesThisTurn: Set<string>;
}

export function createPolicyState(): PolicyState {
  return { writeUnlocked: false, filesThisTurn: new Set() };
}

export interface UICtx {
  hasUI: boolean;
  cwd: string;
  ui: { confirm(title: string, message: string): Promise<boolean> };
}

export interface BlockResult {
  block: true;
  reason: string;
}

export type PolicyResult = BlockResult | undefined;

async function confirmAction(ctx: UICtx, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI) return false;
  try {
    return await ctx.ui.confirm(title, message);
  } catch {
    return false;
  }
}

// ---------- glob ----------

/** 支持 `**`、`*`、`?` 的 glob → RegExp（行内锚定）。 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** 无 `/` 的 glob 按 basename 匹配（任意层级）；含 `/` 的按绝对路径 + cwd 相对路径匹配。 */
export function matchGlob(glob: string, filePath: string, cwd?: string): boolean {
  const re = globToRegExp(glob);
  const candidates: string[] = [filePath];
  if (!glob.includes("/")) {
    candidates.push(basename(filePath));
  } else if (cwd && isAbsolute(filePath)) {
    const rel = relative(cwd, filePath);
    if (rel && !rel.startsWith("..")) candidates.push(rel);
  }
  return candidates.some((c) => re.test(c));
}

function compilePatterns(patterns: string[]): { source: string; re: RegExp }[] {
  return patterns.map((p) => {
    try {
      return { source: p, re: new RegExp(p) };
    } catch {
      return { source: p, re: new RegExp("^$") };
    }
  });
}

// ---------- write / edit 拦截 ----------

export async function checkWrite(style: Style, state: PolicyState, ctx: UICtx, filePath: string): Promise<PolicyResult> {
  const p = style.policy;
  if (!p || !filePath) return undefined;
  const label = `风格 ${style.name}`;

  if (p.allow_write_globs?.length) {
    if (!p.allow_write_globs.some((g) => matchGlob(g, filePath, ctx.cwd))) {
      return {
        block: true,
        reason: `${label} 仅允许修改匹配 [${p.allow_write_globs.join(", ")}] 的路径，拒绝写入 ${filePath}`,
      };
    }
  }

  if (p.deny_write_globs?.length) {
    const hit = p.deny_write_globs.find((g) => matchGlob(g, filePath, ctx.cwd));
    if (hit) {
      return { block: true, reason: `${label} 禁止写入敏感路径（匹配 ${hit}）：${filePath}` };
    }
  }

  if (p.require_plan_confirm_before_write && !state.writeUnlocked) {
    const ok = await confirmAction(ctx, "风格策略提示", "当前为先图后写模式，确认模型已输出架构图并允许开始修改代码吗？");
    if (!ok) {
      return { block: true, reason: "请先输出清晰的设计/架构图并等待用户确认，暂不允许写入文件。" };
    }
    state.writeUnlocked = true;
  }

  if (p.confirm_overwrite_existing) {
    let exists = false;
    try {
      exists = existsSync(filePath);
    } catch {
      /* ignore */
    }
    if (exists) {
      const ok = await confirmAction(ctx, "覆盖确认", `${label}：目标文件已存在，确认覆盖 ${filePath} ？`);
      if (!ok) return { block: true, reason: `用户拒绝覆盖已有文件 ${filePath}` };
    }
  }

  if (p.max_files_per_turn && p.max_files_per_turn > 0 && !state.filesThisTurn.has(filePath)) {
    const wouldBe = state.filesThisTurn.size + 1;
    if (wouldBe > p.max_files_per_turn) {
      const ok = await confirmAction(
        ctx,
        "文件数量确认",
        `${label}：本轮已改动 ${state.filesThisTurn.size} 个文件，超过上限 ${p.max_files_per_turn}，确认继续修改 ${filePath} ？`,
      );
      if (!ok) {
        return { block: true, reason: `本轮改动文件数已达上限 ${p.max_files_per_turn}，请拆分任务或让用户确认继续。` };
      }
    }
    state.filesThisTurn.add(filePath);
  }

  return undefined;
}

// ---------- bash 拦截 ----------

export async function checkBash(style: Style, ctx: UICtx, command: string): Promise<PolicyResult> {
  const p = style.policy;
  if (!p || !command) return undefined;
  const label = `风格 ${style.name}`;

  if (p.deny_bash_patterns?.length) {
    const hit = compilePatterns(p.deny_bash_patterns).find((x) => x.re.test(command));
    if (hit) return { block: true, reason: `${label} 禁止执行匹配 [${hit.source}] 的命令` };
  }

  if (p.confirm_bash_patterns?.length) {
    const hit = compilePatterns(p.confirm_bash_patterns).find((x) => x.re.test(command));
    if (hit) {
      const ok = await confirmAction(
        ctx,
        "高危命令确认",
        `${label}：命令匹配护栏规则 [${hit.source}]，确认执行？\n\n${command}`,
      );
      if (!ok) return { block: true, reason: "用户拒绝执行匹配护栏规则的命令。" };
    }
  }

  return undefined;
}

// ---------- tool_result 瘦身 ----------

export function truncateToolText(text: string, opts: TruncatePolicy): { text: string; removedLines: number } {
  const lines = text.split("\n");
  if (lines.length <= opts.maxLines) return { text, removedLines: 0 };
  const keepHead = Math.min(opts.keepHead, opts.maxLines - 1);
  const keepTail = Math.min(opts.keepTail, Math.max(0, opts.maxLines - 1 - keepHead));
  const head = lines.slice(0, keepHead);
  const tail = keepTail > 0 ? lines.slice(lines.length - keepTail) : [];
  const removed = lines.length - keepHead - keepTail;
  const out = [...head, `[pi-styles truncated ${removed} lines]`, ...tail].join("\n");
  return { text: out, removedLines: removed };
}
