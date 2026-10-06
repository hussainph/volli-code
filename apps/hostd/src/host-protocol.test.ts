import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTicketCommand } from "@volli/host-core/board";
import { insertProject, openVolliDb } from "@volli/host-core/db";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  cloudEnabled,
  HOSTD_FEATURES,
  hostdBoardFeed,
  hostResourceWorkspace,
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
