import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractJson, extractSignals, findRecentSessions, loadBranch, parseDistillOutput, styleToMarkdown } from "../src/distiller.ts";
import { loadStyleFile } from "../src/loader.ts";

function writeSession(file: string, lines: Record<string, unknown>[]) {
  const all = [
    { type: "session", version: 3, id: "uuid-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/proj" },
    ...lines,
  ];
  writeFileSync(file, all.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("loadBranch（JSONL 树回溯）", () => {
  it("沿 id/parentId 回溯主分支，排除废弃分支", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-d-"));
    const f = join(tmp, "s.jsonl");
    writeSession(f, [
      { type: "model_change", id: "m1", parentId: null, timestamp: "t0", provider: "anthropic", modelId: "x" },
      { type: "message", id: "u1", parentId: "m1", timestamp: "t1", message: { role: "user", content: "开始" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "t2", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
      // 废弃分支（从 u1 分出）
      { type: "message", id: "u4", parentId: "u1", timestamp: "t3", message: { role: "user", content: "岔路问题" } },
      { type: "message", id: "a4", parentId: "u4", timestamp: "t4", message: { role: "assistant", content: [{ type: "text", text: "岔路回答" }] } },
      // 主分支继续
      { type: "message", id: "t1", parentId: "a1", timestamp: "t5", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false } },
      { type: "message", id: "u2", parentId: "t1", timestamp: "t6", message: { role: "user", content: "继续" } },
    ]);
    const branch = loadBranch(f);
    const ids = branch.map((e) => e.id);
    expect(ids).toEqual(["m1", "u1", "a1", "t1", "u2"]);
    expect(ids).not.toContain("u4");
    expect(ids).not.toContain("a4");
  });

  it("坏行不崩溃", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-d-"));
    const f = join(tmp, "bad.jsonl");
    writeFileSync(f, 'not json\n{"type":"message","id":"a","parentId":null,"timestamp":"t","message":{"role":"user","content":"x"}}\n', "utf8");
    expect(loadBranch(f).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("extractSignals（双通道摩擦采样）", () => {
  function branch() {
    return [
      {
        id: "u1", parentId: null, timestamp: "2026-01-01T10:00:00Z", type: "message",
        message: { role: "user", content: "帮我看下这个报错" },
      },
      {
        id: "a1", parentId: "u1", timestamp: "2026-01-01T10:00:01Z", type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } }] },
      },
      {
        id: "t1", parentId: "a1", timestamp: "2026-01-01T10:00:02Z", type: "message",
        message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "total 0" }], isError: false },
      },
      {
        id: "u2", parentId: "t1", timestamp: "2026-01-01T10:00:03Z", type: "message",
        message: { role: "user", content: "不对，我是说查 git log，不是 ls" },
      },
      {
        id: "a2", parentId: "u2", timestamp: "2026-01-01T10:00:04Z", type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "git log" } }] },
      },
      {
        id: "t2", parentId: "a2", timestamp: "2026-01-01T10:00:05Z", type: "message",
        message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "fatal: not a git repository" }], isError: true },
      },
      {
        id: "a3", parentId: "t2", timestamp: "2026-01-01T10:00:06Z", type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "抱歉，这是超长输出\n" + "x".repeat(9000) }] },
      },
      {
        id: "u3", parentId: "a3", timestamp: "2026-01-01T10:00:07Z", type: "message",
        message: { role: "user", content: "太长了，简短点，too long and verbose" },
      },
    ] as any;
  }

  it("提取纠偏（含工具归因）、工具报错、长度抱怨", () => {
    const signals = extractSignals(branch(), "/tmp/s.jsonl");
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("correction");
    expect(kinds).toContain("tool_error");
    expect(kinds).toContain("length_complaint");
    const correction = signals.find((s) => s.kind === "correction")!;
    expect(correction.toolName).toBe("bash"); // 归因到紧邻的 tool_call
    expect(correction.quote).toContain("不对");
    expect(correction.timestamp).toBe("2026-01-01T10:00:03Z");
    const err = signals.find((s) => s.kind === "tool_error")!;
    expect(err.toolName).toBe("bash");
    expect(err.quote).toContain("fatal: not a git repository");
  });

  it("并行工具批次（>6 个 toolResult）后用户纠偏仍能归因", () => {
    const entries: any[] = [
      {
        id: "a1", parentId: null, timestamp: "t1", type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] },
      },
    ];
    let prev = "a1";
    for (let k = 0; k < 8; k++) {
      const id = `tr${k}`;
      entries.push({
        id, parentId: prev, timestamp: `t${k}`, type: "message",
        message: { role: "toolResult", toolCallId: `c${k}`, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
      });
      prev = id;
    }
    entries.push({
      id: "u2", parentId: prev, timestamp: "t9", type: "message",
      message: { role: "user", content: "不对，方向错了" },
    });
    const signals = extractSignals(entries, "/tmp/s.jsonl");
    const correction = signals.find((s) => s.kind === "correction");
    expect(correction?.toolName).toBe("bash");
  });

  it("assistant 超长文本不算工具摩擦（只算 toolResult 超长）", () => {
    const signals = extractSignals(branch(), "/tmp/s.jsonl");
    expect(signals.filter((s) => s.kind === "long_output")).toHaveLength(0);
  });

  it("toolResult 超长输出 → long_output", () => {
    const b = branch();
    (b[2].message.content as any)[0].text = "y".repeat(9000);
    const signals = extractSignals(b, "/tmp/s.jsonl");
    const long = signals.find((s) => s.kind === "long_output");
    expect(long?.toolName).toBe("bash");
  });
});

