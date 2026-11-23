import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStyleFile, parseLenientYaml, scanStyles } from "../src/loader.ts";

describe("parseLenientYaml（脏 YAML 容错）", () => {
  it("无引号且含冒号的 description 只按第一个冒号切分", () => {
    const { data, warnings } = parseLenientYaml("name: safety-first\ndescription: 谨慎分析：影响面与高危命令");
    expect(data.name).toBe("safety-first");
    expect(data.description).toBe("谨慎分析：影响面与高危命令");
    expect(warnings).toEqual([]);
  });

  it("嵌套 policy + 块状数组 + 双引号反斜杠转义", () => {
    const text = [
      "name: x",
      "policy:",
      "  disabled_tools:",
      '    - "write"',
      '    - "edit"',
      '  confirm_bash_patterns:',
      '    - "\\\\brm\\\\s+"' ,
      "  truncate_tool_output:",
      "    max_lines: 120",
      "    keep_head: 30",
      "    keep_tail: 80",
    ].join("\n");
    const { data } = parseLenientYaml(text);
    const p = data.policy as Record<string, any>;
    expect(p.disabled_tools).toEqual(["write", "edit"]);
    expect(p.confirm_bash_patterns).toEqual([String.raw`\brm\s+`]);
    expect(p.truncate_tool_output).toEqual({ max_lines: 120, keep_head: 30, keep_tail: 80 });
  });

  it("内联数组、布尔、数字、引号内含冒号", () => {
    const { data } = parseLenientYaml('a: [1, 2, "three"]\nb: true\nc: 42\nd: "quoted: yes"\ne: -3.5');
    expect(data.a).toEqual([1, 2, "three"]);
    expect(data.b).toBe(true);
    expect(data.c).toBe(42);
    expect(data.d).toBe("quoted: yes");
    expect(data.e).toBe(-3.5);
  });

  it("块状标量 | 与 >", () => {
    const { data } = parseLenientYaml("description: |\n  line one\n  line two\nsummary: >\n  fold a\n  fold b");
    expect(data.description).toBe("line one\nline two");
    expect(data.summary).toBe("fold a fold b");
  });

  it("坏行只产生 warning，绝不抛异常", () => {
    const { data, warnings } = parseLenientYaml("name: x\nthis is garbage\n  broken: [unbalanced\nok: fine");
    expect(data.name).toBe("x");
    expect(data.ok).toBe("fine");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("空 frontmatter / 空文件不崩溃", () => {
    expect(parseLenientYaml("").data).toEqual({});
    expect(parseLenientYaml("# only comment\ndata: 1").data).toEqual({ data: 1 });
  });
});

describe("loadStyleFile", () => {
  it("无 frontmatter 的文件用文件名做风格名", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-"));
    const f = join(tmp, "my-style.md");
    writeFileSync(f, "# 正文\n\nhello");
    const { style } = loadStyleFile(f, "builtin");
    expect(style?.name).toBe("my-style");
    expect(style?.body).toBe("# 正文\n\nhello");
    expect(style?.parseWarnings.length).toBeGreaterThan(0);
  });

  it("frontmatter 未闭合时整体按正文处理", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-"));
    const f = join(tmp, "broken.md");
    writeFileSync(f, "---\nname: broken\n\n正文没有闭合");
    const { style } = loadStyleFile(f, "builtin");
    expect(style?.name).toBe("broken");
    expect(style?.body).toContain("正文没有闭合");
  });

  it("完整风格文件（策略 + 成本）解析", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-"));
    const f = join(tmp, "full.md");
    writeFileSync(
      f,
      [
        "---",
        "name: Full Style",
        "description: 测试风格：含冒号",
        "keep-coding-instructions: false",
        "cost:",
        "  verbosity: low",
        "policy:",
        '  deny_write_globs: [".env*"]',
        "  max_files_per_turn: 3",
        "---",
        "正文内容",
      ].join("\n"),
    );
    const { style } = loadStyleFile(f, "builtin");
    expect(style?.name).toBe("full-style");
    expect(style?.keepCodingInstructions).toBe(false);
    expect(style?.cost).toEqual({ verbosity: "low" });
    expect(style?.policy?.deny_write_globs).toEqual([".env*"]);
    expect(style?.policy?.max_files_per_turn).toBe(3);
    expect(style?.body).toBe("正文内容");
  });
});

describe("scanStyles（三级作用域覆盖）", () => {
  function setup() {
    const tmp = mkdtempSync(join(tmpdir(), "pi-styles-scan-"));
    const dirs = {
      cwd: join(tmp, "proj"),
      builtin: join(tmp, "builtin"),
      user: join(tmp, "user"),
      claudeUser: join(tmp, "claude-user"),
    };
    const mk = (dir: string, file: string, content: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), content, "utf8");
    };
    return { tmp, dirs, mk };
  }

  it("同名风格：项目级 > 用户级 > 内置", () => {
    const { dirs, mk } = setup();
    mk(dirs.builtin, "demo.md", "---\nname: demo\ndescription: builtin\n---\nB");
    mk(dirs.user, "demo.md", "---\nname: demo\ndescription: user\n---\nU");
    mk(join(dirs.cwd, ".pi", "styles"), "demo.md", "---\nname: demo\ndescription: project\n---\nP");
    const { styles } = scanStyles({
      cwd: dirs.cwd,
      builtinStylesDir: dirs.builtin,
      userStylesDir: dirs.user,
      claudeUserStylesDir: join(dirs.cwd, "no-claude"),
    });
    expect(styles.filter((s) => s.name === "demo")).toHaveLength(1);
    expect(styles.find((s) => s.name === "demo")?.source).toBe("project");
    expect(styles.find((s) => s.name === "demo")?.body).toBe("P");
  });

  it("同级 pi 目录 > claude 目录；claude 存量风格仍被发现", () => {
    const { dirs, mk } = setup();
    mk(dirs.claudeUser, "legacy.md", "---\ndescription: 无 name 字段的 Claude 风格\n---\nC body");
    const { styles } = scanStyles({
      cwd: dirs.cwd,
      builtinStylesDir: dirs.builtin,
      userStylesDir: dirs.user,
      claudeUserStylesDir: dirs.claudeUser,
    });
    const legacy = styles.find((s) => s.name === "legacy");
    expect(legacy?.source).toBe("claude-user");
    expect(legacy?.body).toBe("C body");

    mk(join(dirs.cwd, ".claude", "output-styles"), "legacy.md", "---\nname: legacy\ndescription: project claude\n---\nPC");
    const scan2 = scanStyles({
      cwd: dirs.cwd,
      builtinStylesDir: dirs.builtin,
      userStylesDir: dirs.user,
      claudeUserStylesDir: dirs.claudeUser,
    });
    const legacy2 = scan2.styles.find((s) => s.name === "legacy");
    expect(legacy2?.source).toBe("claude-project");
    expect(legacy2?.body).toBe("PC");
  });

  it("坏文件不影响其他风格，且收集 warning", () => {
    const { dirs, mk } = setup();
    mk(dirs.builtin, "good.md", "---\nname: good\n---\nG");
    mk(dirs.builtin, "bad.md", "这不是一个正常文件的 frontmatter --- 未闭合");
    const { styles, warnings } = scanStyles({
      cwd: dirs.cwd,
      builtinStylesDir: dirs.builtin,
      userStylesDir: dirs.user,
      claudeUserStylesDir: join(dirs.cwd, "nope"),
    });
    expect(styles.map((s) => s.name)).toContain("good");
    expect(warnings.some((w) => w.path.endsWith("bad.md"))).toBe(true);
  });
});
