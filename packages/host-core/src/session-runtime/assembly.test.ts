import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { piOwnedModelAccess, ALWAYS_ONLINE } from "@volli/agent-runtime";
import {
  createHostCore,
  throwTransactionViolation,
  type HostCorePorts,
  type LiveHostCore,
} from "../index";
import { HEADLESS_ATTENTION, NO_POWER_EVENTS } from "../ports";
import { SecretStore } from "../secrets";
import { SecretService } from "../secrets/service";
import { hostCodeMode } from "../codemode/dev-config";
import { hostMcpDispatch } from "../mcp/dispatch-policy";
import { createTicketSessionDelegationStore } from "./delegation-store";
import { createAttachmentIdentities } from "./attachment-identity";
import { createRuntimeAssembly, type RuntimeAssemblyOptions } from "./assembly";
import * as agentRuntime from "@volli/agent-runtime";
import * as shellPort from "../shell/agent-port";
import { BackgroundShellHost } from "../shell/background-shell-host";
import * as pi from "./pi-adapter";
import * as runtime from "./index";
import * as browser from "../browser/agent-port";
import type { BrowserBackend } from "../browser/backend";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_CODE_MODE_LIMITS,
  decodeSessionEventPayload,
  mcpProviderToolName,
  createToolRefreshDelta,
} from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { testProject } from "../db/test-helpers";
import { createRuntimeContextResolver } from "./context";

let core: LiveHostCore | undefined;
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  await core?.stop("test teardown");
  core = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

function live(): LiveHostCore {
  if (core === undefined) throw new Error("fixture() was not called");
  return core;
}

async function fixture(): Promise<RuntimeAssemblyOptions> {
  root = mkdtempSync(join(tmpdir(), "volli-runtime-assembly-"));
  const hostPorts: HostCorePorts = {
    events: { publish: vi.fn() },
    attention: HEADLESS_ATTENTION,
    power: NO_POWER_EVENTS,
    connectivity: ALWAYS_ONLINE,
    log: { error: vi.fn(), warn: vi.fn() },
  };
  const models = piOwnedModelAccess({ agentDir: join(root, "pi-agent") });
  await models.catalogReady;
  const composed = createHostCore(hostPorts, {
    dataDir: root,
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: false,
    processReaders: { liveSessionIds: () => [], openTerminalCwds: () => [] },
    // The host's model access, so no Pi agent directory outside the fixture is read.
    modelAccess: () => models,
  });
  if (composed.kind !== "live") throw new Error(composed.database.error);
  core = composed;
  vi.spyOn(pi, "createPiRuntimeHost").mockReturnValue({
    adapter: {
      id: "pi",
      durableIdNamespace: "pi",
      adapterVersion: "1",
      runtime: { path: "test", version: "1", fingerprint: "test" },
      attach: async () => {
        throw new Error("assembly test does not attach");
      },
    },
    inspectModelAccess: async () => ({ observedAt: 0, models: [], providers: [] }),
    completeUtility: async () => {
      throw new Error("assembly test does not complete");
    },
  });
  return {
    dbHandle: composed.database,
    sessionEngine: composed.sessionEngine,
    dataDir: root,
    binDir: join(root, "bin"),
    venue: { id: "test-host", kind: "remote" },
    hostPorts,
    modelAccess: models,
    decisions: null,
    webAccess: composed.runtimeServices.webAccess,
    mcpSettings: null,
    mcpDispatch: hostMcpDispatch({ env: {}, packaged: true, log: vi.fn() }),
    codeMode: hostCodeMode({
      env: {},
      packaged: true,
      log: vi.fn(),
      policy: () => DEFAULT_CODE_MODE_POLICY,
      sandboxAvailable: false,
    }),
    observability: null,
    delegation: createTicketSessionDelegationStore(composed.database.db),
    secrets: new SecretService(
      new SecretStore(join(root, "secrets.enc"), {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error("no keys in this test");
        },
        decryptString: () => {
          throw new Error("no keys in this test");
        },
      }),
    ),
    attachmentIdentities: createAttachmentIdentities({
      mint: () => "token",
      revoke: vi.fn(),
      ticketDisplayIdOf: () => null,
    }),
    askUser: false,
    requestSecret: false,
    beforeExecution: vi.fn(async () => {}),
    concurrencyEnvFor: async () => ({}),
    resolveRuntimeContext: vi.fn(async () => null),
    callVerb: async () => {
      throw new Error("assembly test does not call verbs");
    },
  };
}

