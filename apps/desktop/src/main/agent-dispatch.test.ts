/**
 * What the dispatch table holds, now that it is a table (VC-167).
 *
 * This replaced `agent-dispatch-parity.test.ts`, which read `agent-commands.ts`
 * as SOURCE TEXT and matched branch shapes out of it. That scan existed
 * because the chain narrowed `request.cmd` rather than exhausting it, so
 * deleting a branch still compiled and quietly turned a declared verb into a
 * runtime `UNSUPPORTED_COMMAND`. The table closes that with types: it is a
 * total mapping over every binding id the registry projects onto the socket, so
 * a missing handler does not build and an extra one does not either. Its own
 * comment names both directions.
 *
 * What types cannot hold is what is left here:
 *
 * 1. That each id resolves the handler that verb is NAMED for. Exhaustiveness
 *    proves every id has a handler, not that `ticket.move` got the move one.
 * 2. The `envSession` preload policy, which is behavior rather than shape —
 *    the hook hot path resolving nothing it does not need is a promise about
 *    work done, and the only way to check work is to watch for it.
 * 3. The fold's laziness (VC-403), which is no longer a declared policy at
 *    all: `AgentCommandContext.loadProjections`/`loadSessions` fold the roster
 *    only when a handler calls one, so "does this verb pay for the fold" is
 *    now a fact about what the handler does, not about a table entry.
 *
 * The laziness tests spy on the Session Engine rather than on a clock, because
 * what matters is exactly two things: the multi-project `listSessions` fold,
 * and the `getSession` identity lookup. A verb that reads neither must call
 * neither, one that skips only the identity must still fold when it reads the
 * roster, and a verb that reads the roster twice must still fold it once.
 *
 * Point 3 is held EXHAUSTIVELY rather than by sample, in the last describe:
 * retiring the declared policy also retired the one assertion that covered
 * every verb at once, so that assertion is rebuilt by driving the whole table
 * through the real dispatch. The named cases above it stay for the claims a
 * set-equality cannot make — that the hot path resolves no identity either,
 * and that two reads of the roster share one fold.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AGENT_COMMAND_BINDINGS, AGENT_COMMANDS, VERB_REGISTRY } from "@volli/shared";

import { createAgentCommandService } from "./agent-commands";
import { AGENT_VERB_TABLE } from "./agent-dispatch/table";
import { insertProject } from "./db/projects-repo";
import { insertSession } from "./session-control/test-support";
import { openTestDb, testProject, testSession } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { createDesktopSessionEngine } from "./session-control";
import { createSessionTokenRegistry } from "./session-tokens";

let ctx: TestDb;

afterEach(() => ctx?.cleanup());

const SESSION_ID = "abcdef12-3456-7890-abcd-ef1234567890";

/** A project with one Board Session, and a service watching both engine doors. */
function scenario() {
  ctx = openTestDb();
  insertProject(
    ctx.db,
    testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
  );
  insertSession(ctx.db, testSession("project-one", null, { id: SESSION_ID }));
  const sessionEngine = createDesktopSessionEngine(ctx.db);
  const listSessions = vi.spyOn(sessionEngine, "listSessions");
  const getSession = vi.spyOn(sessionEngine, "getSession");
  // Both verbs below are coordination tier, so both need an authenticated
  // caller (VC-163). The token registry is the real one: `verify` is a map
  // lookup that touches neither engine door, which is exactly why admission
  // can be decided on the hot path without disturbing the counts asserted
  // here.
  const tokens = createSessionTokenRegistry();
  const env = {
    session: SESSION_ID,
    token: tokens.mint({ sessionId: SESSION_ID, attachmentId: "attachment-1" }),
  };
  const service = createAgentCommandService({
    db: ctx.db,
    sessionEngine,
    appVersion: "1.2.3",
    verifySessionToken: tokens.verify,
  });
  return { service, listSessions, getSession, env };
}

