/**
 * The `codemode` tool on its own, over stand-in tools (VC-471): the sandbox,
 * the limits, replay, ordering, partial failure and result shaping. The same
 * rules through the real Session path — the gate, approvals, cancellation of
 * real `bash` — are in `runtime-codemode.test.ts`.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_CODE_MODE_LIMITS,
  mcpProviderToolName,
  type CodeModeLimits,
  type McpToolDefinition,
  type ToolRoute,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { MCP_UNTRUSTED_DATA_WARNING } from "../pi/tools";
import { ToolOutputStore } from "../pi/tool-output";
import { CodeModeJournal } from "./journal";
import {
  createCodeModeTool,
  type CodeModeDetails,
  type CodeModeHost,
  type NestedToolEvent,
  type SurfaceTool,
} from "./tool";

/** A real 1×1 PNG, which the sandbox's `image()` checks before it accepts it. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A plain text tool. */
function textTool(
  name: string,
  answer: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<string> | string,
): AgentTool {
  return {
    name,
    label: name,
    description: `${name}: a stand-in tool. It does one thing.`,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_id, params, signal) => ({
      content: [{ type: "text", text: await answer(params as Record<string, unknown>, signal) }],
      details: undefined,
    }),
  };
}

function resultTool(name: string, result: AgentToolResult<unknown>): AgentTool {
  return {
    name,
    label: name,
    description: `${name} returns a fixed result.`,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => result,
  };
}

/** A `bash` stand-in whose every call answers with `outcome`. */
function bash(outcome: () => AgentToolResult<unknown>): AgentTool {
  return {
    name: "bash",
    label: "bash",
    description: "Execute a bash command.",
    parameters: Type.Object({ command: Type.String() }),
    execute: async () => outcome(),
  };
}

interface Fixture {
  host: CodeModeHost;
  events: NestedToolEvent[];
  tool: ReturnType<typeof createCodeModeTool>;
}

