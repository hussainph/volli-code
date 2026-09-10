import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProcessFact } from "@volli/shared";

import type {
  OrphanProcessPolicyResult,
  OrphanProcessReapResult,
  OrphanProcessScanResult,
  VolliIpcChannel,
} from "../../ipc/contract";
import { openTestDb, type TestDb } from "../db/test-helpers";
import { ORPHAN_PROCESS_CHANNELS } from "../ipc-descriptors";

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

import { getAutoReapPolicy } from "./auto-reap-settings";
import { registerOrphanProcessIpcHandlers } from "./ipc";
import { OrphanProcessService } from "./orphan-processes";

const NOW = 1_800_000_000_000;
const worktree = {
  path: "/w/VC-341",
  ticketId: "ticket-341",
  ticketDisplayId: "VC-341",
  projectId: "project-1",
};

const orphan: ProcessFact = {
  pid: 4242,
  ppid: 1,
  pgid: 4242,
  startedAt: NOW - 30 * 3_600_000,
  rssBytes: 1024,
  tty: null,
  command: "next dev",
  cwd: worktree.path,
};

let ctx: TestDb;

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

function service(): OrphanProcessService {
  return new OrphanProcessService({
    ledger: { listOpen: () => [], markExited: () => {}, prune: () => 0 },
    worktrees: () => [worktree],
    liveSessionIds: () => [],
    liveWorktrees: () => [],
    openTerminalCwds: () => [],
    inventory: async () => [orphan],
    now: () => NOW,
    // The process is gone the moment it is asked about: the signal path itself
    // is `orphan-processes.test.ts`'s subject, not this file's.
    signal: (_target, sig) => {
      if (sig === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
    killGraceMs: 0,
  });
}

function invoke<R>(channel: VolliIpcChannel, ...args: unknown[]): R {
  const handler = handlers.get(channel) as ((...args: unknown[]) => R) | undefined;
  if (handler === undefined) throw new Error(`No handler registered for ${channel}`);
  return handler({ sender: {} }, ...args);
}

describe("orphan process IPC", () => {
  it("registers its own complete surface", () => {
    registerOrphanProcessIpcHandlers({ ok: true, db: ctx.db }, service());
    expect([...handlers.keys()].toSorted()).toEqual([...ORPHAN_PROCESS_CHANNELS].toSorted());
  });

  it("scans read-only, and a reap must name the revision it was shown under", async () => {
    registerOrphanProcessIpcHandlers({ ok: true, db: ctx.db }, service());

    const scan = await invoke<Promise<OrphanProcessScanResult>>("volli:orphan-processes-scan");
    expect(scan.ok && scan.inventory.candidates).toHaveLength(1);
    expect(scan.ok && scan.policy).toEqual({ enabled: false, minimumAgeHours: 24 });

    const stale = await invoke<Promise<OrphanProcessReapResult>>("volli:orphan-processes-reap", {
      scanRevision: "someone-elses-revision",
      itemIds: ["ledger:1:1"],
    });
    expect(stale).toEqual({ ok: false, error: expect.stringContaining("out of date") });

    const itemIds = scan.ok ? scan.inventory.candidates.map((entry) => entry.itemId) : [];
    const reaped = await invoke<Promise<OrphanProcessReapResult>>("volli:orphan-processes-reap", {
      scanRevision: scan.ok ? scan.inventory.revision : "",
      itemIds,
    });
    expect(reaped.ok && reaped.report.reapedCount).toBe(1);
  });

  it("refuses a malformed request before it reaches the service", async () => {
    registerOrphanProcessIpcHandlers({ ok: true, db: ctx.db }, service());

    expect(
      await invoke<Promise<OrphanProcessReapResult>>("volli:orphan-processes-reap", {
        scanRevision: "rev",
        itemIds: [],
      }),
    ).toEqual({ ok: false, error: "Invalid reap request" });
    expect(
      await invoke<Promise<OrphanProcessPolicyResult>>("volli:orphan-processes-policy", {
        enabled: "yes",
        minimumAgeHours: 24,
      }),
    ).toEqual({ ok: false, error: "Invalid automatic reaping setting" });
    // Neither guard may reach `args[0]["..."]` on something that is not a
    // record, and neither may accept a call with the wrong arity.
    expect(
      await invoke<Promise<OrphanProcessReapResult>>("volli:orphan-processes-reap", "rev-7"),
    ).toEqual({ ok: false, error: "Invalid reap request" });
    expect(await invoke<Promise<OrphanProcessReapResult>>("volli:orphan-processes-reap")).toEqual({
      ok: false,
      error: "Invalid reap request",
    });
    expect(
      await invoke<Promise<OrphanProcessPolicyResult>>("volli:orphan-processes-policy", null),
    ).toEqual({ ok: false, error: "Invalid automatic reaping setting" });
    expect(
      await invoke<Promise<OrphanProcessPolicyResult>>(
        "volli:orphan-processes-policy",
        { enabled: true, minimumAgeHours: 1 },
        { enabled: false, minimumAgeHours: 1 },
      ),
    ).toEqual({ ok: false, error: "Invalid automatic reaping setting" });
  });

  it("stores what the person chose, clamped by main", async () => {
    registerOrphanProcessIpcHandlers({ ok: true, db: ctx.db }, service(), () => NOW);

    const saved = await invoke<Promise<OrphanProcessPolicyResult>>(
      "volli:orphan-processes-policy",
      { enabled: true, minimumAgeHours: 0 },
    );

    expect(saved).toEqual({ ok: true, policy: { enabled: true, minimumAgeHours: 24 } });
    expect(getAutoReapPolicy(ctx.db)).toEqual({ enabled: true, minimumAgeHours: 24 });
  });

  it("answers every channel with the launch's fault when there is no database or no sweep", async () => {
    registerOrphanProcessIpcHandlers({ ok: false, error: "db is gone" }, null);
    expect(await invoke<Promise<OrphanProcessScanResult>>("volli:orphan-processes-scan")).toEqual({
      ok: false,
      error: "db is gone",
    });

    handlers.clear();
    registerOrphanProcessIpcHandlers({ ok: true, db: ctx.db }, null);
    expect(await invoke<Promise<OrphanProcessScanResult>>("volli:orphan-processes-scan")).toEqual({
      ok: false,
      error: "The process sweep is not available this launch.",
    });
  });
});
