import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import type { HostedSessionRuntime, SessionEngine } from "@volli/session-engine";
import type { DegradedHostCore, HostCorePorts, LiveHostCore } from "../index";
import type { AgentObservability } from "../observability/settings";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { Delegations } from "./delegate-session";
import * as control from "../session-control";
import * as notices from "./durable-host-notice-delivery";
import * as recovery from "./boot-recovery";
import * as mcp from "../mcp/session-host";
import * as shell from "../shell/shell-notices";
import * as resumptions from "./session-resumptions";
import * as schedules from "../db/scheduled-resume-repo";
import * as followUps from "../db/session-follow-up-repo";

vi.mock("../db/session-follow-up-repo", () => ({
  consumeFollowUpCleanClose: vi.fn(() => [] as string[]),
  FOLLOW_UP_DOWNGRADE_HOLD_DETAIL:
    "Held: an older Volli version ran since this was queued — edit or remove it",
}));
import type { SessionProjection } from "@volli/shared";
import { shutdownNativeSessions } from "../host-shutdown";
import { createSessionRuntimeLifecycle, SessionRuntimeClosingError } from "./lifecycle";

vi.mock("../db/projects-repo", () => ({ listProjects: () => [{ id: "project" }] }));
vi.mock("../db/scheduled-resume-repo", () => ({
  listScheduledResumeSessionIds: vi.fn(() => ["scheduled"]),
}));
vi.mock("../session-control", () => ({
  createSessionWatchdog: vi.fn(),
  createScheduledResumeHost: vi.fn(),
  createSuspendClock: vi.fn(() => ({ suspendedMsWithin: () => 0, close: vi.fn() })),
}));
vi.mock("./durable-host-notice-delivery", () => ({ createHostNoticeDelivery: vi.fn() }));
vi.mock("./boot-recovery", () => ({ closeStaleAttachments: vi.fn() }));
vi.mock("../mcp/session-host", () => ({ closeAllMcpSessionHosts: vi.fn() }));
vi.mock("./session-resumptions", () => ({ catchUpSessionResumptions: vi.fn(async () => {}) }));
// The real VC-618 drain still runs, so its RPC/runtime → MCP → flush order is
// asserted end to end below; the spy records the owners the lifecycle hands it.
vi.mock("../host-shutdown", async (original) => {
  const actual = await original<typeof import("../host-shutdown")>();
  return { shutdownNativeSessions: vi.fn(actual.shutdownNativeSessions) };
});
vi.mock("../shell/shell-notices", () => ({
  relayShellNotices: vi.fn(() => vi.fn(async () => {})),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(followUps.consumeFollowUpCleanClose).mockReturnValue([]);
});

function deferred() {
  return Promise.withResolvers<void>();
}
function fixture() {
  const calls: string[] = [];
  const watchdog = {
    start: () => calls.push("watchdog.start"),
    stop: () => calls.push("watchdog.stop"),
    scan: vi.fn(async () => {}),
  };
  const resume = {
    start: async () => {
      calls.push("resume.start");
    },
    pass: vi.fn(async () => {}),
    observe: vi.fn(),
    stop: () => calls.push("resume.stop"),
    settled: vi.fn(async () => {}),
  };
  const delivery = {
    recover: vi.fn(async () => {
      calls.push("notices.recover");
    }),
    close: () => calls.push("notices.close"),
    deliver: vi.fn(async () => "delivered" as const),
  };
  vi.mocked(control.createSessionWatchdog).mockReturnValue(
    watchdog as ReturnType<typeof control.createSessionWatchdog>,
  );
  vi.mocked(control.createScheduledResumeHost).mockReturnValue(
    resume as ReturnType<typeof control.createScheduledResumeHost>,
  );
  vi.mocked(notices.createHostNoticeDelivery).mockReturnValue(
    delivery as ReturnType<typeof notices.createHostNoticeDelivery>,
  );
  vi.mocked(recovery.closeStaleAttachments).mockImplementation(async () => {
    calls.push("attachments");
    return 0;
  });
  vi.mocked(mcp.closeAllMcpSessionHosts).mockImplementation(async () => {
    calls.push("mcp");
  });
  const runtime = {
    close: vi.fn(async () => {
      calls.push("runtime.close");
    }),
    reconcile: vi.fn(async () => {}),
    projection: vi.fn(async () => ({ projection: {} })),
    command: vi.fn(async () => ({})),
    openNativeBindings: vi.fn(() => []),
    reportMessageDeliveryFailure: vi.fn(async () => {}),
    recoverFollowUps: vi.fn(async () => {
      calls.push("follow-ups.recover");
    }),
  } as unknown as HostedSessionRuntime;
  const rpc = {
    close: vi.fn(async () => {
      calls.push("rpc.close");
    }),
  };
  const observability = {
    shutdown: async () => {
      calls.push("flush");
    },
  } as AgentObservability;
  const engine = {
    submit: vi.fn(async () => ({})),
    listSessions: vi.fn(async () => []),
  } as unknown as SessionEngine;
  const host = {
    kind: "live",
    database: { ok: true, db: {} },
    sessionEngine: engine,
    hostNoticeOutbox: {},
    sessionWakeBus: { subscribe: vi.fn() },
    detachedWork: { track: vi.fn() },
  } as unknown as LiveHostCore;
  const ports = {
    power: { on: vi.fn(), removeListener: vi.fn() },
    events: { publish: vi.fn() },
    attention: { deliver: vi.fn() },
    log: { error: vi.fn(), warn: vi.fn() },
  } as unknown as HostCorePorts;
  const delegateHost = {
    recover: vi.fn(async () => {
      calls.push("delegations.recover");
      return { answered: 0, reported: 0, skipped: 0 };
    }),
  } as unknown as Delegations;
  const delegation = {
    listUnansweredSubagents: vi.fn(() => [{ childSessionId: "child" }]),
  } as unknown as TicketSessionDelegationStore;
  const services = vi.fn(() => {
    calls.push("ready.services");
    return { readLedger: vi.fn() };
  });
  let quit!: () => Promise<void>;
  const options = {
    host,
    ports,
    runtime,
    rpc: () => rpc,
    observability,
    delegation,
    delegationsFor: () => {
      calls.push("delegations.construct");
      return delegateHost;
    },
    services,
    installQuitHold: (close: () => Promise<void>) => {
      calls.push("quit.hold");
      quit = close;
    },
    stopProducers: () => calls.push("automations.stop"),
  };
  return {
    options,
    calls,
    services,
    delivery,
    resume,
    watchdog,
    runtime,
    rpc,
    observability,
    engine,
    quit: () => quit(),
  };
}

describe("Session lifecycle port ordering (replaces desktop source scans)", () => {
  it("holds downgraded queues before boot event writes and explains them with existing Attention", async () => {
    const f = fixture();
    vi.mocked(followUps.consumeFollowUpCleanClose).mockImplementation(() => {
      expect(f.calls).not.toContain("attachments");
      expect(f.calls).not.toContain("follow-ups.recover");
      return ["session"];
    });
    vi.mocked(f.runtime.reportMessageDeliveryFailure).mockImplementation(async (input) => {
      expect(input).toEqual({
        sessionId: "session",
        commandId: "follow-up:session",
        detail: followUps.FOLLOW_UP_DOWNGRADE_HOLD_DETAIL,
      });
      expect(f.calls).toContain("attachments");
      expect(f.calls).not.toContain("follow-ups.recover");
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.ready();
    expect(f.runtime.reportMessageDeliveryFailure).toHaveBeenCalledOnce();
    await owner.close();
  });

  it("logs an unreadable Session queue without denying host readiness", async () => {
    const f = fixture();
    vi.mocked(followUps.consumeFollowUpCleanClose).mockImplementationOnce((_db, report) => {
      report!("session", new Error("queue corrupt"));
      return [];
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.ready();
    expect(f.options.ports.log.error).toHaveBeenCalledWith("unreadable follow-up queue", {
      sessionId: "session",
      error: expect.objectContaining({ message: "queue corrupt" }),
    });
    await owner.close();
  });

  it("reports an Attention failure without releasing durable holds or failing readiness", async () => {
    const f = fixture();
    vi.mocked(followUps.consumeFollowUpCleanClose).mockReturnValueOnce(["session"]);
    vi.mocked(f.runtime.reportMessageDeliveryFailure).mockRejectedValueOnce(
      new Error("attention unavailable"),
    );
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.ready();
    expect(f.options.ports.log.error).toHaveBeenCalledWith("failed to explain held follow-ups", {
      sessionId: "session",
      error: expect.objectContaining({ message: "attention unavailable" }),
    });
    await owner.close();
  });

  it("consumes the watermark even when the runtime is unavailable", async () => {
    const f = fixture();
    vi.mocked(followUps.consumeFollowUpCleanClose).mockReturnValueOnce(["session"]);
    const owner = createSessionRuntimeLifecycle({ ...f.options, runtime: null });
    await owner.ready();
    expect(followUps.consumeFollowUpCleanClose).toHaveBeenCalledOnce();
    expect(f.runtime.reportMessageDeliveryFailure).not.toHaveBeenCalled();
    await owner.close();
  });

  it("fails readiness rather than releasing rows after a watermark read failure", async () => {
    const f = fixture();
    vi.mocked(followUps.consumeFollowUpCleanClose).mockImplementationOnce(() => {
      throw new Error("watermark corrupt");
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    await expect(owner.ready()).rejects.toThrow("watermark corrupt");
    expect(f.runtime.recoverFollowUps).not.toHaveBeenCalled();
    await owner.close();
  });
  it("installs quit synchronously and exposes no consumer until attachments, delegations and notices recover", async () => {
    const f = fixture();
    const gate = deferred();
    vi.mocked(recovery.closeStaleAttachments).mockImplementation(async (input) => {
      f.calls.push("attachments");
      expect(input.engine).toBe(f.engine);
      await gate.promise;
      return 0;
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    expect(f.calls).toEqual(["watchdog.start", "quit.hold"]);
    expect(owner).not.toHaveProperty("runtime");
    const ready = owner.ready();
    expect(owner.ready()).toBe(ready);
    expect(f.services).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["watchdog.start", "quit.hold", "attachments"]);
    gate.resolve();
    await ready;
    expect(f.calls).toEqual([
      "watchdog.start",
      "quit.hold",
      "attachments",
      "delegations.construct",
      "delegations.recover",
      "follow-ups.recover",
      "notices.recover",
      "resume.start",
      "ready.services",
    ]);
    expect(notices.createHostNoticeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outbox: f.options.host.hostNoticeOutbox, runtime: f.runtime }),
    );
    await owner.close();
  });

  it("a quit during follow-up recovery never exposes consumers", async () => {
    const f = fixture();
    const recovering = deferred();
    const release = deferred();
    vi.mocked(f.runtime.recoverFollowUps).mockImplementation(async () => {
      recovering.resolve();
      await release.promise;
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    const ready = owner.ready();
    const refused = expect(ready).rejects.toBeInstanceOf(SessionRuntimeClosingError);
    await recovering.promise;
    const closed = owner.close();
    release.resolve();
    await refused;
    await closed;
    expect(f.services).not.toHaveBeenCalled();
    expect(f.delivery.recover).not.toHaveBeenCalled();
  });

  it("a hung follow-up release does not hold readiness, and close still waits for it", async () => {
    const f = fixture();
    const release = deferred();
    vi.mocked(f.runtime.recoverFollowUps).mockImplementation(async () => {
      f.calls.push("follow-ups.recover");
      // An executor attach that never answers.
      await release.promise;
    });
    const owner = createSessionRuntimeLifecycle({ ...f.options, followUpRecoveryWaitMs: 5 });
    await owner.ready();
    expect(f.calls).toEqual(
      expect.arrayContaining(["follow-ups.recover", "notices.recover", "ready.services"]),
    );
    expect(f.calls.indexOf("follow-ups.recover")).toBeLessThan(f.calls.indexOf("notices.recover"));
    expect(f.options.ports.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("queued follow-up recovery is still running"),
      { waitMs: 5 },
    );
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(f.calls).toContain("runtime.close"));
    await Promise.resolve();
    // The background sweep still writes the queue ledger: the drain waits for it.
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    expect(closed).toBe(true);
  });

  it("a failed follow-up sweep is reported and recovery continues", async () => {
    const f = fixture();
    vi.mocked(f.runtime.recoverFollowUps).mockRejectedValue(new Error("ledger unavailable"));
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.ready();
    expect(f.options.ports.log.error).toHaveBeenCalledWith("failed to recover queued follow-ups", {
      error: expect.objectContaining({ message: "ledger unavailable" }),
    });
    expect(f.options.ports.log.warn).not.toHaveBeenCalled();
    expect(f.services).toHaveBeenCalledTimes(1);
    expect(f.delivery.recover).toHaveBeenCalledTimes(1);
    await owner.close();
  });

  it("the installed one close stops producers/notices, drains both owners, then MCP and observability once", async () => {
    const f = fixture();
    const rpc = deferred();
    const runtime = deferred();
    f.rpc.close.mockImplementation(async () => {
      f.calls.push("rpc.close");
      await rpc.promise;
    });
    vi.mocked(f.runtime.close).mockImplementation(async () => {
      f.calls.push("runtime.close");
      await runtime.promise;
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.ready();
    f.calls.length = 0;
    const drain = f.quit();
    expect(owner.close()).toBe(drain);
    expect(f.calls).toEqual([
      "automations.stop",
      "watchdog.stop",
      "resume.stop",
      "notices.close",
      "rpc.close",
      "runtime.close",
    ]);
    rpc.resolve();
    await Promise.resolve();
    expect(f.calls).not.toContain("mcp");
    runtime.resolve();
    await drain;
    expect(f.calls.slice(-2)).toEqual(["mcp", "flush"]);
    // One drain, through host-core's own shutdown with the host's log, not a
    // maintenance-bag closure a host could forget to stage.
    expect(shutdownNativeSessions).toHaveBeenCalledOnce();
    expect(shutdownNativeSessions).toHaveBeenCalledWith({
      log: f.options.ports.log,
      sessionWatchdog: f.watchdog,
      scheduledResumeHost: f.resume,
      shellHostNotices: f.delivery,
      sessionRpc: f.rpc,
      sessionRuntime: f.runtime,
      agentObservability: f.observability,
    });
    await expect(owner.ready()).rejects.toThrow("closing");
  });

  it("continues recovery stages after a reported failure, before releasing consumers", async () => {
    const f = fixture();
    vi.mocked(recovery.closeStaleAttachments).mockRejectedValueOnce(new Error("stale failed"));
    f.delivery.recover.mockRejectedValueOnce(new Error("notice failed"));
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.ready();
    expect(f.options.ports.log.error).toHaveBeenCalledWith("failed to recover stale attachments", {
      error: expect.objectContaining({ message: "stale failed" }),
    });
    expect(f.options.ports.log.error).toHaveBeenCalledWith("failed to recover host notices", {
      error: expect.objectContaining({ message: "notice failed" }),
    });
    expect(f.calls).toContain("delegations.recover");
    expect(f.calls.slice(-2)).toEqual(["resume.start", "ready.services"]);
    await owner.close();
  });

  it("a close during recovery waits for the sweep and never starts resume or exposes consumers", async () => {
    const f = fixture();
    const gate = deferred();
    vi.mocked(recovery.closeStaleAttachments).mockImplementation(async (ports) => {
      expect(ports.shouldStop!()).toBe(false);
      await gate.promise;
      expect(ports.shouldStop!()).toBe(true);
      return 0;
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    const boot = owner.ready();
    const refused = expect(boot).rejects.toThrow("closed during recovery");
    const drain = owner.close();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    // Let the actual RPC/runtime → MCP → flush chain finish. A lone microtask
    // didn't pin this wait: removing boot from close() used to keep this green.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.calls).toContain("flush");
    expect(drained).toBe(false);
    gate.resolve();
    await refused;
    await drain;
    expect(f.services).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("resume.start");
    expect(f.options.ports.log.error).not.toHaveBeenCalled();
    await expect(boot).rejects.toBeInstanceOf(SessionRuntimeClosingError);
  });

  it("forwards engine/runtime, events, attention and shell ports, then releases wake/clock listeners", async () => {
    const f = fixture();
    const owner = createSessionRuntimeLifecycle(f.options);
    const noticePorts = vi.mocked(notices.createHostNoticeDelivery).mock.calls[0]![0];
    const listener = vi.fn();
    noticePorts.subscribeEvents!(listener);
    const subscribe = vi.mocked(f.options.host.sessionWakeBus!.subscribe);
    const event = { type: "test-event" } as unknown as Parameters<typeof listener>[0];
    subscribe.mock.calls[0]![0]({ event } as Parameters<Parameters<typeof subscribe>[0]>[0]);
    expect(listener).toHaveBeenCalledWith(event);
    noticePorts.report("outbox failure");
    const relayPorts = vi.mocked(shell.relayShellNotices).mock.calls[0]![0];
    relayPorts.report("relay failure");
    const watchdogPorts = vi.mocked(control.createSessionWatchdog).mock.calls[0]![0];
    expect(watchdogPorts.listBindings()).toEqual([]);
    expect(await watchdogPorts.projection("session")).toEqual({});
    const submit = {} as Parameters<typeof watchdogPorts.submit>[0];
    await watchdogPorts.submit(submit);
    expect(f.engine.submit).toHaveBeenCalledWith(submit);
    const notification = {} as Parameters<NonNullable<typeof watchdogPorts.notify>>[0];
    watchdogPorts.notify!(notification);
    const resumePorts = vi.mocked(control.createScheduledResumeHost).mock.calls[0]![0];
    expect(await resumePorts.candidates()).toEqual(["scheduled"]);
    expect(schedules.listScheduledResumeSessionIds).toHaveBeenCalledWith(
      f.options.host.database.ok ? f.options.host.database.db : null,
    );
    expect(await resumePorts.projection("session")).toEqual({});
    await resumePorts.ticketSessions({ projectId: "project", ticketId: "ticket" });
    expect(f.engine.listSessions).toHaveBeenCalledWith({
      projectId: "project",
      scope: "ticket",
      ticketId: "ticket",
    });
    const command = {} as Parameters<typeof resumePorts.command>[0];
    await resumePorts.command(command);
    expect(f.runtime.command).toHaveBeenCalledWith(command);
    resumePorts.notify!(notification);
    expect(f.options.ports.attention.deliver).toHaveBeenCalledTimes(2);
    vi.mocked(recovery.closeStaleAttachments).mockImplementationOnce(async (ports) => {
      await ports.reconcile({} as Parameters<typeof ports.reconcile>[0]);
      ports.onError!("attachment", new Error("reconcile failed"));
      return 0;
    });
    await owner.ready();
    expect(f.runtime.reconcile).toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const catchUp = vi.mocked(resumptions.catchUpSessionResumptions).mock.calls[0]![2];
    const change = {} as Parameters<typeof catchUp.publish>[0];
    catchUp.publish(change);
    catchUp.report(new Error("catch up failed"));
    expect(f.options.ports.events.publish).toHaveBeenCalledWith("data-changed", change);
    const wake = vi.mocked(f.options.ports.power.on).mock.calls[0]![1];
    wake();
    const projection = {} as SessionProjection;
    owner.observeScheduledResume(projection);
    const notice = {} as Parameters<typeof owner.relayShellNotice>[0];
    owner.relayShellNotice(notice);
    await Promise.resolve();
    expect(f.resume.pass).toHaveBeenCalledOnce();
    expect(f.resume.observe).toHaveBeenCalledWith(projection);
    const relay = vi.mocked(shell.relayShellNotices).mock.results[0]!.value;
    expect(relay).toHaveBeenCalledWith(notice);
    await owner.close();
    wake();
    owner.observeScheduledResume(projection);
    owner.relayShellNotice(notice);
    expect(f.resume.pass).toHaveBeenCalledOnce();
    expect(f.resume.observe).toHaveBeenCalledOnce();
    expect(relay).toHaveBeenCalledOnce();
    expect(f.options.ports.power.removeListener).toHaveBeenCalledWith("resume", wake);
    expect(
      vi.mocked(control.createSuspendClock).mock.results[0]!.value.close,
    ).toHaveBeenCalledOnce();
    expect(f.options.ports.log.error).toHaveBeenCalledWith("host notice delivery failed", {
      detail: "outbox failure",
    });
    expect(f.options.ports.log.error).toHaveBeenCalledWith("shell notice relay failed", {
      detail: "relay failure",
    });
  });

  it.each(["empty", "unavailable", "failed", "no-store"])(
    "handles %s delegations without skipping the later boot stages",
    async (mode) => {
      const f = fixture();
      const delegation = mode === "no-store" ? null : f.options.delegation;
      if (mode === "empty")
        vi.mocked(f.options.delegation.listUnansweredSubagents).mockReturnValue([]);
      const owner = createSessionRuntimeLifecycle({
        ...f.options,
        delegation,
        delegationsFor: () => {
          if (mode === "failed") throw new Error("delegation failed");
          return null;
        },
      });
      await owner.ready();
      expect(f.calls.slice(-3)).toEqual(["notices.recover", "resume.start", "ready.services"]);
      if (mode === "failed")
        expect(f.options.ports.log.error).toHaveBeenCalledWith("failed to recover delegations", {
          error: expect.objectContaining({ message: "delegation failed" }),
        });
      await owner.close();
    },
  );

  it("missing runtime refuses reconciliation, but still releases degraded consumers", async () => {
    const f = fixture();
    vi.mocked(recovery.closeStaleAttachments).mockImplementationOnce(async (ports) => {
      await expect(ports.reconcile({} as Parameters<typeof ports.reconcile>[0])).rejects.toThrow(
        "unavailable during boot recovery",
      );
      return 0;
    });
    const owner = createSessionRuntimeLifecycle({ ...f.options, runtime: null });
    await owner.ready();
    await owner.close();
  });

  it("a quit during notice recovery refuses services and never starts scheduled retries", async () => {
    const f = fixture();
    const gate = deferred();
    const started = deferred();
    f.delivery.recover.mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
    const owner = createSessionRuntimeLifecycle({
      ...f.options,
      // Type-impossible on a live host; covers the guard lifecycle.ts still carries.
      host: { ...f.options.host, sessionWakeBus: null } as unknown as LiveHostCore,
    });
    const boot = owner.ready();
    const refused = expect(boot).rejects.toThrow("closed during recovery");
    await started.promise;
    const drain = owner.close();
    gate.resolve();
    await refused;
    await drain;
    expect(f.services).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("resume.start");
  });

  it("reads a late-bound RPC owner at close, not the empty slot at construction", async () => {
    const f = fixture();
    let rpc: typeof f.rpc | null = null;
    const owner = createSessionRuntimeLifecycle({ ...f.options, rpc: () => rpc });
    const ready = await owner.ready();
    expect(ready.services).toBe(f.services.mock.results[0]!.value);
    rpc = f.rpc;
    await owner.close();
    expect(f.rpc.close).toHaveBeenCalledOnce();
    expect(vi.mocked(shutdownNativeSessions).mock.lastCall![0].sessionRpc).toBe(f.rpc);
    expect(() => ready.services).toThrow("runtime is closing");
  });

  it("fresh shell notices wait for recovery and are dropped if close wins", async () => {
    const f = fixture();
    const gate = deferred();
    vi.mocked(recovery.closeStaleAttachments).mockImplementationOnce(async () => {
      await gate.promise;
      return 0;
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    const notice = {} as Parameters<typeof owner.relayShellNotice>[0];
    const relay = vi.mocked(shell.relayShellNotices).mock.results[0]!.value;
    owner.relayShellNotice(notice);
    expect(relay).not.toHaveBeenCalled();
    gate.resolve();
    await owner.ready();
    expect(relay).toHaveBeenCalledOnce();
    // A resolved proof does not let the already queued external notice run
    // after its runtime closes in this same turn of the host's event loop.
    owner.relayShellNotice(notice);
    await owner.close();
    expect(relay).toHaveBeenCalledOnce();
  });

  it("drops a queued notice when close interrupts recovery, without an error or unhandled rejection", async () => {
    const f = fixture();
    const gate = deferred();
    vi.mocked(recovery.closeStaleAttachments).mockImplementationOnce(async () => {
      await gate.promise;
      return 0;
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    owner.relayShellNotice({} as Parameters<typeof owner.relayShellNotice>[0]);
    const drain = owner.close();
    gate.resolve();
    await drain;
    expect(f.options.ports.log.error).not.toHaveBeenCalled();
  });

  it("reports a genuinely failed readiness to a queued notice", async () => {
    const f = fixture();
    f.services.mockImplementationOnce(() => {
      throw new Error("service construction failed");
    });
    const owner = createSessionRuntimeLifecycle(f.options);
    owner.relayShellNotice({} as Parameters<typeof owner.relayShellNotice>[0]);
    await expect(owner.ready()).rejects.toThrow("service construction failed");
    expect(f.options.ports.log.error).toHaveBeenCalledWith("failed to ready a shell notice", {
      error: expect.objectContaining({ message: "service construction failed" }),
    });
    await owner.close();
  });

  it("closing an unstarted owner prevents any later recovery", async () => {
    const f = fixture();
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.close();
    await expect(owner.ready()).rejects.toThrow("closing");
    expect(recovery.closeStaleAttachments).not.toHaveBeenCalled();
  });

  it("degraded boot still installs a close, with no recovery engine or schedulers", async () => {
    const f = fixture();
    // The degraded variant carries only its failure: no Session service to null-check.
    const host: DegradedHostCore = {
      kind: "degraded",
      dataDir: "/data",
      dbPath: "/data/volli.db",
      database: { ok: false, error: "unavailable" },
      databaseFailure: { kind: "other" },
      start: vi.fn(async () => {}),
      stop: vi.fn(async (reason: string) => ({ reason, clean: true })),
      warnIfFollowUpCleanCloseSkipped: vi.fn(),
    };
    const owner = createSessionRuntimeLifecycle({ ...f.options, host, runtime: null });
    await owner.ready();
    owner.observeScheduledResume({} as SessionProjection);
    owner.relayShellNotice({} as Parameters<typeof owner.relayShellNotice>[0]);
    expect(recovery.closeStaleAttachments).not.toHaveBeenCalled();
    expect(notices.createHostNoticeDelivery).not.toHaveBeenCalled();
    expect(control.createSessionWatchdog).not.toHaveBeenCalled();
    expect(control.createScheduledResumeHost).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["quit.hold", "ready.services"]);
    await owner.close();
    // The MCP backstop and export flush still run for a degraded host.
    expect(shutdownNativeSessions).toHaveBeenCalledWith({
      log: f.options.ports.log,
      sessionWatchdog: null,
      scheduledResumeHost: null,
      shellHostNotices: null,
      sessionRpc: f.rpc,
      sessionRuntime: null,
      agentObservability: f.observability,
    });
    expect(f.calls.slice(-2)).toEqual(["mcp", "flush"]);
    expect(host.start).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
  });
});

it("passes the host venue into recovery and watchdog and rejects cast/copied proofs", async () => {
  const f = fixture();
  const venue = { id: "headless", kind: "remote" as const };
  const ownsLegacyVenue = vi.fn(() => true);
  const owner = createSessionRuntimeLifecycle({ ...f.options, venue, ownsLegacyVenue });
  const ready = await owner.ready();
  const { readRecoveredSessionServices, mapRecoveredSessionServices } = await import("./lifecycle");
  expect(readRecoveredSessionServices(ready)).toBe(ready.services);
  const view = mapRecoveredSessionServices(ready, (services) => ({ held: services }));
  expect(readRecoveredSessionServices(view).held).toBe(ready.services);
  expect(() => mapRecoveredSessionServices({ ...ready }, (services) => services)).toThrow(
    "no recovery proof",
  );
  expect(() => readRecoveredSessionServices({ services: ready.services } as typeof ready)).toThrow(
    "no recovery proof",
  );
  expect(() => readRecoveredSessionServices({ ...ready })).toThrow("no recovery proof");
  expect(vi.mocked(recovery.closeStaleAttachments).mock.lastCall![0].venue).toBe(venue);
  expect(vi.mocked(recovery.closeStaleAttachments).mock.lastCall![0].ownsLegacyVenue).toBe(
    ownsLegacyVenue,
  );
  expect(vi.mocked(control.createSessionWatchdog).mock.lastCall![0].venue).toBe(venue);
  await owner.close();
  expect(() => readRecoveredSessionServices(ready)).toThrow("closing");
  expect(() => readRecoveredSessionServices(view)).toThrow("closing");
});