function fixture(input: {
  tools: (SurfaceTool | AgentTool)[];
  routes?: Record<string, ToolRoute>;
  limits?: Partial<CodeModeLimits>;
  gate?: NonNullable<AgentLoopConfig["beforeToolCall"]>;
  journal?: CodeModeJournal;
  output?: ToolOutputStore;
  signal?: AbortSignal;
  sandbox?: CodeModeHost["sandbox"];
  now?: () => number;
}): Fixture {
  const tools = input.tools.map((entry): SurfaceTool =>
    "tool" in entry ? entry : { id: entry.name, tool: entry, verb: false },
  );
  const routes: Record<string, ToolRoute> = {};
  for (const entry of tools) routes[entry.id] = input.routes?.[entry.id] ?? "both";
  const events: NestedToolEvent[] = [];
  const host: CodeModeHost = {
    surface: { routes, limits: { ...DEFAULT_CODE_MODE_LIMITS, ...input.limits } },
    tools,
    gate: () => input.gate,
    observe: async (event) => {
      events.push(event);
    },
    journal: input.journal ?? new CodeModeJournal(),
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
  return { host, events, tool: createCodeModeTool(host) };
}

async function run(
  f: Fixture,
  code: string,
  id = "outer",
  signal?: AbortSignal,
): Promise<{ text: string; details: CodeModeDetails; isError: boolean }> {
  const result = await f.tool.execute(id, { code }, signal);
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  return { text, details: result.details, isError: result.isError === true };
}

describe("the sandbox", () => {
  it("offers a program nothing but its tools: no Node, no env, no files, no network, no timers", async () => {
    const f = fixture({ tools: [textTool("echo", () => "hi")] });
    const probe = `
      const kinds = {};
      for (const name of ["process", "require", "fetch", "setTimeout", "setInterval", "WebAssembly",
                          "XMLHttpRequest", "Buffer", "module", "globalThis.process"]) {
        try { kinds[name] = typeof eval(name); } catch (error) { kinds[name] = "throws"; }
      }
      let imported;
      try { await import("node:fs"); imported = "loaded"; } catch (error) { imported = "refused"; }
      return { kinds, imported, tools: Object.keys(tools).sort() };
    `;
    const { text, isError } = await run(f, probe);
    expect(isError).toBe(false);
    const returned = JSON.parse(text.slice(text.indexOf("Returned: ") + 10)) as {
      kinds: Record<string, string>;
      imported: string;
      tools: string[];
    };
    for (const kind of Object.values(returned.kinds))
      expect(["undefined", "throws"]).toContain(kind);
    expect(returned.imported).toBe("refused");
    expect(returned.tools).toEqual(["echo"]);
  });

  it("starts each run in a fresh VM", async () => {
    const f = fixture({ tools: [textTool("echo", () => "hi")] });
    await run(f, "globalThis.leak = 42; return 1;", "a");
    const { text } = await run(f, "return typeof globalThis.leak;", "b");
    expect(text).toContain("Returned: undefined");
  });

  it("pins Date and Math.random per outer call, so a replay sees the same values", async () => {
    let clock = 1_000_000;
    const f = fixture({ tools: [textTool("echo", () => "hi")], now: () => clock });
    const code = "return [Date.now(), new Date().getTime(), Math.random(), new Date(5).getTime()];";
    const first = await run(f, code, "same");
    clock += 60_000;
    const again = await run(f, code, "same");
    const other = await run(f, code, "other");
    expect(again.text.split("\n")[1]).toBe(first.text.split("\n")[1]);
    expect(first.text).toContain("Returned: [1000000,1000000,");
    expect(first.text).toContain(",5]");
    expect(other.text.split("\n")[1]).not.toBe(first.text.split("\n")[1]);
  });

  it("reports a sandbox that cannot start as a failed run, not a thrown call", async () => {
    const f = fixture({
      tools: [textTool("echo", () => "hi")],
      sandbox: { workerUrl: new URL("file:///nonexistent/codemode-worker.js") },
    });
    const { text, isError, details } = await run(f, "return 1;");
    expect(isError).toBe(true);
    expect(details.error).toBe("sandbox");
    expect(text).toContain("Program stopped:");
  });

  it("loads the WebAssembly from a host-supplied path", async () => {
    const { createRequire } = await import("node:module");
    const { fileURLToPath } = await import("node:url");
    const worker = fileURLToPath(import.meta.resolve("@earendil-works/pi-codemode/worker"));
    const wasmPath = createRequire(worker).resolve("quickjs-wasi/quickjs.wasm");
    const f = fixture({ tools: [textTool("echo", () => "hi")], sandbox: { wasmPath } });
    expect((await run(f, "return await tools.echo({});")).text).toContain("Returned: hi");
  });
});

describe("limits", () => {
  it("stops a program that spins past its running time", async () => {
    const f = fixture({ tools: [textTool("echo", () => "hi")], limits: { timeoutMs: 1_000 } });
    const { details, text, isError } = await run(f, "while (true) {}");
    expect(isError).toBe(true);
    expect(details.error).toBe("timeout");
    expect(text).toContain("ran past its 1 s limit");
  });

  it("lets the options line lower the deadline and never raise it", async () => {
    const f = fixture({ tools: [textTool("echo", () => "hi")], limits: { timeoutMs: 1_000 } });
    const lowered = await run(f, '// @options: {"timeout_ms": 1}\nwhile (true) {}');
    expect(lowered.text).toContain("ran past its 0 s limit");
    const raised = await run(f, '// @options: {"timeout_ms": 100000000}\nwhile (true) {}');
    expect(raised.text).toContain("ran past its 1 s limit");
    expect((await run(f, '// @options: {"bogus": 1}\nreturn 1;')).details.error).toBe("check");
  });

  it("holds the VM to its memory limit", async () => {
    const f = fixture({
      tools: [textTool("echo", () => "hi")],
      limits: { memoryLimitBytes: 4 * 1_024 * 1_024 },
    });
    const { text, details } = await run(
      f,
      "const parts = []; while (true) parts.push('x'.repeat(65536) + parts.length);",
    );
    expect(details.error).toBe("script");
    expect(text).toMatch(/out of memory/iu);
  });

  it("fails the call past the nested-call limit and runs nothing more", async () => {
    let calls = 0;
    const f = fixture({
      tools: [textTool("effect", () => String(++calls))],
      limits: { maxNestedCalls: 3 },
    });
    const { text } = await run(
      f,
      "const got = []; for (let i = 0; i < 5; i++) { try { got.push(await tools.effect({})); } catch (e) { got.push(e.message); } } return got;",
    );
    expect(calls).toBe(3);
    expect(text).toContain("has made its 3 calls; no more are run");
  });

  it("cuts long output in the middle and saves it whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "volli-codemode-output-"));
    const output = new ToolOutputStore({ directory: join(root, "out"), workspacePath: root });
    const f = fixture({
      tools: [textTool("echo", () => "hi")],
      limits: { maxOutputBytes: 1_024 },
      output,
    });
    const { text, details } = await run(
      f,
      "for (let i = 0; i < 400; i++) text('line ' + i); return 'end';",
    );
    expect(Buffer.byteLength(text)).toBeLessThan(2_000);
    expect(text).toContain("truncated output");
    expect(details.output?.fullOutputPath).toBeTruthy();
    const saved = readFileSync(details.output!.fullOutputPath!, "utf8");
    expect(saved).toContain("line 399");
    expect(saved).toContain("Returned: end");
    // Without storage, the cut says so.
    const bare = fixture({
      tools: [textTool("echo", () => "hi")],
      limits: { maxOutputBytes: 1_024 },
    });
    const unsaved = await run(bare, "for (let i = 0; i < 400; i++) text('line ' + i);");
    expect(unsaved.text).toContain("could not be saved");
  });

  it("lets a program lower its output budget", async () => {
    const f = fixture({ tools: [textTool("echo", () => "hi")] });
    const { text } = await run(
      f,
      '// @options: {"max_output_tokens": 300}\nfor (let i = 0; i < 400; i++) text("line " + i);',
    );
    expect(text).toContain("truncated output");
  });
});

