/**
 * Desktop's runtime edge, proved through the interfaces it composes rather than
 * by scanning `index.ts` (VC-627). Two pairings live at this edge:
 *
 * - The live runtime, RPC and exporter go to the one Session lifecycle owner,
 *   and that owner runs inside the host's own `start()`/`stop(reason)`. A real
 *   `createHostCore` and a real `createSessionRuntimeLifecycle` run here over a
 *   recorded runtime, RPC, exporter and agent socket, composed in desktop's
 *   runtime-owner shape: the RPC binds only from the recovered proof, after
 *   readiness, and desktop exits without checkpointing or closing the database.
 * - Background-shell notices pair ordinary exact redaction with the
 *   unfinished-credential preview, built through the real `BackgroundShellHost`
 *   constructor over desktop's own keychain codec and `SecretService`.
 *
 * Exhaustive ordering of each piece stays with its owner: host-core's
 * `index.test.ts` (host stop steps), `session-runtime/lifecycle.test.ts`
 * (recovery and drain) and `shell/background-shell-notices.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostedSessionRuntime } from "@volli/session-engine";
import {
  createHostCore,
  HEADLESS_ATTENTION,
  isLiveHost,
  NO_POWER_EVENTS,
  throwTransactionViolation,
  type HostCore,
  type HostCorePorts,
  type LiveHostCore,
} from "@volli/host-core";
import {
  createSessionRuntimeLifecycle,
  readRecoveredSessionServices,
  SessionRuntimeClosingError,
  type RecoveredSessionServices,
} from "@volli/host-core/session-runtime/lifecycle";
import type { TicketSessionDelegationStore } from "@volli/host-core/session-runtime/delegation-store";
import type { AgentObservability } from "@volli/host-core/observability/settings";
import {
  BackgroundShellHost,
  type BackgroundShellNotice,
  type BackgroundShellOwner,
} from "@volli/host-core/shell/background-shell-host";
import { SecretStore } from "@volli/host-core/secrets";
import { SecretService } from "@volli/host-core/secrets/service";
import { keychainSecretCodec } from "../secrets/codec";
import { createDesktopHostRuntime } from "../host-runtime";

const dirs: string[] = [];
const hosts: HostCore[] = [];
const shells: BackgroundShellHost[] = [];
const recoveryGates: PromiseWithResolvers<void>[] = [];
afterEach(async () => {
  // A failed assertion must not leave a stop joined to a recovery held open forever.
  for (const gate of recoveryGates.splice(0)) gate.resolve();
  for (const shell of shells.splice(0)) await shell.close();
  // stop() is idempotent and never rejects; a test that already stopped joins it.
  for (const host of hosts.splice(0)) {
    await host.stop("test teardown");
    if (isLiveHost(host) && host.database.db.open) host.database.db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function hostPorts(): HostCorePorts {
  return {
    log: { error: vi.fn(), warn: vi.fn() },
    events: { publish: vi.fn() },
    attention: HEADLESS_ATTENTION,
    power: NO_POWER_EVENTS,
    connectivity: {
      isOnline: () => true,
      waitUntilOnline: () => Promise.resolve(),
      onResume: () => () => undefined,
    },
    listOpenNativeBindings: () => [],
    observeScheduledResume: vi.fn(),
  };
}

function composeHost(databasePath?: string): HostCore {
  const host = createHostCore(hostPorts(), {
    dataDir: tempDir("volli-desktop-edge-"),
    stopPolicy: "desktop-quit",
    ...(databasePath === undefined ? {} : { databasePath }),
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: true,
    processReaders: { liveSessionIds: () => [], openTerminalCwds: () => [] },
  });
  hosts.push(host);
  return host;
}

/**
 * Desktop's composition over one host, with every outside owner recorded:
 * the runtime lifecycle gets the live runtime, a late-bound RPC slot and the
 * exporter; the host's runtime owner awaits readiness before binding the RPC,
 * and its close drains only the lifecycle, beside the socket, as on main.
 */
