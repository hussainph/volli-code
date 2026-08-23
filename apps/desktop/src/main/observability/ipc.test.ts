import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AgentObservabilityResult, Result, VolliIpcChannel } from "../../ipc/contract";

// Hoisted so the electron mock factory can capture into it — the shape every
// other main IPC suite here uses.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { openTestDb, type TestDb } from "../db/test-helpers";
import { AgentObservability } from "./settings";
import { registerAgentObservabilityIpcHandlers } from "./ipc";
import type { ObservabilityExporter } from "./sink";

const inertExporter: ObservabilityExporter = {
  export: () => {},
  flush: async () => {},
  shutdown: async () => {},
};

let ctx: TestDb;
let observability: AgentObservability;

/** Dispatch one request the way `ipcMain.handle` would, sender included. */
async function invoke(channel: VolliIpcChannel, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`No handler registered for ${channel}`);
  return (handler as (event: unknown, ...rest: unknown[]) => unknown)({ sender: {} }, ...args);
}

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
  observability = new AgentObservability({
    db: ctx.db,
    serviceVersion: "0.0.0-test",
    createExporter: () => inertExporter,
  });
});

afterEach(() => {
  ctx.cleanup();
});

describe("registerAgentObservabilityIpcHandlers", () => {
  it("answers a read with the whole view", async () => {
    registerAgentObservabilityIpcHandlers(observability);
    expect(await invoke("volli:agent-observability-get")).toEqual({
      ok: true,
      settings: {
        enabled: false,
        endpoint: "http://localhost:4318",
        status: "off",
        problem: null,
      },
    });
  });

  it("answers a write with the view the write produced, not an acknowledgement", async () => {
    registerAgentObservabilityIpcHandlers(observability);
    const result = (await invoke(
      "volli:agent-observability-set",
      true,
      "http://localhost:4318/",
    )) as AgentObservabilityResult;
    expect(result).toEqual({
      ok: true,
      // Normalized by the owner: what the page displays is what is used.
      settings: {
        enabled: true,
        endpoint: "http://localhost:4318",
        status: "exporting",
        problem: null,
      },
    });
    expect(await invoke("volli:agent-observability-get")).toEqual(result);
  });

  it("carries the owner's own sentence back when an address is refused", async () => {
    registerAgentObservabilityIpcHandlers(observability);
    expect(await invoke("volli:agent-observability-set", true, "ftp://localhost:4318")).toEqual({
      ok: false,
      error: "The address must start with http:// or https://.",
    });
    // A refusal changed nothing.
    expect(await invoke("volli:agent-observability-get")).toEqual({
      ok: true,
      settings: {
        enabled: false,
        endpoint: "http://localhost:4318",
        status: "off",
        problem: null,
      },
    });
  });

  it("refuses a malformed request before it reaches the owner", async () => {
    registerAgentObservabilityIpcHandlers(observability);
    for (const args of [
      [],
      [true],
      ["yes", "http://localhost:4318"],
      [true, 4318],
      [true, "x", 1],
    ]) {
      expect(await invoke("volli:agent-observability-set", ...args)).toEqual({
        ok: false,
        error: "Invalid request",
      });
    }
    expect(await invoke("volli:agent-observability-get", "junk")).toEqual({
      ok: false,
      error: "Invalid request",
    });
  });

  it("claims its channels and answers when the database never opened", async () => {
    registerAgentObservabilityIpcHandlers(null);
    // Claimed rather than left unregistered: an unregistered invoke channel
    // hangs, and a Settings page that never answers is worse than one that
    // says why.
    for (const channel of [
      "volli:agent-observability-get",
      "volli:agent-observability-set",
    ] satisfies VolliIpcChannel[]) {
      expect(await invoke(channel)).toEqual({
        ok: false,
        error: "Agent telemetry settings are unavailable.",
      } satisfies Result);
    }
  });

  it("uses the caller's reason for an unavailable surface when one is given", async () => {
    registerAgentObservabilityIpcHandlers(null, "the database failed to open");
    expect(await invoke("volli:agent-observability-get")).toEqual({
      ok: false,
      error: "the database failed to open",
    });
  });
});
