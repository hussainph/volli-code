import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { insertProject } from "@volli/host-core/db/projects-repo";
import { openTestDb, testProject } from "@volli/host-core/db/test-helpers";
import type { TestDb } from "@volli/host-core/db/test-helpers";
import { writeSessionUnread } from "@volli/host-core/db/session-read-repo";
import { createTestSessionEngine } from "../testing/session-engine";
import { publishSessionListingRow } from "./row-republish";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const provenance = {
  source: { kind: "system" as const, id: "desktop", detail: null },
  venue: { id: "local", kind: "local" as const },
};

async function seeded() {
  ctx = openTestDb();
  const project = testProject({ id: "project" });
  insertProject(ctx.db, project);
  let id = 0;
  const engine = createTestSessionEngine(ctx.db, { now: () => 100, nextId: () => `id-${++id}` });
  const created = await engine.createSession({
    commandId: "create-1",
    projectId: project.id,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: "Plan the migration",
    provenance,
  });
  return { engine, projectId: project.id, sessionId: created.session.id };
}

describe("publishSessionListingRow", () => {
  it("broadcasts the Session's row, carrying the receipt the row is about", async () => {
    const { engine, projectId, sessionId } = await seeded();
    writeSessionUnread(ctx.db, sessionId, 4_000);
    const publish = vi.fn();

    await publishSessionListingRow(
      {
        db: ctx.db,
        getSession: (query) => engine.getSession(query),
        liveAttachmentIds: () => new Set(),
        publish,
      },
      sessionId,
    );

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      projectId,
      ticketId: null,
      row: { read: { unreadSince: 4_000 } },
    });
  });

  it("publishes nothing for a Session the ledger no longer has", async () => {
    await seeded();
    const publish = vi.fn();

    await publishSessionListingRow(
      {
        db: ctx.db,
        getSession: () => Promise.resolve(null),
        liveAttachmentIds: () => new Set(),
        publish,
      },
      "gone",
    );

    expect(publish).not.toHaveBeenCalled();
  });
});
