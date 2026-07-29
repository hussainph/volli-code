import { describe, it, expect } from "vite-plus/test";
import { FIRST_CLASS_HARNESS_IDS, parseHarnessId, type HarnessId } from "./ticket";
import type { HarnessAdapter } from "./harness/types";
import { getHarnessAdapter } from "./harness/core";
import {
  buildHarnessCommand,
  buildResumeCommand,
  renderResumeArgv,
  buildHarnessResumeCommand,
  canResumeHarness,
  composeAttachmentsSection,
  composeTicketPrompt,
  shellSingleQuote,
  worktreeOrientationPreamble,
  type HarnessAdapterLookup,
} from "./harness-command";

/**
 * The closed built-in registry, spelled the way a caller must now name it. Every
 * case below that passes it is asserting built-in behaviour specifically — the
 * registered cases pass a lookup that knows a manifest instead.
 */
const builtIns: HarnessAdapterLookup = getHarnessAdapter;

/**
 * A manifest-registered adapter: a real, fully-described harness that
 * {@link getHarnessAdapter} answers `undefined` for and always will. Everything
 * a launch reads off an adapter is defaulted to "declares nothing", so each case
 * below adds only the field it is about.
 */
function registered(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: parseHarnessId("my-harness") as HarnessId,
    label: "My Harness",
    command: "my-harness",
    promptFlag: null,
    surfaces: { skillsDir: null, commandsDir: null, instructionsFile: null },
    injection: { kind: "none" },
    sessionId: { kind: "none" },
    resume: { byId: null, latest: null, userResumeTokens: [] },
    events: [],
    startupEvent: null,
    launchSettings: [],
    sessionMarkers: [],
    ...overrides,
  };
}

/** The lookup main supplies once a manifest is registered AND trusted. */
function lookupOf(adapter: HarnessAdapter): HarnessAdapterLookup {
  return (id) => (id === adapter.id ? adapter : getHarnessAdapter(id));
}

describe("shellSingleQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellSingleQuote("hello")).toBe("'hello'");
  });

  it("leaves double quotes, backticks, and $ inert inside single quotes", () => {
    expect(shellSingleQuote('a "b" c')).toBe("'a \"b\" c'");
    expect(shellSingleQuote("run `whoami`")).toBe("'run `whoami`'");
    expect(shellSingleQuote("cost is $FOO")).toBe("'cost is $FOO'");
    expect(shellSingleQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });

  it("escapes an embedded single quote with the '\\'' idiom", () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
    expect(shellSingleQuote("''")).toBe("''\\'''\\'''");
  });

  it("preserves literal newlines inside the quotes", () => {
    expect(shellSingleQuote("line1\nline2")).toBe("'line1\nline2'");
  });

  it("normalizes \\r\\n and lone \\r to \\n", () => {
    expect(shellSingleQuote("a\r\nb")).toBe("'a\nb'");
    expect(shellSingleQuote("a\rb")).toBe("'a\nb'");
    expect(shellSingleQuote("a\r\nb\rc\n d")).toBe("'a\nb\nc\n d'");
  });

  it("strips NUL and EOT control bytes defensively", () => {
    // Escape sequences, never raw control bytes, keep this payload visible —
    // a raw NUL makes git treat the whole file as binary and its diffs
    // unreviewable.
    expect(shellSingleQuote("a\u0000b")).toBe("'ab'");
    expect(shellSingleQuote("a\u0004b")).toBe("'ab'");
    expect(shellSingleQuote("\u0000\u0004x")).toBe("'x'");
  });

  it("round-trips the tricky bytes together", () => {
    // Quotes + backticks + $ + \r\n + a NUL all in one payload.
    expect(shellSingleQuote("it's `$X`\r\ndone\u0000")).toBe("'it'\\''s `$X`\ndone'");
  });
});

describe("composeTicketPrompt", () => {
  it("uses just the header line when the body is empty", () => {
    expect(composeTicketPrompt({ displayId: "VC-12", title: "Add MCP server", body: "" })).toBe(
      "VC-12: Add MCP server",
    );
  });

  it("uses just the header line when the body is whitespace-only", () => {
    expect(
      composeTicketPrompt({ displayId: "VC-12", title: "Add MCP server", body: "  \n\t " }),
    ).toBe("VC-12: Add MCP server");
  });

  it("appends the body after a blank line when present", () => {
    expect(
      composeTicketPrompt({
        displayId: "VC-12",
        title: "Add MCP server",
        body: "Implement the socket handshake.",
      }),
    ).toBe("VC-12: Add MCP server\n\nImplement the socket handshake.");
  });

  it("keeps markdown body content verbatim (trimmed)", () => {
    const body = "## Steps\n\n- one\n- two\n";
    expect(composeTicketPrompt({ displayId: "VC-3", title: "Do it", body })).toBe(
      "VC-3: Do it\n\n## Steps\n\n- one\n- two",
    );
  });
});

