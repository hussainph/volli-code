import { describe, expect, it } from "vite-plus/test";

import { exitCodeForError, renderCliError, renderCliSuccess } from "./render";

describe("renderCliSuccess", () => {
  it("renders ticket lists as stable, untruncated non-TTY columns", () => {
    expect(
      renderCliSuccess(
        "ticket.list",
        {
          tickets: [
            {
              id: "VC-12",
              status: "doing",
              title: "Fix login flow without truncating this title",
              labels: ["bug", "security"],
            },
          ],
        },
        { json: false },
      ),
    ).toBe("VC-12  Doing  Fix login flow without truncating this title  [bug, security]\n");
  });

  it("keeps brief JSON parallel to raw prompt output and formats stable errors", () => {
    const data = { prompt: "# Fix auth\n\nUse the volli skill." };
    expect(renderCliSuccess("ticket.brief", data, { json: false })).toBe(
      "# Fix auth\n\nUse the volli skill.\n",
    );
    expect(renderCliSuccess("ticket.brief", data, { json: true })).toBe(
      '{"prompt":"# Fix auth\\n\\nUse the volli skill."}\n',
    );
    expect(
      renderCliError({ code: "BODY_MATCH_FAILED", message: "The old text is not unique." }),
    ).toBe("error[BODY_MATCH_FAILED] The old text is not unique.\n");
    expect(exitCodeForError("APP_UNREACHABLE")).toBe(3);
    expect(exitCodeForError("INVALID_REQUEST")).toBe(2);
    expect(exitCodeForError("BODY_MATCH_FAILED")).toBe(1);
  });

  it("renders a board as a concise column snapshot instead of serialized JSON", () => {
    expect(
      renderCliSuccess(
        "board",
        {
          project: { name: "Volli Code", prefix: "VC", path: "/repo/volli" },
          columns: {
            backlog: [],
            todo: [],
            doing: [
              {
                id: "VC-1",
                title: "Ship CLI",
                priority: "high",
                labels: ["feature"],
              },
            ],
            needs_review: [],
            done: [],
          },
        },
        { json: false },
      ),
    ).toBe("Volli Code (VC)\n\nDoing\nVC-1  High  Ship CLI  [feature]\n");
  });

  it("puts the display id first for ticket mutations and uses stable lines for reads", () => {
    expect(
      renderCliSuccess(
        "ticket.create",
        { ticket: { id: "VC-12", status: "backlog", title: "Ship CLI", labels: [] } },
        { json: false },
      ),
    ).toBe("VC-12  Backlog  Ship CLI\n");
    expect(
      renderCliSuccess(
        "project.list",
        { projects: [{ name: "Volli Code", prefix: "VC", path: "/repo", tickets: 4 }] },
        { json: false },
      ),
    ).toBe("VC  Volli Code  /repo  4 tickets\n");
    expect(
      renderCliSuccess(
        "session.peek",
        { session: "abcdef12", status: "idle", output: "line one\nline two" },
        { json: false },
      ),
    ).toBe("abcdef12  idle\nline one\nline two\n");
  });

  it("renders the remaining published stable text contracts", () => {
    const options = { json: false };
    const ticket = {
      id: "VC-1",
      status: "doing",
      title: "Ship",
      labels: ["feature", 1],
      priority: "high",
      harness: "codex",
      baseBranch: "main",
      branch: "volli/VC-1-ship",
      body: "Details",
    };
    expect(
      renderCliSuccess(
        "ticket.show",
        { ticket, events: [{ kind: "created" }], comments: [{ body: "hello" }] },
        options,
      ),
    ).toContain("VC-1  Doing  Ship  [feature]\npriority  high\nharness  codex");
    expect(renderCliSuccess("ticket.update", { ticket }, options)).toContain("VC-1  Doing  Ship");
    expect(renderCliSuccess("ticket.move", { ticket }, options)).toContain("VC-1  Doing  Ship");
    expect(renderCliSuccess("ticket.archive", { ticket: { id: "VC-1" } }, options)).toBe(
      "VC-1  archived\n",
    );
    expect(renderCliSuccess("ticket.comment", { comment: { ticket: "VC-1" } }, options)).toBe(
      "VC-1  comment added\n",
    );
    expect(renderCliSuccess("label.list", { labels: [{ name: "bug", tickets: 2 }] }, options)).toBe(
      "bug  2 tickets\n",
    );
    expect(
      renderCliSuccess(
        "session.list",
        {
          sessions: [
            {
              id: "abcdef12",
              kind: "ticket",
              status: "running",
              ticket: null,
              title: "Work",
            },
          ],
        },
        options,
      ),
    ).toBe("abcdef12  ticket  running  Work\n");
    expect(renderCliSuccess("ticket.events", { events: [{ kind: "created" }] }, options)).toBe(
      '{"kind":"created"}\n',
    );
    expect(
      renderCliSuccess(
        "identify",
        { project: null, ticket: "VC-1", worktreePath: "/repo", socket: null },
        options,
      ),
    ).toBe("project  -\nticket  VC-1\nworktreePath  /repo\nsocket  -\n");
    expect(renderCliSuccess("session.done", { session: "abcdef12", signal: "done" }, options)).toBe(
      "abcdef12  done\n",
    );
    expect(
      renderCliSuccess("session.blocked", { session: "abcdef12", signal: "blocked" }, options),
    ).toBe("abcdef12  blocked\n");
    expect(renderCliSuccess("notify", { notified: true }, options)).toBe("notified\n");
    expect(renderCliSuccess("app.launch", { alreadyRunning: true }, options)).toBe(
      "Volli is already running\n",
    );
    expect(renderCliSuccess("app.launch", { alreadyRunning: false }, options)).toBe(
      "Volli launched\n",
    );
    expect(
      renderCliSuccess(
        "ticket.show",
        { ticket: { id: "VC-2", status: "custom", title: "Plain" } },
        options,
      ),
    ).toBe("VC-2  Custom  Plain\n");
    expect(
      renderCliSuccess(
        "ticket.list",
        { tickets: [{ id: "VC-2", status: "todo", title: "No labels", labels: [] }] },
        options,
      ),
    ).toBe("VC-2  Todo  No labels\n");
  });

  it("keeps empty results stable and safely falls back for malformed response shapes", () => {
    const options = { json: false };
    expect(renderCliSuccess("ticket.list", { tickets: [] }, options)).toBe("");
    expect(renderCliSuccess("project.list", { projects: [] }, options)).toBe("");
    expect(renderCliSuccess("label.list", { labels: [] }, options)).toBe("");
    expect(renderCliSuccess("session.list", { sessions: [] }, options)).toBe("");
    expect(renderCliSuccess("ticket.events", { events: [] }, options)).toBe("");
    expect(
      renderCliSuccess("board", { project: { name: "P", prefix: "P" }, columns: {} }, options),
    ).toBe("P (P)\n");
    expect(
      renderCliSuccess(
        "board",
        {
          project: { name: "P", prefix: "P" },
          columns: {
            ignored: "not-an-array",
            empty: [],
            custom: [null, { id: "P-1", priority: "", title: "T" }],
          },
        },
        options,
      ),
    ).toBe("P (P)\n\nCustom\nP-1    T\n");
    expect(renderCliSuccess("session.peek", { session: "s", status: "idle" }, options)).toBe(
      "s  idle\n",
    );
    expect(renderCliSuccess("ticket.brief", { prompt: "ready\n" }, options)).toBe("ready\n");

    for (const [command, data] of [
      ["board", null],
      ["board", { project: [], columns: {} }],
      ["board", { project: {}, columns: {} }],
      ["ticket.list", null],
      ["ticket.list", {}],
      ["ticket.create", null],
      ["ticket.create", {}],
      ["ticket.create", { ticket: {} }],
      ["ticket.create", { ticket: { id: 1, status: "doing", title: "x" } }],
      ["ticket.create", { ticket: { id: "x", status: 1, title: "x" } }],
      ["ticket.create", { ticket: { id: "x", status: "doing" } }],
      ["ticket.show", {}],
      ["ticket.show", { ticket: {} }],
      ["ticket.archive", { ticket: { id: 1 } }],
      ["ticket.comment", { comment: { ticket: 1 } }],
      ["project.list", {}],
      ["label.list", {}],
      ["session.list", {}],
      ["session.peek", { session: 1, status: "idle" }],
      ["session.peek", { session: "s", status: 1 }],
      ["ticket.events", {}],
      ["notify", { notified: false }],
      ["unknown", {}],
      ["unknown", null],
      ["ticket.brief", { prompt: 1 }],
    ] as const) {
      expect(renderCliSuccess(command, data, options)).toBe(`${JSON.stringify(data)}\n`);
    }
  });

  it("renders identify's healthy project object as a readable single line", () => {
    expect(
      renderCliSuccess(
        "identify",
        {
          project: { name: "Volli Code", prefix: "VC", path: "/repo/volli" },
          ticket: "VC-12",
          session: "abcdef12",
          worktreePath: "/repo/volli",
          socket: "/Users/dev/Library/Application Support/Volli Code/volli.sock",
          appVersion: "1.0.0",
        },
        { json: false },
      ),
    ).toBe(
      "project  Volli Code (VC)\n" +
        "ticket  VC-12\n" +
        "session  abcdef12\n" +
        "worktreePath  /repo/volli\n" +
        "socket  /Users/dev/Library/Application Support/Volli Code/volli.sock\n" +
        "appVersion  1.0.0\n",
    );
  });

  it("marks degraded identify output as distinguishable from a healthy read", () => {
    expect(
      renderCliSuccess(
        "identify",
        {
          project: null,
          ticket: null,
          session: null,
          worktreePath: "/repo/volli",
          socket: null,
          appVersion: null,
          degraded: true,
        },
        { json: false },
      ),
    ).toBe(
      "project  -\n" +
        "ticket  -\n" +
        "session  -\n" +
        "worktreePath  /repo/volli\n" +
        "socket  -\n" +
        "appVersion  -\n" +
        "degraded  true\n",
    );
  });

  it("covers every usage exit-code spelling", () => {
    expect(exitCodeForError("USAGE")).toBe(2);
    expect(exitCodeForError("UNSUPPORTED_COMMAND")).toBe(2);
  });
});
