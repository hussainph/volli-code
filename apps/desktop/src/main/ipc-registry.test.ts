import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import type { IpcArgs } from "@volli/shared";

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

import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";

/** Fake IPC event; the registry's envelope must never depend on it. */
const fakeEvent = { sender: {} };

function invoke<T>(channel: string, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)(fakeEvent, ...args);
}

// Real contract channels (the registry's tables are keyed by the contract),
// with test-local guards/handlers — the registry's envelope is under test
// here, not the production descriptors.
const descriptors = {
  "volli:app-state-set": {
    guard: (args: unknown[]): args is IpcArgs<"volli:app-state-set"> =>
      args.length === 2 && args.every((entry) => typeof entry === "string"),
    invalidError: "Invalid app state",
  },
  "volli:data-bootstrap": {
    guard: (args: unknown[]): args is IpcArgs<"volli:data-bootstrap"> => args.length === 0,
    invalidError: "Invalid request",
  },
} as const;

beforeEach(() => {
  handlers.clear();
});

describe("registerGuardedIpcHandlers", () => {
  it("registers a handler for every descriptor channel", () => {
    registerGuardedIpcHandlers(descriptors, {
      "volli:app-state-set": () => ({ ok: true }),
      "volli:data-bootstrap": () => ({ ok: false, error: "unused" }),
    });
    expect([...handlers.keys()].sort()).toEqual(["volli:app-state-set", "volli:data-bootstrap"]);
  });

  it("rejects guard failures synchronously with the descriptor's exact message, never reaching the handler", () => {
    const body = vi.fn(() => ({ ok: true }) as const);
    registerGuardedIpcHandlers(descriptors, {
      "volli:app-state-set": body,
      "volli:data-bootstrap": () => ({ ok: true, data: null as never }),
    });
    const result = invoke("volli:app-state-set", "key-only");
    expect(result).toEqual({ ok: false, error: "Invalid app state" });
    expect(body).not.toHaveBeenCalled();
  });

  it("returns a sync handler's result synchronously — existing sync call sites must keep working", () => {
    registerGuardedIpcHandlers(descriptors, {
      "volli:app-state-set": (key, value) => ({ ok: true, echoed: `${key}=${value}` }) as never,
      "volli:data-bootstrap": () => ({ ok: false, error: "unused" }),
    });
    const result = invoke("volli:app-state-set", "k", "v");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({ ok: true, echoed: "k=v" });
  });

  it("converts a sync handler throw into { ok: false } with the error's message", () => {
    registerGuardedIpcHandlers(descriptors, {
      "volli:app-state-set": () => {
        throw new Error("disk full");
      },
      "volli:data-bootstrap": () => ({ ok: false, error: "unused" }),
    });
    expect(invoke("volli:app-state-set", "k", "v")).toEqual({ ok: false, error: "disk full" });
  });

  it("passes an async handler's resolution through", async () => {
    registerGuardedIpcHandlers(descriptors, {
      "volli:app-state-set": async () => ({ ok: true }),
      "volli:data-bootstrap": () => ({ ok: false, error: "unused" }),
    });
    await expect(invoke<Promise<unknown>>("volli:app-state-set", "k", "v")).resolves.toEqual({
      ok: true,
    });
  });

  it("appends the invoking WebContents after the contract args — sender-scoped handlers (file-watch) need it, everyone else omits the trailing param", () => {
    const seen: unknown[] = [];
    registerGuardedIpcHandlers(descriptors, {
      "volli:app-state-set": (key, value, sender) => {
        seen.push(key, value, sender);
        return { ok: true };
      },
      "volli:data-bootstrap": () => ({ ok: false, error: "unused" }),
    });
    invoke("volli:app-state-set", "k", "v");
    expect(seen).toEqual(["k", "v", fakeEvent.sender]);
  });

  it("converts an async handler rejection into a RESOLVED { ok: false } — failures must cross IPC as data", async () => {
    registerGuardedIpcHandlers(descriptors, {
      "volli:app-state-set": async () => {
        throw new Error("remote said no");
      },
      "volli:data-bootstrap": () => ({ ok: false, error: "unused" }),
    });
    await expect(invoke<Promise<unknown>>("volli:app-state-set", "k", "v")).resolves.toEqual({
      ok: false,
      error: "remote said no",
    });
  });
});

describe("registerDegradedIpcHandlers", () => {
  it("answers every listed channel with the same { ok: false } instead of leaving invoke() hanging", () => {
    registerDegradedIpcHandlers(
      ["volli:app-state-set", "volli:data-bootstrap"],
      "db failed to open",
    );
    expect(invoke("volli:app-state-set", "k", "v")).toEqual({
      ok: false,
      error: "db failed to open",
    });
    expect(invoke("volli:data-bootstrap")).toEqual({ ok: false, error: "db failed to open" });
  });
});
