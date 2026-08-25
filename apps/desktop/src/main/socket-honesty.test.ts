/**
 * VC-163's acceptance, against the real door.
 *
 * > A process that is not a Volli Session, running as the user, can read the
 * > board and change nothing. A Session authenticates itself rather than
 * > announcing itself.
 *
 * Its own file because the property under test is not any one verb's behaviour
 * — it is what the socket does with a CALLER, and that is a claim about the
 * whole surface. `agent-commands.test.ts` acts as an authenticated Session
 * throughout, which is right for testing verbs and would hide exactly this.
 *
 * The premise is worth restating, because the tests below are meaningless
 * without it: the bundled `volli` shim defaults `VOLLI_SOCKET` to a well-known
 * path under the user's own application-support directory. Every process
 * running as that user therefore reaches this socket, with or without any
 * environment. That is not a hole to be closed here — it is the reason the
 * control tier is absent from the socket rather than gated on it, and the
 * reason "no environment variable" had to stop meaning "the user".
 */

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AgentRequest, AgentResponse } from "@volli/shared";

import { createAgentCommandService } from "./agent-commands";
import { insertProject, updateProjectAuthorityPolicy } from "./db/projects-repo";
import { listTicketsByProject, insertTicket } from "./db/tickets-repo";
import { listComments } from "./db/comments-repo";
import { openTestDb, testProject, testSession, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { createDesktopSessionEngine } from "./session-control";
import { insertSession } from "./session-control/test-support";
import { createSessionTokenRegistry } from "./session-tokens";

let ctx: TestDb;

afterEach(() => ctx.cleanup());

const SESSION_ID = "abcdef12-3456-7890-abcd-ef1234567890";

function scenario() {
  ctx = openTestDb();
  insertProject(
    ctx.db,
    testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
  );
  insertTicket(
    ctx.db,
    testTicket("project-one", { id: "ticket-one", ticketNumber: 1, title: "Ship CLI" }),
  );
  insertSession(ctx.db, testSession("project-one", null, { id: SESSION_ID }));

  const tokens = createSessionTokenRegistry();
  const service = createAgentCommandService({
    db: ctx.db,
    sessionEngine: createDesktopSessionEngine(ctx.db),
    appVersion: "1.2.3",
    now: () => 100,
    newId: () => "generated-1",
    verifySessionToken: tokens.verify,
  });

  /** The environment a real Volli Session's shell is given. */
  const session: AgentRequest["ctx"]["env"] = {
    session: SESSION_ID,
    token: tokens.mint({ sessionId: SESSION_ID, attachmentId: "attachment-1" }),
  };

  const run = (
    cmd: AgentRequest["cmd"],
    args: Record<string, unknown>,
    env: AgentRequest["ctx"]["env"],
  ): Promise<AgentResponse> =>
    service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env } });

  return { service, tokens, session, run };
}

describe("a process that is not a Volli Session", () => {
  // The acceptance sentence, first half. `board`, `ticket.list` and
  // `ticket.show` are read tier — any caller, no policy consulted — and they
  // must keep working, because the alternative to "reads are open" is an agent
  // that cannot orient itself without credentials it has no way to obtain.
  it("can read the board with no environment at all", async () => {
    const { run } = scenario();

    for (const [cmd, args] of [
      ["board", {}],
      ["ticket.list", {}],
      ["ticket.show", { id: "VC-1" }],
      ["project.list", {}],
    ] as const) {
      expect(await run(cmd, args, {}), cmd).toMatchObject({ ok: true });
    }
  });

  // The second half, and the one that used to be false: every coordination
  // write is refused, and refused BEFORE it happens rather than reported after.
  it("can change nothing, and the board proves it", async () => {
    const { run } = scenario();

    const writes = [
      ["ticket.create", { title: "Injected" }],
      ["ticket.update", { id: "VC-1", title: "Rewritten" }],
      ["ticket.move", { id: "VC-1", to: "doing" }],
      ["ticket.comment", { id: "VC-1", message: "Forged" }],
      ["notify", { message: "Hello" }],
      ["session.done", {}],
      ["session.blocked", {}],
    ] as const;

    for (const [cmd, args] of writes) {
      expect(await run(cmd, args, {}), cmd).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN_ACTOR" },
      });
    }

    // Nothing landed: one ticket, its original title, its original column, and
    // no comment. A refusal that had already written would be a message.
    expect(listTicketsByProject(ctx.db, "project-one")).toMatchObject([
      { id: "ticket-one", title: "Ship CLI", status: "backlog" },
    ]);
    expect(listComments(ctx.db, "ticket-one")).toEqual([]);
  });

  // The ticket's own named test. Before VC-163 this exact request wrote as the
  // Session it named; before VC-92 an EMPTY environment wrote as the user.
  it("cannot write by naming a Session it does not hold the token for", async () => {
    const { run } = scenario();

    const forged = await run(
      "ticket.comment",
      { id: "VC-1", message: "Not me" },
      {
        session: SESSION_ID,
      },
    );

    expect(forged).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
    expect(listComments(ctx.db, "ticket-one")).toEqual([]);
  });

  it("is told what it is, not merely that it failed", async () => {
    const { run } = scenario();

    const refused = await run("ticket.comment", { id: "VC-1", message: "Nope" }, {});

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // Names the caller's own status and the one thing that changes it. The
    // "do not work around" clause is not decoration: VC-92 §7 is explicit that
    // a refusal an agent cannot act on is a refusal it will route around, by
    // killing a PID or writing a verdict comment by hand.
    expect(refused.error.reason).toContain("not an authenticated Volli Session");
    expect(refused.error.reason).toContain("may read but not write");
    expect(refused.error.next).toContain("from inside a Volli Session");
  });
});

