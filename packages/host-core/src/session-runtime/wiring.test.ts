/**
 * The Session services learn which bindings are open and observe each folded
 * projection for scheduled resume through two internal wire calls (VC-632):
 * `createRuntimeAssembly` wires its runtime's `openNativeBindings()` reader,
 * and `createSessionRuntimeLifecycle` wires its scheduled-resume observer.
 *
 * Both hosts compose the same way: `createHostCore`, then the assembly and the
 * lifecycle over `host.sessionEngine`. This test runs that composition for
 * real, commits a Session through the composed engine, and asserts each wired
 * callback is reached exactly once per fold. Removing either wire call leaves
 * the services on their inert defaults (nothing open, nothing scheduled), and
 * this test fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ALWAYS_ONLINE, piOwnedModelAccess } from "@volli/agent-runtime";
import { DEFAULT_CODE_MODE_POLICY } from "@volli/shared";
import {
  createHostCore,
  throwTransactionViolation,
  type HostCorePorts,
  type LiveHostCore,
} from "../index";
import { HEADLESS_ATTENTION, NO_POWER_EVENTS } from "../ports";
import { insertProject } from "../db/projects-repo";
import { testProject } from "../db/test-helpers";
import { SecretStore } from "../secrets";
import { SecretService } from "../secrets/service";
import { desktopCodeMode } from "../codemode/dev-config";
import { desktopMcpDispatch } from "../mcp/dispatch-policy";
import * as control from "../session-control";
import { createAttachmentIdentities } from "./attachment-identity";
import { createRuntimeAssembly } from "./assembly";
import { createTicketSessionDelegationStore } from "./delegation-store";
import { createSessionRuntimeLifecycle, type SessionRuntimeLifecycle } from "./lifecycle";
import * as pi from "./pi-adapter";

let core: LiveHostCore | undefined;
let lifecycle: SessionRuntimeLifecycle<unknown> | undefined;
let root: string | undefined;
afterEach(async () => {
  await lifecycle?.close();
  lifecycle = undefined;
  core?.sessionActivityWatch.stop();
  await core?.stop("test teardown");
  core = undefined;
  vi.restoreAllMocks();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** `createHostCore` exactly as a host calls it, over a fixture data directory. */
async function composedHost() {
  root = mkdtempSync(join(tmpdir(), "volli-runtime-wiring-"));
  const ports: HostCorePorts = {
    events: { publish: vi.fn() },
    attention: HEADLESS_ATTENTION,
    power: NO_POWER_EVENTS,
    connectivity: ALWAYS_ONLINE,
    log: { error: vi.fn(), warn: vi.fn() },
  };
  const models = piOwnedModelAccess({ agentDir: join(root, "pi-agent") });
  await models.catalogReady;
  const composed = createHostCore(ports, {
    dataDir: root,
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: false,
    processReaders: { liveSessionIds: () => [], openTerminalCwds: () => [] },
    modelAccess: () => models,
  });
  if (composed.kind !== "live") throw new Error(composed.database.error);
  core = composed;
  insertProject(composed.database.db, testProject({ id: "project" }));
  // The executor is the one stand-in: no Pi process, and nothing here attaches.
  vi.spyOn(pi, "createPiRuntimeHost").mockReturnValue({
    adapter: {
      id: "pi",
      durableIdNamespace: "pi",
      adapterVersion: "1",
      runtime: { path: "test", version: "1", fingerprint: "test" },
      attach: async () => {
        throw new Error("wiring test does not attach");
      },
    },
    inspectModelAccess: async () => ({ observedAt: 0, models: [], providers: [] }),
    completeUtility: async () => {
      throw new Error("wiring test does not complete");
    },
  });
  return { host: composed, ports, models, root };
}

function assemble({
  host,
  ports,
  models,
  root: dataDir,
}: Awaited<ReturnType<typeof composedHost>>) {
  return createRuntimeAssembly({
    dbHandle: host.database,
    sessionEngine: host.sessionEngine,
    dataDir,
    binDir: join(dataDir, "bin"),
    venue: { id: "test-host", kind: "remote" },
    hostPorts: ports,
    modelAccess: models,
    decisions: null,
    webAccess: host.runtimeServices.webAccess,
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
    delegation: createTicketSessionDelegationStore(host.database.db),
    secrets: new SecretService(
      new SecretStore(join(dataDir, "secrets.enc"), {
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
      throw new Error("wiring test does not call verbs");
    },
  });
}

/** The lifecycle as both hosts build it, with the scheduled-resume observer recorded. */
function startLifecycle(
  host: LiveHostCore,
  ports: HostCorePorts,
  runtime: ReturnType<typeof assemble>["sessionRuntime"],
) {
  const observe = vi.fn().mockName("scheduled-resume observe");
  const real = control.createScheduledResumeHost;
  vi.spyOn(control, "createScheduledResumeHost").mockImplementation((resumePorts) => {
    const resume = real(resumePorts);
    return {
      ...resume,
      observe: (projection) => {
        observe(projection.session.id);
        resume.observe(projection);
      },
    };
  });
  lifecycle = createSessionRuntimeLifecycle({
    host,
    ports,
    runtime,
    rpc: () => null,
    observability: null,
    delegation: null,
    delegationsFor: () => null,
    services: () => ({}),
    installQuitHold: () => {},
    stopProducers: () => {},
  });
  return { observe, lifecycle };
}

/** Births one Session through the composed engine and waits for its fold to publish. */
async function commitSession(host: LiveHostCore, commandId: string): Promise<string> {
  const created = await host.sessionEngine.createSession({
    commandId,
    projectId: "project",
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: commandId,
    provenance: {
      source: { kind: "system", id: "test", detail: null },
      venue: { id: "local", kind: "local" },
    },
  });
  await host.sessionActivityWatch.flush();
  return created.session.id;
}

describe("Session runtime wiring through the real host composition", () => {
  it("reaches the assembly's open-bindings reader and the lifecycle's resume observer, once each", async () => {
    const composed = await composedHost();
    const { host, ports } = composed;

    // Before the runtime exists the services fold on their inert defaults.
    await commitSession(host, "before-the-runtime");

    const assembled = assemble(composed);
    const runtime = assembled.sessionRuntime;
    if (runtime === null) throw new Error("the assembly built no Session runtime");
    const openNativeBindings = vi.spyOn(runtime, "openNativeBindings");
    const { observe } = startLifecycle(host, ports, runtime);
    expect(openNativeBindings).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();

    const sessionId = await commitSession(host, "after-the-runtime");
    expect(openNativeBindings).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(sessionId);

    // A closing lifecycle observes nothing more; the runtime is still asked
    // which bindings are open, since the listing row still publishes.
    await lifecycle!.close();
    await commitSession(host, "after-close");
    expect(observe).toHaveBeenCalledTimes(1);
  });
});
