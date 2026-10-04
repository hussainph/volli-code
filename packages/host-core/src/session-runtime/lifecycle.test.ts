import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import type { HostedSessionRuntime, SessionEngine } from "@volli/session-engine";
import type { HostCore, HostCorePorts } from "../index";
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
import type { SessionProjection } from "@volli/shared";
import { shutdownNativeSessions } from "../host-shutdown";
import { createSessionRuntimeLifecycle } from "./lifecycle";

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
vi.mock("../shell/shell-notices", () => ({
  relayShellNotices: vi.fn(() => vi.fn(async () => {})),
}));
afterEach(() => vi.clearAllMocks());

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
    database: { ok: true, db: {} },
    sessionEngine: engine,
    hostNoticeOutbox: {},
    sessionWakeBus: { subscribe: vi.fn() },
    maintenance: {
      shutdownNativeSessions: (
        owners: Parameters<HostCore["maintenance"]["shutdownNativeSessions"]>[0],
      ) => shutdownNativeSessions({ ...owners, log: console }),
    },
  } as unknown as HostCore;
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
    rpc,
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
  return { options, calls, services, delivery, resume, runtime, rpc, engine, quit: () => quit() };
}

describe("Session lifecycle port ordering (replaces desktop source scans)", () => {
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
      "notices.recover",
      "resume.start",
      "ready.services",
    ]);
    expect(notices.createHostNoticeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outbox: f.options.host.hostNoticeOutbox, runtime: f.runtime }),
    );
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
    await expect(owner.ready()).rejects.toThrow("closing");
  });

  it("continues recovery stages after a reported failure, before releasing consumers", async () => {
    const f = fixture();
    vi.mocked(recovery.closeStaleAttachments).mockRejectedValueOnce(new Error("stale failed"));
    f.delivery.recover.mockRejectedValueOnce(new Error("notice failed"));
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.ready();
    expect(f.options.ports.log.error).toHaveBeenCalledWith(
      "[volli] failed to recover stale attachments:",
      "stale failed",
    );
    expect(f.options.ports.log.error).toHaveBeenCalledWith(
      "[volli] failed to recover host notices:",
      "notice failed",
    );
    expect(f.calls).toContain("delegations.recover");
    expect(f.calls.slice(-2)).toEqual(["resume.start", "ready.services"]);
    await owner.close();
  });

  it("a close during recovery waits for the sweep and never starts resume or exposes consumers", async () => {
    const f = fixture();
    const gate = deferred();
    vi.mocked(recovery.closeStaleAttachments).mockImplementation(async () => {
      await gate.promise;
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
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await refused;
    await drain;
    expect(f.services).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("resume.start");
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
    expect(f.options.ports.log.error).toHaveBeenCalledWith("[volli] outbox failure");
    expect(f.options.ports.log.error).toHaveBeenCalledWith("[volli] relay failure");
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
        expect(f.options.ports.log.error).toHaveBeenCalledWith(
          "[volli] failed to recover delegations:",
          "delegation failed",
        );
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
      host: { ...f.options.host, sessionWakeBus: null },
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

  it("closing an unstarted owner prevents any later recovery", async () => {
    const f = fixture();
    const owner = createSessionRuntimeLifecycle(f.options);
    await owner.close();
    await expect(owner.ready()).rejects.toThrow("closing");
    expect(recovery.closeStaleAttachments).not.toHaveBeenCalled();
  });

  it("degraded boot still installs a close, with no recovery engine or schedulers", async () => {
    const f = fixture();
    const host = {
      ...f.options.host,
      database: { ok: false as const, error: "unavailable" },
      sessionEngine: null,
      hostNoticeOutbox: null,
      sessionWakeBus: null,
    };
    const owner = createSessionRuntimeLifecycle({ ...f.options, host, runtime: null });
    await owner.ready();
    owner.observeScheduledResume({} as SessionProjection);
    owner.relayShellNotice({} as Parameters<typeof owner.relayShellNotice>[0]);
    expect(recovery.closeStaleAttachments).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["quit.hold", "ready.services"]);
    await owner.close();
  });
});
