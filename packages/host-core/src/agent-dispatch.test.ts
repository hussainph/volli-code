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

import {
  AGENT_COMMAND_BINDINGS,
  AGENT_COMMANDS,
  AGENT_HANDLER_KEYS,
  SERVED_AGENT_HANDLER_KEYS,
  SESSION_READ_VERBS,
  SOCKET_BOARD_PROJECTIONS,
  DEFAULT_AUTHORITY_POLICY,
  HOST_HANDLER_KEYS,
  OperationUnavailableError,
  VERB_REGISTRY,
} from "@volli/shared";
import type { AgentRequest, HandlerCall } from "@volli/shared";

import { createAgentCommandService } from "./agent-commands";
import { socketHandlerPolicy } from "./agent-dispatch/admission";
import {
  ADMITTED,
  HandlerNotServedError,
  type AdmissionObserver,
  type HandlerPolicy,
  type HostHandlerMap,
  invokeHandler,
  refused,
} from "./handlers/handler-map";
import { agentVerbEntries, sessionReadEntries } from "./agent-dispatch/verbs";
import { sealTestHandlers, testHostHandlers } from "./testing/host-handlers";
import {
  doorCallActor,
  projectedHandlerKey,
  projectHandler,
  servedVerb,
} from "./agent-dispatch/projection";
import type { AgentCommandContext } from "./agent-dispatch/context";
import { AGENT_VERB_TABLE } from "./agent-dispatch/table";
import { getTicket, insertTicket } from "./db/tickets-repo";
import { insertProject } from "./db/projects-repo";
import { insertSession } from "./session-control/test-support";
import { openTestDb, testProject, testSession, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { createTestSessionEngine } from "./testing/session-engine";
import { createSessionTokenRegistry } from "./session-tokens";

let ctx: TestDb;

afterEach(() => ctx?.cleanup());

const SESSION_ID = "abcdef12-3456-7890-abcd-ef1234567890";

/** A project with one Board Session, and a service watching both engine doors. */
function scenario(onAdmission?: AdmissionObserver) {
  ctx = openTestDb();
  insertProject(
    ctx.db,
    testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
  );
  insertSession(ctx.db, testSession("project-one", null, { id: SESSION_ID }));
  const sessionEngine = createTestSessionEngine(ctx.db);
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
    handlers: testHostHandlers({
      db: ctx.db,
      ...(onAdmission === undefined ? {} : { onAdmission }),
    }),
    db: ctx.db,
    sessionEngine,
    appVersion: "1.2.3",
    verifySessionToken: tokens.verify,
  });
  return { service, listSessions, getSession, env, verify: tokens.verify };
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
    // Exhaustiveness cannot catch a table that binds `ticket.create` to the
    // archive handler. The handler names can: every one of them is its verb's
    // key in camelCase, suffixed `Verb`. A catalog command's binding has no
    // handler of its own to name; it is checked as a projection below.
    for (const [id, binding] of Object.entries(AGENT_VERB_TABLE)) {
      if (projectedHandlerKey(binding) !== undefined) continue;
      const expected = `${id.replaceAll(/\.([a-z])/g, (_, initial: string) => initial.toUpperCase())}Verb`;
      expect(binding.handle.name).toBe(expected);
    }
  });
});

