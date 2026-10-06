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
import { desktopCodeMode } from "../codemode/dev-config";
import { desktopMcpDispatch } from "../mcp/dispatch-policy";
import { createTicketSessionDelegationStore } from "./delegation-store";
import { createAttachmentIdentities } from "./attachment-identity";
import { createRuntimeAssembly, type RuntimeAssemblyOptions } from "./assembly";
import * as pi from "./pi-adapter";
import * as runtime from "./index";
import * as browser from "../browser/agent-port";
import type { BrowserBackend } from "../browser/backend";
import { DEFAULT_CODE_MODE_POLICY } from "@volli/shared";

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
    mcpDispatch: desktopMcpDispatch({ env: {}, packaged: true, log: vi.fn() }),
    codeMode: desktopCodeMode({
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
    const construct = vi.spyOn(runtime, "createDesktopSessionRuntime");
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