describe("scheduling", () => {
  it("overlaps reads, runs everything else alone, and returns results in the order asked", async () => {
    let active = 0;
    let peak = 0;
    const trace: string[] = [];
    const read = textTool("read", async (params) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(Number(params.ms));
      active -= 1;
      return `read ${String(params.path)}`;
    });
    const write = textTool("write", async (params) => {
      trace.push(`write start, ${active} reads active`);
      active += 1;
      await sleep(5);
      active -= 1;
      return `wrote ${String(params.path)}`;
    });
    const f = fixture({ tools: [read, write], limits: { maxConcurrency: 3 } });
    const { text, details } = await run(
      f,
      `const reads = await Promise.all([40, 5, 20, 1].map((ms, i) => tools.read({ path: "f" + i, ms })));
       const mixed = await Promise.all([tools.read({ path: "a", ms: 20 }), tools.write({ path: "w" }), tools.read({ path: "b", ms: 1 })]);
       return [reads, mixed];`,
    );
    expect(text).toContain(
      'Returned: [["read f0","read f1","read f2","read f3"],["read a","wrote w","read b"]]',
    );
    expect(peak).toBe(3);
    expect(details.peakConcurrency).toBe(3);
    // The write waited for the read before it, and the read after it waited too.
    expect(trace).toEqual(["write start, 0 reads active"]);
  });

  it("makes a partial failure explicit and keeps the rest", async () => {
    const f = fixture({
      tools: [
        textTool("read", async (params) => {
          if (params.path === "bad") throw new Error("no such file: bad");
          return `read ${String(params.path)}`;
        }),
      ],
    });
    const { text, details, isError } = await run(
      f,
      `const settled = await Promise.allSettled(["a", "bad", "c"].map((path) => tools.read({ path })));
       return settled.map((one) => one.status === "fulfilled" ? one.value : "ERR " + one.reason.message);`,
    );
    expect(isError).toBe(false);
    expect(text).toContain('Returned: ["read a","ERR no such file: bad","read c"]');
    expect(text).toContain("3 calls: 2 ok, 1 failed (read #2)");
    expect(details.nestedCalls.calls.map((call) => [call.id, call.status])).toEqual([
      ["outer:1", "ok"],
      ["outer:2", "error"],
      ["outer:3", "ok"],
    ]);
    expect(details.nestedCalls.calls[1]!.error).toBe("no such file: bad");
  });

  it("judges one call at a time, in the order the program issued them", async () => {
    const judged: string[] = [];
    let judging = 0;
    let peakJudging = 0;
    const gate: NonNullable<AgentLoopConfig["beforeToolCall"]> = async ({ toolCall }) => {
      judging += 1;
      peakJudging = Math.max(peakJudging, judging);
      await sleep(5);
      judged.push(toolCall.id);
      judging -= 1;
      return toolCall.id === "outer:2"
        ? { block: true, reason: "refused by the fixture" }
        : undefined;
    };
    const f = fixture({ tools: [textTool("read", () => "ok")], gate });
    const { text } = await run(
      f,
      `return (await Promise.allSettled([1, 2, 3].map(() => tools.read({})))).map((one) => one.status);`,
    );
    expect(judged).toEqual(["outer:1", "outer:2", "outer:3"]);
    expect(peakJudging).toBe(1);
    expect(text).toContain('Returned: ["fulfilled","rejected","fulfilled"]');
  });
});

