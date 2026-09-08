import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  PiSessionOrphanReclaimResult,
  PiSessionOrphanScanResult,
  VolliIpcChannel,
} from "../ipc/contract";
import { openTestDb, type TestDb } from "./db/test-helpers";
import { PI_SESSION_ORPHAN_CHANNELS } from "./ipc-descriptors";

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

import { registerPiSessionOrphanIpcHandlers } from "./pi-session-orphans-ipc";

let ctx: TestDb;
let root: string;

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-pi-orphan-ipc-"));
});

afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function invoke<R>(channel: VolliIpcChannel, ...args: unknown[]): R {
  const handler = handlers.get(channel) as ((...args: unknown[]) => R) | undefined;
  if (handler === undefined) throw new Error(`No handler registered for ${channel}`);
  return handler({ sender: {} }, ...args);
}

describe("Pi session orphan IPC", () => {
  it("registers its own complete two-channel surface", () => {
    registerPiSessionOrphanIpcHandlers({ ok: true, db: ctx.db }, root);

    expect([...handlers.keys()].sort()).toEqual([...PI_SESSION_ORPHAN_CHANNELS].sort());
  });

  it("keeps scan read-only and requires a current main-owned revision for reclaim", async () => {
    registerPiSessionOrphanIpcHandlers({ ok: true, db: ctx.db }, root);

    const scan = await invoke<Promise<PiSessionOrphanScanResult>>("volli:pi-session-orphans-scan");
    expect(scan).toMatchObject({
      ok: true,
      inventory: { candidates: [], candidateCount: 0, candidateBytes: 0 },
    });

    await expect(
      invoke<Promise<PiSessionOrphanReclaimResult>>("volli:pi-session-orphans-reclaim", {
        scanRevision: "not-current",
        itemIds: ["invented"],
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/scan again/i) });
  });

  it("rejects malformed reclaim input at the descriptor boundary", () => {
    registerPiSessionOrphanIpcHandlers({ ok: true, db: ctx.db }, root);

    expect(invoke<PiSessionOrphanReclaimResult>("volli:pi-session-orphans-reclaim", root)).toEqual({
      ok: false,
      error: "Invalid Pi session orphan cleanup request",
    });
  });

  it("answers both channels with the database-open failure in degraded mode", () => {
    registerPiSessionOrphanIpcHandlers({ ok: false, error: "database unavailable" }, root);

    for (const channel of PI_SESSION_ORPHAN_CHANNELS) {
      expect(invoke<unknown>(channel, {})).toEqual({
        ok: false,
        error: "database unavailable",
      });
    }
  });
});
