import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, type ExecutionEnv } from "./harness-env";
import { Type } from "@earendil-works/pi-ai";
import {
  codeModeSurfaceFor,
  NON_CODING_TOOL_IDS,
  resolveAgentToolSurface,
  sessionToolBindings,
  sessionToolIds,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import { piExecutionEnv, sessionCommandEnvironment } from "./execution-env";
import { ScopedExecutionEnv, type ScopedExecutionEnvOptions } from "./scoped-execution-env";
import {
  createRequestSecretTool,
  privateSecretExecution,
  redactToolResults,
  type SecretPort,
} from "./secrets";
import { ToolOutputStore } from "./tool-output";
import { createSessionTools } from "./tools";

const SECRET = "secret-example-123";
function secretPort(outcome: "signed in" | "declined" | "still missing" = "signed in"): SecretPort {
  return {
    request: vi.fn(async () => outcome),
    redact: (text) => text.replaceAll(SECRET, "[redacted]"),
  };
}
function fixtureTool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "fixture",
    label: "fixture",
    description: "fixture",
    parameters: Type.Object({}),
    execute,
  };
}
const signal = new AbortController().signal;

describe("request_secret", () => {
  it("appends its vocabulary and binding, port-gated like ask_user, withheld for subagents", () => {
    const secret = secretPort();
    expect(NON_CODING_TOOL_IDS.at(-1)).toBe("request_secret");
    expect(sessionToolIds({ tools: { tools: [] } })).toEqual([]);
    expect(sessionToolBindings({ tools: { tools: [] }, secret })).toEqual([
      { tool: "request_secret", port: secret },
    ]);
    for (const role of ["project", "ticket", "subagent"] as const) {
      const surface = resolveAgentToolSurface({
        role,
        capabilities: { coding: [], interaction: ["request_secret"] },
      });
      expect(surface.includes("request_secret")).toBe(role !== "subagent");
    }
    expect(
      createSessionTools({ tools: { tools: [] }, secret }, null as never).map((tool) => tool.name),
    ).toEqual(["request_secret"]);
  });

  it.each(["signed in", "declined", "still missing"] as const)(
    "returns only the fixed outcome %s",
    async (outcome) => {
      const port = secretPort(outcome);
      const tool = createRequestSecretTool(port);
      expect(Object.keys(tool.parameters.properties)).toEqual(["name", "purpose"]);
      expect(tool.parameters).toHaveProperty("additionalProperties", false);
      expect(
        await tool.execute("call-1", { name: "API_TOKEN", purpose: "Deploy" }, signal),
      ).toEqual({
        content: [{ type: "text", text: outcome }],
        details: undefined,
      });
      expect(port.request).toHaveBeenCalledWith(
        { name: "API_TOKEN", purpose: "Deploy", toolCallId: "call-1" },
        expect.any(AbortSignal),
      );
    },
  );

  it.each([
    { name: "API_TOKEN", value: SECRET },
    { name: "API_TOKEN", scope: "project" },
    { name: "API_TOKEN", prefill: SECRET },
    { name: "API_TOKEN", additional: "ignored?" },
    { name: "lowercase" },
    { name: "1TOKEN" },
    { name: "TOKEN\n" },
    { name: "TOKEN; echo bad" },
    { name: "TOKEN", purpose: 1 },
    { name: "TOKEN", purpose: "p".repeat(501) },
    { name: "T".repeat(129) },
    {},
    null,
    [],
    1,
  ])("rejects malformed/extra fields before the host is called: %j", async (input) => {
    const port = secretPort();
    await expect(
      createRequestSecretTool(port).execute("call-1", input as never, signal),
    ).rejects.toThrow("accepts only an uppercase environment name");
    expect(port.request).not.toHaveBeenCalled();
  });

  it("never relays a host's malformed outcome", async () => {
    const port = secretPort();
    port.request = async () => SECRET as never;
    await expect(
      createRequestSecretTool(port).execute("call", { name: "TOKEN" }, signal),
    ).rejects.toThrow("no safe outcome");
  });

  it.each(["attachment", "call"] as const)(
    "combines and releases the %s cancellation signal",
    async (which) => {
      const attachment = new AbortController();
      const call = new AbortController();
      const held = Promise.withResolvers<"declined">();
      let received: AbortSignal | undefined;
      const port = secretPort();
      port.request = async (_input, combined) => {
        received = combined;
        return held.promise;
      };
      const pending = createRequestSecretTool(port, attachment.signal).execute(
        "call",
        { name: "TOKEN" },
        call.signal,
      );
      (which === "attachment" ? attachment : call).abort();
      expect(received?.aborted).toBe(true);
      held.resolve("declined");
      await pending;
      const completed = new AbortController();
      await createRequestSecretTool(
        {
          ...port,
          request: async (_input, combined) => {
            received = combined;
            return "declined";
          },
        },
        completed.signal,
      ).execute("call-2", { name: "TOKEN" }, signal);
      completed.abort();
      expect(received?.aborted).toBe(false);
    },
  );

  it("forwards already-aborted cancellation", async () => {
    const port = secretPort();
    port.request = async (_input, combined) => {
      expect(combined.aborted).toBe(true);
      return "declined";
    };
    await createRequestSecretTool(port, AbortSignal.abort()).execute(
      "call",
      { name: "TOKEN" },
      signal,
    );
  });
});

