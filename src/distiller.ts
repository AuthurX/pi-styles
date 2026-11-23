import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { extractPolicy, normalizeName } from "./loader.ts";
import type { EvidenceItem, Style, StyleCost, StylePolicy } from "./types.ts";

// ---------- JSONL 会话主分支回溯 ----------

export interface BranchEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  message?: {
    role: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    [k: string]: unknown;
  };
}

/** 解析会话 JSONL，按 id/parentId 从叶子（文件最后一行）回溯到根，返回时间序主分支。 */
export function loadBranch(file: string): BranchEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, BranchEntry>();
  let leaf: BranchEntry | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === "session" || !o?.id) continue;
    byId.set(o.id, o as BranchEntry);
    leaf = o as BranchEntry;
  }
  const path: BranchEntry[] = [];
  let cur: BranchEntry | undefined = leaf;
  let guard = 0;
  while (cur && guard++ < 100000) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

export interface SessionRef {
  file: string;
  mtimeMs: number;
  cwdHint: string;
}

export function findRecentSessions(sessionsDir: string, limit: number): SessionRef[] {
  const out: SessionRef[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (e.endsWith(".jsonl")) {
        out.push({
          file: full,
          mtimeMs: st.mtimeMs,
          cwdHint: "/" + basename(dir).replace(/^--/, "").replace(/--$/, "").replace(/-/g, "/"),
        });
      }
    }
  };
  walk(sessionsDir);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

// ---------- 摩擦信号提取 ----------

export interface FrictionSignal {
  kind: "correction" | "tool_error" | "long_output" | "length_complaint" | "tone_complaint";
  toolName?: string;
  quote: string;
  timestamp: string;
  sessionFile: string;
}

const CORRECTION_RE =
  /(不对|不是这|错了|应该是|重新(来|写|做)|别(再|用)|不要(再|用|改)|为什么又|no,|wrong|not what|should be|actually,|i meant|stop doing|keep (changing|going))/i;
const LENGTH_RE = /(太长|太啰嗦|啰嗦|简短|简洁(一点|些|点)|精简|too long|verbose|shorter|concise|brevity|tl;?dr)/i;
const TONE_RE = /(语气|太正式|太随意|太客气|tone|too formal|too casual|too polite)/i;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function userText(e: BranchEntry): string {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n");
  return "";
}

function toolCallsOf(e: BranchEntry): string[] {
  const c = e.message?.content;
  if (!Array.isArray(c)) return [];
  return c
    .filter((b: any) => b?.type === "toolCall" && typeof b.name === "string")
    .map((b: any) => b.name as string);
}

function resultText(e: BranchEntry): string {
  const c = e.message?.content;
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n");
  return "";
}

/**
 * 双通道采样：
 * 1) 文本通道：用户纠偏/否定、长度抱怨、语气抱怨
 * 2) 工具摩擦：tool_call 后紧跟用户打断/否定、toolResult 报错、超长输出
 */
export function extractSignals(branch: BranchEntry[], sessionFile: string): FrictionSignal[] {
  const signals: FrictionSignal[] = [];

  for (let i = 0; i < branch.length; i++) {
    const e = branch[i];
    if (e.type !== "message" || !e.message) continue;
    const role = e.message.role;

    if (role === "assistant") {
      continue;
    }

    if (role === "toolResult") {
      const text = resultText(e);
      const toolName = e.message.toolName;
      if (e.message.isError) {
        signals.push({
          kind: "tool_error",
          toolName,
          quote: clip(text, 200) || "(工具报错，无文本)",
          timestamp: e.timestamp,
          sessionFile,
        });
      } else if (text.length > 8000) {
        signals.push({
          kind: "long_output",
          toolName,
          quote: `工具 ${toolName ?? "?"} 返回约 ${Math.round(text.length / 1000)}k 字符超长输出，上下文膨胀`,
          timestamp: e.timestamp,
          sessionFile,
        });
      }
      continue;
    }

    if (role === "user") {
      const text = userText(e).trim();
      if (!text) continue;
      const isCorrection = CORRECTION_RE.test(text);
      const isLength = LENGTH_RE.test(text);
      const isTone = TONE_RE.test(text);
      if (!isCorrection && !isLength && !isTone) continue;

      if (isCorrection) {
        // 工具摩擦：回溯经过 toolResult 链，若紧邻的 assistant 带工具调用则归因到该批次
        let j = i - 1;
        let attributed = false;
        while (j >= 0) {
          const prev = branch[j];
          if (prev.type !== "message" || !prev.message) break;
          if (prev.message.role === "toolResult") {
            j--;
            continue;
          }
          if (prev.message.role === "assistant") {
            const calls = toolCallsOf(prev);
            if (calls.length > 0) {
              for (const name of calls.slice(0, 3)) {
                signals.push({ kind: "correction", toolName: name, quote: clip(text, 200), timestamp: e.timestamp, sessionFile });
              }
              attributed = true;
            }
          }
          break;
        }
        if (!attributed) {
          signals.push({ kind: "correction", quote: clip(text, 200), timestamp: e.timestamp, sessionFile });
        }
      }
      if (isLength) signals.push({ kind: "length_complaint", quote: clip(text, 200), timestamp: e.timestamp, sessionFile });
      if (isTone) signals.push({ kind: "tone_complaint", quote: clip(text, 200), timestamp: e.timestamp, sessionFile });
    }
  }
  return signals;
}

