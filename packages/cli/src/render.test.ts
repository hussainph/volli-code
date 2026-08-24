import { describe, expect, it } from "vite-plus/test";

import { buildMutationPlan, makeAgentError, verbEntry } from "@volli/shared";

import { exitCodeForError, renderCliError, renderCliSuccess } from "./render";

/** One identify answer that differs only in what the second adoption pass reported. */
const identifyWithInteractivePass = (interactiveProvenance: string): string =>
  renderCliSuccess(
    "identify",
    {
      project: null,
      ticket: null,
      session: null,
      worktreePath: "/repo/volli",
      socket: null,
      appVersion: null,
      env: {
        path: "/profile/bin:/usr/bin",
        provenance: "adopted",
        interactiveProvenance,
        tools: { git: null, gh: null, node: null, pnpm: null },
        dependencies: null,
      },
    },
    { json: false },
  );

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
    const refusal = makeAgentError("BODY_MATCH_FAILED", "The old text is not unique.");
    expect(renderCliError(refusal)).toBe(
      "error[BODY_MATCH_FAILED] The old text is not unique. Next: Read the fresh Ticket Body, choose text that appears exactly once, and retry the edit.\n",
    );
    expect(JSON.parse(renderCliError(refusal, { json: true }))).toEqual({
      error: {
        code: "BODY_MATCH_FAILED",
        message: "The old text is not unique.",
        reason: "The old text is not unique.",
        next: "Read the fresh Ticket Body, choose text that appears exactly once, and retry the edit.",
      },
    });
    expect(exitCodeForError("APP_UNREACHABLE")).toBe(3);
    expect(exitCodeForError("INVALID_REQUEST")).toBe(2);
    expect(exitCodeForError("BODY_MATCH_FAILED")).toBe(1);
  });

  it("renders the shared mutation plan as readable text or unchanged stable JSON", () => {
    const plan = buildMutationPlan(verbEntry("notify")!, {
      kind: "notification",
      id: null,
      label: "Native notification ‘Needs input’",
    });
    const text = renderCliSuccess("notify", plan, { json: false });
    expect(text).toContain("Side-effect preview");
    expect(text).toContain("Verb: notify");
    expect(text).toContain("Durable writes:\n  - none");
    expect(text).toContain("Human-visible effects:");
    expect(text).toContain("native macOS notification");
    expect(text).toContain("not an in-app Sonner toast");
    expect(JSON.parse(renderCliSuccess("notify", plan, { json: true }))).toEqual(plan);
  });

  it("fills guidance for a pre-VC-91 error envelope without inventing a reason", () => {
    // An older app sends only code and message: the renderer falls back to the
    // message and this CLI's own recovery table for that stable code.
    const legacy = renderCliError({ code: "TIMEOUT", message: "Timed out." } as never);
    expect(legacy).toContain("error[TIMEOUT] Timed out.");
    expect(legacy).toContain("Next: Inspect the current Ticket or Session state");
    // An explicit but empty `next` means the producer decided none is safe.
    const decided = renderCliError({
      code: "TIMEOUT",
      message: "Timed out.",
      next: undefined,
    } as never);
    expect(decided).toContain("none is safe from this evidence");
  });

  it("lists each planned durable write and an explicit none for empty human effects", () => {
    const plan = buildMutationPlan(
      verbEntry("ticket.comment")!,
      { kind: "ticket", id: "VC-1", label: "VC-1" },
      { humanVisibleEffects: [] },
    );
    const text = renderCliSuccess("ticket.comment", plan, { json: false });
    expect(text).toContain(
      "Durable writes:\n  - Create one attributed Ticket comment and its Ticket activity event.",
    );
    expect(text).toContain("Human-visible effects:\n  - none");
  });

  it("neutralizes terminal control and bidi sequences in every text-mode output path", () => {
    const hostile = "safe\u001b]52;c;YXR0YWNr\u0007\rspoof\u202Etxt\u2066isolate";
    const rendered = renderCliSuccess(
      "ticket.show",
      {
        ticket: {
          id: "VC-1",
          status: "doing",
          title: hostile,
          labels: [],
          body: hostile,
        },
      },
      { json: false },
    );
    const error = renderCliError(makeAgentError("MUTATION_FAILED", hostile));

    for (const control of ["\u001b", "\u0007", "\r", "\u202e", "\u2066"]) {
      expect(rendered).not.toContain(control);
    }
    expect(rendered).toContain("\\x1b]52;c;YXR0YWNr\\x07\\x0dspoof\\u202etxt\\u2066isolate");
    for (const control of ["\u001b", "\u0007", "\r", "\u202e", "\u2066"]) {
      expect(error).not.toContain(control);
    }
    // JSON mode keeps exact parsed data semantics without emitting raw
    // terminal controls (JSON permits a Unicode escape for the bidi mark).
    const json = renderCliSuccess("ticket.brief", { prompt: hostile }, { json: true });
    for (const control of ["\u001b", "\u0007", "\r", "\u202e", "\u2066"]) {
      expect(json).not.toContain(control);
    }
    expect(JSON.parse(json)).toEqual({ prompt: hostile });
  });

  it("keeps untrusted inline fields from injecting forged output lines", () => {
    const title = "safe\nerror[MUTATION_FAILED] forged";
    const rendered = renderCliSuccess(
      "ticket.list",
      { tickets: [{ id: "VC-1", status: "doing", title, labels: [] }] },
      { json: false },
    );
    const error = renderCliError(makeAgentError("MUTATION_FAILED", title));

    expect(rendered).toContain("safe\\x0aerror[MUTATION_FAILED] forged");
    expect(rendered).not.toContain(title);
    expect(error).toContain("safe\\x0aerror[MUTATION_FAILED] forged");
    expect(error).not.toContain(title);
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
    expect(
      renderCliSuccess(
        "session.list",
        { sessions: [{ id: "fedcba98", kind: "chat", ticket: "VC-52", title: "Validate VC-52" }] },
        options,
      ),
    ).toBe("fedcba98  chat  VC-52  Validate VC-52\n");
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
    // The short id leads: it is the one thing the acceptance requires printed,
    // and the handle every follow-up (session peek/list) addresses by.
    expect(
      renderCliSuccess(
        "session.start",
        {
          session: "abcdef12",
          ticket: "VC-4",
          state: "ready",
          model: "openai-codex/gpt-5.2-sol",
          reasoning: "high",
        },
        options,
      ),
    ).toBe("abcdef12  VC-4  ready  openai-codex/gpt-5.2-sol high\n");
    // A failed attach still prints the id — the Session is durable and the app
    // carries its Retry — with the state naming what happened.
    expect(
      renderCliSuccess(
        "session.start",
        {
          session: "abcdef12",
          ticket: "VC-4",
          state: "needs-recovery",
          model: "anthropic/claude",
          reasoning: "medium",
        },
        options,
      ),
    ).toBe("abcdef12  VC-4  needs-recovery  anthropic/claude medium\n");
    expect(
      renderCliSuccess("session.blocked", { session: "abcdef12", signal: "blocked" }, options),
    ).toBe("abcdef12  blocked\n");
    expect(
      renderCliSuccess(
        "session.link",
        { session: "abcdef12", harnessSessionId: "4f1c9a2e-8b7d-4e5a-9c3f-2a1b0d6e5f4c" },
        options,
      ),
    ).toBe("abcdef12  linked 4f1c9a2e-8b7d-4e5a-9c3f-2a1b0d6e5f4c\n");
    // Consumed by `$(…)` in a generated wrapper and prepended to a harness's
    // argv: one bare id when one was minted, and not a byte otherwise.
    expect(
      renderCliSuccess(
        "session.harness",
        {
          session: "abcdef12",
          harness: "cursor",
          changed: true,
          harnessSessionId: "4f1c9a2e-8b7d-4e5a-9c3f-2a1b0d6e5f4c",
        },
        options,
      ),
    ).toBe("4f1c9a2e-8b7d-4e5a-9c3f-2a1b0d6e5f4c\n");
    expect(
      renderCliSuccess(
        "session.harness",
        { session: "abcdef12", harness: "codex", changed: false, harnessSessionId: null },
        options,
      ),
    ).toBe("");
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

  it("renders model.list with the default first, copyable model rows, and an honest rollup", () => {
    const options = { json: false };
    expect(
      renderCliSuccess(
        "model.list",
        {
          observedAt: 1_000,
          default: { model: "anthropic/claude-opus-5", reasoning: "medium" },
          providers: [
            {
              id: "anthropic",
              label: "Anthropic",
              state: "available",
              models: [
                {
                  model: "anthropic/claude-opus-5",
                  label: "Claude Opus 5",
                  state: "available",
                  reasoning: ["low", "medium", "high"],
                },
              ],
              omittedModels: 2,
            },
            {
              id: "openai-codex",
              label: "OpenAI Codex",
              state: "authentication-required",
              omittedModels: 0,
              models: [
                {
                  model: "openai-codex/gpt-5.6-terra",
                  label: "Terra",
                  state: "authentication-required",
                  reasoning: [],
                },
              ],
            },
          ],
          omittedProviders: 37,
        },
        options,
      ),
    ).toBe(
      "default  anthropic/claude-opus-5  medium\n" +
        "anthropic  Anthropic  available\n" +
        "  anthropic/claude-opus-5  low|medium|high\n" +
        "  … and 2 more models not available (use --all)\n" +
        "openai-codex  OpenAI Codex  authentication-required\n" +
        "  openai-codex/gpt-5.6-terra  -  authentication-required\n" +
        "… and 37 more providers not available (use --all)\n",
    );
    // No configured default and nothing signed in: the answer is still legible.
    expect(
      renderCliSuccess(
        "model.list",
        { observedAt: 1_000, default: null, providers: [], omittedProviders: 0 },
        options,
      ),
    ).toBe("default  -\n");
  });

  it("keeps malformed model.list provider rows legible instead of crashing", () => {
    const options = { json: false };
    // Providers survive `recordsAt`, but a row's `models`, a model's
    // `reasoning`, or the `omittedModels` counter may still be the wrong shape
    // — each defensive arm answers with the row it can render, never a throw.
    expect(
      renderCliSuccess(
        "model.list",
        {
          observedAt: 1_000,
          default: null,
          providers: [
            { id: "p1", label: "P1", state: "available", models: "not-an-array" },
            {
              id: "p2",
              label: "P2",
              state: "available",
              models: [
                {
                  model: "p2/model-a",
                  label: "A",
                  state: "available",
                  reasoning: "not-an-array",
                },
                {
                  model: "p2/model-b",
                  label: "B",
                  state: "available",
                  reasoning: ["low", 7],
                },
                null,
              ],
              omittedModels: "not-a-number",
            },
          ],
          omittedProviders: 0,
        },
        options,
      ),
    ).toBe(
      "default  -\n" +
        "p1  P1  available\n" +
        "p2  P2  available\n" +
        "  p2/model-a  -\n" +
        "  p2/model-b  low\n",
    );
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
      ["model.list", {}],
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

  // VC-94's acceptance: an agent discovers its environment from this block,
  // not from the first command that fails. A missing tool renders as `-` —
  // measured and not found — rather than the line disappearing.
  it("renders identify's env block with the tool census, found or missing", () => {
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
          env: {
            path: "/profile/bin:/opt/homebrew/bin:/usr/bin",
            provenance: "adopted",
            interactiveProvenance: "adopted",
            tools: {
              git: "/usr/bin/git",
              gh: "/opt/homebrew/bin/gh",
              node: null,
              npm: null,
              pnpm: null,
              yarn: null,
              bun: null,
            },
            requiredTools: ["git", "node", "pnpm"],
            dependencies: "absent",
          },
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
        "env.path  /profile/bin:/opt/homebrew/bin:/usr/bin\n" +
        "env.provenance  adopted\n" +
        "env.interactiveProvenance  adopted\n" +
        "env.tools.git  /usr/bin/git\n" +
        "env.tools.gh  /opt/homebrew/bin/gh\n" +
        "env.tools.node  -\n" +
        "env.tools.npm  -\n" +
        "env.tools.pnpm  -\n" +
        "env.tools.yarn  -\n" +
        "env.tools.bun  -\n" +
        "env.requiredTools  git node pnpm\n" +
        "env.dependencies  absent\n",
    );
  });

  // The env renderer must survive an env block whose tools are not the
  // expected record: a malformed reply degrades to dashes per tool, never to
  // a crash that costs the agent the whole identity output.
  it("renders the tool census as dashes when the tools record is missing", () => {
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
          env: {
            path: "/usr/bin",
            provenance: "probe-failed",
            interactiveProvenance: "pending",
            tools: "unreadable",
            dependencies: null,
          },
        },
        { json: false },
      ),
    ).toContain("env.tools.git  -\nenv.tools.gh  -");
  });

  // The second adoption pass (VC-94's A3): a session that asked before it
  // landed and one that asked after have genuinely different PATHs, so the
  // block must not describe them with the same words.
  it("renders the interactive pass beside the boot one, pending included", () => {
    expect(identifyWithInteractivePass("pending")).toContain(
      "env.provenance  adopted\nenv.interactiveProvenance  pending\n",
    );
    expect(identifyWithInteractivePass("adopted")).toContain(
      "env.provenance  adopted\nenv.interactiveProvenance  adopted\n",
    );
  });

  it("renders a degraded identify's null provenance as a dash, not a claim", () => {
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
          env: {
            path: "/usr/bin",
            provenance: null,
            interactiveProvenance: null,
            tools: {
              git: null,
              gh: null,
              node: null,
              npm: null,
              pnpm: null,
              yarn: null,
              bun: null,
            },
            requiredTools: [],
            dependencies: null,
          },
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
        "env.path  /usr/bin\n" +
        "env.provenance  -\n" +
        "env.interactiveProvenance  -\n" +
        "env.tools.git  -\n" +
        "env.tools.gh  -\n" +
        "env.tools.node  -\n" +
        "env.tools.npm  -\n" +
        "env.tools.pnpm  -\n" +
        "env.tools.yarn  -\n" +
        "env.tools.bun  -\n" +
        // Nothing on disk implied a tool, so nothing here can be missing.
        "env.requiredTools  -\n" +
        "env.dependencies  -\n" +
        "degraded  true\n",
    );
  });

  // `-` is a measurement: asked, and nothing implied. A block from an
  // answering process that never established requirements at all has not
  // measured anything, and must not borrow the word for one that did.
  it("omits requiredTools entirely when the block never reported them", () => {
    const rendered = renderCliSuccess(
      "identify",
      {
        project: null,
        ticket: null,
        session: null,
        worktreePath: "/repo/volli",
        socket: null,
        appVersion: null,
        env: {
          path: "/usr/bin",
          provenance: "adopted",
          interactiveProvenance: "adopted",
          tools: { git: "/usr/bin/git" },
          dependencies: null,
        },
      },
      { json: false },
    );

    expect(rendered).toContain("env.tools.git  /usr/bin/git");
    expect(rendered).not.toContain("env.requiredTools");
    expect(rendered).toContain("env.dependencies  -");
  });

  it("prints the worktree-misalignment warning right after the path it contradicts", () => {
    expect(
      renderCliSuccess(
        "identify",
        {
          project: { name: "Volli Code", prefix: "VC", path: "/repo/volli" },
          ticket: "VC-12",
          session: "abcdef12",
          worktreePath: "/repo/volli",
          warning:
            "You are working in /repo/volli, which is outside VC-12's worktree at /wt/VC-12.",
          socket: null,
          appVersion: "1.0.0",
        },
        { json: false },
      ),
    ).toBe(
      "project  Volli Code (VC)\n" +
        "ticket  VC-12\n" +
        "session  abcdef12\n" +
        "worktreePath  /repo/volli\n" +
        "warning  You are working in /repo/volli, which is outside VC-12's worktree at /wt/VC-12.\n" +
        "socket  -\n" +
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

  it("renders a chat peek as an activity line over a one-line-per-message tail", () => {
    expect(
      renderCliSuccess(
        "session.peek",
        {
          session: "abcdef12",
          status: "working",
          waitingOn: null,
          lastActivityAgeMs: 12_000,
          turns: 7,
          turnDepth: 3,
          messages: 41,
          unreadable: 0,
          transcript: [
            { ageMs: 5_400_000, role: "user", text: "Ship the CLI", tools: [] },
            { ageMs: 240_000, role: "assistant", text: "", tools: ["bash", "read_file"] },
            { ageMs: 12_000, role: "assistant", text: "Tests pass.", tools: ["edit_file"] },
          ],
        },
        { json: false },
      ),
    ).toBe(
      "abcdef12  working  last 12s  turn 7 depth 3\n" +
        "1h  user  Ship the CLI\n" +
        "4m  assistant  [bash read_file]\n" +
        "12s  assistant  [edit_file] Tests pass.\n",
    );
  });

  it("names what a chat peek is waiting on, and what it could not read", () => {
    expect(
      renderCliSuccess(
        "session.peek",
        {
          session: "abcdef12",
          status: "waiting",
          waitingOn: "permission",
          lastActivityAgeMs: -1,
          turns: null,
          turnDepth: undefined,
          unreadable: 2,
          transcript: [
            "not a record",
            { ageMs: "unknown", role: "assistant", text: 12, tools: ["bash", 7] },
            // A message that said nothing and called nothing keeps its row:
            // the caller learns a turn happened, not that it was empty.
            { ageMs: 0, role: "user" },
          ],
        },
        { json: false },
      ),
    ).toBe(
      "abcdef12  waiting on permission  last -  turn - depth -  2 unreadable\n" +
        "-  assistant  [bash]\n" +
        "0s  user\n",
    );
  });

  it("renders an empty chat tail as the activity line alone", () => {
    expect(
      renderCliSuccess(
        "session.peek",
        {
          session: "abcdef12",
          status: "idle",
          waitingOn: null,
          lastActivityAgeMs: 0,
          turns: 0,
          turnDepth: 0,
          unreadable: 0,
          transcript: [],
        },
        { json: false },
      ),
    ).toBe("abcdef12  idle  last 0s  turn 0 depth 0\n");
  });

  it("covers every usage exit-code spelling", () => {
    expect(exitCodeForError("USAGE")).toBe(2);
    expect(exitCodeForError("UNSUPPORTED_COMMAND")).toBe(2);
  });

  it("renders worktree status as a compact branch/base/sync snapshot", () => {
    expect(
      renderCliSuccess(
        "worktree.status",
        {
          ticket: "VC-12",
          project: "Volli Code",
          worktreePath: "/repo/.volli/worktrees/VC-12",
          branch: "volli/VC-12-slug",
          baseBranch: "main",
          uncommitted: true,
          sequencerActive: false,
          aheadOfBase: 3,
          behindBase: 0,
          unpushed: 2,
        },
        { json: false },
      ),
    ).toBe(
      "VC-12  volli/VC-12-slug → main\n" +
        "worktree  /repo/.volli/worktrees/VC-12\n" +
        "uncommitted  yes\n" +
        "ahead 3  behind 0  unpushed 2\n",
    );
  });

  it("shows a sequencer line only when active and nulls unknown counts as dashes", () => {
    expect(
      renderCliSuccess(
        "worktree.status",
        {
          ticket: "VC-9",
          project: "Volli Code",
          worktreePath: "/wt",
          branch: null,
          baseBranch: null,
          uncommitted: false,
          sequencerActive: true,
          aheadOfBase: null,
          behindBase: null,
          unpushed: null,
        },
        { json: false },
      ),
    ).toBe(
      "VC-9  (detached) → (unknown base)\n" +
        "worktree  /wt\n" +
        "uncommitted  no\n" +
        "sequencer  active\n" +
        "ahead -  behind -  unpushed -\n",
    );
  });

  it("renders a worktree diff as a --stat summary with per-file kinds", () => {
    expect(
      renderCliSuccess(
        "worktree.diff",
        {
          ticket: "VC-12",
          mode: "merge-base",
          baseBranch: "main",
          files: [
            { path: "src/a.ts", insertions: 3, deletions: 1, untracked: false },
            { path: "assets/logo.png", insertions: null, deletions: null, untracked: false },
            { path: "src/new.ts", insertions: null, deletions: null, untracked: true },
          ],
          insertions: 3,
          deletions: 1,
          totalFiles: 3,
          omittedFiles: 0,
        },
        { json: false },
      ),
    ).toBe(
      "VC-12  merge-base vs main  3 files  +3 -1\n" +
        "  src/a.ts  +3 -1\n" +
        "  assets/logo.png  bin\n" +
        "  src/new.ts  (untracked)\n",
    );
  });

  it("caps diff rows with an '… and N more files' rollup and stays compact", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `src/module/file-${i}.ts`,
      insertions: 5,
      deletions: 2,
      untracked: false,
    }));
    const rendered = renderCliSuccess(
      "worktree.diff",
      {
        ticket: "VC-12",
        mode: "working-tree",
        baseBranch: "main",
        files,
        insertions: 500,
        deletions: 200,
        totalFiles: 480,
        omittedFiles: 460,
      },
      { json: false },
    );
    // Working-tree header omits the "vs base" clause.
    expect(rendered).toContain("VC-12  working-tree  480 files  +500 -200\n");
    expect(rendered).toContain("  … and 460 more files\n");
    // 20 file rows + header + rollup, and the whole thing stays well bounded.
    expect(rendered.split("\n").filter((l) => l.startsWith("  src/")).length).toBe(20);
    expect(rendered.length).toBeLessThanOrEqual(1200);
  });

  it("renders a worktree diff with a missing files array as the header alone", () => {
    // A malformed/minimal payload (files absent) must degrade to just the
    // header — no file rows, no throw.
    const rendered = renderCliSuccess(
      "worktree.diff",
      {
        ticket: "VC-12",
        mode: "working-tree",
        insertions: 0,
        deletions: 0,
        totalFiles: 0,
        omittedFiles: 0,
      },
      { json: false },
    );
    expect(rendered).toContain("VC-12  working-tree  0 files  +0 -0");
    expect(rendered.split("\n").filter((l) => l.startsWith("  "))).toEqual([]);
  });
});