describe("buildHarnessCommand", () => {
  it("launches Claude Code with a positional quoted prompt", () => {
    expect(buildHarnessCommand("claude-code", "hi there", null, builtIns)).toBe(
      "claude 'hi there'",
    );
  });

  it("launches Codex with a positional quoted prompt (interactive TUI, not exec)", () => {
    expect(buildHarnessCommand("codex", "hi there", null, builtIns)).toBe("codex 'hi there'");
  });

  it("launches Opencode with --prompt (default TUI, not run)", () => {
    expect(buildHarnessCommand("opencode", "hi there", null, builtIns)).toBe(
      "opencode --prompt 'hi there'",
    );
  });

  it("launches Cursor's CLI, which is cursor-agent rather than cursor", () => {
    expect(buildHarnessCommand("cursor", "hi there", null, builtIns)).toBe(
      "cursor-agent 'hi there'",
    );
  });

  it("launches an unregistered harness by its own slug with a positional prompt", () => {
    const custom = parseHarnessId("my-harness") as HarnessId;
    expect(buildHarnessCommand(custom, "hi there", null, builtIns)).toBe("my-harness 'hi there'");
  });

  it("quotes the prompt so shell metacharacters stay inert", () => {
    expect(buildHarnessCommand("claude-code", "it's `$X`", null, builtIns)).toBe(
      "claude 'it'\\''s `$X`'",
    );
  });

  it("has a template for every first-class harness", () => {
    for (const id of FIRST_CLASS_HARNESS_IDS) {
      expect(buildHarnessCommand(id, "x", null, builtIns)).toContain("'x'");
    }
  });

  // The blocker this parameter exists for: a bare command is resolved by the
  // session's login shell, which on macOS has already rebuilt PATH out from
  // under Volli's bin dir (path_helper, then every user prepend). A launch that
  // names the wrapper by absolute path cannot lose that race.
  it("names the generated wrapper by absolute path rather than the bare command", () => {
    expect(buildHarnessCommand("claude-code", "hi", "/ud/bin/claude", builtIns)).toBe(
      "'/ud/bin/claude' 'hi'",
    );
  });

  it("keeps the prompt flag between the wrapper and the prompt", () => {
    expect(buildHarnessCommand("opencode", "hi", "/ud/bin/opencode", builtIns)).toBe(
      "'/ud/bin/opencode' --prompt 'hi'",
    );
  });

  it("quotes the wrapper path, which on macOS contains spaces under Application Support", () => {
    expect(
      buildHarnessCommand(
        "claude-code",
        "hi",
        "/Users/x/Library/Application Support/Volli/claude",
        builtIns,
      ),
    ).toBe("'/Users/x/Library/Application Support/Volli/claude' 'hi'");
  });

  it("falls back to the bare command when no wrapper was generated", () => {
    expect(buildHarnessCommand("claude-code", "hi", null, builtIns)).toBe("claude 'hi'");
  });

  it("wraps an unregistered harness too, since a manifest earns a wrapper the same way", () => {
    const custom = parseHarnessId("my-harness") as HarnessId;
    expect(buildHarnessCommand(custom, "hi", "/ud/bin/my-harness", builtIns)).toBe(
      "'/ud/bin/my-harness' 'hi'",
    );
  });
});