// ---------- 后台 LLM 蒸馏 ----------

export interface DistillInput {
  signals: FrictionSignal[];
  existingStyle?: { name: string; body: string; policy?: StylePolicy; cost?: StyleCost };
  cwd?: string;
}

export interface DistillOutput {
  name: string;
  description: string;
  body: string;
  policy?: StylePolicy;
  cost?: StyleCost;
  evidence: EvidenceItem[];
}

const DISTILL_SYSTEM = `你是"风格蒸馏器"。根据用户历史会话中的纠偏与工具摩擦证据，生成一个可执行的结构化输出风格。
只输出一个 JSON 对象（不要 markdown 代码块、不要任何多余文字），字段：
{
  "name": "kebab-case 风格名（3-5 个英文单词）",
  "description": "一句话中文描述",
  "body": "风格正文（中文 markdown，200-400 tokens，写给模型的第二人称行为规则）",
  "policy": { "可选": "工具策略，字段: disabled_tools, active_tools, require_plan_confirm_before_write, deny_write_globs, allow_write_globs, confirm_bash_patterns, deny_bash_patterns, confirm_overwrite_existing, max_files_per_turn, truncate_tool_output: {max_lines, keep_head, keep_tail}" },
  "cost": { "verbosity": "low|medium|high" },
  "evidence": [ { "timestamp": "...", "quote": "用户原话摘录", "kind": "信号类型" } 3-6 条 ]
}
要求：
- policy 必须直接针对证据中的摩擦（用户抱怨太长 → verbosity low 或 truncate_tool_output；工具频繁报错 → 加护栏；单轮改文件过多 → max_files_per_turn；无对应摩擦则省略 policy）。
- evidence 必须从给定证据中真实摘录，严禁编造时间戳或原话。
- body 是直接给模型的指令，不要解释风格本身。`;

const ENHANCE_SYSTEM = `你是"风格增强器"。给定一个已有的纯文本风格正文和用户的会话摩擦证据，为该风格补充最匹配的 policy 护栏与 cost 配置，并可轻微润色正文（必须保持原风格的身份、语气与核心规则不变）。
只输出一个 JSON 对象（不要 markdown 代码块、不要任何多余文字），字段：
{
  "body": "增强后的风格正文（保持原风格核心）",
  "policy": { "工具策略": "字段同: disabled_tools, active_tools, require_plan_confirm_before_write, deny_write_globs, allow_write_globs, confirm_bash_patterns, deny_bash_patterns, confirm_overwrite_existing, max_files_per_turn, truncate_tool_output" },
  "cost": { "verbosity": "low|medium|high" },
  "evidence": [ { "timestamp": "...", "quote": "用户原话摘录", "kind": "信号类型" } 3-6 条 ]
}
要求：policy 必须直接针对证据中的摩擦；evidence 必须真实摘录，严禁编造；若摩擦证据与现有风格无冲突，policy 从简。`;

