import { afterEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { queueOrder } from "./engine";
import { movePhase, reached, MOVE_STATES } from "./states";

let ctx: TestDb;
afterEach(() => ctx?.cleanup());

function session(id: string, projectId: string) {
  ctx.db
    .prepare(
      "INSERT INTO sessions (id, project_id, role, title, created_at) VALUES (?, ?, 'project', NULL, 0)",
    )
    .run(id, projectId);
}

describe("the queue's order", () => {
  it("is smallest first, a delegation's parent project first, the named projects last", () => {
    ctx = openTestDb();
    for (const id of ["big", "small", "child", "parent", "current"]) {
      insertProject(ctx.db, testProject({ id, path: `/repo/${id}` }));
    }
    const tickets = { big: 5, small: 0, child: 0, parent: 3, current: 0 };
    for (const [projectId, count] of Object.entries(tickets)) {
      for (let i = 0; i < count; i += 1) insertTicket(ctx.db, testTicket(projectId));
    }
    session("child-session", "child");
    session("parent-session", "parent");
    ctx.db
      .prepare(
        "INSERT INTO session_delegations (session_id, parent_session_id, depth) VALUES (?, ?, 1)",
      )
      .run("child-session", "parent-session");

    expect(
      queueOrder(ctx.db, ["current", "big", "small", "child", "parent"], new Set(["current"])),
    ).toEqual(["small", "parent", "child", "big", "current"]);
  });
});

describe("move states", () => {
  it("map onto the phases a person sees", () => {
    expect(MOVE_STATES.map(movePhase)).toEqual([
      "queued",
      "frozen",
      "exported",
      "uploading",
      "uploading",
      "importing",
      "importing",
      "verifying",
      "verifying",
      "committed",
      "committed",
      "committed",
      "confirmed",
      "rolling_back",
      "rolled_back",
      "returning",
      "returned",
      "superseded",
    ]);
    expect(reached("rows", "staged")).toBe(true);
    expect(reached("staged", "rows")).toBe(false);
    expect(reached("rolling_back", "queued")).toBe(false);
  });
});