describe("replay", () => {
  it("answers completed calls from the journal and never repeats their effect", async () => {
    const effects: string[] = [];
    const journal = new CodeModeJournal();
    const f = fixture({
      tools: [
        textTool("effect", (params) => {
          effects.push(String(params.name));
          return `did ${String(params.name)}`;
        }),
      ],
      journal,
    });
    const code = `const a = await tools.effect({ name: "start-session" });
                  const b = await tools.effect({ name: "second" });
                  return [a, b];`;
    const first = await run(f, code, "outer-1");
    const replay = await run(f, code, "outer-1");
    expect(effects).toEqual(["start-session", "second"]);
    expect(replay.text).toContain('Returned: ["did start-session","did second"]');
    expect(replay.details.replayedCalls).toBe(2);
    expect(replay.text).toContain("2 calls: 2 ok, 2 answered from the replay journal");
    expect(first.text.split("\n")[1]).toBe(replay.text.split("\n")[1]);
    // Only replay: nested activity is reported once, by the run that did it.
    expect(f.events.filter((event) => event.type === "tool_execution_start")).toHaveLength(2);
  });

  it("stops a replay that diverges before running anything in the changed position", async () => {
    const effects: string[] = [];
    const f = fixture({
      tools: [
        textTool("effect", (params) => {
          effects.push(String(params.name));
          return "ok";
        }),
      ],
    });
    await run(
      f,
      'await tools.effect({ name: "a" }); await tools.effect({ name: "b" });',
      "outer-2",
    );
    const diverged = await run(
      f,
      'await tools.effect({ name: "a" }); await tools.effect({ name: "DIFFERENT" });',
      "outer-2",
    );
    expect(effects).toEqual(["a", "b"]);
    expect(diverged.isError).toBe(true);
    expect(diverged.details.error).toBe("replay");
    expect(diverged.text).toContain("Replay diverged at call 2");
  });

  it("runs again a call that never finished, because nothing says it happened", async () => {
    const effects: string[] = [];
    const journal = new CodeModeJournal();
    const controller = new AbortController();
    let gate = true;
    const slow = textTool("effect", async (params, signal) => {
      if (params.name === "slow" && gate) {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          setTimeout(() => controller.abort(), 20);
        });
      }
      effects.push(String(params.name));
      return "ok";
    });
    const f = fixture({ tools: [slow], journal });
    const code =
      'await tools.effect({ name: "fast" }); await tools.effect({ name: "slow" }); return "end";';
    const cancelled = await run(f, code, "outer-3", controller.signal);
    expect(cancelled.details.error).toBe("aborted");
    expect(cancelled.details.nestedCalls.calls.map((call) => call.status)).toEqual([
      "ok",
      "unfinished",
    ]);
    expect(cancelled.details.nestedCalls.complete).toBe(false);
    gate = false;
    const replay = await run(f, code, "outer-3");
    expect(effects).toEqual(["fast", "slow"]);
    expect(replay.details.replayedCalls).toBe(1);
    expect(replay.text).toContain("Returned: end");
  });

  it("forgets the oldest run once the journal is full", async () => {
    let calls = 0;
    const f = fixture({
      tools: [textTool("effect", () => String(++calls))],
      journal: new CodeModeJournal(1),
    });
    await run(f, "await tools.effect({});", "first");
    await run(f, "await tools.effect({});", "second");
    await run(f, "await tools.effect({});", "first");
    expect(calls).toBe(3);
  });
});