describe("buildHarnessResumeCommand", () => {
  it("resumes Claude Code by session id with --resume", () => {
    expect(buildHarnessResumeCommand("claude-code", "abc123", null, builtIns)).toBe(
      "claude --resume 'abc123'",
    );
  });

  it("falls back to Claude Code's --continue when no session id is known", () => {
    expect(buildHarnessResumeCommand("claude-code", null, null, builtIns)).toBe(
      "claude --continue",
    );
  });

  it("resumes Codex by session id with resume", () => {
    expect(buildHarnessResumeCommand("codex", "abc123", null, builtIns)).toBe(
      "codex resume 'abc123'",
    );
  });

  it("falls back to Codex's resume --last when no session id is known", () => {
    expect(buildHarnessResumeCommand("codex", null, null, builtIns)).toBe("codex resume --last");
  });

  it("resumes Opencode by session id with --session", () => {
    expect(buildHarnessResumeCommand("opencode", "abc123", null, builtIns)).toBe(
      "opencode --session 'abc123'",
    );
  });

  it("falls back to Opencode's --continue when no session id is known", () => {
    expect(buildHarnessResumeCommand("opencode", null, null, builtIns)).toBe("opencode --continue");
  });

  it("resumes Cursor by session id with --resume", () => {
    expect(buildHarnessResumeCommand("cursor", "abc123", null, builtIns)).toBe(
      "cursor-agent --resume 'abc123'",
    );
  });

  it("returns null for a harness with no registered adapter, with or without a session id", () => {
    expect(buildHarnessResumeCommand("custom-harness", "abc123", null, builtIns)).toBeNull();
    expect(buildHarnessResumeCommand("custom-harness", null, null, builtIns)).toBeNull();
  });

  it("returns null for a stored id that is not even a well-formed harness slug", () => {
    expect(buildHarnessResumeCommand("Not A Harness", "abc123", null, builtIns)).toBeNull();
  });

  it("substitutes the id wherever the template puts it, not only at the end", () => {
    expect(renderResumeArgv(["--session={id}", "--json"], "abc123")).toEqual([
      "--session='abc123'",
      "--json",
    ]);
  });

  it("quotes only the substituted id, leaving the rest of the template literal", () => {
    expect(renderResumeArgv(["--resume", "{id}"], "it's mine")).toEqual([
      "--resume",
      "'it'\\''s mine'",
    ]);
  });

  it("returns null for an adapter that declares no resume at all, session id or not", () => {
    const declared: HarnessAdapter = {
      id: parseHarnessId("my-harness") as HarnessId,
      label: "My Harness",
      command: "my-harness",
      promptFlag: null,
      surfaces: { skillsDir: null, commandsDir: null, instructionsFile: null },
      injection: { kind: "none" },
      sessionId: { kind: "none" },
      resume: { byId: null, latest: null, userResumeTokens: [] },
      events: [],
      startupEvent: null,
      launchSettings: [],
      sessionMarkers: [],
    };
    expect(buildResumeCommand(declared, "abc123", null)).toBeNull();
    expect(buildResumeCommand(declared, null, null)).toBeNull();
  });

  it("quotes a session id that needs shell quoting, same as prompt quoting", () => {
    expect(buildHarnessResumeCommand("claude-code", "it's a session", null, builtIns)).toBe(
      "claude --resume 'it'\\''s a session'",
    );
  });

  it("names the wrapper by absolute path on a by-id resume", () => {
    expect(buildHarnessResumeCommand("claude-code", "abc123", "/ud/bin/claude", builtIns)).toBe(
      "'/ud/bin/claude' --resume 'abc123'",
    );
  });

  it("names the wrapper by absolute path on a latest-in-cwd resume too", () => {
    expect(buildHarnessResumeCommand("codex", null, "/ud/bin/codex", builtIns)).toBe(
      "'/ud/bin/codex' resume --last",
    );
  });
});

describe("canResumeHarness", () => {
  it("is true for a harness that resumes by id when an id is known", () => {
    expect(canResumeHarness("claude-code", "abc123", builtIns)).toBe(true);
  });

  it("is true with no id when the harness can resume the latest in cwd", () => {
    expect(canResumeHarness("claude-code", null, builtIns)).toBe(true);
  });

  it("is false for a harness with no registered adapter", () => {
    expect(canResumeHarness("custom-harness", "abc123", builtIns)).toBe(false);
  });

  it("is false for a stored id that is not a well-formed harness slug", () => {
    expect(canResumeHarness("Not A Harness", "abc123", builtIns)).toBe(false);
  });

  // The capability question a UI asks must not depend on where a wrapper
  // lives — those paths are main's, and the renderer has none.
  it("agrees with the command builder for every first-class harness", () => {
    for (const id of FIRST_CLASS_HARNESS_IDS) {
      for (const sessionId of ["abc123", null]) {
        expect(canResumeHarness(id, sessionId, builtIns)).toBe(
          buildHarnessResumeCommand(id, sessionId, null, builtIns) !== null,
        );
      }
    }
  });
});