describe("renderCliSuccess — prompt.baseline", () => {
  const data = {
    project: { name: "Volli Code", prefix: "VC" },
    role: "project",
    workspace: "/repo/volli",
    charsPerToken: 4,
    sections: [
      {
        id: "operating",
        chars: 420,
        tokens: 105,
        cacheClass: "project-static",
        placement: "prefix",
      },
      {
        id: "resource:skills index",
        chars: 40000,
        tokens: 10000,
        cacheClass: "project-static",
        placement: "prefix",
      },
      { id: "brief", chars: 300, tokens: 75, cacheClass: "session-static", placement: "message" },
      {
        id: "reminder:workspace-environment",
        chars: 240,
        tokens: 60,
        cacheClass: "session-static",
        placement: "message",
      },
    ],
    system: { chars: 44000, tokens: 11000 },
    brief: { chars: 300, tokens: 75 },
    reminder: { chars: 240, tokens: 60 },
    total: { chars: 44540, tokens: 11135 },
    excluded: "tool definitions, the user's first message, and provider overhead",
  };

  it("renders the rollup, one row per section, and the named exclusions", () => {
    const text = renderCliSuccess("prompt.baseline", data, { json: false });
    expect(text).toContain("prompt baseline  project  ~11135 tokens  44540 chars");
    expect(text).toContain("(est. at 4 chars/token)");
    expect(text).toContain("  operating  ~105 tokens  420 chars");
    expect(text).toContain("  resource:skills index  ~10000 tokens  40000 chars");
    expect(text).toContain("  brief  ~75 tokens  300 chars");
    expect(text).toContain(
      "excluded  tool definitions, the user's first message, and provider overhead",
    );
  });

  it("carries the cache class as a column, marking only the message side", () => {
    const text = renderCliSuccess("prompt.baseline", data, { json: false });
    // Prefix-side rows stay unmarked: that is the common case, and a cell that
    // says nothing new does not earn its width.
    expect(text).toContain("  operating  ~105 tokens  420 chars  project-static");
    expect(text).toContain("  resource:skills index  ~10000 tokens  40000 chars  project-static");
    // Message-side rows say so beside the class, because "session-static" prices
    // differently on the two sides of the Cache Prefix.
    expect(text).toContain("  brief  ~75 tokens  300 chars  session-static, message-side");
    expect(text).toContain(
      "  reminder:workspace-environment  ~60 tokens  240 chars  session-static, message-side",
    );
  });

  it("drops the class column for a section that names none, rather than printing undefined", () => {
    const text = renderCliSuccess(
      "prompt.baseline",
      { ...data, sections: [{ id: "operating", chars: 420, tokens: 105 }] },
      { json: false },
    );
    expect(text).toContain("  operating  ~105 tokens  420 chars");
    expect(text).not.toContain("undefined");
  });

  it("passes the structured breakdown straight through with --json", () => {
    expect(JSON.parse(renderCliSuccess("prompt.baseline", data, { json: true }))).toEqual(data);
  });

  it("falls back to the generic renderer when the reply is not a breakdown", () => {
    expect(() =>
      renderCliSuccess("prompt.baseline", { unexpected: true }, { json: false }),
    ).not.toThrow();
    expect(() => renderCliSuccess("prompt.baseline", null, { json: false })).not.toThrow();
  });

  it("omits the excluded line when the server names no exclusions", () => {
    const { excluded: _excluded, ...withoutExcluded } = data;
    const text = renderCliSuccess("prompt.baseline", withoutExcluded, { json: false });
    expect(text).toContain("prompt baseline  project");
    expect(text).not.toContain("excluded");
  });
});

