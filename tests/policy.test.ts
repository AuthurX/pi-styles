import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkBash, checkWrite, createPolicyState, globToRegExp, matchGlob, truncateToolText } from "../src/policy.ts";
import type { Style } from "../src/types.ts";

function makeStyle(policy: Style["policy"]): Style {
  return {
    name: "test-style",
    source: "builtin",
    path: "/tmp/test-style.md",
    description: "",
    keepCodingInstructions: true,
    policy,
    body: "body",
    parseWarnings: [],
  };
}

function mockCtx(opts: { hasUI?: boolean; confirmResult?: boolean; cwd?: string } = {}) {
  const confirm = vi.fn(async () => opts.confirmResult ?? false);
  return {
    hasUI: opts.hasUI ?? true,
    cwd: opts.cwd ?? "/tmp/proj",
    ui: { confirm },
    confirm,
  };
}

describe("glob 匹配", () => {
  it("globToRegExp 基本形态", () => {
    expect(globToRegExp("*.md").test("a.md")).toBe(true);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
    expect(globToRegExp("**/*.md").test("a/b.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("b.md")).toBe(true);
    expect(globToRegExp("**/docs/**").test("src/docs/x.md")).toBe(true);
    expect(globToRegExp("**/docs/**").test("docs/x.md")).toBe(true);
    expect(globToRegExp(".env*").test(".env.local")).toBe(true);
    expect(globToRegExp(".env*").test("envx")).toBe(false);
  });

  it("无斜杠 glob 匹配任意层级的 basename", () => {
    expect(matchGlob(".env*", "/home/u/proj/.env")).toBe(true);
    expect(matchGlob(".env*", "/home/u/proj/sub/.env.local")).toBe(true);
    expect(matchGlob("**/*secret*", "/home/u/proj/a/b/secret.txt")).toBe(true);
    expect(matchGlob("**/*.md", "/home/u/proj/readme.txt")).toBe(false);
  });

  it("含斜杠 glob 同时尝试 cwd 相对路径", () => {
    expect(matchGlob("src/**", "/home/u/proj/src/a.ts", "/home/u/proj")).toBe(true);
    expect(matchGlob("src/**", "/home/u/other/src/a.ts", "/home/u/proj")).toBe(false);
  });
});

describe("checkWrite 拦截", () => {
  it("deny_write_globs 拦截敏感文件", async () => {
    const style = makeStyle({ deny_write_globs: [".env*", "**/*secret*"] });
    const ctx = mockCtx();
    const res = await checkWrite(style, createPolicyState(), ctx, "/tmp/proj/.env.local");
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain(".env");
    const ok = await checkWrite(style, createPolicyState(), ctx, "/tmp/proj/src/a.ts");
    expect(ok).toBeUndefined();
  });

  it("allow_write_globs 只放行白名单", async () => {
    const style = makeStyle({ allow_write_globs: ["**/*.md", "**/*.mdx"] });
    const ctx = mockCtx();
    expect((await checkWrite(style, createPolicyState(), ctx, "/tmp/proj/docs/a.md"))?.block).toBeUndefined();
    const blocked = await checkWrite(style, createPolicyState(), ctx, "/tmp/proj/src/a.ts");
    expect(blocked?.block).toBe(true);
  });

  it("require_plan_confirm_before_write：拒绝则 block，同意后本会话放开", async () => {
    const style = makeStyle({ require_plan_confirm_before_write: true });
    const state = createPolicyState();
    const deny = mockCtx({ confirmResult: false });
    const r1 = await checkWrite(style, state, deny, "/tmp/proj/a.ts");
    expect(r1?.block).toBe(true);
    expect(r1?.reason).toContain("设计/架构图");
    expect(state.writeUnlocked).toBe(false);

    const allow = mockCtx({ confirmResult: true });
    const r2 = await checkWrite(style, state, allow, "/tmp/proj/a.ts");
    expect(r2).toBeUndefined();
    expect(state.writeUnlocked).toBe(true);
    // 第二次不再弹窗
    const r3 = await checkWrite(style, state, allow, "/tmp/proj/b.ts");
    expect(r3).toBeUndefined();
    expect(allow.confirm).toHaveBeenCalledTimes(1);
  });

  it("非交互模式（!hasUI）confirm 安全降级为 block", async () => {
    const style = makeStyle({ require_plan_confirm_before_write: true });
    const ctx = mockCtx({ hasUI: false, confirmResult: true });
    const res = await checkWrite(style, createPolicyState(), ctx, "/tmp/proj/a.ts");
    expect(res?.block).toBe(true);
  });

  it("confirm_overwrite_existing：已存在文件需确认", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-p-"));
    const f = join(tmp, "exists.ts");
    writeFileSync(f, "x");
    const style = makeStyle({ confirm_overwrite_existing: true });
    const deny = mockCtx({ confirmResult: false });
    expect((await checkWrite(style, createPolicyState(), deny, f))?.block).toBe(true);
    const allow = mockCtx({ confirmResult: true });
    expect(await checkWrite(style, createPolicyState(), allow, f)).toBeUndefined();
    // 不存在文件不弹窗
    const fresh = mockCtx({ confirmResult: false });
    expect(await checkWrite(style, createPolicyState(), fresh, join(tmp, "new.ts"))).toBeUndefined();
    expect(fresh.confirm).not.toHaveBeenCalled();
  });

  it("max_files_per_turn：超限第 N+1 个文件触发确认", async () => {
    const style = makeStyle({ max_files_per_turn: 2 });
    const state = createPolicyState();
    const ctx = mockCtx({ confirmResult: false });
    expect(await checkWrite(style, state, ctx, "/tmp/proj/a.ts")).toBeUndefined();
    expect(await checkWrite(style, state, ctx, "/tmp/proj/b.ts")).toBeUndefined();
    const over = await checkWrite(style, state, ctx, "/tmp/proj/c.ts");
    expect(over?.block).toBe(true);
    expect(over?.reason).toContain("2");
    // 同文件重复修改不计数
    const state2 = createPolicyState();
    expect(await checkWrite(style, state2, mockCtx(), "/tmp/proj/a.ts")).toBeUndefined();
    expect(await checkWrite(style, state2, mockCtx(), "/tmp/proj/a.ts")).toBeUndefined();
  });
});

describe("checkBash 护栏", () => {
  it("deny_bash_patterns 直接拦截", async () => {
    const style = makeStyle({ deny_bash_patterns: [String.raw`\bmkfs` , String.raw`\brm\s+-rf\s+/`] });
    const ctx = mockCtx({ confirmResult: true });
    const res = await checkBash(style, ctx, "mkfs.ext4 /dev/sda1");
    expect(res?.block).toBe(true);
    expect(await checkBash(style, ctx, "ls -la")).toBeUndefined();
  });

  it("confirm_bash_patterns 弹窗确认（拒绝则 block）", async () => {
    const style = makeStyle({
      confirm_bash_patterns: [String.raw`\brm\s+.*-[a-zA-Z]*r`, String.raw`\bgit\s+push\b.*(--force|-f)`],
    });
    const deny = mockCtx({ confirmResult: false });
    const res = await checkBash(style, deny, "rm -rf /tmp/build");
    expect(res?.block).toBe(true);
    const allow = mockCtx({ confirmResult: true });
    expect(await checkBash(style, allow, "rm -rf /tmp/build")).toBeUndefined();
    expect(await checkBash(style, allow, "git push origin main")).toBeUndefined();
    expect((await checkBash(style, deny, "git push --force origin main"))?.block).toBe(true);
  });

  it("非交互模式 confirm 降级为 block", async () => {
    const style = makeStyle({ confirm_bash_patterns: [String.raw`\brm\s+.*-[a-zA-Z]*r`] });
    const res = await checkBash(style, mockCtx({ hasUI: false }), "rm -rf /tmp/x");
    expect(res?.block).toBe(true);
  });

  it("无效正则不崩溃（永不匹配）", async () => {
    const style = makeStyle({ confirm_bash_patterns: ["([invalid"] });
    expect(await checkBash(style, mockCtx({ confirmResult: false }), "rm -rf /tmp/x")).toBeUndefined();
  });
});

describe("truncateToolText 瘦身", () => {
  it("超行裁剪保留头尾 + 截断标记", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    const { text, removedLines } = truncateToolText(lines, { maxLines: 120, keepHead: 30, keepTail: 80 });
    expect(removedLines).toBe(90);
    const out = text.split("\n");
    expect(out).toHaveLength(111);
    expect(out[0]).toBe("line 1");
    expect(out[29]).toBe("line 30");
    expect(out[30]).toBe("[pi-styles truncated 90 lines]");
    expect(out[110]).toBe("line 200");
  });

  it("未超行不改动", () => {
    const text = "a\nb\nc";
    expect(truncateToolText(text, { maxLines: 10, keepHead: 3, keepTail: 3 })).toEqual({ text, removedLines: 0 });
  });
});
