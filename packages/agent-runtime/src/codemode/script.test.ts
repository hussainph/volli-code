import { describe, expect, it } from "vite-plus/test";
import { checkScript, MAX_SCRIPT_BYTES } from "./script";

const callable = new Map([
  ["read", "read"],
  ["bash", "bash"],
  ["session_start", "session_start"],
  ["my-tool", "my-tool"],
  ["my_tool", "my-tool"],
]);
const limits = { timeoutMs: 60_000, maxOutputBytes: 20_000 };

describe("checkScript", () => {
  it("accepts a program and lists the tools it names, each once, in first-mention order", () => {
    const check = checkScript(
      'const a = await tools.bash({ command: "ls" });\nawait tools["my-tool"]({}); await tools.my_tool({}); await tools.read({});',
      callable,
      limits,
    );
    expect(check).toEqual({
      ok: true,
      code: 'const a = await tools.bash({ command: "ls" });\nawait tools["my-tool"]({}); await tools.my_tool({}); await tools.read({});',
      timeoutMs: 60_000,
      maxOutputBytes: 20_000,
      references: ["bash", "my-tool", "read"],
    });
  });

  it("lets a computed name through to the sandbox, which only holds what it was handed", () => {
    const check = checkScript(
      "const name = 'read'; await tools[name]({}); other.thing; tools;",
      callable,
      limits,
    );
    expect(check.ok).toBe(true);
  });

  it("refuses a program that is too long, empty, or has a bad options line", () => {
    expect(checkScript("x".repeat(MAX_SCRIPT_BYTES + 1), callable, limits)).toMatchObject({
      ok: false,
      message: expect.stringContaining("longer than 64 KiB"),
    });
    expect(checkScript("   ", callable, limits)).toMatchObject({ ok: false });
    expect(checkScript('// @options: {"nope": 1}\nreturn 1;', callable, limits)).toMatchObject({
      ok: false,
      message: expect.stringContaining("@options only supports"),
    });
  });

  it("reads the options line as a request to lower the limits, never to raise them", () => {
    const lowered = checkScript(
      '// @options: {"timeout_ms": 1000, "max_output_tokens": 100}\nreturn 1;',
      callable,
      limits,
    );
    expect(lowered).toMatchObject({
      ok: true,
      timeoutMs: 1_000,
      maxOutputBytes: 400,
      code: "\nreturn 1;",
    });
    const raised = checkScript(
      '// @options: {"timeout_ms": 999999999, "max_output_tokens": 999999}\nreturn 1;',
      callable,
      limits,
    );
    expect(raised).toMatchObject({ ok: true, timeoutMs: 60_000, maxOutputBytes: 20_000 });
    expect(
      checkScript('// @options: {"max_output_tokens": 0}\nreturn 1;', callable, limits),
    ).toMatchObject({
      ok: true,
      maxOutputBytes: 1,
    });
  });

  it("parses the program as one function body, so it cannot close the sandbox's wrapper", () => {
    expect(checkScript("}); (async () => {", callable, limits)).toMatchObject({
      ok: false,
      message: expect.stringContaining("SyntaxError"),
    });
    // Top-level return and await are what a body allows.
    expect(checkScript("await null; return 1;", callable, limits).ok).toBe(true);
  });
});