describe("runtime attachment assembly", () => {
  it("is synchronous and inert, and consumes the host's existing engine", async () => {
    const options = await fixture();
    const read = vi.spyOn(live().sessionEngine, "getSession");
    const events = vi.spyOn(live().sessionEngine, "listEvents");
    const construct = vi.spyOn(runtime, "createHostSessionRuntime");
    const assembled = createRuntimeAssembly(options);
    expect(read).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(options.beforeExecution).not.toHaveBeenCalled();
    expect(construct).toHaveBeenCalledWith(
      expect.objectContaining({ sessionEngine: live().sessionEngine }),
    );
    expect(assembled.sessionToolSurface?.resolve("subagent", [])).toEqual([
      "read",
      "edit",
      "write",
      "execute",
    ]);
    const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
    await expect(native.resolveRuntimeContext("unknown")).resolves.toBeNull();
    expect(options.resolveRuntimeContext).toHaveBeenCalledWith("unknown");
    expect(read).not.toHaveBeenCalled();
    await assembled.sessionRuntime?.close();
  });

  it.each(["execute", "background shell"] as const)(
    "wires %s credential reads through environmentAsync with the Session and signal",
    async (door) => {
      const options = await fixture();
      const environment = { API_TOKEN: "fixture-token" };
      const read = vi.spyOn(options.secrets, "environmentAsync").mockResolvedValue(environment);
      const syncRead = vi.spyOn(options.secrets, "environment").mockReturnValue({});
      const execute = vi.spyOn(agentRuntime, "piExecutionEnv");
      const shell = vi.spyOn(shellPort, "createAgentShellPort");
      const assembled = createRuntimeAssembly({
        ...options,
        shells: new BackgroundShellHost({ publishState: vi.fn(), publishRemoved: vi.fn() }),
      });
      const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
      const scope = {
        sessionId: `${door}-session`,
        role: "project" as const,
        rootThreadId: "thread",
        attachmentId: "attachment",
        projectId: "project",
        ticketId: null,
        workspacePath: root,
      };
      try {
        // Exercise the callbacks supplied by assembly, without spawning a process.
        let hook;
        if (door === "execute") {
          await native.executionEnvFactory!(root, scope);
          hook = execute.mock.calls[0]![1]!.secretEnvironment;
        } else {
          native.resolveShellPort!(scope);
          hook = shell.mock.calls[0]![0].secretEnvironment;
        }
        expect(read).not.toHaveBeenCalled();
        const signal = new AbortController().signal;
        expect(await hook!(signal)).toBe(environment);
        expect(read).toHaveBeenCalledExactlyOnceWith(scope.sessionId, signal);
        expect(syncRead).not.toHaveBeenCalled();
      } finally {
        await assembled.sessionRuntime?.close();
      }
    },
  );

  it.each([true, false])(
    "wires foreground execution only for a frozen surface with all shell tools (supported: %s)",
    async (supported) => {
      const options = await fixture();
      const shells = new BackgroundShellHost({ publishState: vi.fn(), publishRemoved: vi.fn() });
      const execute = vi.spyOn(agentRuntime, "piExecutionEnv");
      const assembled = createRuntimeAssembly({
        ...options,
        shells,
        resolveRuntimeContext: async () => ({
          role: "project",
          projectId: "project",
          ticketId: null,
          rootThreadId: "thread",
          brief: "assembly fixture",
          model: { providerId: "fixture", modelId: "fixture", reasoningLevel: "off" },
          toolSurface: supported
            ? ["execute", "shell_start", "shell_output", "shell_kill"]
            : ["execute", "shell_start", "shell_output"],
          promptResources: [],
        }),
      });
      const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
      const scope = {
        sessionId: "foreground-session",
        attachmentId: "foreground-attachment",
        rootThreadId: "thread",
        role: "project" as const,
        projectId: "project",
        ticketId: null,
      };
      try {
        await native.executionEnvFactory!(root, scope);
        const executor = execute.mock.calls[0]![1]!.foregroundExecutor;
        if (!supported) {
          expect(executor).toBeUndefined();
          return;
        }
        expect(executor).toBeTypeOf("function");
        const chunks: Uint8Array[] = [];
        const ready = vi.fn();
        const run = vi.spyOn(shells, "runForeground");
        const signal = new AbortController().signal;
        expect(
          await executor!({
            command: "printf assembly-wired",
            shellConfig: { shell: "/bin/sh", args: ["-c"] },
            cwd: root,
            env: {},
            toolCallId: "foreground-call",
            timeout: 1,
            signal,
            onOutput: (chunk) => chunks.push(chunk),
            onReady: ready,
          }),
        ).toMatchObject({ code: 0 });
        expect(Buffer.concat(chunks).toString()).toBe("assembly-wired");
        expect(ready).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledWith(
          {
            sessionId: scope.sessionId,
            attachmentId: scope.attachmentId,
            projectId: "project",
            ticketId: null,
          },
          expect.objectContaining({
            command: "printf assembly-wired",
            shellConfig: { shell: "/bin/sh", args: ["-c"] },
            cwd: root,
            env: {},
          }),
          expect.objectContaining({ toolCallId: "foreground-call", timeout: 1, signal }),
        );
      } finally {
        await assembled.sessionRuntime?.close();
        await shells.close();
      }
    },
  );

  it("binds the shared bounded screenshot sink even on a headless host, and recovers its pictures", async () => {
    const options = await fixture();
    const first = createRuntimeAssembly(options);
    const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
    const data = Buffer.alloc(50_000, 201).toString("base64");
    const id = native.persistActivityImage!("session", { data, mimeType: "image/png" })!;
    expect(first.pictures.dataUrl(id)).toBe(`data:image/png;base64,${data}`);
    const second = createRuntimeAssembly(options);
    expect(second.pictures.dataUrl(id)).toBe(`data:image/png;base64,${data}`);
    expect(createRuntimeAssembly({ ...options, pictures: second.pictures }).pictures).toBe(
      second.pictures,
    );
  });

  it("binds the supplied browser before any recovery/attachment can run", async () => {
    const options = await fixture();
    // Only the factory's construction input is under test; it must not drive the engine.
    const backend = {} as BrowserBackend;
    const cursorFor = vi.fn();
    const bind = vi.spyOn(browser, "browserAgentPort");
    const assembled = createRuntimeAssembly({ ...options, browser: { backend, cursorFor } });
    const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
    const scope = {
      sessionId: "session",
      attachmentId: "attachment",
      projectId: "project",
      ticketId: null,
      workspacePath: root,
    };
    const port = native.resolveBrowserPort!(scope);
    expect(port).toBeDefined();
    expect(bind).toHaveBeenCalledWith({
      backend,
      cursorFor,
      scope: { projectId: "project", ticketId: null },
      session: { sessionId: "session", attachmentId: "attachment" },
    });
    expect(assembled.sessionToolSurface?.resolve("subagent", [])).toContain("browser_find");
    await assembled.sessionRuntime?.close();
  });

  it.each([true, false])(
    "freezes the ask_user declaration at new birth only when present (host capability %s)",
    async (askUser) => {
      const options = await fixture();
      const engine = live().sessionEngine;
      const db = live().database.db;
      insertProject(db, testProject({ id: "project", path: root }));
      const provenance = {
        source: { kind: "system", id: "test", detail: null },
        venue: options.venue,
      } as const;
      const { session } = await engine.createSession({
        commandId: "birth",
        projectId: "project",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        provenance,
      });
      await engine.submit({
        commandId: "model",
        sessionId: session.id,
        intent: {
          kind: "model.select",
          selection: { providerId: "scripted", modelId: "test", reasoningLevel: "off" },
        },
        provenance,
      });
      const assembled = createRuntimeAssembly({ ...options, askUser });
      try {
        const surface = assembled.sessionToolSurface!;
        const tools = surface.resolve("project", []);
        expect(tools.includes("ask_user")).toBe(askUser);
        await surface.record(session.id, tools);
        // Read the actual persisted JSON through the codec, not a mocked engine.
        const rows = db
          .prepare("SELECT payload FROM session_events WHERE session_id = ? ORDER BY sequence")
          .all(session.id) as { payload: string }[];
        const frozen = rows
          .map(({ payload }) => decodeSessionEventPayload(JSON.parse(payload), "stored"))
          .find(
            (payload) =>
              payload.kind === "session.input.recorded" && payload.input.kind === "tool-surface",
          );
        expect(frozen).toMatchObject({
          kind: "session.input.recorded",
          input: { kind: "tool-surface", tools },
        });
        if (askUser) expect(frozen).toHaveProperty("input.askUserQuestions", true);
        else expect(frozen).not.toHaveProperty("input.askUserQuestions");
        const context = createRuntimeContextResolver({
          db,
          sessionEngine: engine,
          venue: options.venue,
          mcpDispatch: options.mcpDispatch,
          waitForBirth: async () => {},
          toolSurface: () => {
            throw new Error("reattach must not resolve today's surface");
          },
        });
        const attached = await context(session.id);
        expect(attached?.toolSurface).toEqual(tools);
        if (askUser) expect(attached).toHaveProperty("askUserQuestions", true);
        else expect(attached).not.toHaveProperty("askUserQuestions");
        // A record predating this marker wins even if today's birth writer is called.
        const old = await engine.createSession({
          commandId: "old-birth",
          projectId: "project",
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
          provenance,
        });
        const oldInput = { kind: "tool-surface", tools: ["read", "ask_user"] } as const;
        await engine.getOrRecordSessionInput({
          sessionId: old.session.id,
          input: oldInput,
          provenance,
        });
        await surface.record(old.session.id, tools);
        expect(
          await engine.getOrRecordSessionInput({
            sessionId: old.session.id,
            input: oldInput,
            provenance,
          }),
        ).toEqual(oldInput);
        await engine.submit({
          commandId: "old-model",
          sessionId: old.session.id,
          intent: {
            kind: "model.select",
            selection: { providerId: "scripted", modelId: "test", reasoningLevel: "off" },
          },
          provenance,
        });
        const oldAttach = await context(old.session.id);
        expect(oldAttach?.toolSurface).toEqual(oldInput.tools);
        expect(oldAttach).not.toHaveProperty("askUserQuestions");
      } finally {
        await assembled.sessionRuntime?.close();
      }
    },
  );

  it("recomputes additive effective surfaces and bounds delegate MCP refreshes by their parent", async () => {
    const options = await fixture();
    const engine = live().sessionEngine;
    const db = live().database.db;
    insertProject(db, testProject({ id: "refresh-project", path: root }));
    const model = { providerId: "scripted", modelId: "test", reasoningLevel: "off" } as const;
    const provenance = {
      source: { kind: "system", id: "pi-runtime", detail: null },
      venue: options.venue,
    } as const;
    const one = {
      serverId: "paper",
      toolName: "lookup",
      providerName: "mcp__paper__lookup__12345678",
      description: "Lookup",
      inputSchema: { type: "object", properties: {} },
    } as const;
    const two = {
      ...one,
      toolName: "second",
      providerName: "mcp__paper__second__12345678",
    } as const;
    let selected = [one] as readonly import("@volli/shared").McpToolDefinition[];
    const assembleOptions = {
      ...options,
      codeMode: hostCodeMode({
        env: { VOLLI_DEV_CODE_MODE: '{"mode":"only","mcp":{"paper":"deferred"}}' },
        packaged: false,
        log: vi.fn(),
        policy: () => DEFAULT_CODE_MODE_POLICY,
        sandboxAvailable: true,
      }),
      mcpSettings: {
        surfaceRevision: () => selected.length,
        selectedTools: () => selected,
      } as unknown as RuntimeAssemblyOptions["mcpSettings"],
    };
    const assembled = createRuntimeAssembly(assembleOptions);
    const surface = assembled.sessionToolSurface!;
    const resolver = createRuntimeContextResolver({
      db,
      sessionEngine: engine,
      venue: options.venue,
      mcpDispatch: options.mcpDispatch,
      waitForBirth: async () => {},
      toolSurface: () => surface,
    });
    assembleOptions.resolveRuntimeContext = resolver;
    const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
    async function birth(role: "project" | "subagent", parentSessionId: string | null) {
      const { session } = await engine.createSession({
        commandId: `birth-${role}`,
        projectId: "refresh-project",
        ticketId: null,
        role,
        parentSessionId,
        title: null,
        provenance,
      });
      await engine.submit({
        commandId: `model-${role}`,
        sessionId: session.id,
        intent: { kind: "model.select", selection: model },
        provenance,
      });
      return session.id;
    }
    const parent = await birth("project", null);
    await engine.getOrRecordSessionInput({
      sessionId: parent,
      input: {
        kind: "tool-surface",
        tools: ["read", "codemode"],
        codeMode: { routes: { read: "both" }, limits: DEFAULT_CODE_MODE_LIMITS },
      },
      provenance,
    });
    await native.refreshRuntimeContext!(parent, { trigger: "warm-turn", model });
    expect(await surface.recordedMcp!(parent)).toEqual([one]);
    const child = await birth("subagent", parent);
    const parentTools = await surface.recorded(parent);
    const parentMcp = await surface.recordedMcp!(parent);
    const childBirth = surface.codeModeAt!(model, parentMcp);
    const childTools = surface.resolve("subagent", [], parentTools!, parentMcp, childBirth);
    await surface.record(child, childTools, parentMcp, { codeMode: childBirth });
    selected = [one, two];
    expect(
      (await native.refreshRuntimeContext!(child, { trigger: "warm-turn", model }))?.mcpTools,
    ).toEqual([one]);
    const desired = await native.refreshRuntimeContext!(parent, { trigger: "code-mode", model });
    const reads = vi.spyOn(engine, "listEvents");
    const projections = vi.spyOn(engine, "getSession");
    const writes = vi.spyOn(engine, "recordToolRefresh");
    for (let i = 0; i < 20; i++)
      expect(await native.refreshRuntimeContext!(parent, { trigger: "code-mode", model })).toBe(
        desired,
      );
    expect(reads).not.toHaveBeenCalled();
    expect(projections).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    await native.refreshRuntimeContext!(child, { trigger: "code-mode", model });
    expect(await surface.recordedMcp!(child)).toEqual([one, two]);
    const cold = await native.refreshRuntimeContext!(parent, { trigger: "cold-turn", model });
    expect(cold?.toolSurface).toContain("edit");
    expect(cold?.codeMode?.descriptionVersion).toBe(2);
    const count = (await engine.listEvents({ sessionId: parent })).filter(
      (event) => event.payload.kind === "session.tools.refreshed",
    ).length;
    await native.refreshRuntimeContext!(parent, { trigger: "cold-turn", model });
    expect(
      (await engine.listEvents({ sessionId: parent })).filter(
        (event) => event.payload.kind === "session.tools.refreshed",
      ),
    ).toHaveLength(count);
    await expect(
      native.refreshRuntimeContext!("missing", { trigger: "cold-turn", model }),
    ).resolves.toBeNull();
    await assembled.sessionRuntime?.close();
  });

  it("measures a large-ledger steady Code Mode check without rereading history or rewriting schemas", async () => {
    const options = await fixture();
    const engine = live().sessionEngine;
    const db = live().database.db;
    insertProject(db, testProject({ id: "benchmark-project", path: root }));
    const model = { providerId: "scripted", modelId: "test", reasoningLevel: "off" } as const;
    const provenance = {
      source: { kind: "system", id: "benchmark", detail: null },
      venue: options.venue,
    } as const;
    const definitions = Array.from({ length: 100 }, (_, i) => ({
      serverId: "large",
      toolName: `tool${i}`,
      providerName: mcpProviderToolName("large", "Large", `tool${i}`),
      description: "Catalog text ".repeat(100),
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 20 }, (_property, j) => [
            `property${j}`,
            { type: "string", description: "Schema detail ".repeat(20) },
          ]),
        ),
      },
    }));
    let revision = 0;
    const assembledOptions = {
      ...options,
      codeMode: hostCodeMode({
        env: { VOLLI_DEV_CODE_MODE: '{"mode":"only","mcp":{"large":"deferred"}}' },
        packaged: false,
        log: vi.fn(),
        policy: () => DEFAULT_CODE_MODE_POLICY,
        sandboxAvailable: true,
      }),
      mcpSettings: {
        surfaceRevision: () => revision,
        selectedTools: () => definitions,
      } as unknown as RuntimeAssemblyOptions["mcpSettings"],
    };
    const assembled = createRuntimeAssembly(assembledOptions);
    const surface = assembled.sessionToolSurface!;
    assembledOptions.resolveRuntimeContext = createRuntimeContextResolver({
      db,
      sessionEngine: engine,
      venue: options.venue,
      mcpDispatch: options.mcpDispatch,
      waitForBirth: async () => {},
      toolSurface: () => surface,
    });
    const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
    const { session } = await engine.createSession({
      commandId: "benchmark-create",
      projectId: "benchmark-project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance,
    });
    await engine.submit({
      commandId: "benchmark-model",
      sessionId: session.id,
      intent: { kind: "model.select", selection: model },
      provenance,
    });
    const mode = surface.codeModeAt!(model, definitions);
    const tools = surface.resolve("project", [], undefined, definitions, mode);
    await surface.record(session.id, tools, definitions, { codeMode: mode });
    const raw = db
      .prepare(
        "SELECT id, sequence FROM session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(session.id) as { id: string; sequence: number };
    const append = db.prepare(
      `INSERT INTO session_events (id,session_id,sequence,occurred_at,recorded_at,provenance_id,attachment_id,command_id,payload) SELECT ?,session_id,?,occurred_at,recorded_at,provenance_id,NULL,NULL,? FROM session_events WHERE id = ?`,
    );
    db.transaction(() => {
      for (let i = 1; i <= 10_000; i++)
        append.run(
          `benchmark-history-${i}`,
          raw.sequence + i,
          JSON.stringify({
            kind: "adapter.observed",
            attachmentId: null,
            name: "large ledger history",
            native: null,
          }),
          raw.id,
        );
    })();
    await native.refreshRuntimeContext!(session.id, { trigger: "warm-turn", model });
    const measure = async (trigger: "warm-turn" | "code-mode", count: number) => {
      const times: number[] = [];
      for (let i = 0; i < count; i++) {
        const start = performance.now();
        await native.refreshRuntimeContext!(session.id, { trigger, model });
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      return {
        samples: count,
        p50Ms: times[Math.floor(count * 0.5)],
        p95Ms: times[Math.floor(count * 0.95)],
      };
    };
    // Both triggers use identical warm policy. warm-turn deliberately bypasses
    // the new gate, measuring the old full-check path in the same implementation.
    const before = await measure("warm-turn", 10);
    const reads = vi.spyOn(engine, "listEvents");
    const writes = vi.spyOn(engine, "recordToolRefresh");
    const after = await measure("code-mode", 100);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    revision++;
    await native.refreshRuntimeContext!(session.id, { trigger: "code-mode", model });
    expect(reads).toHaveBeenCalled();
    expect(writes).toHaveBeenCalledOnce();
    const birth = (await engine.listEvents({ sessionId: session.id })).find(
      (event) =>
        event.payload.kind === "session.input.recorded" &&
        event.payload.input.kind === "tool-surface",
    )!.payload;
    if (birth.kind !== "session.input.recorded" || birth.input.kind !== "tool-surface")
      throw new Error("Missing benchmark surface");
    const next = { ...birth.input, refreshDescriptions: true as const };
    const storage = {
      fullSurfaceBytes: Buffer.byteLength(
        JSON.stringify({
          kind: "session.tools.refreshed",
          trigger: "cold-turn",
          added: [],
          changed: ["mcp.tools"],
          surface: next,
        }),
      ),
      deltaBytes: Buffer.byteLength(
        JSON.stringify({
          kind: "session.tools.refreshed",
          trigger: "cold-turn",
          added: [],
          changed: ["mcp.tools"],
          delta: createToolRefreshDelta({ ...birth.input, refreshDescriptions: undefined }, next),
        }),
      ),
    };
    console.log(
      "VC756_REFRESH_BENCHMARK",
      JSON.stringify({ historyEvents: 10_000, mcpTools: 100, before, after, storage }),
    );
    await assembled.sessionRuntime?.close();
  }, 60_000);

  it("keeps a removed MCP tool attached and returns its named unavailable result without opening a transport", async () => {
    const options = await fixture();
    const open = vi.fn();
    const assembled = createRuntimeAssembly({
      ...options,
      mcpSettings: {
        list: () => [],
        opener: () => open,
        credentials: {},
      } as unknown as RuntimeAssemblyOptions["mcpSettings"],
    });
    const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
    const port = native.resolveMcpPort!({
      projectId: "project",
      sessionId: "session",
      attachmentId: "attachment",
      workspacePath: root,
      mcpTools: [
        {
          serverId: "removed",
          toolName: "lookup",
          providerName: "mcp__removed__lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
        },
      ],
    });
    try {
      expect(
        await port.call(
          { serverId: "removed", toolName: "lookup", arguments: {}, toolCallId: "call" },
          new AbortController().signal,
        ),
      ).toMatchObject({
        isError: true,
        content: [
          { type: "text", text: "MCP tool lookup is unavailable: its server was removed." },
        ],
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      await port.dispose();
      await assembled.sessionRuntime?.close();
    }
  });

  it("answers a disabled server's retained tool by name without opening it, and calls it again once enabled (VC-771)", async () => {
    const options = await fixture();
    const configured = {
      id: "paper",
      name: "Paper",
      enabled: false,
      transport: { type: "stdio" as const, command: "paper", args: [] },
    };
    const open = vi.fn(async () => ({
      listTools: async () => [],
      callTool: async () => ({ content: [{ type: "text", text: "lookup ok" }], isError: false }),
      close: async () => undefined,
    }));
    const assembled = createRuntimeAssembly({
      ...options,
      mcpSettings: {
        list: () => [configured],
        opener: () => open,
        credentials: { revision: () => 0, accessRevision: () => 0 },
      } as unknown as RuntimeAssemblyOptions["mcpSettings"],
    });
    const native = vi.mocked(pi.createPiRuntimeHost).mock.calls[0]![0];
    const port = native.resolveMcpPort!({
      projectId: "project",
      sessionId: "session",
      attachmentId: "attachment",
      workspacePath: root,
      mcpTools: [
        {
          serverId: "paper",
          toolName: "lookup",
          providerName: "mcp__paper__lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
        },
      ],
    });
    const call = { serverId: "paper", toolName: "lookup", arguments: {}, toolCallId: "call" };
    try {
      expect(await port.call(call, new AbortController().signal)).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: "MCP tool lookup is unavailable: its server is disabled in Settings. Ask the person to enable it.",
          },
        ],
      });
      expect(open).not.toHaveBeenCalled();
      configured.enabled = true;
      expect(await port.call(call, new AbortController().signal)).toEqual({
        isError: false,
        content: [{ type: "text", text: "lookup ok" }],
      });
      expect(open).toHaveBeenCalledOnce();
    } finally {
      await port.dispose();
      await assembled.sessionRuntime?.close();
    }
  });

  it("keeps an unavailable database inert instead of constructing an executor", async () => {
    const options = await fixture();
    const assembled = createRuntimeAssembly({
      ...options,
      dbHandle: { ok: false, error: "unavailable" },
      sessionEngine: null,
      delegation: null,
      webAccess: null,
      modelAccess: null,
    });
    expect(assembled.sessionRuntime).toBeNull();
    expect(assembled.sessionToolSurface).toBeNull();
    expect(pi.createPiRuntimeHost).not.toHaveBeenCalled();
  });
});
