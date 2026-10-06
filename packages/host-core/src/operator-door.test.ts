/**
 * VC-623's acceptance, against the real door: a hostd-issued operator token
 * proves the person, and nothing else about the door moves.
 *
 * > No Session can become a person. A valid operator token means the person.
 * > A request with no token, or with a Session token, is judged exactly as
 * > today.
 *
 * Beside `socket-honesty.test.ts` (VC-163) rather than inside it, because that
 * file's claims must stay true unedited — which is half of what this ticket
 * promises. The verifier here is a stub; the store that backs it on a headless
 * host (a root-owned file of hashes, compared in constant time) is hostd's,
 * and `apps/hostd/src/operators.test.ts` holds it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AgentRequest, AgentResponse } from "@volli/shared";

import { createAgentCommandService } from "./agent-commands";
import type { OperatorWriteRecord } from "./agent-dispatch/context";
import {
  findProjectByPath,
  insertProject,
  listProjects,
  updateProjectAuthorityPolicy,
} from "./db/projects-repo";
import { insertTicket, listTicketsByProject } from "./db/tickets-repo";
import { listComments } from "./db/comments-repo";
import { listTicketEvents } from "./db/events-repo";
import { openTestDb, testProject, testSession, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { createTestSessionEngine } from "./testing/session-engine";
import { insertSession } from "./session-control/test-support";
import { createSessionTokenRegistry } from "./session-tokens";

let ctx: TestDb;
const scratch: string[] = [];

afterEach(() => {
  ctx.cleanup();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION_ID = "abcdef12-3456-7890-abcd-ef1234567890";
const OPERATOR_TOKEN = "volli_op_the-persons-token";

function folder(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), "operator-door-"));
  scratch.push(parent);
  const path = join(parent, name);
  mkdirSync(path);
  return path;
}

function scenario(options: { verifier?: boolean } = {}) {
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
  const verifyOperatorToken = vi.fn((token: string) =>
    token === OPERATOR_TOKEN ? { login: "alice" } : null,
  );
  const audit: OperatorWriteRecord[] = [];
  let ids = 0;
  const service = createAgentCommandService({
    busyWorktreeSites: async () => [],
    db: ctx.db,
    sessionEngine: createTestSessionEngine(ctx.db),
    appVersion: "1.2.3",
    now: () => 100,
    newId: () => `generated-${(ids += 1)}`,
    detectBaseBranch: async () => "main",
    verifySessionToken: tokens.verify,
    ...(options.verifier === false ? {} : { verifyOperatorToken }),
    onOperatorWrite: (record) => audit.push(record),
  });

  /** A real Volli Session's environment. */
  const session: AgentRequest["ctx"]["env"] = {
    session: SESSION_ID,
    token: tokens.mint({ sessionId: SESSION_ID, attachmentId: "attachment-1" }),
  };
  /** The person at the host's shell. */
  const operator: AgentRequest["ctx"]["env"] = { operatorToken: OPERATOR_TOKEN };

  const run = (
    cmd: AgentRequest["cmd"],
    args: Record<string, unknown>,
    env: AgentRequest["ctx"]["env"],
    cwd = "/repo/volli",
  ): Promise<AgentResponse> => service.execute({ v: 1, cmd, args, ctx: { cwd, env } });

  return { run, session, operator, verifyOperatorToken, audit };
}