describe("the dispatch table (VC-167)", () => {
  it("binds every verb the registry projects onto the socket", () => {
    // The compiler already refuses a table that is missing one of these. This
    // says the same thing about the RUNTIME value, so a registry entry added
    // without a handler cannot pass by way of a cast.
    expect(Object.keys(AGENT_VERB_TABLE).toSorted()).toEqual([...AGENT_COMMANDS].toSorted());
  });

  it("resolves each wire name through the binding its entry declares", () => {
    for (const command of AGENT_COMMANDS) {
      const binding = AGENT_COMMAND_BINDINGS[command];
      expect(AGENT_VERB_TABLE[binding]).toBeDefined();
      // The declaration drives the dispatch: the id is the entry's own, not a
      // second naming scheme this table invented.
      expect(binding).toBe(command);
    }
  });

  it("binds no verb whose handler lives in the CLI process", () => {
    // `app.launch` and `help` are on the CLI surface and never on the socket:
    // `packages/cli` answers both locally, so an entry here for either would
    // mean two implementations of one verb — the thing the registry exists to
    // make impossible. The mapped type is what refuses it; this names the two.
    const local = VERB_REGISTRY.filter((entry) => entry.handler.site === "cli").map(
      (entry) => entry.key,
    );
    expect(local).toEqual(["app.launch", "help"]);
    for (const key of local) {
      expect(Object.keys(AGENT_VERB_TABLE)).not.toContain(key);
    }
  });

  it("gives each verb its own handler, including the two session signals", () => {
    // One handler binding per verb, and `session.done` and `session.blocked`
    // are two verbs. Under the chain they shared a branch and read
    // `request.cmd` to tell which they were; now each is bound separately over
    // one private write, so neither can be reached by the other's name.
    expect(AGENT_VERB_TABLE["session.done"].handle).not.toBe(
      AGENT_VERB_TABLE["session.blocked"].handle,
    );
    const handlers = Object.values(AGENT_VERB_TABLE).map((binding) => binding.handle);
    expect(new Set(handlers).size).toBe(handlers.length);
  });

  it("names each handler for the verb it answers", () => {
    // Exhaustiveness cannot catch a table that binds `ticket.move` to the
    // archive handler. The handler names can: every one of them is its verb's
    // key in camelCase, suffixed `Verb`.
    for (const [id, binding] of Object.entries(AGENT_VERB_TABLE)) {
      const expected = `${id.replaceAll(/\.([a-z])/g, (_, initial: string) => initial.toUpperCase())}Verb`;
      expect(binding.handle.name).toBe(expected);
    }
  });
});

describe("the envSession preload policy each entry declares", () => {
  /** The three that resolve their own terminal record instead of an identity. */
  const NO_ENV_SESSION = ["session.link", "session.harness", "hook"];

  it("skips the VOLLI_SESSION lookup for exactly the three that resolve their own", () => {
    const skipped = Object.entries(AGENT_VERB_TABLE)
      .filter(([, binding]) => binding.envSession === "skip")
      .map(([id]) => id);
    expect(skipped.toSorted()).toEqual(NO_ENV_SESSION.toSorted());
  });
});