describe("renderCliSuccess — doctor", () => {
  const data = {
    checks: [
      {
        id: "path-position",
        title: "Volli's bin is first on PATH",
        status: "fail",
        detail: "position 20 of 30",
        remedy: "Run `volli doctor --fix`.",
      },
      { id: "session", title: "Session context", status: "ok", detail: "s-1" },
    ],
    summary: "1 failed of 2 checks.",
  };

  it("renders the report a human reads, worst finding included", () => {
    const text = renderCliSuccess("doctor", data, { json: false });
    expect(text).toContain("✗ Volli's bin is first on PATH");
    expect(text).toContain("position 20 of 30");
    expect(text).toContain("→ Run `volli doctor --fix`.");
    expect(text.trimEnd().endsWith("1 failed of 2 checks.")).toBe(true);
  });

  it("renders the path repair before this Session's stale checks", () => {
    const text = renderCliSuccess(
      "doctor",
      {
        ...data,
        pathRepair: {
          path: "/volli/bin:/opt/homebrew/bin:/usr/bin",
          provenance: "adopted",
          added: ["/opt/homebrew/bin"],
          interactiveProvenance: "already-complete",
          interactiveAdded: [],
        },
      },
      { json: false },
    );

    expect(text).toContain("Session PATH repair");
    expect(text).toContain("env.added  /opt/homebrew/bin");
    expect(text).toContain("env.interactiveProvenance  already-complete");
    expect(text).toContain("This running Session keeps the environment it started with.");
    expect(text.indexOf("Session PATH repair")).toBeLessThan(
      text.indexOf("✗ Volli's bin is first on PATH"),
    );
  });

  it("drops a malformed repair block rather than rendering a half-invented one", () => {
    const text = renderCliSuccess(
      "doctor",
      // `added` is missing: main never sends this, so nothing may render it.
      {
        ...data,
        pathRepair: {
          path: "/volli/bin:/usr/bin",
          provenance: "adopted",
          interactiveProvenance: "already-complete",
          interactiveAdded: [],
        },
      },
      { json: false },
    );

    expect(text).not.toContain("Session PATH repair");
    expect(text).toContain("✗ Volli's bin is first on PATH");
  });

  it("passes the structured report straight through with --json", () => {
    expect(JSON.parse(renderCliSuccess("doctor", data, { json: true }))).toEqual(data);
  });

  it("falls back to the generic renderer when the reply is not a report", () => {
    expect(() => renderCliSuccess("doctor", { unexpected: true }, { json: false })).not.toThrow();
    expect(() => renderCliSuccess("doctor", null, { json: false })).not.toThrow();
    expect(() => renderCliSuccess("doctor", { checks: [] }, { json: false })).not.toThrow();
  });
});