describe("a valid operator token", () => {
  it("writes as the person: the event and the comment say user, never a Session", async () => {
    const { run, operator } = scenario();

    const created = await run("ticket.create", { title: "Over SSH" }, operator);
    expect(created).toMatchObject({ ok: true });
    const ticket = listTicketsByProject(ctx.db, "project-one").find(
      (candidate) => candidate.title === "Over SSH",
    )!;
    expect(listTicketEvents(ctx.db, ticket.id)).toMatchObject([
      { actor: "user", actorContext: null },
    ]);

    expect(
      await run("ticket.comment", { id: "VC-1", message: "From the box" }, operator),
    ).toMatchObject({ ok: true, data: { comment: { actor: "user" } } });
    expect(listComments(ctx.db, "ticket-one")).toMatchObject([{ actor: "user", sessionId: null }]);
  });

  it("is governed by the project's user policy, the same actor the app's writes are", async () => {
    const { run, operator } = scenario();
    updateProjectAuthorityPolicy(
      ctx.db,
      "project-one",
      { actors: { user: { coordinationVerbs: ["ticket.comment"] } } },
      100,
    );

    expect(await run("ticket.move", { id: "VC-1", to: "doing" }, operator)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR" },
    });
    expect(await run("ticket.comment", { id: "VC-1", message: "Still" }, operator)).toMatchObject({
      ok: true,
    });
  });

  it("reports every write to the audit line, refused or not, and no read", async () => {
    const { run, operator, audit } = scenario();
    updateProjectAuthorityPolicy(
      ctx.db,
      "project-one",
      { actors: { user: { coordinationVerbs: ["ticket.comment"] } } },
      100,
    );

    await run("board", {}, operator);
    await run("ticket.comment", { id: "VC-1", message: "Hi" }, operator);
    await run("ticket.move", { id: "VC-1", to: "doing" }, operator);
    await run("project.add", { id: "/nowhere/at/all" }, operator);

    expect(audit).toEqual([
      { login: "alice", cmd: "ticket.comment", ok: true, code: null },
      { login: "alice", cmd: "ticket.move", ok: false, code: "FORBIDDEN_ACTOR" },
      { login: "alice", cmd: "project.add", ok: false, code: "INVALID_REQUEST" },
    ]);
    expect(JSON.stringify(audit)).not.toContain(OPERATOR_TOKEN);
  });
});

describe("project add", () => {
  it("registers a folder by the app's own rules, named for the folder", async () => {
    const { run, operator } = scenario();
    const path = folder("Acme Rockets");

    const added = await run("project.add", { id: path }, operator);

    expect(added).toEqual({
      v: 1,
      ok: true,
      data: {
        created: true,
        project: {
          id: "generated-1",
          name: "Acme Rockets",
          prefix: "AR",
          path,
          baseBranch: "main",
        },
      },
    });
    expect(findProjectByPath(ctx.db, path)).toMatchObject({ name: "Acme Rockets" });
    // And a second add of the same folder answers with it rather than a twin.
    expect(await run("project.add", { id: path, name: "Other" }, operator)).toMatchObject({
      ok: true,
      data: { created: false, project: { id: "generated-1", name: "Acme Rockets" } },
    });
    expect(listProjects(ctx.db)).toHaveLength(2);
  });

  it("resolves a relative path where the operator typed it, and takes --name", async () => {
    const { run, operator } = scenario();
    const path = folder("repo");

    expect(
      await run(
        "project.add",
        { id: basename(path), name: "  Bravo Board " },
        operator,
        join(path, ".."),
      ),
    ).toMatchObject({ ok: true, data: { project: { path, name: "Bravo Board", prefix: "BB" } } });
  });

  it("previews without writing, and says when the folder is already a project", async () => {
    const { run, operator } = scenario();
    const path = folder("Delta");

    const preview = await run("project.add", { id: path, dryRun: true }, operator);
    expect(preview).toMatchObject({
      ok: true,
      data: { kind: "mutation-plan", target: { kind: "project", id: null, label: "Delta" } },
    });
    expect(findProjectByPath(ctx.db, path)).toBeUndefined();

    const known = await run("project.add", { id: "/repo/volli", dryRun: true }, operator);
    expect(known).toMatchObject({
      ok: true,
      data: { target: { id: "project-one" }, durableWrites: [] },
    });
  });

  it("refuses what the app refuses, with the app's sentences", async () => {
    const { run, operator } = scenario();
    const parent = folder("x");
    const file = join(parent, "file.txt");
    writeFileSync(file, "");

    for (const [args, reason] of [
      [{ id: join(parent, "missing") }, "Project path does not exist"],
      [{ id: file }, "Project path is not a directory"],
      // `VC` is already the first project's prefix.
      [{ id: parent, name: "Volli Code" }, 'Ticket prefix "VC" is already used by'],
      [{ id: "  " }, "needs the folder's path"],
      [{ id: parent, name: "" }, "--name needs a non-empty name"],
      [{}, "needs the folder's path"],
    ] as const) {
      const refused = await run("project.add", args, operator);
      expect(refused, reason).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      if (!refused.ok) expect(refused.error.reason).toContain(reason);
    }
    expect(listProjects(ctx.db)).toHaveLength(1);
  });

  it("is never a Session's, even when a project's policy lists it for Sessions", async () => {
    const { run, session } = scenario();
    updateProjectAuthorityPolicy(
      ctx.db,
      "project-one",
      { actors: { session: { coordinationVerbs: ["$defaults", "project.add"] } } },
      100,
    );
    const path = folder("Echo");

    const refused = await run("project.add", { id: path }, session);

    expect(refused).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
    if (!refused.ok) expect(refused.error.reason).toContain("is a Volli Session");
    expect(findProjectByPath(ctx.db, path)).toBeUndefined();
  });

  it("is never an unauthenticated caller's, even when a policy grants it", async () => {
    const { run } = scenario();
    updateProjectAuthorityPolicy(
      ctx.db,
      "project-one",
      { actors: { unauthenticated: { coordinationVerbs: ["project.add"] } } },
      100,
    );
    const path = folder("Foxtrot");

    const refused = await run("project.add", { id: path }, {});

    expect(refused).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
    if (!refused.ok) expect(refused.error.next).toContain("volli-hostd operator-token");
    expect(findProjectByPath(ctx.db, path)).toBeUndefined();
  });
});