describe("cancellation", () => {
  it("aborts in-flight nested calls and never admits queued ones", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const slow = textTool("bash", async (_params, signal) => {
      seen.push("bash started");
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          seen.push("bash aborted");
          resolve();
        });
        setTimeout(() => controller.abort(), 10);
      });
      throw new Error("Command aborted");
    });
    const write = textTool("write", () => {
      seen.push("write ran");
      return "wrote";
    });
    const f = fixture({ tools: [slow, write] });
    const { details } = await run(
      f,
      "await Promise.allSettled([tools.bash({ command: 'sleep 30' }), tools.write({})]); return 1;",
      "outer",
      controller.signal,
    );
    expect(seen).toEqual(["bash started", "bash aborted"]);
    expect(details.error).toBe("aborted");
  });

  it("runs nothing for a call whose turn was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const f = fixture({
      tools: [textTool("effect", () => String(++calls))],
      signal: controller.signal,
    });
    const { details } = await run(f, "await tools.effect({}); return 1;");
    expect(calls).toBe(0);
    expect(details.error).toBe("aborted");
  });

  it("refuses a judgement for a call cancelled while it waited its turn", async () => {
    const controller = new AbortController();
    const judged: string[] = [];
    const gate: NonNullable<AgentLoopConfig["beforeToolCall"]> = async ({ toolCall }) => {
      judged.push(toolCall.id);
      // The second call queues behind this judgement; the turn is cancelled
      // while it waits there.
      setTimeout(() => controller.abort(), 10);
      await sleep(40);
      return undefined;
    };
    const f = fixture({ tools: [textTool("read", () => "ok")], gate });
    await run(
      f,
      "await Promise.allSettled([tools.read({}), tools.read({})]);",
      "outer",
      controller.signal,
    );
    expect(judged).toEqual(["outer:1"]);
  });

  it("keeps the effect of a call that finished after its signal fired", async () => {
    const controller = new AbortController();
    const journal = new CodeModeJournal();
    let started = 0;
    const unstoppable = textTool("effect", async () => {
      started += 1;
      controller.abort();
      await sleep(10);
      return "started anyway";
    });
    const f = fixture({ tools: [unstoppable], journal });
    const code = "return await tools.effect({});";
    const first = await run(f, code, "outer", controller.signal);
    expect(first.details.nestedCalls.calls[0]!.status).toBe("ok");
    await run(f, code, "outer");
    expect(started).toBe(1);
  });
});