function composeDesktopEdge(
  host: HostCore,
  options: { runtime: "live" | "absent" } = { runtime: "live" },
) {
  const calls: string[] = [];
  const recovery = Promise.withResolvers<void>();
  recoveryGates.push(recovery);
  const facade = { facade: "prepared Session services" };
  const db = isLiveHost(host) ? host.database.db : null;
  const runtime =
    options.runtime === "absent"
      ? null
      : ({
          close: vi.fn(async () => {
            calls.push("runtime.close");
          }),
          reconcile: vi.fn(async () => {}),
          projection: vi.fn(async () => ({ projection: {} })),
          command: vi.fn(async () => ({})),
          openNativeBindings: vi.fn(() => []),
        } as unknown as HostedSessionRuntime);
  const rpc = {
    close: vi.fn(async () => {
      calls.push("rpc.close");
    }),
  };
  let sessionRpc: typeof rpc | null = null;
  // Desktop's `createSessionRpc`: it can only be given a recovered proof.
  const bindRpc = vi.fn((ready: RecoveredSessionServices<typeof facade>) => {
    calls.push("rpc.bind");
    expect(readRecoveredSessionServices(ready)).toBe(facade);
    return rpc;
  });
  const observability = {
    shutdown: async () => {
      // The one export flush runs while the database is still open.
      calls.push(`flush (database ${db?.open === true ? "open" : "closed"})`);
    },
  } as AgentObservability;
  // An unanswered delegation is the recorded gate that holds recovery open.
  const delegation = {
    listUnansweredSubagents: () => [{ childSessionId: "child" }],
  } as unknown as TicketSessionDelegationStore;
  const stopAutomations = vi.fn(() => calls.push("automations.stop"));
  let quit: (() => Promise<unknown>) | undefined;
  const lifecycle = createSessionRuntimeLifecycle({
    host,
    ports: hostPorts(),
    runtime,
    rpc: () => sessionRpc,
    observability,
    delegation,
    delegationsFor: () => ({
      recover: async () => {
        calls.push("delegations.recover");
        await recovery.promise;
        return { answered: 0, reported: 0, skipped: 0 };
      },
    }),
    services: () => {
      calls.push("services");
      return facade;
    },
    stopProducers: stopAutomations,
    // Desktop's accepted-quit coordinator: its only job is the quit trigger.
    installQuitHold: () => {
      calls.push("quit.hold");
      quit = () => host.stop("quit");
    },
  });
  const desktop = createDesktopHostRuntime({
    host,
    lifecycle,
    bindReady: (ready) => {
      sessionRpc = bindRpc(ready);
    },
    stopProducers: stopAutomations,
    closeSocket: async () => {
      calls.push("socket.close");
    },
  });
  const start = desktop.start;
  return {
    calls,
    recovery,
    rpc,
    bindRpc,
    runtime,
    lifecycle,
    start,
    quit: () => quit!(),
  };
}

