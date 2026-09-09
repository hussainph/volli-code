/**
 * The label repo is the one funnel every door reaches labels through —
 * `ticket-commands.ts` (ticket create AND `ticket.setLabels`), `data-ipc.ts`,
 * and the agent `label.list` verb. That is why case-insensitive identity is
 * enforced HERE and not in the picker: the picker's create guard was already
 * case-insensitive, and `UI`/`ui` still both existed, because every non-picker
 * door minted its own spelling (VC-310).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { findLabelByName, getOrCreateLabel } from "./labels-repo";
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
});
