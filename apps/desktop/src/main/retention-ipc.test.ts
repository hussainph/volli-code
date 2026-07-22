/**
 * Integration test for the retention IPC handlers (issue #76) — the UI agent's
 * contract. Mocks only electron (capturing `ipcMain.handle`, a fake window for
 * the broadcast, a no-op `Notification`); the retention module + runtime are
 * REAL, so these drive the actual watch singleton against a real test db.
 * Handlers exercised here never reach `gh`: they read the composed state of a
 * never-polled ticket, toggle the Keep pin / dismissal, get/set the TTL, and
 * archive-and-clean a worktree-less ticket.
 */
import type {
  RetentionKeepResult,
  RetentionStateResult,
  RetentionTtlResult,
  Result,
  VolliIpcChannel,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { handlers, dataChangedSends } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  dataChangedSends: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  // `worktree-runtime`'s real `worktreeDeps` resolves `attachmentsRoot` off
  // this — unused by the retention paths this suite exercises.
  app: {
    getPath: () => "/volli-test-userdata",
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => {
            dataChangedSends.push({ channel, payload });
          },
        },
      },
    ],
  },
  // The merge notification — a no-op class so `new Notification().show()` works.
  Notification: class {
    show(): void {}
  },
}));

import { registerDataIpcHandlers } from "./data-ipc";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./db/test-helpers";
import { getTicketRow, insertTicket, updateTicketFields } from "./db/tickets-repo";
import { resetOrphanSweepForTest } from "./orphan-sweep";
import { resetRetentionWatcherForTest } from "./retention-runtime";

const fakeEvent = { sender: {} };

function invoke<T>(channel: VolliIpcChannel, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)(fakeEvent, ...args);
}

let ctx: TestDb;

beforeEach(() => {
  handlers.clear();
  dataChangedSends.length = 0;
  resetOrphanSweepForTest();
  resetRetentionWatcherForTest();
  ctx = openTestDb();
  registerDataIpcHandlers({ ok: true, db: ctx.db });
  insertProject(ctx.db, testProject({ id: "p1", path: "/repo" }));
});

afterEach(() => {
  resetRetentionWatcherForTest();
  ctx.cleanup();
});

function seedTicket(over: Parameters<typeof testTicket>[1] = {}): void {
  insertTicket(ctx.db, testTicket("p1", { id: "t1", status: "done", ...over }));
}

describe("volli:retention-state", () => {
  it("returns the composed state for a never-polled ticket (keep=false, prState null)", () => {
    seedTicket();
    updateTicketFields(ctx.db, "t1", { prUrl: "https://x/pull/1" }, 1);
    const result = invoke<RetentionStateResult>("volli:retention-state", { ticketId: "t1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.ticketId).toBe("t1");
    expect(result.state.prUrl).toBe("https://x/pull/1");
    expect(result.state.prState).toBeNull();
    expect(result.state.keep).toBe(false);
  });

  it("errors on an unknown ticket", () => {
    const result = invoke<RetentionStateResult>("volli:retention-state", { ticketId: "nope" });
    expect(result.ok).toBe(false);
  });
});

describe("volli:retention-keep", () => {
  it("persists the pin, reflects it in state, and re-hydrates", () => {
    seedTicket();
    const set = invoke<RetentionKeepResult>("volli:retention-keep", {
      ticketId: "t1",
      keep: true,
    });
    expect(set).toEqual({ ok: true, keep: true });
    expect(getTicketRow(ctx.db, "t1")!.retention_keep).toBe(1);
    expect(dataChangedSends.some((s) => s.channel === "volli:data-changed")).toBe(true);

    const state = invoke<RetentionStateResult>("volli:retention-state", { ticketId: "t1" });
    expect(state.ok && state.state.keep).toBe(true);

    invoke<RetentionKeepResult>("volli:retention-keep", { ticketId: "t1", keep: false });
    expect(getTicketRow(ctx.db, "t1")!.retention_keep).toBe(0);
  });

  it("rejects a malformed request", () => {
    const result = invoke<RetentionKeepResult>("volli:retention-keep", { ticketId: "t1" });
    expect(result.ok).toBe(false);
  });
});

describe("volli:retention-dismiss", () => {
  it("marks the ticket dismissed in the composed state (launch-scoped)", () => {
    seedTicket();
    invoke<Result>("volli:retention-dismiss", { ticketId: "t1" });
    const state = invoke<RetentionStateResult>("volli:retention-state", { ticketId: "t1" });
    expect(state.ok && state.state.dismissed).toBe(true);
  });
});

describe("volli:retention-ttl-get / -set", () => {
  it("defaults to 14 days and round-trips a set (clamped, re-hydrates)", () => {
    expect(invoke<RetentionTtlResult>("volli:retention-ttl-get")).toEqual({ ok: true, days: 14 });

    expect(invoke<RetentionTtlResult>("volli:retention-ttl-set", { days: 30 })).toEqual({
      ok: true,
      days: 30,
    });
    expect(invoke<RetentionTtlResult>("volli:retention-ttl-get")).toEqual({ ok: true, days: 30 });
    // A zero/negative TTL clamps to 1.
    expect(invoke<RetentionTtlResult>("volli:retention-ttl-set", { days: 0 })).toEqual({
      ok: true,
      days: 1,
    });
    expect(dataChangedSends.some((s) => s.channel === "volli:data-changed")).toBe(true);
  });

  it("rejects a non-numeric TTL", () => {
    expect(invoke<RetentionTtlResult>("volli:retention-ttl-set", { days: "lots" }).ok).toBe(false);
  });
});

describe("volli:retention-archive-clean", () => {
  it("archives a worktree-less ticket (nothing to remove) and re-hydrates", async () => {
    seedTicket();
    const result = await invoke<Promise<Result>>("volli:retention-archive-clean", {
      ticketId: "t1",
    });
    expect(result.ok).toBe(true);
    expect(getTicketRow(ctx.db, "t1")!.archived_at).not.toBeNull();
    expect(dataChangedSends.some((s) => s.channel === "volli:data-changed")).toBe(true);
  });
});

describe("volli:retention-poll", () => {
  it("acks the trigger (no candidates → the async poll is a no-op)", () => {
    // No worktree/branch tickets exist, so the fired poll iterates nothing.
    const result = invoke<Result>("volli:retention-poll");
    expect(result.ok).toBe(true);
  });
});