describe("every socket verb is a projection of the host's map (VC-668, VC-923)", () => {
  // Every key the map holds that the socket binds, its Session reads included
  // (VC-894: no verb is delegated the other way any more).
  const SOCKET_HANDLER_KEYS = HOST_HANDLER_KEYS.filter((key) => key in AGENT_VERB_TABLE);

  // The ticket writes whose command is a board handler under the board's key (VC-794).
  const BOARD_PROJECTIONS: Readonly<Record<string, string>> = {
    "ticket.create": "board.createTicket",
    "ticket.update": "board.updateTicket",
    "ticket.comment": "board.createComment",
  };

  it("binds the both-door commands, the board's ticket writes and its own verbs as projections", () => {
    expect(SOCKET_HANDLER_KEYS.toSorted()).toEqual(
      [
        "ticket.move",
        ...SESSION_READ_VERBS,
        ...AGENT_HANDLER_KEYS.filter((key) => key in AGENT_VERB_TABLE),
      ].toSorted(),
    );
    expect(SOCKET_BOARD_PROJECTIONS).toEqual(BOARD_PROJECTIONS);
    for (const [id, binding] of Object.entries(AGENT_VERB_TABLE)) {
      expect(projectedHandlerKey(binding), id).toBe(
        (SOCKET_HANDLER_KEYS as readonly string[]).includes(id) ? id : BOARD_PROJECTIONS[id],
      );
    }
    // No verb keeps a handler of its own: the Session reads too are projections.
    const own = Object.entries(AGENT_VERB_TABLE)
      .filter(([, binding]) => projectedHandlerKey(binding) === undefined)
      .map(([id]) => id);
    expect(own).toEqual([]);
  });

  it("serves one entry for every socket-served agent key, and no other", () => {
    // The socket's own verbs' handlers, as the map's entries: exactly the
    // socket's served agent keys, in the registry's order. The start is the
    // map's own command, shared with the tool door.
    expect(Object.keys(agentVerbEntries({} as never))).toEqual(
      SERVED_AGENT_HANDLER_KEYS.filter((key) => key in AGENT_VERB_TABLE),
    );
    expect(projectedHandlerKey(AGENT_VERB_TABLE["session.start"])).toBe("session.start");
    // The Session reads' entries are the service's too (VC-894), served beside them.
    expect(Object.keys(sessionReadEntries({} as never))).toEqual([...SESSION_READ_VERBS]);
  });

  it("serves the socket's own verbs into the map once, and refuses a second service", () => {
    ctx = openTestDb();
    const handlers = testHostHandlers({ db: ctx.db });
    const build = () =>
      createAgentCommandService({
        handlers,
        db: ctx.db,
        sessionEngine: createTestSessionEngine(ctx.db),
        appVersion: "1.2.3",
      });
    build();
    expect(build).toThrow("The handler map already serves identify.");
  });

  it("answers an agent key nothing served as unavailable, after the policy admits it", async () => {
    ctx = openTestDb();
    const records: string[] = [];
    const handlers = testHostHandlers({
      db: ctx.db,
      onAdmission: ({ door, key, admitted }) => records.push(`${door} ${key} ${admitted}`),
    });
    const policy = { door: "test", admit: () => ADMITTED };
    const input = {
      request: { v: 1, cmd: "identify", args: {}, ctx: { cwd: "/", env: {} } },
      projects: [],
      envSession: null,
      envSessionTerminal: null,
      authenticatedSessionId: null,
      actor: null,
    } as const;
    await expect(
      Promise.resolve().then(() =>
        invokeHandler(handlers, policy, "identify", input, { actor: { kind: "unauthenticated" } }),
      ),
    ).rejects.toBeInstanceOf(HandlerNotServedError);
    expect(records).toEqual(["test identify true"]);
  });

  it("admits a board ticket write at the map under the board's key, and no other key", async () => {
    const { env, verify } = scenario();
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-one", ticketNumber: 1, status: "todo" }),
    );
    const log: string[] = [];
    const note = (name: string) => () => {
      log.push(`handler ${name}`);
      throw new Error("stop");
    };
    const service = createAgentCommandService({
      handlers: sealTestHandlers(
        {
          "board.createTicket": note("board.createTicket"),
          "board.updateTicket": note("board.updateTicket"),
          "board.createComment": note("board.createComment"),
        },
        ({ door, key, admitted }) =>
          log.push(`${door} ${admitted ? "admitted" : "refused"} ${key}`),
      ),
      db: ctx.db,
      sessionEngine: createTestSessionEngine(ctx.db),
      appVersion: "1.2.3",
      verifySessionToken: verify,
    });
    const run = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env } });
    await run("ticket.create", { title: "New" });
    await run("ticket.update", { id: "VC-1", title: "Renamed" });
    await run("ticket.comment", { id: "VC-1", message: "Hello" });
    expect(log).toEqual([
      "agent-socket admitted board.createTicket",
      "handler board.createTicket",
      "agent-socket admitted board.updateTicket",
      "handler board.updateTicket",
      "agent-socket admitted board.createComment",
      "handler board.createComment",
    ]);
    const policy = socketHandlerPolicy(
      { v: 1, cmd: "ticket.update", args: {}, ctx: { cwd: "/", env: {} } },
      "board.updateTicket",
      () => null,
    );
    expect(policy.admit("board.setPriority", {}, { actor: { kind: "user" } })).toEqual({
      admitted: false,
      message: "ticket.update does not reach board.setPriority.",
      hint: null,
    });
    expect(policy.admit("board.updateTicket", {}, { actor: { kind: "user" } })).toEqual({
      admitted: true,
    });
  });

  it("reaches handlers[key] with the decoded input and the attributed actor, admitted first", async () => {
    const { env, verify } = scenario();
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-one", ticketNumber: 1, status: "todo" }),
    );
    const log: string[] = [];
    const move = vi.fn(async () => {
      log.push("handler ticket.move");
      return [{ ...getTicket(ctx.db, "ticket-one")!, status: "done" as const }];
    });
    const projected = createAgentCommandService({
      handlers: sealTestHandlers({ "ticket.move": move }, ({ door, key, admitted }) =>
        log.push(`${door} ${admitted ? "admitted" : "refused"} ${key}`),
      ),
      db: ctx.db,
      sessionEngine: createTestSessionEngine(ctx.db),
      appVersion: "1.2.3",
      verifySessionToken: verify,
    });
    const response = await projected.execute({
      v: 1,
      cmd: "ticket.move",
      args: { id: "VC-1", to: "done" },
      ctx: { cwd: "/repo/volli", env },
    });
    expect(response).toMatchObject({ ok: true, data: { ticket: { id: "VC-1", status: "done" } } });
    // The socket's coordination policy, judged at the map, before the handler.
    expect(log).toEqual(["agent-socket admitted ticket.move", "handler ticket.move"]);
    expect(move).toHaveBeenCalledExactlyOnceWith(
      { projectId: "project-one", ticketId: "ticket-one", toStatus: "done" },
      { actor: { kind: "session", sessionId: SESSION_ID, ticketId: null } },
    );
  });

  it("judges the coordination policy again at the map, and a refusal there never reaches the handler", async () => {
    const { env, verify } = scenario();
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-one", ticketNumber: 1, status: "todo" }),
    );
    // The project narrows its Sessions between the dispatch's admission line
    // and the handler: the map's own judgement is what still stops the move.
    const narrowed = {
      ...DEFAULT_AUTHORITY_POLICY,
      actors: {
        ...DEFAULT_AUTHORITY_POLICY.actors,
        session: { ...DEFAULT_AUTHORITY_POLICY.actors.session, coordinationVerbs: [] },
      },
    };
    let reads = 0;
    const log: string[] = [];
    const move = vi.fn(() => []);
    const response = await createAgentCommandService({
      handlers: sealTestHandlers({ "ticket.move": move }, ({ door, key, admitted }) =>
        log.push(`${door} ${admitted ? "admitted" : "refused"} ${key}`),
      ),
      db: ctx.db,
      sessionEngine: createTestSessionEngine(ctx.db),
      appVersion: "1.2.3",
      verifySessionToken: verify,
      readAuthorityPolicy: () => (reads++ === 0 ? DEFAULT_AUTHORITY_POLICY : narrowed),
    }).execute({
      v: 1,
      cmd: "ticket.move",
      args: { id: "VC-1", to: "done" },
      ctx: { cwd: "/repo/volli", env },
    });
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN_ACTOR",
        message: expect.stringContaining(
          "ticket.move is not among the coordination-tier verbs this project allows a session caller to run.",
        ),
      },
    });
    expect(log).toEqual(["agent-socket refused ticket.move"]);
    expect(move).not.toHaveBeenCalled();
    expect(getTicket(ctx.db, "ticket-one")?.status).toBe("todo");
  });

  it("answers a refusal at the map with the socket's own refusal, hint or not", async () => {
    const move = vi.fn(() => []);
    const binding = projectHandler("ticket.move", {
      envSession: "resolve",
      decode: () => ({
        input: { projectId: "p", ticketId: "t", toStatus: "done" },
        call: { actor: { kind: "user" } },
        reply: () => ({ v: 1, ok: true, data: null }),
      }),
    });
    const request = { v: 1, cmd: "ticket.move", args: {}, ctx: { cwd: "/", env: {} } } as const;
    for (const hint of [null, "Ask a person to change the project's policy."]) {
      const response = await binding.handle(
        {
          options: { handlers: sealTestHandlers({ "ticket.move": move }) },
          handlerPolicy: { door: "agent-socket", admit: () => refused("Not here.", hint) },
        } as never,
        request,
      );
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN_ACTOR",
          message: "Not here.",
          next: hint ?? expect.any(String),
        },
      });
    }
    expect(move).not.toHaveBeenCalled();
  });

  it("admits at the map only the key the request's own verb projects", () => {
    const policy = socketHandlerPolicy(
      { v: 1, cmd: "ticket.show", args: {}, ctx: { cwd: "/", env: {} } },
      undefined,
      () => null,
    );
    expect(policy.door).toBe("agent-socket");
    expect(policy.admit("ticket.move", {}, { actor: { kind: "user" } })).toEqual({
      admitted: false,
      message: "ticket.show does not reach ticket.move.",
      hint: null,
    });
  });

  it("answers a handler's unavailable as retryable, and any other throw as a failed write", async () => {
    const { env, verify } = scenario();
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-one", ticketNumber: 1, status: "todo" }),
    );
    const answer = async (thrown: unknown) =>
      createAgentCommandService({
        handlers: sealTestHandlers({
          "ticket.move": () => {
            throw thrown;
          },
        }),
        db: ctx.db,
        sessionEngine: createTestSessionEngine(ctx.db),
        appVersion: "1.2.3",
        verifySessionToken: verify,
      }).execute({
        v: 1,
        cmd: "ticket.move",
        args: { id: "VC-1", to: "done" },
        ctx: { cwd: "/repo/volli", env },
      });
    await expect(answer(new OperationUnavailableError("No board here"))).resolves.toMatchObject({
      ok: false,
      error: { code: "APP_UNREACHABLE", message: expect.stringContaining("No board here") },
    });
    await expect(answer(new Error("Unknown ticket"))).resolves.toMatchObject({
      ok: false,
      error: { code: "MUTATION_FAILED", message: expect.stringContaining("Unknown ticket") },
    });
  });

  it("refuses to build without the map, for a JavaScript caller too", () => {
    ctx = openTestDb();
    expect(() =>
      createAgentCommandService({
        db: ctx.db,
        sessionEngine: createTestSessionEngine(ctx.db),
        appVersion: "1.2.3",
      } as never),
    ).toThrow("The host's handler map is required.");
  });
});

