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
import { DEFAULT_CODE_MODE_POLICY, decodeSessionEventPayload } from "@volli/shared";
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
          expect.objectContaining({ command: "printf assembly-wired", cwd: root, env: {} }),
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
