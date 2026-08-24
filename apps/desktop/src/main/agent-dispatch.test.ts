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
 * 2. The preload policy, which is behavior rather than shape — the hook hot
 *    path resolving nothing it does not need is a promise about work done, and
 *    the only way to check work is to watch for it.
 *
 * The laziness tests spy on the Session Engine rather than on a clock, because
 * what the skips buy is exactly two things: the multi-project `listSessions`
 * fold, and the `getSession` identity lookup. A verb that skips both must call
 * neither, and one that skips only the fold must still call the lookup.
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

let ctx: TestDb;

afterEach(() => ctx?.cleanup());

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

describe("the preload policy each entry declares", () => {
  /**
   * The verbs that take no Session snapshot. Six, exactly as the chain's
   * ternary listed — this is the same policy, moved beside the handlers it
   * governs rather than restated.
   */
  const NO_PROJECTIONS = [
    "model.list",
    "session.done",
    "session.blocked",
    "session.link",
    "session.harness",
    "hook",
  ];

  /** The three that resolve their own terminal record instead of an identity. */
  const NO_ENV_SESSION = ["session.link", "session.harness", "hook"];

  it("skips the Session fold for exactly the verbs that never read one", () => {
    const skipped = Object.entries(AGENT_VERB_TABLE)
      .filter(([, binding]) => binding.projections === "skip")
      .map(([id]) => id);
    expect(skipped.toSorted()).toEqual(NO_PROJECTIONS.toSorted());
  });

  it("skips the VOLLI_SESSION lookup for exactly the three that resolve their own", () => {
    const skipped = Object.entries(AGENT_VERB_TABLE)
      .filter(([, binding]) => binding.envSession === "skip")
      .map(([id]) => id);
    expect(skipped.toSorted()).toEqual(NO_ENV_SESSION.toSorted());
  });

  it("never resolves an identity for a verb that skips it", () => {
    // The two axes are independent, and this is the direction that would be
    // easy to get wrong: a verb may skip the fold and still need the identity
    // (both signals do), but one that skips the identity must not have it
    // resolved behind its back.
    for (const id of NO_ENV_SESSION) {
      expect(AGENT_VERB_TABLE[id as keyof typeof AGENT_VERB_TABLE].projections).toBe("skip");
    }
  });
});

describe("what the hot path actually resolves", () => {
  const SESSION_ID = "abcdef12-3456-7890-abcd-ef1234567890";

  /** A project with one Project Session, and a service watching both engine doors. */
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
    const service = createAgentCommandService({ db: ctx.db, sessionEngine, appVersion: "1.2.3" });
    return { service, listSessions, getSession };
  }

  it("folds no project's Sessions and resolves no identity for a hook", async () => {
    // The hottest involuntary path in the app: one process per event,
    // addressing one durable Session directly. It resolves that Session's
    // terminal record itself — one lookup, not two, and no fold at all.
    const { service, listSessions, getSession } = scenario();

    const response = await service.execute({
      v: 1,
      cmd: "hook",
      args: { harness: "claude-code", event: "turn.started" },
      ctx: { cwd: "/repo/volli", env: { session: SESSION_ID } },
    });

    expect(response).toMatchObject({ ok: true, data: { session: "abcdef12" } });
    expect(listSessions).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("folds nothing for a lifecycle signal, but still resolves who is signalling", async () => {
    // The other half of the two-axis policy: identity is the whole requirement
    // for a signal (VC-51), and a terminal snapshot would answer nothing it
    // asks — a structured Session has no terminal attachment to find in one.
    const { service, listSessions, getSession } = scenario();

    const response = await service.execute({
      v: 1,
      cmd: "session.done",
      args: { reason: "Tests pass" },
      ctx: { cwd: "/repo/volli", env: { session: SESSION_ID } },
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
});
