import { afterEach, describe, expect, it } from "vite-plus/test";
import type Database from "better-sqlite3";
import { commandScope, gitScope, readScope, writeScope, type ApprovalScope } from "@volli/shared";

import {
  findCoveringApproval,
  insertApproval,
  insertDecision,
  listApprovals,
  listDecisions,
  recordApprovalUse,
  restoreApproval,
  revokeApproval,
} from "./authority-approvals-repo";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const PROVENANCE = {
  sessionId: "parent",
  sessionTitle: "Docs pass",
  ticketDisplayId: "VC-12",
  asked: "write  /Users/me/code/docs/guides/a.md",
  reason: "outside the workspace",
  interactionId: "ask:call-1",
};

function fixture(): { db: Database.Database; projectId: string } {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  for (const id of ["parent", "child", "stranger"]) {
    ctx.db
      .prepare(
        "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, project.id, null, id, 1_000);
  }
  return { db: ctx.db, projectId: project.id };
}

function add(
  f: { db: Database.Database; projectId: string },
  scope: "session" | "project",
  approval: ApprovalScope,
  sessionId: string | null = scope === "session" ? "parent" : null,
) {
  return insertApproval(f.db, {
    projectId: f.projectId,
    scope,
    sessionId,
    approval,
    rule: "path.outside-workspace",
    provenance: PROVENANCE,
    now: 5_000,
  });
}

describe("authority approvals", () => {
  it("stores a row with its provenance and describes it from the fields the gate matches", () => {
    const f = fixture();
    const row = add(f, "project", writeScope("/Users/me/code/docs/guides/a.md"));
    expect(row).toMatchObject({
      scope: "project",
      sessionId: null,
      operation: "write",
      key: "/Users/me/code/docs/guides",
      summary: "Write to /Users/me/code/docs/guides",
      rule: "path.outside-workspace",
      provenance: PROVENANCE,
      createdAt: 5_000,
      useCount: 0,
      lastUsedAt: null,
      lastUsedBySessionId: null,
    });
    expect(listApprovals(f.db, f.projectId)).toEqual([row]);
  });

  it("refuses a scope that cannot be remembered, and a project row never carries a Session", () => {
    const f = fixture();
    expect(() => add(f, "session", { ...writeScope("/a/b/c/d/e"), key: null })).toThrow(
      "cannot be remembered",
    );
    const row = add(f, "project", writeScope("/a/b/c/d/e"), "parent");
    expect(row.sessionId).toBeNull();
  });

  it("lets a project row serve every Session and a Session row serve only itself and its descendants", () => {
    const f = fixture();
    const scope = writeScope("/Users/me/code/docs/guides/a.md");
    add(f, "session", scope);
    const mine = { projectId: f.projectId, sessionIds: ["parent"] };
    const child = { projectId: f.projectId, sessionIds: ["child", "parent"] };
    const stranger = { projectId: f.projectId, sessionIds: ["stranger"] };
    expect(findCoveringApproval(f.db, mine, scope)?.scope).toBe("session");
    // The child reads through to its parent's live set; a stranger does not.
    expect(findCoveringApproval(f.db, child, scope)?.sessionId).toBe("parent");
    expect(findCoveringApproval(f.db, stranger, scope)).toBeNull();
    add(f, "project", scope);
    expect(findCoveringApproval(f.db, stranger, scope)?.scope).toBe("project");
  });

  it("never lets a child's own Session approval reach its parent", () => {
    const f = fixture();
    const scope = readScope("/Users/me/.npmrc");
    add(f, "session", scope, "child");
    expect(
      findCoveringApproval(f.db, { projectId: f.projectId, sessionIds: ["parent"] }, scope),
    ).toBeNull();
    expect(
      findCoveringApproval(
        f.db,
        { projectId: f.projectId, sessionIds: ["child", "parent"] },
        scope,
      ),
    ).not.toBeNull();
  });

  it("matches at segment boundaries, by operation, and exactly for git and commands", () => {
    const f = fixture();
    add(f, "project", writeScope("/Users/me/code/docs/guides/a.md"));
    add(f, "project", gitScope("git push -C /x"));
    add(f, "project", commandScope("python3 build.py"));
    const who = { projectId: f.projectId, sessionIds: ["parent"] };
    expect(
      findCoveringApproval(f.db, who, writeScope("/Users/me/code/docs/guides/sub/b.md")),
    ).not.toBeNull();
    expect(
      findCoveringApproval(f.db, who, writeScope("/Users/me/code/docs/guides-evil/b.md")),
    ).toBeNull();
    expect(
      findCoveringApproval(f.db, who, readScope("/Users/me/code/docs/guides/a.md")),
    ).toBeNull();
    expect(findCoveringApproval(f.db, who, gitScope("git push -C /x"))).not.toBeNull();
    expect(findCoveringApproval(f.db, who, gitScope("git push --force -C /x"))).toBeNull();
    expect(findCoveringApproval(f.db, who, commandScope("python3 build.py"))).not.toBeNull();
    expect(findCoveringApproval(f.db, who, commandScope("python3 evil.py"))).toBeNull();
    expect(findCoveringApproval(f.db, who, { ...writeScope("/a/b/c/d"), key: null })).toBeNull();
  });

  it.each(["session", "project"] as const)(
    "reuses an identical live %s grant so revoking it leaves no duplicate coverage",
    (scope) => {
      const f = fixture();
      const approval = writeScope("/Users/me/code/docs/guides/a.md");
      const row = add(f, scope, approval);
      recordApprovalUse(f.db, row.id, "child", 6_000);
      const existing = listApprovals(f.db, f.projectId)[0];
      const repeated = insertApproval(f.db, {
        projectId: f.projectId,
        scope,
        sessionId: "parent",
        approval: writeScope("/Users/me/code/docs/guides/b.md"),
        rule: "another-rule",
        provenance: { ...PROVENANCE, interactionId: "ask:call-2" },
        now: 7_000,
      });
      expect(repeated).toEqual(existing);
      expect(listApprovals(f.db, f.projectId)).toEqual([existing]);
      revokeApproval(f.db, row.id, 8_000);
      expect(
        findCoveringApproval(f.db, { projectId: f.projectId, sessionIds: ["parent"] }, approval),
      ).toBeNull();
      const renewed = add(f, scope, approval);
      expect(renewed.id).not.toBe(row.id);
      expect(listApprovals(f.db, f.projectId)).toEqual([renewed]);
    },
  );

  it("keeps grants distinct across project, row scope, Session, operation and key", () => {
    const f = fixture();
    const approval = writeScope("/Users/me/code/docs/guides/a.md");
    const parent = add(f, "session", approval);
    const child = add(f, "session", approval, "child");
    const project = add(f, "project", approval);
    const read = add(f, "session", { ...approval, operation: "read" });
    const differentKey = add(f, "session", writeScope("/Users/me/code/docs/other/a.md"));
    const otherProject = testProject();
    insertProject(f.db, otherProject);
    const other = add({ db: f.db, projectId: otherProject.id }, "project", approval);
    expect(
      new Set([parent, child, project, read, differentKey, other].map((row) => row.id)).size,
    ).toBe(6);
    revokeApproval(f.db, parent.id, 8_000);
    expect(
      listApprovals(f.db, f.projectId)
        .map((row) => row.id)
        .toSorted(),
    ).toEqual([child.id, project.id, read.id, differentKey.id].toSorted());
    expect(listApprovals(f.db, otherProject.id)).toEqual([other]);
  });

  it("revokes all identical legacy rows without leaving hidden coverage", () => {
    const f = fixture();
    const approval = writeScope("/Users/me/code/docs/guides/a.md");
    const row = add(f, "session", approval);
    // Simulate duplicate grants persisted before inserts became idempotent.
    f.db
      .prepare(`INSERT INTO authority_approvals
      (id, project_id, scope, session_id, operation, key, rule, provenance, created_at)
      SELECT 'legacy-duplicate', project_id, scope, session_id, operation, key, rule,
             provenance, created_at FROM authority_approvals WHERE id = ?`)
      .run(row.id);
    expect(revokeApproval(f.db, row.id, 8_000)?.id).toBe(row.id);
    expect(listApprovals(f.db, f.projectId)).toEqual([]);
    expect(
      findCoveringApproval(
        f.db,
        { projectId: f.projectId, sessionIds: ["child", "parent"] },
        approval,
      ),
    ).toBeNull();
    expect(restoreApproval(f.db, row.id)).toEqual(row);
    expect(listApprovals(f.db, f.projectId)).toEqual([row]);
  });

  it("revokes at once, restores the same row, and ignores a repeat", () => {
    const f = fixture();
    const scope = writeScope("/Users/me/code/docs/guides/a.md");
    const row = add(f, "project", scope);
    const who = { projectId: f.projectId, sessionIds: ["parent"] };
    expect(revokeApproval(f.db, row.id, 6_000)?.id).toBe(row.id);
    expect(findCoveringApproval(f.db, who, scope)).toBeNull();
    expect(listApprovals(f.db, f.projectId)).toEqual([]);
    expect(revokeApproval(f.db, row.id, 7_000)).toBeNull();
    expect(restoreApproval(f.db, row.id)).toEqual(row);
    expect(restoreApproval(f.db, row.id)).toBeNull();
    expect(findCoveringApproval(f.db, who, scope)?.id).toBe(row.id);
  });

  it("counts uses, naming a different Session only when it was not the approver", () => {
    const f = fixture();
    const own = add(f, "session", readScope("/Users/me/.npmrc"));
    recordApprovalUse(f.db, own.id, "parent", 8_000);
    recordApprovalUse(f.db, own.id, "child", 9_000);
    const [row] = listApprovals(f.db, f.projectId);
    expect(row).toMatchObject({ useCount: 2, lastUsedAt: 9_000, lastUsedBySessionId: "child" });
    recordApprovalUse(f.db, own.id, "parent", 9_500);
    expect(listApprovals(f.db, f.projectId)[0].lastUsedBySessionId).toBeNull();
    const project = add(f, "project", readScope("/Users/me/.zshrc"));
    recordApprovalUse(f.db, project.id, "child", 9_000);
    expect(
      listApprovals(f.db, f.projectId).find((entry) => entry.id === project.id)
        ?.lastUsedBySessionId,
    ).toBe("child");
  });

  it("dies with its Session", () => {
    const f = fixture();
    add(f, "session", readScope("/Users/me/.npmrc"), "child");
    f.db.prepare("DELETE FROM sessions WHERE id = 'child'").run();
    expect(listApprovals(f.db, f.projectId)).toEqual([]);
  });

  it("reads a damaged provenance as an empty one rather than failing the list", () => {
    const f = fixture();
    const row = add(f, "project", readScope("/Users/me/.zshrc"));
    f.db.prepare("UPDATE authority_approvals SET provenance = '\"oops\"' WHERE id = ?").run(row.id);
    expect(listApprovals(f.db, f.projectId)[0].provenance).toMatchObject({ asked: "", reason: "" });
    f.db.prepare("UPDATE authority_approvals SET provenance = '{}' WHERE id = ?").run(row.id);
    expect(listApprovals(f.db, f.projectId)[0].provenance.interactionId).toBe("");
  });

  it("appends who authorised each call, in a log a Session can be read back from", () => {
    const f = fixture();
    insertDecision(f.db, {
      projectId: f.projectId,
      sessionId: "parent",
      now: 1,
      decision: {
        toolCallId: "call-1",
        tool: "write",
        authoriser: "user:once",
        rule: "path.outside-workspace",
        summary: "Write to /a",
        asked: "write  /a/b",
        approvalId: null,
      },
    });
    insertDecision(f.db, {
      projectId: f.projectId,
      sessionId: "parent",
      now: 2,
      decision: {
        toolCallId: "call-2",
        tool: "write",
        authoriser: "policy:ledger",
        rule: "path.outside-workspace",
        summary: "Write to /a",
        asked: "write  /a/c",
        approvalId: "row-1",
      },
    });
    expect(
      listDecisions(f.db, "parent").map((entry) => [
        entry.toolCallId,
        entry.authoriser,
        entry.approvalId,
        entry.createdAt,
      ]),
    ).toEqual([
      ["call-2", "policy:ledger", "row-1", 2],
      ["call-1", "user:once", null, 1],
    ]);
    expect(listDecisions(f.db, "child")).toEqual([]);
  });
});