describe("tool result credential boundary", () => {
  it.each([
    { credential: "731942", primitive: 731942, redacted: "[redacted]" },
    { credential: "194", primitive: 731942, redacted: "73[redacted]2" },
    { credential: "true", primitive: true, redacted: "[redacted]" },
    { credential: "false", primitive: false, redacted: "[redacted]" },
    { credential: "rue", primitive: true, redacted: "t[redacted]" },
  ])(
    "scrubs credential $credential in numeric/boolean result data without changing safe primitives",
    async ({ credential, primitive, redacted }) => {
      const port = {
        ...secretPort(),
        redact: (text: string) => text.replaceAll(credential, "[redacted]"),
      };
      const safe = [17, -0, null];
      const data = { credential: primitive, nested: [primitive, { value: primitive }], safe };
      // MCP-shaped data can live anywhere in a result, not only its text blocks.
      const result = {
        content: [{ type: "text" as const, text: "MCP fixture" }],
        structuredContent: data,
        details: data,
        result: data,
      };
      const updates: AgentToolResult<unknown>[] = [];
      const tool = redactToolResults(
        fixtureTool(async (_id, _params, _signal, update) => {
          update?.(result);
          return result;
        }),
        port,
      );
      const final = await tool.execute("mcp-call", {}, signal, (partial) => updates.push(partial));
      const expected = { credential: redacted, nested: [redacted, { value: redacted }], safe };
      expect(final).toEqual({
        ...result,
        structuredContent: expected,
        details: expected,
        result: expected,
      });
      expect(updates).toEqual([final]);
      expect(result.structuredContent.credential).toBe(primitive);
      expect(Object.is((final.details as typeof data).safe[1], -0)).toBe(true);
      // Also cover a primitive at the root of the details/structured payload.
      const rootResult = await redactToolResults(
        fixtureTool(async () => ({
          content: [],
          details: primitive,
          structuredContent: primitive,
        })),
        port,
      ).execute("root-call", {}, signal);
      expect(rootResult.details).toBe(redacted);
      expect(rootResult.structuredContent).toBe(redacted);
    },
  );

  it("preserves unmatched numbers and booleans and fails closed for primitive redaction errors", async () => {
    const details = [17, 0, -0, 0.5, true, false, null];
    const raw = fixtureTool(async () => ({ content: [], details }));
    const final = await redactToolResults(raw, secretPort()).execute("safe", {}, signal);
    expect(final.details).toEqual(details);
    expect(Object.is((final.details as number[])[2], -0)).toBe(true);
    const broken = {
      ...secretPort(),
      redact: (text: string) => {
        if (text === "content" || text === "details") return text;
        throw new Error(SECRET);
      },
    };
    const withheld = await redactToolResults(raw, broken).execute("broken", {}, signal);
    expect(withheld.details).toEqual([
      ...Array(6).fill("[Text withheld: credential redaction failed.]"),
      null,
    ]);
  });

  it("scrubs final and partial strings recursively, including details, structuredContent and keys", async () => {
    const result: AgentToolResult<unknown> = {
      content: [
        { type: "text", text: `echo ${SECRET}` },
        { type: "image", data: "dGVzdA==", mimeType: "image/png" },
      ],
      details: { [SECRET]: [SECRET, { nested: SECRET }, 1, null, true] },
      structuredContent: { token: SECRET },
    };
    const updates: AgentToolResult<unknown>[] = [];
    const tool = redactToolResults(
      fixtureTool(async (_id, _params, _signal, update) => {
        update?.(result);
        return result;
      }),
      secretPort(),
    );
    const final = await tool.execute("call", {}, signal, (update) => updates.push(update));
    expect(updates).toEqual([final]);
    expect(JSON.stringify(final)).not.toContain(SECRET);
    expect(final.structuredContent).toEqual({ token: "[redacted]" });
    expect(final.content[1]).toEqual({
      type: "text",
      text: "[Image withheld while secure credentials are enabled.]",
    });
    expect(JSON.stringify(result)).toContain(SECRET); // Never mutate a tool's object.
  });

  it.each([new Error(`failure ${SECRET}`, { cause: new Error(SECRET) }), SECRET])(
    "scrubs thrown errors and discards causes/stacks",
    async (failure) => {
      const tool = redactToolResults(
        fixtureTool(async () => {
          throw failure;
        }),
        secretPort(),
      );
      try {
        await tool.execute("call", {}, signal);
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("[redacted]");
        expect((error as Error).stack).not.toContain(SECRET);
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );

  it("withholds text if redaction itself fails and preserves unwired tools", async () => {
    const raw = fixtureTool(async () => ({
      content: [{ type: "text", text: SECRET }],
      details: {},
    }));
    expect(redactToolResults(raw, undefined)).toBe(raw);
    const broken = {
      ...secretPort(),
      redact: () => {
        throw new Error(SECRET);
      },
    };
    const result = await redactToolResults(raw, broken).execute("call", {}, signal);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("scrubs a bound verb's output and structured details before returning them", async () => {
    const tools = createSessionTools(
      {
        tools: { tools: [], verbs: ["session.stop"] },
        secret: secretPort(),
        callVerb: async () => ({ text: SECRET, details: { receipt: SECRET } }),
      },
      null as never,
    );
    const tool = tools.find((entry) => entry.name === "session_stop")!;
    const result = await tool.execute("verb-call", { session: "s" }, signal);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.details).toEqual({ receipt: "[redacted]" });
  });

  it("wraps Code Mode itself and every nested bound tool", async () => {
    const secret = secretPort();
    const tools = ["ask_user", "request_secret"] as const;
    const codeMode = codeModeSurfaceFor({ tools });
    let nested: AgentTool | undefined;
    const declared = createSessionTools(
      {
        tools: { tools: [], codeMode },
        secret,
        askUser: async () => ({ optionIds: [], response: SECRET }),
      },
      null as never,
      undefined,
      (_surface, surfaceTools) => {
        nested = surfaceTools.find((entry) => entry.id === "ask_user")!.tool;
        return fixtureTool(async (_id, _params, _signal, update) => {
          const result = {
            content: [{ type: "text" as const, text: SECRET }],
            details: { nested: SECRET },
          };
          update?.(result);
          return result;
        });
      },
    );
    expect(
      JSON.stringify(await nested!.execute("nested", { question: "Question?" }, signal)),
    ).not.toContain(SECRET);
    const codemode = declared.find((tool) => tool.name === "fixture")!;
    const updates: unknown[] = [];
    expect(
      JSON.stringify(
        await codemode.execute("code", {}, signal, (partial) => updates.push(partial)),
      ),
    ).not.toContain(SECRET);
    expect(JSON.stringify(updates)).not.toContain(SECRET);
  });

  it("scrubs real read and execute results, including streamed execute updates", async () => {
    const root = await mkdtemp(join(process.cwd(), ".volli-secrets-test-"));
    const env = await piExecutionEnv(root, { secretEnvironment: () => ({ API_TOKEN: SECRET }) });
    try {
      await writeFile(join(root, "output.txt"), SECRET);
      const created = createSessionTools(
        { tools: { tools: ["read", "execute"] }, secret: secretPort() },
        env,
      );
      const read = created.find((tool) => tool.name === "read")!;
      const execute = created.find((tool) => tool.name === "bash")!;
      const readResult = await read.execute("read", { path: "output.txt" }, signal);
      expect(JSON.stringify(readResult)).toContain("[redacted]");
      expect(JSON.stringify(readResult)).not.toContain(SECRET);
      const updates: unknown[] = [];
      const execResult = await execute.execute(
        "exec",
        { command: 'printf "%s" "$API_TOKEN"' },
        signal,
        (partial) => updates.push(partial),
      );
      expect(JSON.stringify(execResult)).toContain("[redacted]");
      expect(JSON.stringify([execResult, updates])).not.toContain(SECRET);
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("dynamic credential environment", () => {
  it("layers secrets over regular variables and below identity, evaluating each command", () => {
    let token = "first";
    const options = {
      environment: { API_TOKEN: "regular", VOLLI_SESSION: "regular" },
      secretEnvironment: () => ({ API_TOKEN: token, VOLLI_SESSION: "secret" }),
      identity: { sessionId: "identity", ticketDisplayId: null },
    };
    expect(sessionCommandEnvironment({}, options)).toMatchObject({
      API_TOKEN: "first",
      VOLLI_SESSION: "identity",
    });
    token = "second";
    expect(sessionCommandEnvironment({}, options)).toMatchObject({
      API_TOKEN: "second",
      VOLLI_SESSION: "identity",
    });
  });

  it.each(["default", "scoped"] as const)(
    "injects newly supplied credentials at exec on the %s path",
    async (path) => {
      const root = await mkdtemp(join(process.cwd(), ".volli-secrets-test-"));
      let token = "first";
      const options = {
        secretEnvironment: () => ({ API_TOKEN: token, VOLLI_SESSION: "not-the-identity" }),
        environment: { API_TOKEN: "regular" },
        identity: { sessionId: "identity", ticketDisplayId: null },
      };
      let config: ReturnType<NonNullable<ScopedExecutionEnvOptions["sandbox"]>["getConfig"]>;
      const sandbox: NonNullable<ScopedExecutionEnvOptions["sandbox"]> = {
        isSupportedPlatform: () => true,
        isSandboxingEnabled: () => config !== undefined,
        checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
        initialize: async (next) => {
          config = next;
        },
        getConfig: () => config,
        wrapWithSandboxArgv: async (command) => ({
          argv: ["/bin/bash", "-c", command],
          env: { PATH: "/usr/bin:/bin" },
        }),
        cleanupAfterCommand: () => {},
      };
      const env =
        path === "default"
          ? await piExecutionEnv(root, options)
          : await ScopedExecutionEnv.create(root, { ...options, sandbox, processKill: () => {} });
      try {
        const [execute] = createSessionTools({ tools: { tools: ["execute"] } }, env);
        const run = () =>
          execute!.execute(
            "call",
            { command: 'printf "%s:%s" "$API_TOKEN" "$VOLLI_SESSION"' },
            signal,
          );
        expect(JSON.stringify(await run())).toContain("first:identity");
        token = "second";
        expect(JSON.stringify(await run())).toContain("second:identity");
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("credential output privacy before disk spill", () => {
  it.each([false, true, "failed"] as const)(
    "only withholds images once values exist (%s)",
    async (active) => {
      const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
      const port = {
        ...secretPort(),
        hasValues: () => {
          if (active === "failed") throw new Error("unavailable");
          return active;
        },
      };
      const result = await redactToolResults(
        fixtureTool(async () => ({ content: [image], details: undefined })),
        port,
      ).execute("c", {}, signal);
      expect(result.content[0]?.type).toBe(active === false ? "image" : "text");
    },
  );
  it("passes through ordinary environments and disables spill dynamically, failing closed", async () => {
    const exec = vi.fn<ExecutionEnv["exec"]>(async () => ({
      ok: true,
      value: {
        exitCode: 0,
        truncation: {
          truncated: false,
          truncatedBy: null,
          totalLines: 0,
          totalBytes: 0,
          outputLines: 0,
          outputBytes: 0,
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 1,
          maxBytes: 10,
        },
      },
    }));
    const exists = vi.fn(async () => ({ ok: true, value: true }));
    const env = { cwd: "/workspace", exec, exists } as unknown as ExecutionEnv;
    expect(privateSecretExecution(env, undefined)).toBe(env);
    let active: boolean | "failed" = false;
    const port = {
      ...secretPort(),
      hasValues: () => {
        if (active === "failed") throw new Error("unavailable");
        return active;
      },
    };
    const wrapped = privateSecretExecution(env, port);
    expect(wrapped.cwd).toBe("/workspace");
    await wrapped.exists("x", BACKGROUND_CONTEXT);
    expect(exists).toHaveBeenCalled();
    const options = { capture: { limits: { maxBytes: 10, maxLines: 1 }, spill: true } };
    await wrapped.exec("x", options, BACKGROUND_CONTEXT);
    expect(exec.mock.calls.at(-1)?.[1]).toBe(options);
    for (const next of [true, "failed"] as const) {
      active = next;
      await wrapped.exec("x", options, BACKGROUND_CONTEXT);
      expect(exec.mock.calls.at(-1)?.[1]).toMatchObject({ capture: { spill: false } });
    }
    await wrapped.exec("x", undefined, BACKGROUND_CONTEXT);
    expect(exec.mock.calls.at(-1)?.[1]).toBeUndefined();
    await privateSecretExecution(env, secretPort()).exec("x", options, BACKGROUND_CONTEXT);
    expect(exec.mock.calls.at(-1)?.[1]).toMatchObject({ capture: { spill: false } });
  });
  it("scrubs saved output before writing and refuses a file when redaction fails", async () => {
    const root = await mkdtemp(join(process.cwd(), ".secret-save-test-"));
    try {
      const saved = await new ToolOutputStore({
        directory: join(root, "saved"),
        workspacePath: root,
        redact: secretPort().redact,
      }).save({ callId: "c", header: SECRET, text: SECRET });
      expect(saved.saved).toBe(true);
      if (saved.saved)
        expect(await (await import("node:fs/promises")).readFile(saved.path, "utf8")).toBe(
          "[redacted]\n\n[redacted]",
        );
      const failed = await new ToolOutputStore({
        directory: join(root, "failed"),
        workspacePath: root,
        redact: () => {
          throw new Error(SECRET);
        },
      }).save({ callId: "c", header: SECRET, text: SECRET });
      expect(failed).toMatchObject({ saved: false, reason: "credential redaction failed" });
      expect(JSON.stringify(failed)).not.toContain(SECRET);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
