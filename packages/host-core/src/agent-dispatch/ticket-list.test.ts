/**
 * `volli ticket list` on a long-lived board (VC-824).
 *
 * The CLI stops reading any answer past its response limit, and ticket bodies are most of a
 * `ticket list` answer. These drive the real dispatch with a board big enough
 * to cross that limit and measure the frame the socket would write.
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AGENT_RESPONSE_LIMIT_BYTES } from "@volli/shared";
import type { AgentResponse } from "@volli/shared";

import { createAgentCommandService } from "../agent-commands";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { testHostHandlers } from "../testing/host-handlers";
import { createTestSessionEngine } from "../testing/session-engine";

type TicketList = (args: Record<string, unknown>) => Promise<AgentResponse>;

/** A project holding `tickets` tickets, each with a 3 KB body. */
function board(db: TestDb, tickets: number): TicketList {
  insertProject(db.db, testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }));
  db.db.transaction(() => {
    for (let number = 1; number <= tickets; number += 1) {
      insertTicket(
        db.db,
        testTicket("project-one", {
          id: `ticket-${number}`,
          ticketNumber: number,
          title: `Ticket number ${number}`,
          body: `## Evidence\n\n${"x".repeat(3_000)}`,
          status: number % 3 === 0 ? "done" : "backlog",
          labels: number % 2 === 0 ? ["bug"] : [],
        }),
      );
    }
  })();
  const service = createAgentCommandService({
    handlers: testHostHandlers({ db: db.db }),
    db: db.db,
    sessionEngine: createTestSessionEngine(db.db),
    appVersion: "1.2.3",
    now: () => 100,
    newId: () => "generated-1",
  });
  return (args) =>
    service.execute({ v: 1, cmd: "ticket.list", args, ctx: { cwd: "/repo/volli", env: {} } });
}

/** The bytes the socket writes for one answer: the JSON line and its newline. */
const frameBytes = (response: AgentResponse): number =>
  Buffer.byteLength(`${JSON.stringify(response)}\n`);

const ticketsOf = (response: AgentResponse): Record<string, unknown>[] => {
  if (!response.ok) throw new Error(response.error.message);
  return (response.data as { tickets: Record<string, unknown>[] }).tickets;
};

describe("ticket list past the CLI's response limit (VC-824)", () => {
  // One 2,000-ticket board for the reads: neither one writes.
  let db: TestDb;
  let list: TicketList;
  beforeAll(() => {
    db = openTestDb();
    list = board(db, 2_000);
  });
  afterAll(() => db.cleanup());

  it("answers body: false under the limit, with every row but no bodies", async () => {
    const summary = await list({ body: false });

    expect(frameBytes(summary)).toBeLessThan(AGENT_RESPONSE_LIMIT_BYTES);
    const rows = ticketsOf(summary);
    expect(rows).toHaveLength(2_000);
    expect(rows.some((row) => "body" in row)).toBe(false);
    expect(rows[0]).toMatchObject({
      id: "VC-1",
      title: "Ticket number 1",
      status: "backlog",
      labels: [],
    });
  });

  it("keeps bodies in the default rows, which is why the table opts out", async () => {
    const full = await list({});

    const rows = ticketsOf(full);
    expect(rows).toHaveLength(2_000);
    expect(rows.every((row) => typeof row["body"] === "string")).toBe(true);
    expect(frameBytes(full)).toBeGreaterThan(AGENT_RESPONSE_LIMIT_BYTES);
    expect(ticketsOf(await list({ body: true }))[0]).toHaveProperty("body");
  });
});

describe("ticket list's body selector", () => {
  it("refuses one that is not a boolean", async () => {
    const db = openTestDb();
    try {
      expect(await board(db, 0)({ body: "no" })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    } finally {
      db.cleanup();
    }
  });
});
