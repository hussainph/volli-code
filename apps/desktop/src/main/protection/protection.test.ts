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
import { setAppState } from "../db/app-state-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { PROTECTION_CHANNELS, PROTECTION_IPC } from "../ipc-descriptors";
import { createProtection } from "./host";
import { registerProtectionIpcHandlers } from "./ipc";
import {
  PROTECTION_EXPERIMENT_KEY,
  protectionExperimentEnabled,
  setProtectionExperimentEnabled,
} from "./settings";

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

describe("the experiment switch", () => {
  it("is off until someone turns it on, and reads anything odd as off", () => {
    expect(protectionExperimentEnabled(ctx.db)).toBe(false);
    setProtectionExperimentEnabled(ctx.db, true, 1);
    expect(protectionExperimentEnabled(ctx.db)).toBe(true);
    setProtectionExperimentEnabled(ctx.db, false, 2);
    expect(protectionExperimentEnabled(ctx.db)).toBe(false);
    setAppState(ctx.db, PROTECTION_EXPERIMENT_KEY, "not json", 3);
    expect(protectionExperimentEnabled(ctx.db)).toBe(false);
    setAppState(ctx.db, PROTECTION_EXPERIMENT_KEY, "null", 4);
    expect(protectionExperimentEnabled(ctx.db)).toBe(false);
    setAppState(ctx.db, PROTECTION_EXPERIMENT_KEY, '{"enabled":"yes"}', 5);
    expect(protectionExperimentEnabled(ctx.db)).toBe(false);
  });
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

  it("writes a row with provenance from a person's answer, and serves it back as a counted hit", () => {
    const { protection } = host("parent");
    expect(protection.covers(writeScope("/Users/me/code/docs/guides/b.md"))).toBeNull();
    protection.remember(grant("project"));
    const hit = protection.covers(writeScope("/Users/me/code/docs/guides/b.md"));
    expect(hit).toMatchObject({ summary: "Write to /Users/me/code/docs/guides" });
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
    expect(child.covers(scope)).not.toBeNull();
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
    protection.decided({
      toolCallId: "call-3",
      tool: "write",
      authoriser: "user:once",
      rule: "r",
      summary: "s",
      asked: "a",
      approvalId: null,
    });
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
    protection.decided({
      toolCallId: "c",
      tool: "write",
      authoriser: "rule:hard",
      rule: "r",
      summary: "s",
      asked: "a",
      approvalId: null,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the protection IPC surface", () => {
  it("reads and writes the switch", async () => {
    registerProtectionIpcHandlers(ctx.db, undefined, () => 7);
    expect(await invoke("volli:protection-get")).toEqual({ ok: true, enabled: false });
    expect(await invoke("volli:protection-set", true)).toEqual({ ok: true, enabled: true });
    expect(await invoke("volli:protection-get")).toEqual({ ok: true, enabled: true });
  });

  it("lists, revokes and restores approvals, and says so when one is already gone", async () => {
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
      rule: "path.private",
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
    expect(await invoke("volli:protection-revoke", id)).toMatchObject({ ok: true });
    expect(await invoke("volli:protection-revoke", id)).toEqual({
      ok: false,
      error: "That approval is already gone.",
    });
    expect(
      ((await invoke("volli:protection-approvals", projectId)) as { approvals: unknown[] })
        .approvals,
    ).toEqual([]);
    expect(await invoke("volli:protection-restore", id)).toMatchObject({ ok: true });
    expect(await invoke("volli:protection-restore", id)).toEqual({
      ok: false,
      error: "That approval can't be restored.",
    });
  });

  it("refuses malformed requests before they reach anything", async () => {
    registerProtectionIpcHandlers(ctx.db);
    expect(await invoke("volli:protection-set", "yes")).toEqual({
      ok: false,
      error: "Invalid request",
    });
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
    expect(await invoke("volli:protection-get", "junk")).toEqual({
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
    expect(await invoke("volli:protection-get")).toEqual({
      ok: false,
      error: "Protection settings are unavailable.",
    });
  });

  it("derives its channel list from the descriptor table", () => {
    expect(PROTECTION_CHANNELS).toEqual(Object.keys(PROTECTION_IPC));
    expect(PROTECTION_CHANNELS).toEqual([
      "volli:protection-get",
      "volli:protection-set",
      "volli:protection-approvals",
      "volli:protection-revoke",
      "volli:protection-restore",
    ]);
  });
});
