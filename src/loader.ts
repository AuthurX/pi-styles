import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Style, StyleCost, StylePolicy, StyleSource, TruncatePolicy, Verbosity } from "./types.ts";

// ---------- 容错 YAML 解析 ----------

export interface LenientYamlResult {
  data: Record<string, unknown>;
  warnings: string[];
}

interface Frame {
  indent: number;
  container: Record<string, unknown> | unknown[];
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function unescapeDouble(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && (s[i + 1] === "\\" || s[i + 1] === '"')) {
      out += s[i + 1];
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return unescapeDouble(s.slice(1, -1));
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  const hash = s.search(/\s#/);
  const stripped = hash >= 0 ? s.slice(0, hash).trim() : s;
  if (stripped === "") return null;
  if (stripped.startsWith("[") && stripped.endsWith("]")) {
    const inner = stripped.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(parseScalar);
  }
  if (stripped === "true") return true;
  if (stripped === "false") return false;
  if (stripped === "null" || stripped === "~") return null;
  if (/^-?\d+$/.test(stripped)) return parseInt(stripped, 10);
  if (/^-?\d+\.\d+$/.test(stripped)) return parseFloat(stripped);
  return stripped;
}

/**
 * 容错 YAML 子集解析：
 * - 只按每行第一个冒号切分 key-value（值里可含冒号）
 * - 支持缩进嵌套对象、块状数组（- item）、内联数组（[a, b]）
 * - 支持双/单引号、布尔、数字、块状标量（| 和 >）
 * - 坏行只记录 warning，绝不抛异常
 */
export function parseLenientYaml(text: string): LenientYamlResult {
  const warnings: string[] = [];
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, container: root }];
  const lines = text.split(/\r?\n/);

  const nextContentLine = (from: number): { line: string } | null => {
    for (let i = from + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith("#")) continue;
      return { line: t };
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (trimmed.startsWith("- ") || trimmed === "-") {
      const top = stack[stack.length - 1];
      if (Array.isArray(top.container)) {
        top.container.push(trimmed === "-" ? null : parseScalar(trimmed.slice(2)));
      } else {
        warnings.push(`line ${i + 1}: 游离的数组项已忽略: ${trimmed.slice(0, 40)}`);
      }
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      warnings.push(`line ${i + 1}: 缺少冒号，已忽略: ${trimmed.slice(0, 40)}`);
      continue;
    }
    const keyRaw = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    const key = keyRaw.length >= 2 && keyRaw.startsWith('"') && keyRaw.endsWith('"') ? keyRaw.slice(1, -1) : keyRaw;
    if (!key) {
      warnings.push(`line ${i + 1}: 空 key 已忽略`);
      continue;
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const frame = stack[stack.length - 1];
    if (Array.isArray(frame.container)) {
      warnings.push(`line ${i + 1}: 数组内的 key 已忽略: ${key}`);
      continue;
    }

    if (/^[|>][+-]?$/.test(rest)) {
      const fold = rest[0] === ">";
      const block: string[] = [];
      let j = i + 1;
      let blockIndent: number | null = null;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) {
          block.push("");
          continue;
        }
        const ind = l.length - l.trimStart().length;
        if (ind <= indent) break;
        if (blockIndent === null) blockIndent = ind;
        block.push(l.slice(blockIndent));
      }
      while (block.length && block[block.length - 1] === "") block.pop();
      frame.container[key] = fold ? block.join(" ").trim() : block.join("\n");
      i = j - 1;
      continue;
    }

    if (rest !== "") {
      frame.container[key] = parseScalar(rest);
      continue;
    }

    const next = nextContentLine(i);
    if (next && (next.line.startsWith("- ") || next.line === "-")) {
      const arr: unknown[] = [];
      frame.container[key] = arr;
      stack.push({ indent, container: arr });
    } else {
      const obj: Record<string, unknown> = {};
      frame.container[key] = obj;
      stack.push({ indent, container: obj });
    }
  }

  return { data: root, warnings };
}

// ---------- 风格文件 ----------

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export function splitFrontmatter(text: string): { fm: string | null; body: string; warning?: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { fm: null, body: text, warning: "缺少 frontmatter，使用文件名作为风格名" };
  }
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      return { fm: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n").replace(/^\s*\n/, "") };
    }
  }
  return { fm: null, body: text, warning: "frontmatter 未闭合，整个文件按正文处理" };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined;
}
function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => (typeof x === "string" ? x : typeof x === "number" ? String(x) : ""))
    .filter((x) => x.length > 0);
  return out.length ? out : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asVerbosity(v: unknown): Verbosity | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}

