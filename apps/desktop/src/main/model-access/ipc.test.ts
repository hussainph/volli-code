import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

import { MODEL_ACCESS_CHANNELS } from "../ipc-descriptors";
import { registerModelAccessIpcHandlers } from "./ipc";

function invoke(channel: string): unknown {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...args: unknown[]) => unknown)({ sender: {} });
}

beforeEach(() => {
  handlers.clear();
});

// The degraded half of the surface (VC-76): a runtime that never came up must
// answer WHY, on every channel, instead of leaving a nameless refusal — the
// renderer toasts this exact string from its "Couldn't start sign-in" path.
describe("registerModelAccessIpcHandlers (degraded)", () => {
  it("claims every channel and answers with the caller's classified reason", () => {
    const reason =
      "Sign-in is unavailable — the local database failed to open: " +
      "better-sqlite3 was built for a different Node ABI.";
    registerModelAccessIpcHandlers(null, reason);
    expect([...handlers.keys()].toSorted()).toEqual([...MODEL_ACCESS_CHANNELS].toSorted());
    for (const channel of MODEL_ACCESS_CHANNELS) {
      expect(invoke(channel)).toEqual({ ok: false, error: reason });
    }
  });

  it("falls back to the generic refusal when no reason is given", () => {
    registerModelAccessIpcHandlers(null);
    for (const channel of MODEL_ACCESS_CHANNELS) {
      expect(invoke(channel)).toEqual({ ok: false, error: "The agent runtime is unavailable." });
    }
  });
});