describe("what the hot path actually resolves", () => {
  it("folds no project's Sessions and resolves no identity for a hook", async () => {
    // The hottest involuntary path in the app: one process per event,
    // addressing one durable Session directly. It resolves that Session's
    // terminal record itself — one lookup, not two, and no fold at all.
    const { service, listSessions, getSession, env } = scenario();

    const response = await service.execute({
      v: 1,
      cmd: "hook",
      args: { harness: "claude-code", event: "turn.started" },
      ctx: { cwd: "/repo/volli", env },
    });

    expect(response).toMatchObject({ ok: true, data: { session: "abcdef12" } });
    expect(listSessions).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("folds nothing for a lifecycle signal, but still resolves who is signalling", async () => {
    // The other half of the two-axis policy: identity is the whole requirement
    // for a signal (VC-51), and a terminal snapshot would answer nothing it
    // asks — a structured Session has no terminal attachment to find in one.
    const { service, listSessions, getSession, env } = scenario();

    const response = await service.execute({
      v: 1,
      cmd: "session.done",
      args: { reason: "Tests pass" },
      ctx: { cwd: "/repo/volli", env },
    });

    expect(response).toMatchObject({ ok: true, data: { signal: "done", recorded: true } });
    expect(listSessions).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalled();
  });

  it("resolves nothing at all for a verb that reads neither", async () => {
    // `model.list` skips the fold and has no session env to resolve, so the
    // dispatch does no Session work whatsoever before calling it.
    const { service, listSessions, getSession } = scenario();

    const response = await service.execute({
      v: 1,
      cmd: "model.list",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(response).toMatchObject({ ok: false, error: { code: "APP_UNREACHABLE" } });
    expect(listSessions).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("still folds every project's Sessions for a verb that reads them", async () => {
    // The other direction, so the skips above cannot be mistaken for the
    // dispatch having stopped resolving anything: `session.list` is answered
    // out of the fold, and it still happens.
    const { service, listSessions } = scenario();

    const response = await service.execute({
      v: 1,
      cmd: "session.list",
      args: { project: "/repo/volli" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(response).toMatchObject({ ok: true });
    expect(listSessions).toHaveBeenCalled();
  });

  // VC-403: the fold is lazy now, not declared per verb. Which verbs pay for it
  // is asserted over the WHOLE table in the last describe; what this one adds
  // is the memo, which a set of verb names cannot express.
  it("folds the roster once even when a verb's handler reads it twice", async () => {
    // `session.peek` reads `loadSessions` for the terminal half and falls back
    // to `loadProjections` for the chat half on a miss — two reads sharing one
    // memo, so the underlying `listSessions` call must still happen once.
    const { service, listSessions } = scenario();

    const response = await service.execute({
      v: 1,
      cmd: "session.peek",
      args: { id: "not-a-real-session" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(response).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    expect(listSessions).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every verb, not a sample of them (VC-403).
 *
 * The fold used to be declared per verb in `table.ts`, and one table-driven
 * test held the whole declaration: any verb that started folding broke it.
 * Laziness replaced the declaration with behavior, and behavior has no list to
 * compare against — so this rebuilds the same guarantee at the only place it
 * still exists, by driving EVERY verb through the real dispatch and watching
 * the Session Engine.
 *
 * Without this, the ticket's own measured wins are unprotected: a
 * `loadProjections()` added to `ticketListVerb` would put 718-968ms back on
 * `volli ticket list` with a green suite.
 */
describe("which verbs pay for the roster fold (VC-403)", () => {
  /**
   * The args each verb is driven with, exhaustive over the table by TYPE: a
   * verb added to the registry does not compile here until someone says how to
   * exercise it, which is what stops a new verb from joining the folding set
   * unnoticed.
   */
  const ARGS: Readonly<Record<keyof typeof AGENT_VERB_TABLE, Readonly<Record<string, unknown>>>> = {
    identify: {},
    board: { project: "/repo/volli" },
    "ticket.list": { project: "/repo/volli", limit: 1 },
    "ticket.show": { id: "VC-1" },
    "ticket.events": { id: "VC-1" },
    "ticket.create": { project: "/repo/volli", title: "A ticket" },
    "ticket.update": { id: "VC-1", title: "Renamed" },
    "ticket.move": { id: "VC-1", to: "Doing" },
    "ticket.comment": { id: "VC-1", body: "A comment" },
    "ticket.signal": { signal: "approved" },
    "ticket.brief": { id: "VC-1" },
    "worktree.status": { ticket: "VC-1" },
    "worktree.diff": { ticket: "VC-1" },
    "worktree.sync": { ticket: "VC-1" },
    conflicts: { project: "/repo/volli" },
    "project.list": {},
    "label.list": { project: "/repo/volli" },
    "label.merge": { project: "/repo/volli", from: "bug", into: "defect" },
    "model.list": {},
    // Deliberately WITHOUT `--session`: that flag is the one selector `cost`
    // resolves against a projection, and it is covered on its own below.
    cost: { project: "/repo/volli" },
    "session.list": { project: "/repo/volli" },
    "session.peek": { id: "not-a-real-session" },
    "session.answer": { id: "not-a-real-session" },
    "session.done": { reason: "Tests pass" },
    "session.blocked": { reason: "Needs a decision" },
    "session.link": { harness: "claude-code", harnessSessionId: "h-1" },
    "session.harness": { harness: "claude-code" },
    notify: { message: "Done" },
    hook: { harness: "claude-code", event: "turn.started" },
    doctor: {},
    "prompt.baseline": {},
  };

  /**
   * The verbs whose ANSWER contains a Session, and which therefore have to read
   * the roster. Everything else must not, and the assertion below is an
   * equality so this list cannot quietly grow.
   *
   * - `session.list` IS the listing.
   * - `session.peek` resolves a handle against both halves of it (VC-79).
   * - `session.answer` resolves the same handle before reading one artifact.
   *
   * `cost` is absent on purpose: it reads the roster only for `--session`,
   * which the second test below drives separately.
   */
  const READS_THE_ROSTER = ["session.list", "session.peek", "session.answer"];

  it("folds the roster for exactly the verbs whose answer holds a Session", async () => {
    const folded: string[] = [];
    for (const command of AGENT_COMMANDS) {
      const { service, listSessions, env } = scenario();
      await service.execute({
        v: 1,
        cmd: command,
        args: { ...ARGS[AGENT_COMMAND_BINDINGS[command]] },
        // The authenticated caller, so a coordination-tier verb reaches its
        // handler rather than stopping at admission — admission itself touches
        // neither engine door, which is what makes this count the handler's own
        // work.
        ctx: { cwd: "/repo/volli", env },
      });
      if (listSessions.mock.calls.length > 0) folded.push(AGENT_COMMAND_BINDINGS[command]);
      ctx.cleanup();
    }

    expect(folded.toSorted()).toEqual(READS_THE_ROSTER.toSorted());
  });

  it("folds the roster for cost only when a --session handle has to be resolved", async () => {
    const withoutHandle = scenario();
    await withoutHandle.service.execute({
      v: 1,
      cmd: "cost",
      args: { project: "/repo/volli" },
      ctx: { cwd: "/repo/volli", env: withoutHandle.env },
    });
    expect(withoutHandle.listSessions).not.toHaveBeenCalled();
    ctx.cleanup();

    const withHandle = scenario();
    await withHandle.service.execute({
      v: 1,
      cmd: "cost",
      args: { session: "abcdef12" },
      ctx: { cwd: "/repo/volli", env: withHandle.env },
    });
    expect(withHandle.listSessions).toHaveBeenCalled();
  });
});