function buildUserPrompt(input: DistillInput): string {
  const lines: string[] = [];
  if (input.cwd) lines.push(`工作目录: ${input.cwd}`);
  if (input.existingStyle) {
    lines.push(`现有风格名: ${input.existingStyle.name}`);
    if (input.existingStyle.policy) lines.push(`现有策略: ${JSON.stringify(input.existingStyle.policy)}`);
    lines.push(`现有风格正文:\n${input.existingStyle.body.slice(0, 6000)}`);
  }
  lines.push("", `会话摩擦证据（共 ${input.signals.length} 条，按时间排序）:`);
  for (const s of input.signals) {
    const tool = s.toolName ? ` [tool: ${s.toolName}]` : "";
    lines.push(`- [${s.timestamp}]${tool} (${s.kind}) ${s.quote}`);
  }
  return lines.join("\n");
}

/** 从模型回复中提取 JSON（容忍代码块包裹与前后缀文字）。 */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizeEvidence(v: unknown): EvidenceItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e: any) => e && typeof e === "object" && typeof e.quote === "string")
    .map((e: any) => ({ timestamp: String(e.timestamp ?? ""), quote: e.quote, kind: String(e.kind ?? "") }))
    .slice(0, 6);
}

export function parseDistillOutput(text: string, input: DistillInput): DistillOutput {
  const json = extractJson(text);
  if (!json || typeof json !== "object") throw new Error("模型输出无法解析为 JSON");
  const j = json as Record<string, any>;
  const body = typeof j.body === "string" ? j.body.trim() : "";
  if (!body) throw new Error("模型输出缺少 body 字段");
  const cost =
    j.cost && typeof j.cost === "object" && ["low", "medium", "high"].includes(j.cost.verbosity as string)
      ? { verbosity: j.cost.verbosity }
      : undefined;
  return {
    name: normalizeName(typeof j.name === "string" && j.name ? j.name : input.existingStyle?.name ?? "distilled-style"),
    description: typeof j.description === "string" ? j.description : "",
    body,
    policy: j.policy && typeof j.policy === "object" && !Array.isArray(j.policy) ? extractPolicy(j.policy) : undefined,
    cost,
    evidence: sanitizeEvidence(j.evidence),
  };
}

/** 独立后台 LLM 调用（不污染当前会话）。无可用凭据时抛错，不做正则假蒸馏。 */
export async function distillWithModel(opts: {
  model: Model<any>;
  registry: ModelRegistry;
  input: DistillInput;
  signal?: AbortSignal;
}): Promise<DistillOutput> {
  const { model, registry, input, signal } = opts;
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(`模型 ${model.provider}/${model.id} 没有可用凭据（API Key/OAuth），无法蒸馏`);
  }
  const context: Context = {
    systemPrompt: input.existingStyle ? ENHANCE_SYSTEM : DISTILL_SYSTEM,
    messages: [{ role: "user", content: buildUserPrompt(input), timestamp: Date.now() }],
  };
  const res: AssistantMessage = await registry.complete(model, context, { temperature: 0.2, maxTokens: 4096, signal });
  if (res.errorMessage) throw new Error(`蒸馏模型调用失败: ${res.errorMessage}`);
  const text = res.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
  return parseDistillOutput(text, input);
}

/** 压缩风格正文（独立后台调用）。 */
export async function compressStyle(opts: {
  model: Model<any>;
  registry: ModelRegistry;
  body: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { model, registry, body, signal } = opts;
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(`模型 ${model.provider}/${model.id} 没有可用凭据`);
  }
  const res: AssistantMessage = await registry.complete(
    model,
    {
      systemPrompt: "你是提示词压缩器。把用户的风格正文压缩到 350 tokens 以内，保留全部核心规则，只输出压缩后的正文（不要 JSON、不要代码块、不要解释）。",
      messages: [{ role: "user", content: body, timestamp: Date.now() }],
    },
    { temperature: 0.2, maxTokens: 2048, signal },
  );
  if (res.errorMessage) throw new Error(`压缩模型调用失败: ${res.errorMessage}`);
  const text = res.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n")
    .trim();
  if (!text) throw new Error("压缩结果为空");
  return text;
}

// ---------- 落盘 ----------