describe("desktop runtime edge composition", () => {
  it("binds the RPC only from recovered readiness, and quits without checkpointing or closing the database", async () => {
    const host = composeHost();
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const live: LiveHostCore = host;
    const edge = composeDesktopEdge(live);
    // The quit hold is installed synchronously, before anything can yield.
    expect(edge.calls).toEqual(["quit.hold"]);

    const started = edge.start();
    await vi.waitFor(() => expect(edge.calls).toContain("delegations.recover"));
    // Recovery is still open: no consumer, no RPC.
    expect(edge.bindRpc).not.toHaveBeenCalled();
    expect(edge.calls).not.toContain("services");
    edge.recovery.resolve();
    await started;
    expect(edge.calls).toEqual(["quit.hold", "delegations.recover", "services", "rpc.bind"]);
    expect(edge.bindRpc).toHaveBeenCalledOnce();
    expect(live.database.db.open).toBe(true);

    edge.calls.length = 0;
    const checkpoint = vi.spyOn(live.database.db, "pragma");
    const close = vi.spyOn(live.database.db, "close");
    const report = await edge.quit();
    expect(report).toEqual({ reason: "quit", clean: true });
    // Producers stop first; the late-bound RPC and the runtime close beside the
    // socket; the exporter flushes with the database open. No new writer
    // joins or synchronous WAL checkpoint/close are added to desktop quit.
    expect(edge.calls).toEqual([
      "automations.stop",
      "automations.stop",
      "rpc.close",
      "runtime.close",
      "socket.close",
      "flush (database open)",
    ]);
    expect(edge.rpc.close).toHaveBeenCalledOnce();
    expect(live.database.db.open).toBe(true);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    // One drain: a second quit joins it, and nothing re-runs.
    await expect(edge.quit()).resolves.toBe(report);
    expect(edge.rpc.close).toHaveBeenCalledOnce();
    await expect(edge.lifecycle.ready()).rejects.toBeInstanceOf(SessionRuntimeClosingError);
  });

  it("a quit during recovery never binds the RPC, joins the existing sweep and leaves the database open", async () => {
    const host = composeHost();
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const edge = composeDesktopEdge(host);
    const started = edge.start();
    const refused = expect(started).rejects.toBeInstanceOf(SessionRuntimeClosingError);
    await vi.waitFor(() => expect(edge.calls).toContain("delegations.recover"));

    let stopped = false;
    const stopping = edge.quit().then((report) => {
      stopped = true;
      return report;
    });
    // The Session drain finishes, but its close joins the in-flight recovery
    // sweep, exactly as on main: the accepted quit waits for it.
    await vi.waitFor(() => expect(edge.calls).toContain("flush (database open)"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(host.database.db.open).toBe(true);
    edge.recovery.resolve();
    await refused;
    // The start's own rejection reached its caller; it does not make the stop unclean.
    await expect(stopping).resolves.toEqual({ reason: "quit", clean: true });
    expect(edge.bindRpc).not.toHaveBeenCalled();
    expect(edge.calls).not.toContain("services");
    expect(edge.calls).not.toContain("rpc.close");
    expect(edge.calls.at(-1)).toBe("flush (database open)");
    expect(edge.calls).toContain("runtime.close");
    expect(host.database.db.open).toBe(true);
  });

  it("runs a degraded host through the same start and stop, with no runtime and no RPC to close", async () => {
    const dataDir = tempDir("volli-desktop-degraded-");
    // A directory where the database file should be: the open fails.
    const databasePath = join(dataDir, "volli.db");
    mkdirSync(databasePath);
    const host = composeHost(databasePath);
    expect(host.kind).toBe("degraded");
    const edge = composeDesktopEdge(host, { runtime: "absent" });
    await edge.start();
    // No recovery to wait on: readiness, then the (absent-runtime) RPC binding.
    expect(edge.calls).toEqual(["quit.hold", "services", "rpc.bind"]);
    edge.calls.length = 0;
    await expect(edge.quit()).resolves.toEqual({ reason: "quit", clean: true });
    expect(edge.calls).toEqual([
      "automations.stop",
      "automations.stop",
      "rpc.close",
      "socket.close",
      "flush (database closed)",
    ]);
  });
});

describe("desktop background-shell notice redaction", () => {
  const owner: BackgroundShellOwner = {
    sessionId: "session-1",
    attachmentId: "attachment-1",
    projectId: "project-1",
    ticketId: null,
  };
  /** Desktop's secret service: its keychain codec over its sealed session store. */
  function desktopSecrets(value: string): SecretService {
    const dir = tempDir("volli-desktop-secrets-");
    const secrets = new SecretService(
      new SecretStore(
        join(dir, "session-secrets.enc"),
        keychainSecretCodec({
          // Session-scope values never need the keychain.
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error("unused");
          },
          decryptString: () => {
            throw new Error("unused");
          },
        }),
      ),
    );
    secrets.store.put({ name: "TOKEN", value, scope: "session", sessionId: owner.sessionId });
    return secrets;
  }
  /** The real constructor, with desktop's deps; only the test's timing knobs differ. */
  function backgroundShells(secrets: SecretService, options: { preview: boolean }) {
    const notices: BackgroundShellNotice[] = [];
    const shellHost = new BackgroundShellHost({
      redactOutput: (text) => secrets.store.redact(text),
      ...(options.preview
        ? { redactNoticeOutput: (text: string) => secrets.store.redactPartial(text) }
        : {}),
      onNotice: (notice) => notices.push(notice),
      publishState: () => {},
      publishRemoved: () => {},
      createId: () => "sh-1",
      settleMs: 150,
      killGraceMs: 200,
      exitNoticeGraceMs: 40,
    });
    shells.push(shellHost);
    return { shellHost, notices };
  }
  /** A stored two-line credential whose first line arrives one chunk before the second. */
  async function splitCredentialRun(options: { preview: boolean }) {
    const secrets = desktopSecrets("Ready ALMOND123\nWALNUT456");
    const { shellHost, notices } = backgroundShells(secrets, options);
    await shellHost.start(owner, {
      command:
        "sleep 0.3; printf 'Ready ALMOND123\\n'; sleep 0.2; printf 'WALNUT456\\nsafe\\n'; sleep 30",
      cwd: tempDir("volli-desktop-shell-"),
      title: null,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      notifyOn: { pattern: "Ready", regex: false },
    });
    await vi.waitFor(() => expect(shellHost.tailOf("sh-1")?.output).toContain("safe"), {
      timeout: 4_000,
      interval: 20,
    });
    return { shellHost, notices };
  }

  it("pairs exact output redaction with the unfinished-credential preview", async () => {
    const { shellHost, notices } = await splitCredentialRun({ preview: true });
    // The live match never quotes the half of the credential that arrived first.
    expect(notices).toEqual([]);
    expect(shellHost.tailOf("sh-1")?.output).toContain("‹secret:TOKEN›");
    expect(shellHost.tailOf("sh-1")?.output).not.toContain("ALMOND123");
  });

  it("without the preview, exact redaction alone would quote the fragment", async () => {
    // The reason desktop wires both: this is the leak the pairing closes.
    const { notices } = await splitCredentialRun({ preview: false });
    expect(notices).toEqual([
      expect.objectContaining({ kind: "matched", line: expect.stringContaining("ALMOND123") }),
    ]);
  });
});