describe("results", () => {
  it("gives bash a typed result for every exit code", async () => {
    const ok = fixture({
      tools: [
        bash(() => ({
          content: [{ type: "text", text: "a\nb" }],
          details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full.txt" },
        })),
      ],
    });
    expect((await run(ok, "return await tools.bash({ command: 'x' });")).text).toContain(
      'Returned: {"output":"a\\nb","exitCode":0,"truncated":true,"fullOutputPath":"/tmp/full.txt"}',
    );
    const empty = fixture({
      tools: [
        bash(() => ({ content: [{ type: "text", text: "(no output)" }], details: undefined })),
      ],
    });
    expect((await run(empty, "return await tools.bash({ command: 'x' });")).text).toContain(
      'Returned: {"output":"","exitCode":0,"truncated":false}',
    );
    const exited = fixture({
      tools: [
        bash(() => {
          throw new Error(
            "partial\n\n[Showing lines 1-2 of 9. Full output: /tmp/x]\n\nCommand exited with code 2",
          );
        }),
      ],
    });
    expect((await run(exited, "return await tools.bash({ command: 'x' });")).text).toContain(
      '"exitCode":2,"truncated":true',
    );
    const silent = fixture({
      tools: [
        bash(() => {
          throw new Error("Command exited with code 1");
        }),
      ],
    });
    expect((await run(silent, "return await tools.bash({ command: 'x' });")).text).toContain(
      'Returned: {"output":"","exitCode":1,"truncated":false}',
    );
    const timedOut = fixture({
      tools: [
        bash(() => {
          throw new Error("Command timed out after 1 seconds");
        }),
      ],
    });
    expect(
      (
        await run(
          timedOut,
          "try { await tools.bash({ command: 'x' }); } catch (e) { return e.message; }",
        )
      ).text,
    ).toContain("Returned: Command timed out after 1 seconds");
  });

  it("gives an MCP tool its server's text, structured content and error flag, and no images", async () => {
    const definition: McpToolDefinition = {
      serverId: "srv",
      toolName: "get",
      providerName: mcpProviderToolName("srv", "Server", "get"),
      description: "Get one record from the server.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { id: { type: "number" } } },
    };
    const mcp = (isError: boolean): AgentTool =>
      resultTool(definition.providerName, {
        content: [
          { type: "text", text: MCP_UNTRUSTED_DATA_WARNING },
          { type: "text", text: "record 7" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        details: {},
        structuredContent: { id: 7 },
        ...(isError ? { isError: true } : {}),
      });
    for (const isError of [false, true]) {
      const f = fixture({
        tools: [{ id: definition.providerName, tool: mcp(isError), verb: false, mcp: definition }],
      });
      const { text, details } = await run(f, `return await tools.${definition.providerName}({});`);
      expect(text).toContain(
        `{"text":"record 7\\n[image image/png left out: Code Mode passes no images to programs]","structuredContent":{"id":7},"isError":${isError},"omittedImages":1}`,
      );
      expect(details.untrusted).toEqual([definition.providerName]);
    }
    // A call that never reached the server is a failure like any other.
    const refused = fixture({
      tools: [
        {
          id: definition.providerName,
          tool: resultTool(definition.providerName, {
            content: [{ type: "text", text: "never sent" }],
            details: {},
            isError: true,
          }),
          verb: false,
          mcp: definition,
        },
      ],
    });
    expect(
      (
        await run(
          refused,
          `try { await tools.${definition.providerName}({}); } catch (e) { return e.message; }`,
        )
      ).text,
    ).toContain("Returned: never sent");
    const { outputSchema: _unused, ...unschemed } = definition;
    const plain = fixture({
      tools: [
        {
          id: definition.providerName,
          tool: resultTool(definition.providerName, {
            content: [{ type: "text", text: "bare" }],
            details: {},
          }),
          verb: false,
          mcp: unschemed,
        },
      ],
    });
    expect(plain.tool.description).toContain("structuredContent?: unknown");
    const empty = fixture({
      tools: [
        {
          id: definition.providerName,
          tool: resultTool(definition.providerName, {
            details: {},
          } as unknown as AgentToolResult<unknown>),
          verb: false,
          mcp: definition,
        },
      ],
    });
    expect((await run(empty, `return await tools.${definition.providerName}({});`)).text).toContain(
      '{"text":"","isError":false,"omittedImages":0}',
    );
    const textOnly = fixture({
      tools: [
        {
          id: definition.providerName,
          tool: resultTool(definition.providerName, {
            content: [
              { type: "text", text: MCP_UNTRUSTED_DATA_WARNING },
              { type: "text", text: "just text" },
            ],
            details: {},
          }),
          verb: false,
          mcp: definition,
        },
      ],
    });
    expect(
      (await run(textOnly, `return await tools.${definition.providerName}({});`)).text,
    ).toContain('{"text":"just text","isError":false,"omittedImages":0}');
    expect((await run(plain, `return await tools.${definition.providerName}({});`)).text).toContain(
      '{"text":"bare","isError":false,"omittedImages":0}',
    );
  });

  it("gives a verb its text and details, and rejects a refused verb", async () => {
    const verb = (result: AgentToolResult<unknown>): SurfaceTool => ({
      id: "session.start",
      tool: resultTool("session_start", result),
      verb: true,
    });
    const started = fixture({
      tools: [
        verb({ content: [{ type: "text", text: "Started." }], details: { sessionId: "s-1" } }),
      ],
    });
    expect((await run(started, "return await tools.session_start({});")).text).toContain(
      'Returned: {"text":"Started.","details":{"sessionId":"s-1"}}',
    );
    const bare = fixture({
      tools: [verb({ content: [{ type: "text", text: "Started." }], details: undefined })],
    });
    expect((await run(bare, "return await tools.session_start({});")).text).toContain(
      'Returned: {"text":"Started."}',
    );
    const refused = fixture({
      tools: [
        verb({ content: [{ type: "text", text: "No." }], details: undefined, isError: true }),
      ],
    });
    expect(
      (await run(refused, "try { await tools.session_start({}); } catch (e) { return e.message; }"))
        .text,
    ).toContain("Returned: No.");
  });

  it("lets no image into a program or out of one", async () => {
    const f = fixture({
      tools: [
        resultTool("read", {
          content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
          details: undefined,
        }),
      ],
    });
    const { text } = await run(
      f,
      `const seen = await tools.read({ path: "pixel.png" }); image("data:image/png;base64,${PNG}"); image("data:image/png;base64,${PNG}"); return seen;`,
    );
    expect(text).toContain("2 images were left out: Code Mode returns no images.");
    expect(text).toContain("[image image/png left out");
    const one = await run(f, `image("data:image/png;base64,${PNG}");`);
    expect(one.text).toContain("1 image was left out");
  });

  it("reports a script error with its stack, and output printed before it", async () => {
    const f = fixture({ tools: [textTool("echo", () => "hi")] });
    const { text, isError, details } = await run(f, 'text("before");\nthrow new Error("boom");');
    expect(isError).toBe(true);
    expect(details.error).toBe("script");
    expect(text).toMatch(/before\nProgram error: Error: boom\n\s+at .*codemode\.js:2/u);
  });

  it("calls a tool with no arguments, and reports a thrown non-Error", async () => {
    const seen: unknown[] = [];
    const f = fixture({
      tools: [
        textTool("echo", (params) => {
          seen.push(params);
          return "hi";
        }),
        resultTool("bare", { details: {} } as unknown as AgentToolResult<unknown>),
      ],
    });
    const { text } = await run(
      f,
      "const a = await tools.echo(); const b = await tools.bare({}); const s = await searchTools(); let d; try { await describeTool(); } catch (e) { d = e.message; } return [a, b, s.length, d, /x/u.source];",
    );
    expect(seen).toEqual([{}]);
    expect(text).toContain(
      'Returned: ["hi","",0,"No code-callable tool is named \\"\\". Try searchTools().","x"]',
    );
    const thrown = await run(f, 'throw "plain";');
    expect(thrown.text).toContain("Program error: ");
  });

  it("marks saved output untrusted when the run read untrusted content", async () => {
    const root = mkdtempSync(join(tmpdir(), "volli-codemode-output-"));
    const output = new ToolOutputStore({ directory: join(root, "out"), workspacePath: root });
    const f = fixture({
      tools: [textTool("web_fetch", () => "page")],
      limits: { maxOutputBytes: 1_024 },
      output,
    });
    const { text, details } = await run(
      f,
      "const page = await tools.web_fetch({}); for (let i = 0; i < 400; i++) text(page + i);",
    );
    expect(text).toContain("--- begin untrusted program output");
    expect(readFileSync(details.output!.fullOutputPath!, "utf8")).toContain(
      "The program read untrusted third-party content",
    );
  });

  it("says when a run made no calls and returned nothing", async () => {
    const f = fixture({ tools: [textTool("echo", () => "hi")] });
    expect((await run(f, "1;")).text).toBe("Program completed in 0.0 s · no calls.");
  });

  it("bounds the nested call record it keeps", async () => {
    const f = fixture({ tools: [textTool("echo", () => "hi")] });
    const { details } = await run(
      f,
      `for (let i = 0; i < 55; i++) await tools.echo({ i });
       await tools.echo({ big: "y".repeat(2000) });
       await tools.echo("not an object");`,
    );
    expect(details.nestedCalls.calls).toHaveLength(50);
    expect(details.nestedCalls.complete).toBe(false);
    const g = fixture({ tools: [textTool("echo", () => "hi")] });
    const big = await run(g, 'await tools.echo({ big: "y".repeat(2000) }); await tools.echo("x");');
    expect(big.details.nestedCalls.calls[0]).toMatchObject({ argumentsBytes: 2010 });
    expect(big.details.nestedCalls.calls[0]).not.toHaveProperty("arguments");
    expect(big.details.nestedCalls.calls[1]).toMatchObject({ argumentsBytes: 3 });
    expect(big.details.nestedCalls.complete).toBe(false);
  });

  it("names failed calls, eight at most", async () => {
    const f = fixture({
      tools: [
        textTool("read", () => {
          throw new Error("nope");
        }),
      ],
    });
    const { text } = await run(
      f,
      "await Promise.allSettled(Array.from({ length: 10 }, () => tools.read({})));",
    );
    expect(text).toContain(
      "10 calls: 0 ok, 10 failed (read #1, read #2, read #3, read #4, read #5, read #6, read #7, read #8, …)",
    );
  });
});

describe("discovery", () => {
  it("lets a program search and describe tools the description left out", async () => {
    const f = fixture({
      tools: [
        textTool("read", () => "x"),
        {
          ...textTool("list_issues", () => "x"),
          description: "List the open issues of a repository.",
        },
        { ...textTool("close_issue", () => "x"), description: "Close one issue." },
      ],
      routes: { list_issues: "deferred", close_issue: "deferred" },
    });
    expect(f.tool.description).not.toContain("list_issues(");
    expect(f.tool.description).toContain("volli (3, 1 declared below)");
    const { text } = await run(
      f,
      `const hits = await searchTools("open issues", { limit: 1 });
       const all = await searchTools("issue");
       const none = await searchTools("issue", { namespace: "mcp:nowhere" });
       const described = await describeTool(hits[0].name);
       let missing;
       try { await describeTool("nothing"); } catch (e) { missing = e.message; }
       return { first: hits[0].name, count: all.length, none: none.length, described, missing };`,
    );
    expect(text).toContain('"first":"list_issues"');
    expect(text).toContain('"count":2');
    expect(text).toContain('"none":0');
    expect(text).toContain("List the open issues of a repository.");
    expect(text).toContain('No code-callable tool is named \\"nothing\\"');
    // Searches and descriptions are not tool calls.
    expect(text).toContain("no calls");
  });

  it("does not offer a direct-only or hidden tool to a program", async () => {
    const f = fixture({
      tools: [
        textTool("ask_user", () => "x"),
        textTool("secret", () => "x"),
        textTool("read", () => "x"),
      ],
      routes: { ask_user: "direct", secret: "hidden" },
    });
    const { text } = await run(f, "return Object.keys(tools);");
    expect(text).toContain('Returned: ["read"]');
    expect((await run(f, "await tools.ask_user({});")).text).toContain(
      "no code-callable tool named ask_user",
    );
  });
});