describe("how often the coordination policy is read (VC-923)", () => {
  function counted() {
    const ctxScenario = scenario();
    let reads = 0;
    const service = createAgentCommandService({
      handlers: testHostHandlers({ db: ctx.db }),
      db: ctx.db,
      sessionEngine: createTestSessionEngine(ctx.db),
      appVersion: "1.2.3",
      verifySessionToken: ctxScenario.verify,
      readAuthorityPolicy: () => {
        reads += 1;
        return DEFAULT_AUTHORITY_POLICY;
      },
    });
    return { service, env: ctxScenario.env, reads: () => reads };
  }

  it("reads it once for one of the socket's own verbs, the hot path included", async () => {
    const { service, env, reads } = counted();
    const response = await service.execute({
      v: 1,
      cmd: "hook",
      args: { harness: "claude-code", event: "turn.started" },
      ctx: { cwd: "/repo/volli", env },
    });
    expect(response.ok).toBe(true);
    expect(reads()).toBe(1);
  });

  it("reads it again at the map for a key another door also reaches", async () => {
    const { service, env, reads } = counted();
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-one", ticketNumber: 1, status: "todo" }),
    );
    await service.execute({
      v: 1,
      cmd: "ticket.move",
      args: { id: "VC-1", to: "done" },
      ctx: { cwd: "/repo/volli", env },
    });
    expect(reads()).toBe(2);
  });
});