function yamlValue(v: string): string {
  if (v && /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .-]*$/.test(v) && !/^\d+$/.test(v)) return v;
  return JSON.stringify(v);
}

function inlineArray(items: string[]): string {
  return `[${items.map(yamlValue).join(", ")}]`;
}

function policyToYaml(policy: StylePolicy, indent: string): string[] {
  const lines: string[] = [];
  if (policy.disabled_tools?.length) lines.push(`${indent}disabled_tools: ${inlineArray(policy.disabled_tools)}`);
  if (policy.active_tools?.length) lines.push(`${indent}active_tools: ${inlineArray(policy.active_tools)}`);
  if (policy.require_plan_confirm_before_write !== undefined) {
    lines.push(`${indent}require_plan_confirm_before_write: ${policy.require_plan_confirm_before_write}`);
  }
  if (policy.deny_write_globs?.length) lines.push(`${indent}deny_write_globs: ${inlineArray(policy.deny_write_globs)}`);
  if (policy.allow_write_globs?.length) lines.push(`${indent}allow_write_globs: ${inlineArray(policy.allow_write_globs)}`);
  if (policy.confirm_bash_patterns?.length) lines.push(`${indent}confirm_bash_patterns: ${inlineArray(policy.confirm_bash_patterns)}`);
  if (policy.deny_bash_patterns?.length) lines.push(`${indent}deny_bash_patterns: ${inlineArray(policy.deny_bash_patterns)}`);
  if (policy.confirm_overwrite_existing !== undefined) {
    lines.push(`${indent}confirm_overwrite_existing: ${policy.confirm_overwrite_existing}`);
  }
  if (policy.max_files_per_turn !== undefined) lines.push(`${indent}max_files_per_turn: ${policy.max_files_per_turn}`);
  if (policy.truncate_tool_output) {
    const t = policy.truncate_tool_output;
    lines.push(`${indent}truncate_tool_output:`);
    lines.push(`${indent}  max_lines: ${t.maxLines}`);
    lines.push(`${indent}  keep_head: ${t.keepHead}`);
    lines.push(`${indent}  keep_tail: ${t.keepTail}`);
  }
  return lines;
}

export function styleToMarkdown(opts: {
  name: string;
  description: string;
  body: string;
  policy?: StylePolicy;
  cost?: StyleCost;
  keepCodingInstructions?: boolean;
  evidence?: EvidenceItem[];
}): string {
  const { name, description, body, policy, cost, keepCodingInstructions = true, evidence } = opts;
  const fm: string[] = ["---", `name: ${yamlValue(name)}`];
  if (description) fm.push(`description: ${yamlValue(description)}`);
  if (!keepCodingInstructions) fm.push("keep-coding-instructions: false");
  if (cost?.verbosity) {
    fm.push("cost:", `  verbosity: ${cost.verbosity}`);
  }
  if (policy) {
    fm.push("policy:");
    fm.push(...policyToYaml(policy, "  "));
  }
  fm.push("---", "");
  let out = fm.join("\n") + body.trim() + "\n";
  if (evidence && evidence.length) {
    out += `\n<!-- Evidence from sessions:\n${evidence.map((e) => `- [${e.timestamp}] (${e.kind}) ${e.quote}`).join("\n")}\n-->`;
  }
  return out;
}

export function saveStyle(style: Style, targetDir: string, evidence?: EvidenceItem[]): string {
  mkdirSync(targetDir, { recursive: true });
  let path = join(targetDir, `${style.name}.md`);
  // 同目录同名冲突（增强场景）时另存为 -enhanced[-N]，避免覆盖原文件
  if (existsSync(path) && resolve(style.path) !== resolve(path)) {
    let n = 1;
    while (existsSync(join(targetDir, `${style.name}-enhanced${n > 1 ? `-${n}` : ""}.md`))) n++;
    path = join(targetDir, `${style.name}-enhanced${n > 1 ? `-${n}` : ""}.md`);
  }
  writeFileSync(
    path,
    styleToMarkdown({
      name: style.name,
      description: style.description,
      body: style.body,
      policy: style.policy,
      cost: style.cost,
      keepCodingInstructions: style.keepCodingInstructions,
      evidence,
    }),
    "utf8",
  );
  return path;
}
