import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { writeScope } from "@volli/shared";

import * as approvals from "../db/authority-approvals-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createProtection } from "./host";

let ctx: TestDb;

afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
});

function fixture() {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  ctx.db
    .prepare(
      "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?,?,?,?,?)",
    )
    .run("parent", project.id, null, "Docs pass", 1_000);
  const errors: unknown[] = [];
  const protection = createProtection({
    db: ctx.db,
    now: () => 5_000,
    projectId: project.id,
    sessionId: "parent",
    inheritedFrom: [],
    sessionTitle: "Docs pass",
    ticketDisplayId: "VC-12",
    onError: (error) => errors.push(error),
  });
  return { projectId: project.id, protection, errors };
}

const GRANT = {
  rule: "path.outside-workspace",
  asked: "write sibling files",
  reason: "outside the workspace",
  interactionId: "ask:call-1",
};

describe("protection host remembered grants", () => {
  it.each(["session", "project"] as const)(
    "remembers sibling scopes once per operation/key for a %s answer",
    (scope) => {
      const f = fixture();
      const insert = vi.spyOn(approvals, "insertApproval");
      const siblingA = writeScope("/Users/me/code/docs/guides/a.md");
      const siblingB = writeScope("/Users/me/code/docs/guides/b.md");
      const read = { ...siblingA, operation: "read" as const };
      f.protection.remember({
        ...GRANT,
        scope,
        scopes: [siblingA, siblingB, read, { ...siblingA, key: null }],
      });
      expect(insert).toHaveBeenCalledTimes(2);
      const rows = approvals.listApprovals(ctx.db, f.projectId);
      expect(rows).toHaveLength(2);
      const write = rows.find((row) => row.operation === "write")!;
      f.protection.remember({ ...GRANT, scope, scopes: [siblingB] });
      expect(approvals.listApprovals(ctx.db, f.projectId)).toEqual(rows);
      approvals.revokeApproval(ctx.db, write.id, 6_000);
      expect(f.protection.covers(siblingA)).toBeNull();
      expect(f.protection.covers(siblingB)).toBeNull();
      expect(approvals.listApprovals(ctx.db, f.projectId)).toEqual(
        rows.filter((row) => row.operation === "read"),
      );
    },
  );

  it("rolls back the whole multi-scope grant if any distinct scope cannot be written", () => {
    const f = fixture();
    const first = writeScope("/Users/me/code/docs/guides/a.md");
    ctx.db
      .prepare(`CREATE TRIGGER fail_second_approval BEFORE INSERT ON authority_approvals
      WHEN NEW.key = '/Users/me/code/docs/other'
      BEGIN SELECT RAISE(ABORT, 'cannot write second scope'); END`)
      .run();
    expect(() =>
      f.protection.remember({
        ...GRANT,
        scope: "session",
        scopes: [first, writeScope("/Users/me/code/docs/other/b.md")],
      }),
    ).toThrow("cannot write second scope");
    expect(approvals.listApprovals(ctx.db, f.projectId)).toEqual([]);
  });
});

describe("post-success accounting regressions", () => {
  it("logs a tally failure and retries idempotently without failing successful work", () => {
    const f = fixture();
    const scope = writeScope("/Users/me/code/docs/guides/a.md");
    f.protection.remember({ ...GRANT, scope: "session", scopes: [scope] });
    const hit = f.protection.covers(scope)!;
    f.protection.decided({
      toolCallId: "completed-1",
      tool: "write",
      authoriser: "policy:ledger",
      rule: GRANT.rule,
      summary: hit.summary,
      asked: GRANT.asked,
      approvalId: hit.approvalId,
    });
    ctx.db.exec(`CREATE TRIGGER tally_failure BEFORE UPDATE OF use_count ON authority_approvals
      BEGIN SELECT RAISE(ABORT, 'tally unavailable'); END`);
    expect(() => f.protection.completed?.("completed-1")).not.toThrow();
    expect(f.errors).toHaveLength(1);
    expect(approvals.listApprovals(ctx.db, f.projectId)[0].useCount).toBe(0);
    ctx.db.exec("DROP TRIGGER tally_failure");
    f.protection.completed?.("completed-1");
    f.protection.completed?.("completed-1");
    expect(approvals.listApprovals(ctx.db, f.projectId)[0].useCount).toBe(1);
  });

  it("never records ordinary project use as subagent inheritance", () => {
    const f = fixture();
    const scope = writeScope("/Users/me/code/docs/guides/a.md");
    f.protection.remember({ ...GRANT, scope: "project", scopes: [scope] });
    const hit = f.protection.covers(scope)!;
    f.protection.decided({
      toolCallId: "project-use",
      tool: "write",
      authoriser: "policy:ledger",
      rule: GRANT.rule,
      summary: hit.summary,
      asked: GRANT.asked,
      approvalId: hit.approvalId,
    });
    f.protection.completed?.("project-use");
    expect(approvals.listApprovals(ctx.db, f.projectId)[0].lastUsedBySessionId).toBeNull();
  });
});