export function extractPolicy(raw: unknown): StylePolicy | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const policy: StylePolicy = {};
  policy.disabled_tools = asStringArray(o.disabled_tools);
  policy.active_tools = asStringArray(o.active_tools);
  if (o.require_plan_confirm_before_write !== undefined) {
    policy.require_plan_confirm_before_write = asBool(o.require_plan_confirm_before_write, false);
  }
  policy.deny_write_globs = asStringArray(o.deny_write_globs);
  policy.allow_write_globs = asStringArray(o.allow_write_globs);
  policy.confirm_bash_patterns = asStringArray(o.confirm_bash_patterns);
  policy.deny_bash_patterns = asStringArray(o.deny_bash_patterns);
  if (o.confirm_overwrite_existing !== undefined) {
    policy.confirm_overwrite_existing = asBool(o.confirm_overwrite_existing, false);
  }
  const mft = asNumber(o.max_files_per_turn);
  if (mft !== undefined) policy.max_files_per_turn = mft;
  if (o.truncate_tool_output && typeof o.truncate_tool_output === "object" && !Array.isArray(o.truncate_tool_output)) {
    const t = o.truncate_tool_output as Record<string, unknown>;
    const maxLines = asNumber(t.max_lines);
    if (maxLines !== undefined && maxLines > 2) {
      const keepHead = Math.max(0, Math.min(asNumber(t.keep_head) ?? 10, maxLines - 2));
      const keepTail = Math.max(0, Math.min(asNumber(t.keep_tail) ?? maxLines - keepHead - 1, maxLines - keepHead - 1));
      const truncate: TruncatePolicy = { maxLines, keepHead, keepTail };
      policy.truncate_tool_output = truncate;
    }
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

export function loadStyleFile(path: string, source: StyleSource): { style: Style | null; warnings: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { style: null, warnings: [`无法读取 ${path}: ${(e as Error).message}`] };
  }
  const warnings: string[] = [];
  const { fm, body, warning } = splitFrontmatter(text);
  if (warning) warnings.push(warning);
  let data: Record<string, unknown> = {};
  if (fm !== null) {
    const parsed = parseLenientYaml(fm);
    data = parsed.data;
    warnings.push(...parsed.warnings.map((w) => `frontmatter: ${w}`));
  }
  // 剥离尾部证据注释（落盘时写入的 provenance，不属于注入 prompt 的正文）
  const bodyClean = body.replace(/\n*<!--\s*Evidence from sessions:[\s\S]*?-->\s*$/, "");
  const fileName = basename(path, ".md");
  const name = normalizeName(asString(data.name) ?? fileName);
  const description = asString(data.description) ?? "";
  const keepCoding = asBool(data["keep-coding-instructions"], true);
  let cost: StyleCost | undefined;
  if (data.cost && typeof data.cost === "object" && !Array.isArray(data.cost)) {
    const v = asVerbosity((data.cost as Record<string, unknown>).verbosity);
    if (v) cost = { verbosity: v };
  }
  const policy = extractPolicy(data.policy);
  const style: Style = {
    name,
    source,
    path,
    description,
    keepCodingInstructions: keepCoding,
    cost,
    policy,
    body: bodyClean.trim(),
    parseWarnings: warnings,
  };
  return { style, warnings };
}

// ---------- 三级作用域扫描 ----------

export interface ScanLocations {
  cwd: string;
  builtinStylesDir: string;
  userStylesDir?: string;
  claudeUserStylesDir?: string;
  configDirName?: string;
}

export interface StyleScan {
  styles: Style[];
  warnings: { path: string; message: string }[];
}

/**
 * 优先级（高 → 低，按归一化 name 去重，先到者胜）：
 * 项目 .pi/styles > 项目 .claude/output-styles > 用户 .pi/agent/styles > 用户 .claude/output-styles > 包内置
 */
export function scanStyles(loc: ScanLocations): StyleScan {
  const cfg = loc.configDirName ?? ".pi";
  const dirs: { dir: string; source: StyleSource }[] = [
    { dir: join(loc.cwd, cfg, "styles"), source: "project" },
    { dir: join(loc.cwd, ".claude", "output-styles"), source: "claude-project" },
    { dir: loc.userStylesDir ?? join(homedir(), cfg, "agent", "styles"), source: "user" },
    { dir: loc.claudeUserStylesDir ?? join(homedir(), ".claude", "output-styles"), source: "claude-user" },
    { dir: loc.builtinStylesDir, source: "builtin" },
  ];
  const byName = new Map<string, Style>();
  const warnings: { path: string; message: string }[] = [];
  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      continue;
    }
    for (const f of entries) {
      const full = join(dir, f);
      const { style, warnings: w } = loadStyleFile(full, source);
      for (const message of w) warnings.push({ path: full, message });
      if (!style) continue;
      if (!byName.has(style.name)) byName.set(style.name, style);
    }
  }
  return { styles: [...byName.values()], warnings };
}
