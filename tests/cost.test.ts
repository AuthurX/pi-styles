import { describe, expect, it } from "vitest";
import { estimateTokens, formatStatus, getCostInfo, inferVerbosity, policyBadge } from "../src/cost.ts";
import type { Style } from "../src/types.ts";

function makeStyle(over: Partial<Style>): Style {
  return {
    name: "t",
    source: "builtin",
    path: "/tmp/t.md",
    description: "",
    keepCodingInstructions: true,
    body: "body",
    parseWarnings: [],
    ...over,
  };
}

describe("estimateTokens", () => {
  it("CJK 约 1 token/字", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });
  it("ASCII 约 4 字符/token", () => {
    expect(estimateTokens("hello world!")).toBe(3); // 12 chars / 4
  });
  it("混合文本", () => {
    expect(estimateTokens("中文 and english")).toBe(2 + 3); // 2 CJK + ceil(11 ascii / 4)
  });
  it("空文本为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("inferVerbosity", () => {
  it("低信息量关键词 → low", () => {
    expect(inferVerbosity("回复要简洁、简短，concise and brief，电报体")).toBe("low");
  });
  it("高信息量关键词 → high", () => {
    expect(inferVerbosity("分步教学，详细解释为什么，detailed step by step")).toBe("high");
  });
  it("无明显倾向 → medium", () => {
    expect(inferVerbosity("普通风格，没有特殊要求")).toBe("medium");
  });
});

describe("policyBadge", () => {
  it("无策略 → Claude 兼容纯文本", () => {
    expect(policyBadge(makeStyle({}))).toBe("💬 纯文本(Claude兼容)");
  });
  it("禁写工具 → 只读", () => {
    expect(policyBadge(makeStyle({ policy: { disabled_tools: ["write", "edit"] } }))).toBe("🔒 只读");
  });
  it("bash 护栏 → 护栏徽章", () => {
    expect(policyBadge(makeStyle({ policy: { confirm_bash_patterns: ["x"] } }))).toContain("🛡️ 护栏");
  });
  it("截断 → 截断徽章", () => {
    expect(policyBadge(makeStyle({ policy: { truncate_tool_output: { maxLines: 100, keepHead: 10, keepTail: 80 } } }))).toContain("✂️ 截断");
  });
});

describe("getCostInfo / formatStatus", () => {
  it("显式 verbosity 优先于推断", () => {
    const s = makeStyle({ body: "简洁 concise brief 电报", cost: { verbosity: "high" } });
    expect(getCostInfo(s).verbosity).toBe("high");
  });
  it("状态栏格式", () => {
    const s = makeStyle({ name: "caveman", body: "简洁 concise", policy: { truncate_tool_output: { maxLines: 10, keepHead: 3, keepTail: 5 } } });
    const status = formatStatus(s);
    expect(status).toMatch(/^🎭 caveman \(\+\d+ tok \| low \| ✂️ 截断\)$/);
  });
});
