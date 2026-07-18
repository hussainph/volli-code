import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_ERROR_CODES,
  applyTicketBodyMutation,
  parseColumnToken,
  resolveAgentContext,
} from "./agent-surface";

describe("resolveAgentContext", () => {
  it("uses an explicit project path before cwd inference", () => {
    const result = resolveAgentContext({
      explicit: { project: "/work/beta" },
      env: {},
      cwd: "/work/alpha/packages/app",
      projects: [
        { id: "project-alpha", name: "App", path: "/work/alpha", ticketPrefix: "AA" },
        { id: "project-beta", name: "App", path: "/work/beta", ticketPrefix: "BB" },
      ],
      tickets: [],
      sessions: [],
    });

    expect(result).toEqual({
      ok: true,
      context: {
        projectId: "project-beta",
        ticketDisplayId: null,
        sessionId: null,
        socketPath: null,
        source: "flag",
      },
    });
  });

  it("rejects an ambiguous project name with readable candidates", () => {
    const result = resolveAgentContext({
      explicit: { project: "App" },
      env: {},
      cwd: "/elsewhere",
      projects: [
        { id: "project-alpha", name: "App", path: "/work/alpha", ticketPrefix: "AA" },
        { id: "project-beta", name: "App", path: "/work/beta", ticketPrefix: "BB" },
      ],
      tickets: [],
      sessions: [],
    });

    expect(result).toEqual({
      ok: false,
      code: "AMBIGUOUS_PROJECT",
      message:
        'Project "App" is ambiguous: App (AA, /work/alpha); App (BB, /work/beta). Use its path.',
    });
  });

  it("uses Volli session environment before cwd inference", () => {
    const result = resolveAgentContext({
      explicit: {},
      env: {
        VOLLI_SESSION: "session-7",
        VOLLI_TICKET: "BB-4",
        VOLLI_SOCKET: "/profiles/volli.sock",
      },
      cwd: "/work/alpha",
      projects: [
        { id: "project-alpha", name: "Alpha", path: "/work/alpha", ticketPrefix: "AA" },
        { id: "project-beta", name: "Beta", path: "/work/beta", ticketPrefix: "BB" },
      ],
      tickets: [{ displayId: "BB-4", projectId: "project-beta" }],
      sessions: [
        {
          id: "session-7",
          projectId: "project-beta",
          ticketDisplayId: "BB-4",
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      context: {
        projectId: "project-beta",
        ticketDisplayId: "BB-4",
        sessionId: "session-7",
        socketPath: "/profiles/volli.sock",
        source: "env",
      },
    });
  });

  it("never guesses when a legacy duplicate prefix makes a display id ambiguous", () => {
    const result = resolveAgentContext({
      explicit: {},
      env: { VOLLI_TICKET: "VC-12" },
      cwd: "/elsewhere",
      projects: [
        { id: "project-one", name: "One", path: "/work/one", ticketPrefix: "VC" },
        { id: "project-two", name: "Two", path: "/work/two", ticketPrefix: "VC" },
      ],
      tickets: [
        { displayId: "VC-12", projectId: "project-one" },
        { displayId: "VC-12", projectId: "project-two" },
      ],
      sessions: [],
    });

    expect(result).toEqual({
      ok: false,
      code: "AMBIGUOUS_TICKET",
      message:
        "Ticket VC-12 is ambiguous: One (VC, /work/one); Two (VC, /work/two). Make project prefixes unique in Settings.",
    });
  });

  it("infers a project from a registered worktree ancestor", () => {
    const result = resolveAgentContext({
      explicit: {},
      env: {},
      cwd: "/profiles/worktrees/project-one/VC-12-fix/packages/shared",
      projects: [
        {
          id: "project-one",
          name: "One",
          path: "/work/one",
          ticketPrefix: "VC",
          worktreePaths: ["/profiles/worktrees/project-one/VC-12-fix"],
        },
      ],
      tickets: [],
      sessions: [],
    });

    expect(result).toEqual({
      ok: true,
      context: {
        projectId: "project-one",
        ticketDisplayId: null,
        sessionId: null,
        socketPath: null,
        source: "cwd",
      },
    });
  });

  it("reports unknown explicit, session, and ticket selectors", () => {
    const base = {
      explicit: {},
      env: {},
      cwd: "/elsewhere",
      projects: [{ id: "p1", name: "One", path: "/work/one", ticketPrefix: "ONE" }],
      tickets: [],
      sessions: [],
    };
    expect(resolveAgentContext({ ...base, explicit: { project: "missing" } })).toMatchObject({
      ok: false,
      code: "PROJECT_NOT_FOUND",
    });
    expect(resolveAgentContext({ ...base, env: { VOLLI_SESSION: "missing" } })).toMatchObject({
      ok: false,
      code: "SESSION_NOT_FOUND",
    });
    expect(resolveAgentContext({ ...base, env: { VOLLI_TICKET: "ONE-9" } })).toMatchObject({
      ok: false,
      code: "TICKET_NOT_FOUND",
    });
  });

  it("resolves unique prefix and ticket selectors with their source metadata", () => {
    const projects = [{ id: "p1", name: "One", path: "/work/one", ticketPrefix: "ONE" }];
    expect(
      resolveAgentContext({
        explicit: { project: "ONE", socket: "/explicit.sock" },
        env: {},
        cwd: "/elsewhere",
        projects,
        tickets: [],
        sessions: [],
      }),
    ).toMatchObject({
      ok: true,
      context: { projectId: "p1", socketPath: "/explicit.sock", source: "flag" },
    });
    expect(
      resolveAgentContext({
        explicit: {},
        env: { VOLLI_TICKET: "ONE-9" },
        cwd: "/elsewhere",
        projects,
        tickets: [{ displayId: "ONE-9", projectId: "p1" }],
        sessions: [],
      }),
    ).toMatchObject({
      ok: true,
      context: { projectId: "p1", ticketDisplayId: "ONE-9", source: "env" },
    });
    expect(
      resolveAgentContext({
        explicit: {},
        env: { VOLLI_SESSION: "session-1" },
        cwd: "/elsewhere",
        projects,
        tickets: [],
        sessions: [{ id: "session-1", projectId: "p1", ticketDisplayId: null }],
      }),
    ).toMatchObject({
      ok: true,
      context: { projectId: "p1", sessionId: "session-1", socketPath: null, source: "env" },
    });
  });

  it("reports ambiguous and absent cwd context without guessing", () => {
    const projects = [
      { id: "p1", name: "Root", path: "/work", ticketPrefix: "ROOT" },
      {
        id: "p2",
        name: "Nested",
        path: "/other",
        ticketPrefix: "NEST",
        worktreePaths: ["/work/nested"],
      },
    ];
    expect(
      resolveAgentContext({
        explicit: {},
        env: {},
        cwd: "/work/nested/src",
        projects,
        tickets: [],
        sessions: [],
      }),
    ).toMatchObject({ ok: false, code: "AMBIGUOUS_CONTEXT" });
    expect(
      resolveAgentContext({
        explicit: {},
        env: {},
        cwd: "/nowhere",
        projects,
        tickets: [],
        sessions: [],
      }),
    ).toMatchObject({ ok: false, code: "CONTEXT_REQUIRED" });
  });

  it("matches the exact root when a registered project path has a trailing slash", () => {
    expect(
      resolveAgentContext({
        explicit: {},
        env: {},
        cwd: "/work/one",
        projects: [{ id: "p1", name: "One", path: "/work/one/", ticketPrefix: "ONE" }],
        tickets: [],
        sessions: [],
      }),
    ).toMatchObject({ ok: true, context: { projectId: "p1", source: "cwd" } });
  });
});

describe("applyTicketBodyMutation", () => {
  it("replaces one exact body match", () => {
    expect(
      applyTicketBodyMutation("Before\nold sentence\nAfter", {
        mode: "edit",
        oldText: "old sentence",
        newText: "new sentence",
      }),
    ).toEqual({ ok: true, body: "Before\nnew sentence\nAfter" });
  });

  it.each<[string, string, string]>([
    ["missing", "Alpha", "Beta"],
    ["non-unique", "Alpha Alpha", "Alpha"],
  ])("rejects a %s exact-match edit", (_case, body, oldText) => {
    expect(
      applyTicketBodyMutation(body, { mode: "edit", oldText, newText: "replacement" }),
    ).toEqual({
      ok: false,
      code: "BODY_MATCH_FAILED",
      message: `Body edit expected exactly one match for ${JSON.stringify(oldText)}.`,
    });
  });

  it("replaces and appends bodies, including an initially empty body", () => {
    expect(applyTicketBodyMutation("old", { mode: "replace", body: "new" })).toEqual({
      ok: true,
      body: "new",
    });
    expect(applyTicketBodyMutation("", { mode: "append", text: "first" })).toEqual({
      ok: true,
      body: "first",
    });
    expect(applyTicketBodyMutation("first", { mode: "append", text: "second" })).toEqual({
      ok: true,
      body: "first\n\nsecond",
    });
    expect(
      applyTicketBodyMutation("body", { mode: "edit", oldText: "", newText: "x" }),
    ).toMatchObject({ ok: false, code: "BODY_MATCH_FAILED" });
  });
});

describe("parseColumnToken", () => {
  it("normalizes both public review spellings to the domain status", () => {
    expect(parseColumnToken("needs-review")).toEqual({ ok: true, status: "needs_review" });
    expect(parseColumnToken("review")).toEqual({ ok: true, status: "needs_review" });
  });

  it("accepts each direct column token and rejects unknown tokens", () => {
    for (const status of ["backlog", "todo", "doing", "done"] as const) {
      expect(parseColumnToken(status)).toEqual({ ok: true, status });
    }
    expect(parseColumnToken("icebox")).toEqual({
      ok: false,
      code: "INVALID_COLUMN",
      message: 'Unknown column "icebox"',
    });
  });
});

describe("agent error vocabulary", () => {
  it("publishes stable codes for usage, resolution, mutation, and infrastructure failures", () => {
    expect(AGENT_ERROR_CODES).toContain("TICKET_NOT_FOUND");
    expect(AGENT_ERROR_CODES).toContain("AMBIGUOUS_PROJECT");
    expect(AGENT_ERROR_CODES).toContain("BODY_MATCH_FAILED");
    expect(AGENT_ERROR_CODES).toContain("APP_UNREACHABLE");
    expect(AGENT_ERROR_CODES).toContain("DB_UNAVAILABLE");
  });
});
