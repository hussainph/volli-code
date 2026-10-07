import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTicketCommand } from "@volli/host-core/board";
import { insertProject, openVolliDb } from "@volli/host-core/db";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { validateListenerLimits } from "@volli/session-rpc/websocket";
import { HOST_LINK_RELAY_STREAMS_PER_LINK } from "@volli/shared";

import {
  cloudEnabled,
  HOSTD_FEATURES,
  HOSTD_LISTENER_LIMITS,
  hostdBoardFeed,
  hostResourceWorkspace,
  isLiteralLoopback,
  sessionWorkspace,
} from "./host-protocol";

describe("the cloud flag", () => {
  it("is on only when the environment's opt-in list names it", () => {
    expect(cloudEnabled({})).toBe(false);
    expect(cloudEnabled({ VOLLI_EXPERIMENTAL: "" })).toBe(false);
    expect(cloudEnabled({ VOLLI_EXPERIMENTAL: "something-else" })).toBe(false);
    expect(cloudEnabled({ VOLLI_EXPERIMENTAL: "Cloud" })).toBe(true);
    expect(cloudEnabled({ VOLLI_EXPERIMENTAL: "future, cloud" })).toBe(true);
  });
});

describe("what hostd offers", () => {
  it("is every v1 feature it composes, and not Model Access, which it does not", () => {
    expect(HOSTD_FEATURES).toStrictEqual([
      "sessions",
      "sessions.queue",
      "sessions.subscribe",
      "sessions.history",
      "session.read",
      "board.read",
      "board.write",
      // Sign-ins on this host and the relay's delivery (VC-702).
      "sign-ins",
      "auth.callback",
      // The Session listing rows (VC-713).
      "sessions.listing",
    ]);
  });
});

describe("the Session router's resource port", () => {
  it("answers a Session's project, null for an absent one, and nothing for another kind", async () => {
    const asked: string[] = [];
    const resolve = sessionWorkspace({
      getSession: async ({ sessionId }) => {
        asked.push(sessionId);
        return sessionId === "known"
          ? ({ session: { projectId: "project-1" } } as Awaited<
              ReturnType<Parameters<typeof sessionWorkspace>[0]["getSession"]>
            >)
          : null;
      },
    });
    expect(await resolve({ kind: "session", id: "known" })).toBe("project-1");
    expect(await resolve({ kind: "session", id: "absent" })).toBeNull();
    expect(await resolve({ kind: "ticket", id: "known" })).toBeNull();
    expect(asked).toEqual(["known", "absent"]);
  });
});

describe("hostd's board feed and resource port (VC-565)", () => {
  const PROJECT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hostd-board-"));
    db = openVolliDb(join(root, "volli.db"));
    insertProject(db, {
      id: PROJECT,
      name: "Fixture",
      path: root,
      ticketPrefix: "FX",
      colorIndex: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    createTicketCommand(
      db,
      { id: "ticket-1", projectId: PROJECT, title: "One", status: "todo" },
      { now: 2, actor: { kind: "user" } },
    );
    db.prepare(
      "INSERT INTO workspace_epochs (workspace_id, epoch, host_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(PROJECT, 4, "host", 1);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("answers nothing before the database opens, and stamps nothing anywhere", () => {
    const feed = hostdBoardFeed(() => undefined);
    const seen: unknown[] = [];
    feed.subscribe(PROJECT, null, (batch) => seen.push(batch));
    feed.noteDataChanged({ ticketId: "ticket-1" });
    feed.noteDataChanged({});
    expect(seen).toEqual([]);
    expect(feed.cursor(PROJECT)).toMatch(/^0:/u);
  });

  it("reads the Workspace's epoch, a ticket's project and every Workspace once it is open", () => {
    const feed = hostdBoardFeed(() => db);
    const seen: { changes: readonly unknown[] }[] = [];
    feed.subscribe(PROJECT, null, (batch) => seen.push(batch));
    expect(feed.cursor(PROJECT)).toMatch(/^4:/u);
    // A Workspace this host has no row for has never been served: epoch 0.
    expect(feed.cursor("no-such-project")).toMatch(/^0:/u);
    feed.noteDataChanged({ ticketId: "ticket-1" });
    feed.noteDataChanged({});
    expect(seen.map(({ changes }) => changes)).toEqual([
      [{ kind: "ticket", op: "upsert", id: "ticket-1", projectId: PROJECT }],
      [{ kind: "project", op: "upsert", id: PROJECT, projectId: PROJECT }],
    ]);
  });

  it("answers a Session from its ledger and every board kind from the board", async () => {
    const resolve = hostResourceWorkspace(db, {
      getSession: async () => null as never,
    });
    expect(await resolve({ kind: "ticket", id: "ticket-1" })).toBe(PROJECT);
    expect(await resolve({ kind: "session", id: "nobody" })).toBeNull();
    expect(await resolve({ kind: "label", id: "nothing" })).toBeNull();
  });
});

// B9 (VC-700): until VC-575's host-wide budget, the listener's own bounds are it.
describe("hostd's listener limits", () => {
  const MIB = 1024 * 1024;

  it("let a desktop open every project, and bound the worst case to 544 MiB", () => {
    const limits = HOSTD_LISTENER_LIMITS;
    expect(() => validateListenerLimits(limits)).not.toThrow();
    expect(limits).toMatchObject({
      maxConnections: 32,
      handshakeBurst: 32,
      maxSubscriptions: 4,
      maxFrameBytes: 2 * MIB,
      maxReplayBytes: 1.5 * MIB,
      maxOutboundBytes: 4 * MIB,
      maxInboundBytes: 1 * MIB,
    });
    // A full resume and the frame behind it fit what one connection may hold unsent.
    expect(limits.maxReplayBytes + limits.maxFrameBytes).toBeLessThanOrEqual(
      limits.maxOutboundBytes,
    );
    const perConnection =
      limits.maxOutboundBytes +
      limits.maxSubscriptions * 2 * limits.maxReplayBytes +
      limits.maxInboundBytes;
    expect(limits.maxConnections * perConnection).toBe(544 * MIB);
    // The desktop's Workspace link relay keeps its streams inside this budget
    // (VC-711, AM1): a change here is a change there.
    expect(limits.maxSubscriptions).toBe(HOST_LINK_RELAY_STREAMS_PER_LINK);
  });

  it("serve a literal loopback address only, never a name", () => {
    for (const host of ["127.0.0.1", "127.8.9.10", "::1"])
      expect(isLiteralLoopback(host)).toBe(true);
    for (const host of ["localhost", "0.0.0.0", "::", "192.168.1.5", "box.local"]) {
      expect(isLiteralLoopback(host)).toBe(false);
    }
  });
});