describe("a socket verb the map serves (VC-923)", () => {
  const REQUEST: AgentRequest = { v: 1, cmd: "identify", args: {}, ctx: { cwd: "/", env: {} } };
  const UNAUTHENTICATED = { kind: "unauthenticated" } as const;

  /** The door's context for one request, as the dispatch builds it. */
  function doorContext(handlers: HostHandlerMap, admit: HandlerPolicy["admit"] = () => ADMITTED) {
    return {
      options: { handlers },
      handlerPolicy: { door: "agent-socket", admit },
      projects: [testProject({ id: "project-one" })],
      envSession: null,
      envSessionTerminal: null,
      authenticatedSessionId: "s-1",
      actor: null,
      doorActor: UNAUTHENTICATED,
    } as unknown as AgentCommandContext;
  }

  it("hands its entry the request as the door resolved it, and answers the entry's answer", async () => {
    const seen: unknown[] = [];
    const answer = { v: 1, ok: true, data: { echoed: true } } as const;
    const handlers = sealTestHandlers({
      identify: (input: never, call: HandlerCall) => {
        seen.push(input, call);
        return answer;
      },
    });
    const presented: AgentRequest = {
      ...REQUEST,
      ctx: { cwd: "/", env: { session: "s-1", token: "secret", operatorToken: "op" } },
    };
    const response = await servedVerb("identify", "resolve").handle(
      doorContext(handlers),
      presented,
    );
    expect(response).toBe(answer);
    // The claim goes on; the door's credentials stay behind.
    expect(seen).toEqual([
      {
        request: { ...REQUEST, ctx: { cwd: "/", env: { session: "s-1" } } },
        projects: [expect.objectContaining({ id: "project-one" })],
        envSession: null,
        envSessionTerminal: null,
        authenticatedSessionId: "s-1",
        actor: null,
      },
      { actor: UNAUTHENTICATED },
    ]);
  });

  it("answers a refusal at the map as the socket's own refusal", async () => {
    const handlers = sealTestHandlers({ identify: () => ({ v: 1, ok: true, data: {} }) });
    const response = await servedVerb("identify", "resolve").handle(
      doorContext(handlers, () => refused("Not you.", "Ask a person.")),
      REQUEST,
    );
    expect(response).toEqual({
      v: 1,
      ok: false,
      error: expect.objectContaining({
        code: "FORBIDDEN_ACTOR",
        message: "Not you.",
        next: "Ask a person.",
      }),
    });
    const bare = await servedVerb("identify", "resolve").handle(
      doorContext(handlers, () => refused("Not you.")),
      REQUEST,
    );
    expect(bare).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR", message: "Not you." },
    });
  });

  it("answers an entry nothing served as retryable", async () => {
    const response = await servedVerb("identify", "resolve").handle(
      doorContext(sealTestHandlers({})),
      REQUEST,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "APP_UNREACHABLE", message: "identify is not served on this host." },
    });
  });

  it("passes a verb's own throw on to the socket's door, as the table's direct call did", async () => {
    const handlers = sealTestHandlers({
      identify: () => {
        throw new Error("The verb broke.");
      },
    });
    await expect(
      servedVerb("identify", "resolve").handle(doorContext(handlers), REQUEST),
    ).rejects.toThrow("The verb broke.");
  });

  it("calls the map as whoever the door authenticated", () => {
    const own = { id: "s-1", projectId: "p", ticketId: "t-1", role: "ticket" } as const;
    expect(doorCallActor({ kind: "operator", login: "me" }, null)).toEqual({ kind: "user" });
    expect(doorCallActor({ kind: "unauthenticated" }, own)).toEqual(UNAUTHENTICATED);
    expect(doorCallActor({ kind: "session", sessionId: "s-1" }, own)).toEqual({
      kind: "session",
      sessionId: "s-1",
      ticketId: "t-1",
    });
    // Another Session's identity is never cited for this one.
    expect(doorCallActor({ kind: "session", sessionId: "s-2" }, own)).toEqual({
      kind: "session",
      sessionId: "s-2",
      ticketId: null,
    });
    expect(doorCallActor({ kind: "session", sessionId: "s-2" }, null)).toEqual({
      kind: "session",
      sessionId: "s-2",
      ticketId: null,
    });
  });
});

