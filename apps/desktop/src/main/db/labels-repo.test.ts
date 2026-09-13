/**
 * The label repo is the one funnel every door reaches labels through —
 * `ticket-commands.ts` (ticket create AND `ticket.setLabels`), `data-ipc.ts`,
 * and the agent `label.list` verb. That is why case-insensitive identity is
 * enforced HERE and not in the picker: the picker's create guard was already
 * case-insensitive, and `UI`/`ui` still both existed, because every non-picker
 * door minted its own spelling (VC-310).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  findLabelByName,
  findLabelRetirement,
  getOrCreateLabel,
  listAllLabels,
  listLabelsByProject,
  retireLabelInto,
} from "./labels-repo";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;

afterEach(() => ctx?.cleanup());

/** A migrated db with one project, the fixture every case below starts from. */
function withProject(): string {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  return project.id;
}

function labelNamesIn(projectId: string): string[] {
  return (
    ctx.db.prepare("SELECT name FROM labels WHERE project_id = ? ORDER BY name").all(projectId) as {
      name: string;
    }[]
  ).map((row) => row.name);
}

describe("getOrCreateLabel", () => {
  it("resolves an existing label whose name differs only in case, minting nothing", () => {
    const projectId = withProject();
    const created = getOrCreateLabel(ctx.db, projectId, "UI", 1);

    const resolved = getOrCreateLabel(ctx.db, projectId, "ui", 2);

    expect(resolved.id).toBe(created.id);
    expect(resolved.name).toBe("UI");
    expect(labelNamesIn(projectId)).toEqual(["UI"]);
  });
});

describe("findLabelByName", () => {
  it("finds a label under any case spelling of its name", () => {
    const projectId = withProject();
    const created = getOrCreateLabel(ctx.db, projectId, "UI", 1);

    expect(findLabelByName(ctx.db, projectId, "ui")?.id).toBe(created.id);
  });

  it("prefers a live Label over an older alias with the same folded name", () => {
    const projectId = withProject();
    const old = getOrCreateLabel(ctx.db, projectId, "UI", 1);
    const target = getOrCreateLabel(ctx.db, projectId, "frontend", 1);
    retireLabelInto(ctx.db, {
      fromLabelId: old.id,
      intoLabelId: target.id,
      now: 2,
      actor: { kind: "user" },
    });
    ctx.db
      .prepare(
        `INSERT INTO labels
           (id, project_id, name, color, row_version, created_at, updated_at)
         VALUES ('new-ui', ?, 'ui', NULL, 1, 3, 3)`,
      )
      .run(projectId);

    expect(findLabelByName(ctx.db, projectId, "Ui")?.id).toBe("new-ui");
  });
});

describe("retireLabelInto", () => {
  it("keeps a zero-Ticket merge as an alias that every create door resolves", () => {
    const projectId = withProject();
    const from = getOrCreateLabel(ctx.db, projectId, "front-end", 1);
    const into = getOrCreateLabel(ctx.db, projectId, "frontend", 1);

    retireLabelInto(ctx.db, {
      fromLabelId: from.id,
      intoLabelId: into.id,
      now: 20,
      actor: { kind: "session", sessionId: "s1", ticketId: null },
    });

    expect(getOrCreateLabel(ctx.db, projectId, "front-end", 30).id).toBe(into.id);
    expect(listAllLabels(ctx.db).map((label) => label.name)).toEqual(["frontend"]);
    expect(listLabelsByProject(ctx.db, projectId).map((label) => label.name)).toEqual(["frontend"]);
    expect(labelNamesIn(projectId)).toEqual(["front-end", "frontend"]);
    expect(findLabelRetirement(ctx.db, projectId, "front-end")).toMatchObject({
      id: from.id,
      intoId: into.id,
      intoName: "frontend",
      mergedAt: 20,
      mergedBy: '{"kind":"session","sessionId":"s1","ticketId":null}',
    });
  });

  it("flattens aliases when their survivor is merged again", () => {
    const projectId = withProject();
    const a = getOrCreateLabel(ctx.db, projectId, "a", 1);
    const b = getOrCreateLabel(ctx.db, projectId, "b", 1);
    const c = getOrCreateLabel(ctx.db, projectId, "c", 1);
    retireLabelInto(ctx.db, {
      fromLabelId: a.id,
      intoLabelId: b.id,
      now: 2,
      actor: { kind: "user" },
    });
    retireLabelInto(ctx.db, {
      fromLabelId: b.id,
      intoLabelId: c.id,
      now: 3,
      actor: { kind: "user" },
    });

    expect(findLabelByName(ctx.db, projectId, "a")?.id).toBe(c.id);
    expect(findLabelByName(ctx.db, projectId, "b")?.id).toBe(c.id);
    expect(
      ctx.db
        .prepare(
          "SELECT name, merged_into_id FROM labels WHERE merged_into_id IS NOT NULL ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "a", merged_into_id: c.id },
      { name: "b", merged_into_id: c.id },
    ]);
  });
});