describe("a registered harness the built-in registry cannot see", () => {
  it("honours a manifest's promptFlag instead of passing the prompt positionally", () => {
    // The opencode shape, declared by a manifest rather than shipped. Resolved
    // against the built-ins the same launch reads no flag at all and hands
    // `my-harness` its prompt as a SUBCOMMAND.
    const adapter = registered({ promptFlag: "--prompt" });
    const id = adapter.id;

    expect(buildHarnessCommand(id, "hi there", null, lookupOf(adapter))).toBe(
      "my-harness --prompt 'hi there'",
    );
    expect(buildHarnessCommand(id, "hi there", null, builtIns)).toBe("my-harness 'hi there'");
  });

  it("keeps a manifest's promptFlag between the generated wrapper and the prompt", () => {
    const adapter = registered({ promptFlag: "--prompt" });

    expect(buildHarnessCommand(adapter.id, "hi", "/ud/bin/my-harness", lookupOf(adapter))).toBe(
      "'/ud/bin/my-harness' --prompt 'hi'",
    );
  });

  it("launches by the manifest's command, which need not be its slug", () => {
    const adapter = registered({ command: "my-harness-cli" });

    expect(buildHarnessCommand(adapter.id, "hi", null, lookupOf(adapter))).toBe(
      "my-harness-cli 'hi'",
    );
    // Unresolvable, so the slug stands in for a command nobody has described.
    expect(buildHarnessCommand(adapter.id, "hi", null, builtIns)).toBe("my-harness 'hi'");
  });

  it("resumes by id from a manifest's template, which the built-in lookup silently refuses", () => {
    const adapter = registered({
      resume: { byId: ["--session={id}"], latest: ["--continue"], userResumeTokens: ["--session"] },
    });

    expect(buildHarnessResumeCommand(adapter.id, "abc123", null, lookupOf(adapter))).toBe(
      "my-harness --session='abc123'",
    );
    expect(buildHarnessResumeCommand(adapter.id, "abc123", null, builtIns)).toBeNull();
  });

  it("falls back to a manifest's latest-in-cwd resume when no session id is known", () => {
    const adapter = registered({
      resume: { byId: ["--session={id}"], latest: ["--continue"], userResumeTokens: [] },
    });

    expect(buildHarnessResumeCommand(adapter.id, null, null, lookupOf(adapter))).toBe(
      "my-harness --continue",
    );
  });

  it("names the wrapper by absolute path on a registered harness's resume", () => {
    const adapter = registered({
      resume: { byId: ["resume", "{id}"], latest: null, userResumeTokens: [] },
    });

    expect(
      buildHarnessResumeCommand(adapter.id, "abc123", "/ud/bin/my-harness", lookupOf(adapter)),
    ).toBe("'/ud/bin/my-harness' resume 'abc123'");
  });

  it("offers the resume action for a registered harness only to a lookup that knows it", () => {
    const adapter = registered({
      resume: { byId: ["--session={id}"], latest: null, userResumeTokens: [] },
    });

    expect(canResumeHarness(adapter.id, "abc123", lookupOf(adapter))).toBe(true);
    expect(canResumeHarness(adapter.id, null, lookupOf(adapter))).toBe(false);
    expect(canResumeHarness(adapter.id, "abc123", builtIns)).toBe(false);
  });

  it("agrees with the command builder for a registered harness, as it does for built-ins", () => {
    const cases = [
      registered(),
      registered({ resume: { byId: ["--session={id}"], latest: null, userResumeTokens: [] } }),
      registered({ resume: { byId: null, latest: ["--continue"], userResumeTokens: [] } }),
      registered({ resume: { byId: [], latest: [], userResumeTokens: [] } }),
    ];
    for (const adapter of cases) {
      for (const sessionId of ["abc123", null]) {
        expect(canResumeHarness(adapter.id, sessionId, lookupOf(adapter))).toBe(
          buildHarnessResumeCommand(adapter.id, sessionId, null, lookupOf(adapter)) !== null,
        );
      }
    }
  });
});

describe("empty resume argv is not a resume path", () => {
  // `[]` is truthy. Testing the array rather than its length reports the harness
  // as resumable and then builds a line that is only the executable — a FRESH
  // session under the name of a resume, losing the work it claimed to pick up.
  it("returns null rather than a bare executable when both slots are empty", () => {
    const adapter = registered({ resume: { byId: [], latest: [], userResumeTokens: [] } });

    expect(buildResumeCommand(adapter, "abc123", null)).toBeNull();
    expect(buildResumeCommand(adapter, null, null)).toBeNull();
    expect(buildResumeCommand(adapter, "abc123", "/ud/bin/my-harness")).toBeNull();
  });

  it("falls through an empty by-id template to a latest resume that does say something", () => {
    const adapter = registered({
      resume: { byId: [], latest: ["--continue"], userResumeTokens: [] },
    });

    expect(buildResumeCommand(adapter, "abc123", null)).toBe("my-harness --continue");
  });

  it("never offers the action for an adapter whose only resume argv is empty", () => {
    const empty = registered({ resume: { byId: [], latest: [], userResumeTokens: [] } });
    const emptyById = registered({ resume: { byId: [], latest: null, userResumeTokens: [] } });

    expect(canResumeHarness(empty.id, "abc123", lookupOf(empty))).toBe(false);
    expect(canResumeHarness(empty.id, null, lookupOf(empty))).toBe(false);
    expect(canResumeHarness(emptyById.id, "abc123", lookupOf(emptyById))).toBe(false);
  });
});

