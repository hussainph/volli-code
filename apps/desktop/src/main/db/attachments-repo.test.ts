import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// A controllable failure switch for the "event write fails mid-transaction"
// test below: every other test leaves this false, so recordTicketEvent
// behaves exactly like the real implementation (spread from importOriginal),
// making this mock transparent everywhere except that one test.
const { eventWriteFailure } = vi.hoisted(() => ({ eventWriteFailure: { armed: false } }));

vi.mock("./events-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./events-repo")>();
  return {
    ...actual,
    recordTicketEvent: (...args: Parameters<typeof actual.recordTicketEvent>) => {
      if (eventWriteFailure.armed) throw new Error("simulated event-write failure");
      return actual.recordTicketEvent(...args);
    },
  };
});

import {
  createAttachment,
  deleteAttachment,
  getAttachment,
  listAttachments,
} from "./attachments-repo";
import { listTicketEvents } from "./events-repo";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  eventWriteFailure.armed = false;
  ctx.cleanup();
});

function setup(): { projectId: string; ticketId: string } {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  return { projectId: project.id, ticketId: ticket.id };
}

describe("listAttachments", () => {
  it("returns an empty list for a ticket with no attachments", () => {
    const { ticketId } = setup();
    expect(listAttachments(ctx.db, ticketId)).toEqual([]);
  });

  it("returns attachments chronologically", () => {
    const { ticketId } = setup();
    createAttachment(ctx.db, { ticketId, kind: "file", fileName: "first.pdf" }, 100);
    createAttachment(ctx.db, { ticketId, kind: "file", fileName: "second.pdf" }, 200);

    const attachments = listAttachments(ctx.db, ticketId);
    expect(attachments.map((a) => (a.kind === "file" ? a.fileName : a.url))).toEqual([
      "first.pdf",
      "second.pdf",
    ]);
  });

  it("scopes strictly to the requested ticket", () => {
    const { projectId, ticketId } = setup();
    const otherTicket = testTicket(projectId, { id: "other-ticket" });
    insertTicket(ctx.db, otherTicket);

    createAttachment(ctx.db, { ticketId, kind: "file", fileName: "mine.pdf" }, 100);
    createAttachment(
      ctx.db,
      { ticketId: otherTicket.id, kind: "file", fileName: "theirs.pdf" },
      100,
    );

    expect(
      listAttachments(ctx.db, ticketId).map((a) => (a.kind === "file" ? a.fileName : a.url)),
    ).toEqual(["mine.pdf"]);
  });
});

describe("createAttachment — file", () => {
  it("inserts the row with the given fileName and defaults the label to it", () => {
    const { ticketId } = setup();
    const attachment = createAttachment(
      ctx.db,
      { ticketId, kind: "file", fileName: "spec.pdf" },
      100,
    );

    expect(attachment.ticketId).toBe(ticketId);
    expect(attachment.kind).toBe("file");
    if (attachment.kind !== "file") throw new Error("expected a file attachment");
    expect(attachment.fileName).toBe("spec.pdf");
    expect(attachment.label).toBe("spec.pdf");
    expect(attachment.createdAt).toBe(100);
  });

  it("accepts an explicit label distinct from the fileName", () => {
    const { ticketId } = setup();
    const attachment = createAttachment(
      ctx.db,
      { ticketId, kind: "file", fileName: "spec.pdf", label: "The Spec" },
      100,
    );

    expect(attachment.label).toBe("The Spec");
  });

  it("round-trips through getAttachment", () => {
    const { ticketId } = setup();
    const attachment = createAttachment(
      ctx.db,
      { ticketId, kind: "file", fileName: "spec.pdf" },
      100,
    );

    expect(getAttachment(ctx.db, attachment.id)).toEqual(attachment);
  });

  it("returns undefined from getAttachment for an unknown id", () => {
    setup();
    expect(getAttachment(ctx.db, "nope")).toBeUndefined();
  });
});

describe("createAttachment — url", () => {
  it("inserts the row with the given url and defaults the label to it", () => {
    const { ticketId } = setup();
    const attachment = createAttachment(
      ctx.db,
      { ticketId, kind: "url", url: "https://example.com/spec" },
      100,
    );

    expect(attachment.kind).toBe("url");
    if (attachment.kind !== "url") throw new Error("expected a url attachment");
    expect(attachment.url).toBe("https://example.com/spec");
    expect(attachment.label).toBe("https://example.com/spec");
  });

  it("accepts an explicit label distinct from the url", () => {
    const { ticketId } = setup();
    const attachment = createAttachment(
      ctx.db,
      { ticketId, kind: "url", url: "https://example.com/spec", label: "Design doc" },
      100,
    );

    expect(attachment.label).toBe("Design doc");
  });
});

describe("createAttachment — events", () => {
  it("records an attachment_added event in the same transaction", () => {
    const { ticketId } = setup();
    const attachment = createAttachment(
      ctx.db,
      { ticketId, kind: "file", fileName: "spec.pdf" },
      100,
    );

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      kind: "attachment_added",
      attachmentId: attachment.id,
      label: "spec.pdf",
    });
  });

  it("rolls back the row when ticketId is unknown (FK violation)", () => {
    setup();
    expect(() =>
      createAttachment(
        ctx.db,
        { ticketId: "does-not-exist", kind: "file", fileName: "spec.pdf" },
        100,
      ),
    ).toThrow();

    expect(ctx.db.prepare("SELECT COUNT(*) as n FROM ticket_attachments").get()).toEqual({ n: 0 });
  });

  it("rolls back the already-inserted row when the event write fails after it", () => {
    const { ticketId } = setup();
    eventWriteFailure.armed = true;

    expect(() =>
      createAttachment(ctx.db, { ticketId, kind: "file", fileName: "spec.pdf" }, 100),
    ).toThrow("simulated event-write failure");

    expect(listAttachments(ctx.db, ticketId)).toEqual([]);
  });
});

describe("deleteAttachment", () => {
  it("removes the row and records an attachment_removed event", () => {
    const { ticketId } = setup();
    const attachment = createAttachment(
      ctx.db,
      { ticketId, kind: "file", fileName: "spec.pdf" },
      100,
    );

    const deleted = deleteAttachment(ctx.db, attachment.id, 200);

    expect(deleted).toEqual(attachment);
    expect(getAttachment(ctx.db, attachment.id)).toBeUndefined();
    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toEqual({
      kind: "attachment_removed",
      attachmentId: attachment.id,
      label: "spec.pdf",
    });
  });

  it("is idempotent for an unknown id — returns undefined, records no event", () => {
    const { ticketId } = setup();
    expect(deleteAttachment(ctx.db, "nope", 100)).toBeUndefined();
    expect(listTicketEvents(ctx.db, ticketId)).toEqual([]);
  });
});

describe("cascade behavior", () => {
  it("deleting the ticket cascades its attachments away", () => {
    const { ticketId } = setup();
    createAttachment(ctx.db, { ticketId, kind: "file", fileName: "spec.pdf" }, 100);

    ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);

    expect(ctx.db.prepare("SELECT COUNT(*) as n FROM ticket_attachments").get()).toEqual({
      n: 0,
    });
  });
});