describe("the envSession preload policy each entry declares", () => {
  /** The three that resolve their own terminal record instead of an identity. */
  const NO_ENV_SESSION = ["session.start", "session.link", "session.harness", "hook"];

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
    // A Session is refused at admission (VC-623), which is exactly the point:
    // the person's verb never reaches a handler that could fold anything.
    "project.add": { id: "/repo/volli" },
    "label.list": { project: "/repo/volli" },
    "label.merge": { project: "/repo/volli", from: "bug", into: "defect" },
    "model.list": {},
    // Deliberately WITHOUT `--session`: that flag is the one selector `cost`
    // resolves against a projection, and it is covered on its own below.
    cost: { project: "/repo/volli" },
    "session.start": { id: "VC-1" },
    "session.list": { project: "/repo/volli" },
    "session.peek": { id: "not-a-real-session" },
    "session.show": { id: "not-a-real-session" },
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
  const READS_THE_ROSTER = ["session.list", "session.peek", "session.show", "session.answer"];

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

  // Verb parity at the map (VC-923): every verb the socket answers reaches
  // the map's entry for its own key (a board write: the board's), once,
  // admitted by the socket's policy, and no other entry, the four Session
  // reads included (VC-894), and a verb its dispatch refused touches none.
  it("reaches exactly its own map entry, under the socket's policy, for every verb", async () => {
    const reached: Record<string, string[]> = {};
    for (const command of AGENT_COMMANDS) {
      const records: string[] = [];
      const { service, env } = scenario(({ door, key, admitted }) =>
        records.push(`${door} ${key} ${admitted}`),
      );
      // A ticket for the ticket writes to resolve before they reach the map.
      insertTicket(
        ctx.db,
        testTicket("project-one", { id: "ticket-one", ticketNumber: 1, status: "todo" }),
      );
      const response = await service.execute({
        v: 1,
        cmd: command,
        args:
          command === "ticket.move"
            ? { id: "VC-1", to: "done" }
            : { ...ARGS[AGENT_COMMAND_BINDINGS[command]] },
        ctx: { cwd: "/repo/volli", env },
      });
      // Admitted is not ran: an entry nothing served would answer this.
      if (!response.ok) {
        expect(response.error.message, command).not.toMatch(
          /is not served|Session reads are unavailable/,
        );
      }
      reached[command] = records;
      ctx.cleanup();
    }
    const expected: Record<string, string[]> = {};
    for (const command of AGENT_COMMANDS) {
      const key = projectedHandlerKey(AGENT_VERB_TABLE[AGENT_COMMAND_BINDINGS[command]]);
      expected[command] =
        key === undefined ||
        // Refused at the door: the person's verbs, which a Session may not
        // run (`session.start` answers only a hostd operator token).
        command === "project.add" ||
        command === "session.start" ||
        // Refused before the map by its own decode: the comment's text is
        // `--message`, and these args name none.
        command === "ticket.comment"
          ? []
          : [`agent-socket ${key} true`];
    }
    expect(reached).toEqual(expected);
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
