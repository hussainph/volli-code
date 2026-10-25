/**
 * The Session services learn which bindings are open, which turn starts are
 * pending, and each folded projection for scheduled resume from the runtime
 * and lifecycle built after them (VC-632). The runner composition binds those
 * answers once, through the services' runtime slot (VC-671).
 *
 * This test runs that composition for real over `createHostCore`, commits a
 * Session through the composed engine, and asserts each bound callback is
 * reached exactly once per fold. Without the binding the services stay on
 * their inert defaults (nothing open, nothing scheduled), and this test fails.
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
import { hostCodeMode } from "../codemode/dev-config";
import { hostMcpDispatch } from "../mcp/dispatch-policy";
import * as control from "../session-control";
import { createAttachmentIdentities } from "./attachment-identity";
import { createRuntimeAssembly } from "./assembly";
import { createTicketSessionDelegationStore } from "./delegation-store";
import * as pi from "./pi-adapter";
import { createRunnerComposition } from "./runner";

let core: LiveHostCore | undefined;
let root: string | undefined;
afterEach(async () => {
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
    sessionWake: host.sessionWakeBus.subscribe,
    dataDir,
    binDir: join(dataDir, "bin"),
    venue: { id: "test-host", kind: "remote" },
    hostPorts: ports,
    modelAccess: models,
    decisions: null,
    webAccess: host.runtimeServices.webAccess,
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

/** Records each projection scheduled resume observes. */
function recordScheduledResume() {
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
  return observe;
}

/** The runner composition as a host composes it, over the fixture host. */
function composeRunner({ host, ports, root: dataDir }: Awaited<ReturnType<typeof composedHost>>) {
  return createRunnerComposition({
    store: { kind: "local", host },
    ports,
    version: "0.0.0-test",
    venue: { id: "test-host", kind: "remote" },
    homeDir: dataDir,
    binDir: join(dataDir, "bin"),
    env: {},
    packaged: true,
    cloudEnabled: () => false,
    secrets: new SecretService(host.secretStore),
    capabilities: { askUser: false, requestSecret: false },
    beforeExecution: async () => {},
    doors: () => ({ experiments: null, busyWorktreeSites: async () => [] }),
    installQuitHold: () => {},
  });
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
  it("binds the runtime's open-bindings reader and the lifecycle's resume observer, once each", async () => {
    const composed = await composedHost();
    const { host } = composed;

    // Before the runtime exists the services fold on their inert defaults.
    await commitSession(host, "before-the-runtime");

    const observe = recordScheduledResume();
    const runner = composeRunner(composed);
    const runtime = runner.runtime;
    if (runtime === null) throw new Error("the runner built no Session runtime");
    const openNativeBindings = vi.spyOn(runtime, "openNativeBindings");
    expect(openNativeBindings).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();

    const sessionId = await commitSession(host, "after-the-runtime");
    expect(openNativeBindings).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(sessionId);

    // A closing lifecycle observes nothing more; the runtime is still asked
    // which bindings are open, since the listing row still publishes.
    await runner.owner().close();
    await commitSession(host, "after-close");
    expect(observe).toHaveBeenCalledTimes(1);

    // One runtime per host: a second runner over the same engine is refused.
    expect(() => composeRunner(composed)).toThrow("already bound");
  });

  it("feeds the assembled runtime's open chats from the host's wake bus (VC-790)", async () => {
    const composed = await composedHost();
    const { host } = composed;
    const runtime = assemble(composed).sessionRuntime;
    if (runtime === null) throw new Error("the assembly built no Session runtime");
    const sessionId = await commitSession(host, "an-open-chat");
    const kinds: string[] = [];
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      (emission) => {
        if ("event" in emission && emission.event !== null) {
          kinds.push(emission.event.payload.kind);
        }
      },
    );

    // Around the runtime, as `volli:session-rename` and the auto-titler write,
    // with nothing published after it.
    await host.sessionEngine.submit({
      commandId: "retitle-at-rest",
      sessionId,
      intent: { kind: "session.retitle", title: "Named while idle" },
      provenance: {
        source: { kind: "system", id: "auto-title", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });

    await vi.waitFor(() =>
      expect(kinds).toEqual(["command.recorded", "session.retitled", "command.receipt.recorded"]),
    );
    stop();
    await runtime.close();
  });
});
