/**
 * The relaunch read, against the real SQLite ledger: a schedule written by one
 * process is found by the next, with the reset it was scheduled for.
 */
import { pendingScheduledResume } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createTestSessionEngine } from "../testing/session-engine";
import { insertProject } from "./projects-repo";
import { listScheduledResumeSessionIds } from "./scheduled-resume-repo";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const person = {
  source: { kind: "user" as const, id: "person", detail: null },
  venue: { id: "local", kind: "local" as const },
};
const pi = {
  source: { kind: "adapter" as const, id: "pi", detail: null },
  venue: { id: "local", kind: "local" as const },
};

describe("listScheduledResumeSessionIds", () => {
  it("names each Session that ever scheduled a resume, once, and no other", async () => {
    ctx = openTestDb();
    const project = testProject({ id: "project" });
    insertProject(ctx.db, project);
    let id = 0;
    const engine = createTestSessionEngine(ctx.db, {
      now: () => 100 + id,
      nextId: () => `id-${++id}`,
    });
    const create = async (commandId: string) =>
      (
        await engine.createSession({
          commandId,
          projectId: project.id,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
          provenance: person,
        })
      ).session.id;
    const scheduled = await create("create-scheduled");
    const untouched = await create("create-untouched");
    await engine.observe({
      id: "open",
      sessionId: scheduled,
      occurredAt: 1,
      provenance: pi,
      kind: "attachment.opened",
      attachment: {
        id: "attachment-1",
        sessionId: scheduled,
        adapterId: "pi",
        venue: pi.venue,
        continuity: "fresh",
        native: null,
        authority: null,
      },
    });
    await engine.observe({
      id: "quota",
      sessionId: scheduled,
      attachmentId: "attachment-1",
      occurredAt: 2,
      provenance: pi,
      kind: "attention.raised",
      attention: {
        id: "attention-quota",
        attachmentId: "attachment-1",
        kind: "adapter_unrecoverable",
        detail: "429: Usage limit reached for 5 hour.",
        diagnostic: null,
        resetsAt: 50_000,
      },
    });
    for (const commandId of ["schedule-1", "schedule-2"]) {
      await engine.submit({
        commandId,
        sessionId: scheduled,
        intent: {
          kind: "resume.schedule",
          attentionId: "attention-quota",
          attachmentId: "attachment-1",
          resumeAt: 50_000,
        },
        provenance: person,
      });
    }

    expect(listScheduledResumeSessionIds(ctx.db)).toEqual([scheduled]);
    expect(listScheduledResumeSessionIds(ctx.db)).not.toContain(untouched);
    // And the schedule reads back whole from disk, the latest one pending.
    const projection = await engine.getSession({ sessionId: scheduled });
    expect(projection?.attention.primary).toMatchObject({ resetsAt: 50_000 });
    expect(pendingScheduledResume(projection!)).toMatchObject({
      id: "schedule-2",
      resumeAt: 50_000,
    });
  });
});