describe("composeAttachmentsSection", () => {
  it("returns an empty string when there are no files and no urls", () => {
    expect(composeAttachmentsSection({ files: [], urls: [] })).toBe("");
  });

  it("renders a files-only section with the read-each lead-in and no urls block", () => {
    const section = composeAttachmentsSection({
      files: [{ relPath: ".volli/attachments/spec.png", label: "homepage mock" }],
      urls: [],
    });
    expect(section).toBe(
      "## Attachments\n\n" +
        "Read each attached file before starting — they are part of the ticket's spec:\n" +
        "- `.volli/attachments/spec.png` — homepage mock",
    );
  });

  it("renders a urls-only section with no read-each lead-in", () => {
    const section = composeAttachmentsSection({
      files: [],
      urls: [{ url: "https://example.com/design", label: "design doc" }],
    });
    expect(section).toBe(
      "## Attachments\n\nReference URLs:\n- https://example.com/design — design doc",
    );
  });

  it("renders both files and urls together", () => {
    const section = composeAttachmentsSection({
      files: [{ relPath: ".volli/attachments/spec.png", label: "homepage mock" }],
      urls: [{ url: "https://example.com/design", label: "design doc" }],
    });
    expect(section).toBe(
      "## Attachments\n\n" +
        "Read each attached file before starting — they are part of the ticket's spec:\n" +
        "- `.volli/attachments/spec.png` — homepage mock\n" +
        "Reference URLs:\n" +
        "- https://example.com/design — design doc",
    );
  });

  it("omits the ` — label` suffix when a file's label matches its materialized basename", () => {
    const section = composeAttachmentsSection({
      files: [{ relPath: ".volli/attachments/spec.png", label: "spec.png" }],
      urls: [],
    });
    expect(section.endsWith("- `.volli/attachments/spec.png`")).toBe(true);
  });

  it("treats a slashless relPath as its own basename for the label-suffix check", () => {
    const section = composeAttachmentsSection({
      files: [{ relPath: "spec.png", label: "spec.png" }],
      urls: [],
    });
    expect(section.endsWith("- `spec.png`")).toBe(true);
  });

  it("omits the ` — label` suffix when a url's label matches the url verbatim", () => {
    const section = composeAttachmentsSection({
      files: [],
      urls: [{ url: "https://example.com/design", label: "https://example.com/design" }],
    });
    expect(section).toBe("## Attachments\n\nReference URLs:\n- https://example.com/design");
  });

  it("lists multiple files and urls in order", () => {
    const section = composeAttachmentsSection({
      files: [
        { relPath: ".volli/attachments/a.png", label: "a.png" },
        { relPath: ".volli/attachments/b.png", label: "b.png" },
      ],
      urls: [
        { url: "https://example.com/a", label: "https://example.com/a" },
        { url: "https://example.com/b", label: "https://example.com/b" },
      ],
    });
    expect(section).toBe(
      "## Attachments\n\n" +
        "Read each attached file before starting — they are part of the ticket's spec:\n" +
        "- `.volli/attachments/a.png`\n" +
        "- `.volli/attachments/b.png`\n" +
        "Reference URLs:\n" +
        "- https://example.com/a\n" +
        "- https://example.com/b",
    );
  });
});

describe("worktreeOrientationPreamble", () => {
  it("states worktree path, branch, base, and the reference-only main checkout", () => {
    const preamble = worktreeOrientationPreamble({
      worktreePath: "/home/u/.volli/worktrees/repo-abc/VC-1-x",
      branch: "volli/VC-1-x",
      baseBranch: "main",
      projectPath: "/Users/dev/repo",
    });
    expect(preamble).toContain(
      "isolated git worktree at `/home/u/.volli/worktrees/repo-abc/VC-1-x`",
    );
    expect(preamble).toContain("branch `volli/VC-1-x` (branched from `main`)");
    expect(preamble).toContain("main checkout at `/Users/dev/repo` is reference-only");
  });

  it("omits the branched-from clause when the base is unknown", () => {
    const preamble = worktreeOrientationPreamble({
      worktreePath: "/w",
      branch: "b",
      baseBranch: null,
      projectPath: "/p",
    });
    expect(preamble).not.toContain("branched from");
  });
});