describe("findRecentSessions", () => {
  it("按 mtime 取最近 N 个", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-s-"));
    const d1 = join(tmp, "--proj-a--");
    const d2 = join(tmp, "--proj-b--");
    mkdirSync(d1);
    mkdirSync(d2);
    const f1 = join(d1, "old.jsonl");
    const f2 = join(d2, "new.jsonl");
    writeFileSync(f1, "{}\n");
    writeFileSync(f2, "{}\n");
    const past = new Date(Date.now() - 86400000);
    utimesSync(f1, past, past);
    const sessions = findRecentSessions(tmp, 1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].file).toBe(f2);
    expect(sessions[0].cwdHint).toBe("/proj/b");
  });
});

describe("extractJson / parseDistillOutput", () => {
  it("解析代码块包裹的 JSON", () => {
    const json = extractJson('```json\n{"a": 1}\n```');
    expect(json).toEqual({ a: 1 });
  });
  it("解析前后带废话的 JSON", () => {
    expect(extractJson('好的，结果如下：{"a": 1} 希望有用')).toEqual({ a: 1 });
  });
  it("垃圾返回 null", () => {
    expect(extractJson("没有 json")).toBeNull();
  });

  it("parseDistillOutput 校验 body 并规整 evidence", () => {
    const out = parseDistillOutput('{"name":"My Style","description":"d","body":"规则","cost":{"verbosity":"low"},"policy":{"max_files_per_turn":3},"evidence":[{"quote":"不对","timestamp":"t1","kind":"correction"}]}', { signals: [] });
    expect(out.name).toBe("my-style");
    expect(out.cost).toEqual({ verbosity: "low" });
    expect(out.policy).toEqual({ max_files_per_turn: 3 });
    expect(out.evidence).toHaveLength(1);
  });

  it("缺 body 抛错", () => {
    expect(() => parseDistillOutput('{"name":"x"}', { signals: [] })).toThrow();
  });
});

describe("styleToMarkdown 落盘往返", () => {
  it("生成 frontmatter 可被 loader 重新解析", () => {
    const md = styleToMarkdown({
      name: "distilled-style",
      description: "蒸馏出的风格：针对工具摩擦",
      body: "规则一\n规则二",
      policy: {
        max_files_per_turn: 4,
        deny_write_globs: [".env*"],
        confirm_bash_patterns: [String.raw`\brm\s+.*-[a-zA-Z]*r`],
        truncate_tool_output: { maxLines: 120, keepHead: 30, keepTail: 80 },
      },
      cost: { verbosity: "low" },
      evidence: [{ timestamp: "2026-01-01T10:00:00Z", quote: "不对，我是要 git log", kind: "correction" }],
    });
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-w-"));
    const f = join(tmp, "distilled-style.md");
    writeFileSync(f, md, "utf8");
    const { style } = loadStyleFile(f, "user");
    expect(style?.name).toBe("distilled-style");
    expect(style?.cost).toEqual({ verbosity: "low" });
    expect(style?.policy?.max_files_per_turn).toBe(4);
    expect(style?.policy?.deny_write_globs).toEqual([".env*"]);
    expect(style?.policy?.confirm_bash_patterns).toEqual([String.raw`\brm\s+.*-[a-zA-Z]*r`]);
    expect(style?.policy?.truncate_tool_output).toEqual({ maxLines: 120, keepHead: 30, keepTail: 80 });
    expect(style?.body).toBe("规则一\n规则二");
    expect(readFileSync(f, "utf8")).toContain("Evidence from sessions");
    expect(readFileSync(f, "utf8")).toContain("不对，我是要 git log");
  });
});
