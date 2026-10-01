import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readScope, writeScope } from "@volli/shared";

import type { VolliIpcChannel } from "../../ipc/contract";

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

import { listApprovals, listDecisions } from "../db/authority-approvals-repo";
import { insertProject } from "../db/projects-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { PROTECTION_CHANNELS, PROTECTION_IPC } from "../ipc-descriptors";
import { createProtection } from "./host";
import { registerProtectionIpcHandlers } from "./ipc";

let ctx: TestDb;
let projectId: string;

async function invoke(channel: VolliIpcChannel, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`No handler registered for ${channel}`);
  return (handler as (event: unknown, ...rest: unknown[]) => unknown)({ sender: {} }, ...args);
}

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  projectId = project.id;
  for (const id of ["parent", "child"]) {
    ctx.db
      .prepare(
        "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, project.id, null, id, 1);
  }
});

afterEach(() => {
  ctx.cleanup();
});

const grant = (scope: "session" | "project") => ({
  scope,
  scopes: [writeScope("/Users/me/code/docs/guides/a.md")],
  rule: "path.outside-workspace",
  asked: "write  /Users/me/code/docs/guides/a.md",
  reason: "outside",
  interactionId: "ask:call-1",
});

describe("the protection host", () => {
  function host(sessionId: string, inheritedFrom: string[] = []) {
    const errors: unknown[] = [];
    return {
      errors,
      protection: createProtection({
        db: ctx.db,
        now: () => 42,
        projectId,
        sessionId,
        inheritedFrom,
        sessionTitle: "Docs pass",
        ticketDisplayId: "VC-12",
        onError: (error) => errors.push(error),
      }),
    };
  }

  it("writes provenance, but counts a ledger hit only after the call completes", () => {
    const { protection } = host("parent");
    expect(protection.covers(writeScope("/Users/me/code/docs/guides/b.md"))).toBeNull();
    protection.remember(grant("project"));
    const hit = protection.covers(writeScope("/Users/me/code/docs/guides/b.md"));
    expect(hit).toMatchObject({ summary: "Write to /Users/me/code/docs/guides" });
    expect(listApprovals(ctx.db, projectId)[0].useCount).toBe(0);
    protection.decided({
      toolCallId: "call-1",
      tool: "write",
      authoriser: "policy:ledger",
      rule: "path.outside-workspace",
      summary: hit!.summary,
      asked: "write b.md",
      approvalId: hit!.approvalId,
    });
    expect(listApprovals(ctx.db, projectId)[0].useCount).toBe(0);
    protection.completed?.("call-1");
    protection.completed?.("call-1"); // a repeated completion never double-counts
    const [row] = listApprovals(ctx.db, projectId);
    expect(row).toMatchObject({
      scope: "project",
      sessionId: null,
      useCount: 1,
      lastUsedAt: 42,
      createdAt: 42,
      provenance: {
        sessionId: "parent",
        sessionTitle: "Docs pass",
        ticketDisplayId: "VC-12",
        asked: "write  /Users/me/code/docs/guides/a.md",
        interactionId: "ask:call-1",
      },
    });
  });

  it("lists one passed request when a completed call uses two grants, even after host recreation", async () => {
    const { protection } = host("parent");
    const targets = [
      writeScope("/Users/me/code/docs/guides/a.md"),
      writeScope("/Users/me/code/docs/reference/b.md"),
    ];
    protection.remember({ ...grant("project"), scopes: targets });
    for (const target of targets) {
      const hit = protection.covers(target)!;
      protection.decided({
        toolCallId: "compound-1",
        tool: "execute",
        authoriser: "policy:ledger",
        rule: "path.outside-workspace",
        summary: hit.summary,
        asked: "write both folders",
        approvalId: hit.approvalId,
      });
    }
    protection.completed?.("compound-1");
    registerProtectionIpcHandlers(ctx.db);
    expect(await invoke("volli:protection-approvals", projectId)).toMatchObject({
      ok: true,
      passedRequestCount: 1,
      approvals: [
        expect.objectContaining({ useCount: 1 }),
        expect.objectContaining({ useCount: 1 }),
      ],
    });
    const replacement = host("parent").protection;
    for (const target of targets) {
      const hit = replacement.covers(target)!;
      replacement.decided({
        toolCallId: "compound-1",
        tool: "execute",
        authoriser: "policy:ledger",
        rule: "path.outside-workspace",
        summary: hit.summary,
        asked: "write both folders",
        approvalId: hit.approvalId,
      });
    }
    replacement.completed?.("compound-1");
    expect(await invoke("volli:protection-approvals", projectId)).toMatchObject({
      passedRequestCount: 1,
    });
    expect(listApprovals(ctx.db, projectId).map((row) => row.useCount)).toEqual([1, 1]);
  });

  it("rolls back every scope when a multi-scope grant cannot be saved", () => {
    const { protection } = host("parent");
    ctx.db.exec(`CREATE TRIGGER fail_second_approval BEFORE INSERT ON authority_approvals
      WHEN NEW.operation = 'read' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    expect(() =>
      protection.remember({
        ...grant("project"),
        scopes: [...grant("project").scopes, readScope("/Users/me/.npmrc")],
      }),
    ).toThrow("disk full");
    expect(listApprovals(ctx.db, projectId)).toEqual([]);
  });

  it("skips a scope with nothing to remember", () => {
    const { protection } = host("parent");
    protection.remember({
      ...grant("session"),
      scopes: [{ ...writeScope("/a/b/c/d/e"), key: null }],
    });
    expect(listApprovals(ctx.db, projectId)).toEqual([]);
  });

  it("lets a subagent read its parent's Session approvals, but never write into them", () => {
    host("parent").protection.remember(grant("session"));
    const child = host("child", ["parent"]).protection;
    const parent = host("parent").protection;
    const scope = writeScope("/Users/me/code/docs/guides/x.md");
    const hit = child.covers(scope)!;
    expect(hit).not.toBeNull();
    child.decided({
      toolCallId: "child-call",
      tool: "write",
      authoriser: "policy:ledger",
      rule: "path.outside-workspace",
      summary: hit.summary,
      asked: "write x.md",
      approvalId: hit.approvalId,
    });
    child.completed?.("child-call");
    expect(listApprovals(ctx.db, projectId)[0].lastUsedBySessionId).toBe("child");

    const own = readScope("/Users/me/.npmrc");
    child.remember({ ...grant("session"), scopes: [own] });
    expect(child.covers(own)).not.toBeNull();
    expect(parent.covers(own)).toBeNull();
  });

  it("records who authorised a call, and reports a record it could not write", () => {
    const { protection, errors } = host("parent");
    protection.decided({
      toolCallId: "call-1",
      tool: "write",
      authoriser: "user:once",
      rule: "path.outside-workspace",
      summary: "Write to /a",
      asked: "write /a/b",
      approvalId: null,
    });
    expect(listDecisions(ctx.db, "parent")).toHaveLength(1);
    protection.decided({
      toolCallId: "call-2",
      tool: "write",
      authoriser: "user:once",
      rule: "r",
      summary: "s",
      asked: "a",
      approvalId: null,
    });
    ctx.db.exec("DROP TABLE authority_decisions");
    expect(() =>
      protection.decided({
        toolCallId: "call-3",
        tool: "write",
        authoriser: "user:once",
        rule: "r",
        summary: "s",
        asked: "a",
        approvalId: null,
      }),
    ).toThrow("no such table");
    expect(errors).toHaveLength(1);
  });

  it("falls back to console diagnostics when nobody gave a sink", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const protection = createProtection({
      db: ctx.db,
      now: () => 1,
      projectId,
      sessionId: "no-such-session",
      inheritedFrom: [],
      sessionTitle: null,
      ticketDisplayId: null,
    });
    expect(() =>
      protection.decided({
        toolCallId: "c",
        tool: "write",
        authoriser: "rule:hard",
        rule: "r",
        summary: "s",
        asked: "a",
        approvalId: null,
      }),
    ).toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the protection IPC surface", () => {
  it("lists, revokes and restores approvals through durable commands", async () => {
    createProtection({
      db: ctx.db,
      now: () => 1,
      projectId,
      sessionId: "parent",
      inheritedFrom: [],
      sessionTitle: null,
      ticketDisplayId: null,
    }).remember({
      scope: "project",
      scopes: [readScope("/Users/me/.npmrc")],
      rule: "path.outside-workspace",
      asked: "cat ~/.npmrc",
      reason: "private",
      interactionId: "ask:c",
    });
    registerProtectionIpcHandlers(ctx.db, undefined, () => 9);
    const listed = (await invoke("volli:protection-approvals", projectId)) as {
      approvals: { id: string }[];
    };
    expect(listed.approvals).toHaveLength(1);
    const id = listed.approvals[0].id;
    expect(await invoke("volli:protection-revoke", id, "revoke-1")).toMatchObject({ ok: true });
    expect(await invoke("volli:protection-revoke", id, "revoke-1")).toMatchObject({ ok: true });
    expect(
      ((await invoke("volli:protection-approvals", projectId)) as { approvals: unknown[] })
        .approvals,
    ).toEqual([]);
    expect(await invoke("volli:protection-restore", id, "restore-1")).toMatchObject({ ok: true });
    expect(await invoke("volli:protection-restore", id, "restore-1")).toMatchObject({ ok: true });
  });

  it("replays the same revoke/restore Command IDs after SQLite reopening", async () => {
    const protection = createProtection({
      db: ctx.db,
      now: () => 1,
      projectId,
      sessionId: "parent",
      inheritedFrom: [],
      sessionTitle: null,
      ticketDisplayId: null,
    });
    protection.remember(grant("project"));
    const [row] = listApprovals(ctx.db, projectId);
    registerProtectionIpcHandlers(ctx.db, undefined, () => 9);
    const [first, concurrent] = await Promise.all([
      invoke("volli:protection-revoke", row.id, "revoke-command"),
      invoke("volli:protection-revoke", row.id, "revoke-command"),
    ]);
    expect(first).toMatchObject({
      ok: true,
      receipt: { commandId: "revoke-command", status: "accepted" },
    });
    expect(concurrent).toEqual(first);
    ctx.db.close();
    ctx.db = openRawDb(ctx.dbPath);
    ctx.db.pragma("foreign_keys = ON");
    registerProtectionIpcHandlers(ctx.db, undefined, () => 99);
    expect(await invoke("volli:protection-revoke", row.id, "revoke-command")).toEqual(first);
    const restored = await invoke("volli:protection-restore", row.id, "restore-command");
    expect(restored).toMatchObject({ ok: true, receipt: { status: "accepted" } });
    expect(await invoke("volli:protection-restore", row.id, "restore-command")).toEqual(restored);
    expect(ctx.db.prepare("SELECT * FROM authority_approval_events").all()).toHaveLength(2);
    expect(listApprovals(ctx.db, projectId)).toHaveLength(1);
  });

  it("records rejected commands, refuses ID reuse, and rolls back events/receipts if projection fails", async () => {
    registerProtectionIpcHandlers(ctx.db, undefined, () => 9);
    expect(await invoke("volli:protection-revoke", "missing", "missing-revoke")).toEqual({
      ok: false,
      error: "That approval is gone.",
    });
    expect(await invoke("volli:protection-restore", "missing", "missing-restore")).toEqual({
      ok: false,
      error: "That approval can't be restored.",
    });
    const protection = createProtection({
      db: ctx.db,
      now: () => 1,
      projectId,
      sessionId: "parent",
      inheritedFrom: [],
      sessionTitle: null,
      ticketDisplayId: null,
    });
    protection.remember(grant("project"));
    const [row] = listApprovals(ctx.db, projectId);
    expect(await invoke("volli:protection-revoke", row.id, "missing-revoke")).toEqual({
      ok: false,
      error: "That command ID belongs to a different action.",
    });
    expect(await invoke("volli:protection-restore", row.id, "missing-restore")).toEqual({
      ok: false,
      error: "That command ID belongs to a different action.",
    });
    ctx.db.exec(`CREATE TRIGGER fail_revoke BEFORE UPDATE OF revoked_at ON authority_approvals
      BEGIN SELECT RAISE(ABORT, 'projection failed'); END`);
    await expect(invoke("volli:protection-revoke", row.id, "rollback-revoke")).resolves.toEqual({
      ok: false,
      error: "projection failed",
    });
    expect(
      ctx.db
        .prepare("SELECT * FROM authority_approval_commands WHERE command_id = 'rollback-revoke'")
        .get(),
    ).toBeUndefined();
    expect(ctx.db.prepare("SELECT * FROM authority_approval_events").all()).toEqual([]);
    expect(listApprovals(ctx.db, projectId)).toHaveLength(1);
    ctx.db.exec("DROP TRIGGER fail_revoke");
    expect(await invoke("volli:protection-revoke", row.id, "rollback-revoke")).toMatchObject({
      ok: true,
    });
  });

  it("refuses malformed requests before they reach anything", async () => {
    registerProtectionIpcHandlers(ctx.db);
    expect(await invoke("volli:protection-approvals", "")).toEqual({
      ok: false,
      error: "Invalid request",
    });
    expect(await invoke("volli:protection-revoke")).toEqual({
      ok: false,
      error: "Invalid request",
    });
    expect(await invoke("volli:protection-restore", 3)).toEqual({
      ok: false,
      error: "Invalid request",
    });
  });

  it("answers every channel with the reason when the database never opened", async () => {
    registerProtectionIpcHandlers(null, "The database failed to open.");
    for (const channel of PROTECTION_CHANNELS) {
      expect(await invoke(channel)).toEqual({ ok: false, error: "The database failed to open." });
    }
    handlers.clear();
    registerProtectionIpcHandlers(null);
    expect(await invoke("volli:protection-approvals")).toEqual({
      ok: false,
      error: "Protection settings are unavailable.",
    });
  });

  it("derives its channel list from the descriptor table", () => {
    expect(PROTECTION_CHANNELS).toEqual(Object.keys(PROTECTION_IPC));
    expect(PROTECTION_CHANNELS).toEqual([
      "volli:protection-approvals",
      "volli:protection-revoke",
      "volli:protection-restore",
    ]);
  });
});