describe("a real Volli Session", () => {
  // The regression guard the ticket asks for in as many words: "a real
  // Session's verbs keep working unchanged".
  it("keeps every coordination verb it had", async () => {
    const { run, session } = scenario();

    expect(await run("ticket.comment", { id: "VC-1", message: "Working" }, session)).toMatchObject({
      ok: true,
      data: { comment: { ticket: "VC-1", body: "Working" } },
    });
    expect(await run("ticket.move", { id: "VC-1", to: "doing" }, session)).toMatchObject({
      ok: true,
      data: { ticket: { status: "doing" } },
    });
    expect(await run("session.done", { reason: "Tests pass" }, session)).toMatchObject({
      ok: true,
      data: { signal: "done" },
    });
  });

  // "A Session authenticates itself rather than announcing itself": the write
  // is attributed to the Session the TOKEN proves, and the comment row cites
  // the same one. Those were two independent derivations until this ticket.
  it("is attributed from its token, in the event and the comment alike", async () => {
    const { run, session } = scenario();

    const commented = await run("ticket.comment", { id: "VC-1", message: "Working" }, session);

    expect(commented).toMatchObject({
      ok: true,
      data: { comment: { actor: "session", session: SESSION_ID.slice(0, 8) } },
    });
    expect(listComments(ctx.db, "ticket-one")).toMatchObject([
      { actor: "session", sessionId: SESSION_ID },
    ]);
  });

  // Per ATTACHMENT: the token dies with the terminal that held it, and a
  // request replaying an old one is a stranger again.
  it("loses its authority when its attachment's token is revoked", async () => {
    const { run, tokens, session } = scenario();

    tokens.revoke("attachment-1");

    expect(await run("ticket.comment", { id: "VC-1", message: "Stale" }, session)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR" },
    });
    // Still a legitimate reader, exactly like any other unauthenticated caller.
    expect(await run("board", {}, session)).toMatchObject({ ok: true });
  });
});

describe("per-project policy, which is what decides all of it", () => {
  // VC-44 built this store and nothing read it. These two prove the wiring:
  // the reads-only default is policy rather than a hard-coded rule, so a
  // project can widen it — and a project can narrow its own Sessions too.
  it("lets a project grant one write to unauthenticated callers", async () => {
    const { run } = scenario();
    updateProjectAuthorityPolicy(
      ctx.db,
      "project-one",
      {
        actors: { unauthenticated: { coordinationVerbs: ["ticket.comment"] } },
      },
      100,
    );

    expect(await run("ticket.comment", { id: "VC-1", message: "From CI" }, {})).toMatchObject({
      ok: true,
    });
    // Granting one grants exactly one.
    expect(await run("ticket.move", { id: "VC-1", to: "doing" }, {})).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR" },
    });
  });

  // And the honest attribution for that caller: not `user`, which is the lie
  // this ticket removed, and not `session`, which it is not.
  it("attributes a granted unauthenticated write as itself", async () => {
    const { run } = scenario();
    updateProjectAuthorityPolicy(
      ctx.db,
      "project-one",
      {
        actors: { unauthenticated: { coordinationVerbs: ["ticket.comment"] } },
      },
      100,
    );

    await run("ticket.comment", { id: "VC-1", message: "From CI" }, {});

    expect(listComments(ctx.db, "ticket-one")).toMatchObject([
      { actor: "unauthenticated", sessionId: null },
    ]);
  });

  it("lets a project withdraw a verb from its own Sessions", async () => {
    const { run, session } = scenario();
    updateProjectAuthorityPolicy(
      ctx.db,
      "project-one",
      {
        actors: { session: { coordinationVerbs: ["ticket.comment"] } },
      },
      100,
    );

    expect(await run("ticket.comment", { id: "VC-1", message: "Fine" }, session)).toMatchObject({
      ok: true,
    });
    const refused = await run("ticket.move", { id: "VC-1", to: "doing" }, session);
    expect(refused).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
    // A different refusal from the anonymous one, because the next move differs:
    // this caller cannot fix it by becoming a Session — it already is one.
    if (!refused.ok) {
      expect(refused.error.reason).toContain("this project allows a session caller");
      expect(refused.error.next).toContain("A person can change it in Settings");
    }
  });
});
