import type { Style, StyleCostInfo, Verbosity } from "./types.ts";

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/** 稳定 token 估算：CJK 约 1 token/字，其他约 4 字符/token。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0)!)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

const LOW_KEYWORDS = [
  "简洁", "简短", "精简", "极简", "电报", "少说", "一句话", "简短点", "tl;dr",
  "concise", "brief", "terse", "minimal", "short", "laconic",
];
const HIGH_KEYWORDS = [
  "详细", "详尽", "逐步", "分步", "教学", "解释", "为什么",
  "verbose", "detailed", "explain", "step by step", "teach", "thorough", "comprehensive",
];

/** verbosity 自动推断（正文关键词启发式）。 */
export function inferVerbosity(body: string): Verbosity {
  const lower = body.toLowerCase();
  let low = 0;
  let high = 0;
  for (const k of LOW_KEYWORDS) if (lower.includes(k)) low++;
  for (const k of HIGH_KEYWORDS) if (lower.includes(k)) high++;
  if (low > high) return "low";
  if (high > low) return "high";
  return "medium";
}

export function policyBadge(style: Style): string {
  const p = style.policy;
  if (!p) return "💬 纯文本(Claude兼容)";
  const badges: string[] = [];
  const disabled = p.disabled_tools ?? [];
  if (disabled.includes("write") && disabled.includes("edit")) badges.push("🔒 只读");
  else if (disabled.length > 0) badges.push(`🚫 ${disabled.length}工具`);
  if (p.deny_bash_patterns?.length || p.confirm_bash_patterns?.length || p.deny_write_globs?.length) {
    badges.push("🛡️ 护栏");
  }
  if (p.truncate_tool_output) badges.push("✂️ 截断");
  return badges.length ? badges.join(" ") : "💬 纯文本";
}

export function getCostInfo(style: Style): StyleCostInfo {
  return {
    promptTokens: estimateTokens(style.body),
    verbosity: style.cost?.verbosity ?? inferVerbosity(style.body),
    policyBadge: policyBadge(style),
  };
}

export function formatStatus(style: Style): string {
  const c = getCostInfo(style);
  return `🎭 ${style.name} (+${c.promptTokens} tok | ${c.verbosity} | ${c.policyBadge})`;
}
