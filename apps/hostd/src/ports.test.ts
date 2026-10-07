import { describe, expect, it, vi } from "vite-plus/test";

import { ALWAYS_ONLINE } from "@volli/agent-runtime";
import { NO_POWER_EVENTS } from "@volli/host-core/ports";

import type { HostdLogger } from "./log";
import { headlessPorts } from "./ports";

type LogFn = HostdLogger["info"];

function logger() {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}

describe("hostd's headless ports", () => {
  it("drops a broadcast, logging its topic and never its payload", () => {
    const log = logger();
    headlessPorts(log).events.publish("data-changed", { projectId: "secret-project" });
    expect(log.debug).toHaveBeenCalledWith("event dropped: no client connected", {
      topic: "data-changed",
    });
  });

  it("answers every alert unsupported, logs what it would have raised, and focuses nothing", () => {
    const log = logger();
    const ports = headlessPorts(log);
    const outcome = ports.attention.deliver({
      producer: "agent-notify",
      title: "Ticket moved",
      body: "the body stays out of the log",
      target: null,
    });
    expect(outcome).toEqual({ delivered: false, reason: "unsupported" });
    expect(log.info).toHaveBeenCalledWith("attention not delivered: no client connected", {
      producer: "agent-notify",
      title: "Ticket moved",
    });
    expect(ports.attention.focusedSessionIds().size).toBe(0);
  });

  it("routes host-core's own log through the structured logger", () => {
    const log = logger();
    const ports = headlessPorts(log);
    ports.log.error("failed to open database", { detail: "EACCES" });
    ports.log.warn("careful");
    expect(log.error).toHaveBeenCalledWith("failed to open database", {
      source: "host-core",
      detail: "EACCES",
    });
    expect(log.warn).toHaveBeenCalledWith("careful", { source: "host-core" });
  });

  it("never sleeps, is always online, and has no client, trash or runtime", () => {
    const ports = headlessPorts(logger());
    expect(ports.power).toBe(NO_POWER_EVENTS);
    expect(ports.connectivity).toBe(ALWAYS_ONLINE);
    expect(ports.client).toBeUndefined();
    expect(ports.trash).toBeUndefined();
    // The runtime's open bindings and scheduled resume are host-core's own wiring.
    expect(ports).not.toHaveProperty("listOpenNativeBindings");
    expect(ports).not.toHaveProperty("observeScheduledResume");
  });
});