describe("no Session can become a person", () => {
  it("judges a Session that also carries an operator token as the Session, never reading it", async () => {
    const { run, session, verifyOperatorToken } = scenario();

    const commented = await run(
      "ticket.comment",
      { id: "VC-1", message: "Mine" },
      { ...session, operatorToken: OPERATOR_TOKEN },
    );

    expect(commented).toMatchObject({ ok: true, data: { comment: { actor: "session" } } });
    expect(
      await run(
        "project.add",
        { id: folder("Golf") },
        { ...session, operatorToken: OPERATOR_TOKEN },
      ),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
    expect(verifyOperatorToken).not.toHaveBeenCalled();
  });

  it("does not rescue a forged Session token with a valid operator token", async () => {
    const { run, verifyOperatorToken } = scenario();

    for (const env of [
      { token: "forged", operatorToken: OPERATOR_TOKEN },
      { token: "", operatorToken: OPERATOR_TOKEN },
      { session: SESSION_ID, operatorToken: OPERATOR_TOKEN },
    ]) {
      const refused = await run("ticket.comment", { id: "VC-1", message: "Hm" }, env);
      expect(refused, JSON.stringify(env)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN_ACTOR" },
      });
      // Today's sentence, word for word: this request is judged as VC-163 did.
      if (!refused.ok) expect(refused.error.next).toContain("from inside a Volli Session");
    }
    expect(verifyOperatorToken).not.toHaveBeenCalled();
    expect(listComments(ctx.db, "ticket-one")).toEqual([]);
  });

  it("treats an operator token this host did not issue as nobody, and says which token", async () => {
    const { run, audit } = scenario();

    const refused = await run(
      "ticket.create",
      { title: "Nope" },
      { operatorToken: "volli_op_stale" },
    );

    expect(refused).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
    if (!refused.ok) expect(refused.error.reason).toContain("operator token");
    // Still a reader, like any other unauthenticated caller.
    expect(await run("board", {}, { operatorToken: "volli_op_stale" })).toMatchObject({ ok: true });
    // An unverified token names nobody, so there is no one to audit.
    expect(audit).toEqual([]);
  });

  it("accepts no operator token at all on a host that verifies none (desktop)", async () => {
    const { run, operator } = scenario({ verifier: false });

    expect(await run("ticket.create", { title: "Nope" }, operator)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR" },
    });
    expect(await run("project.add", { id: folder("Hotel") }, operator)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR" },
    });
  });

  it("leaves a token-less caller exactly where VC-163 put it", async () => {
    const { run, verifyOperatorToken } = scenario();

    const refused = await run("ticket.comment", { id: "VC-1", message: "Nope" }, {});

    expect(refused).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
    if (!refused.ok) {
      expect(refused.error.reason).toContain("not an authenticated Volli Session");
      expect(refused.error.next).toContain("from inside a Volli Session");
    }
    expect(verifyOperatorToken).not.toHaveBeenCalled();
  });
});
