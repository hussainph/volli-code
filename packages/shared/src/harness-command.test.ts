import { describe, it, expect } from "vite-plus/test";
import { FIRST_CLASS_HARNESS_IDS, parseHarnessId, type HarnessId } from "./ticket";
import {
  buildHarnessCommand,
  buildHarnessResumeCommand,
  composeAttachmentsSection,
  composeTicketPrompt,
  shellSingleQuote,
  worktreeOrientationPreamble,
} from "./harness-command";

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
    expect(buildHarnessCommand("claude-code", "hi there")).toBe("claude 'hi there'");
  });

  it("launches Codex with a positional quoted prompt (interactive TUI, not exec)", () => {
    expect(buildHarnessCommand("codex", "hi there")).toBe("codex 'hi there'");
  });

  it("launches Opencode with --prompt (default TUI, not run)", () => {
    expect(buildHarnessCommand("opencode", "hi there")).toBe("opencode --prompt 'hi there'");
  });

  it("launches Cursor's CLI, which is cursor-agent rather than cursor", () => {
    expect(buildHarnessCommand("cursor", "hi there")).toBe("cursor-agent 'hi there'");
  });

  it("launches an unregistered harness by its own slug with a positional prompt", () => {
    const custom = parseHarnessId("my-harness") as HarnessId;
    expect(buildHarnessCommand(custom, "hi there")).toBe("my-harness 'hi there'");
  });

  it("quotes the prompt so shell metacharacters stay inert", () => {
    expect(buildHarnessCommand("claude-code", "it's `$X`")).toBe("claude 'it'\\''s `$X`'");
  });

  it("has a template for every first-class harness", () => {
    for (const id of FIRST_CLASS_HARNESS_IDS) {
      expect(buildHarnessCommand(id, "x")).toContain("'x'");
    }
  });
});

describe("buildHarnessResumeCommand", () => {
  it("resumes Claude Code by session id with --resume", () => {
    expect(buildHarnessResumeCommand("claude-code", "abc123")).toBe("claude --resume 'abc123'");
  });

  it("falls back to Claude Code's --continue when no session id is known", () => {
    expect(buildHarnessResumeCommand("claude-code", null)).toBe("claude --continue");
  });

  it("resumes Codex by session id with resume", () => {
    expect(buildHarnessResumeCommand("codex", "abc123")).toBe("codex resume 'abc123'");
  });

  it("falls back to Codex's resume --last when no session id is known", () => {
    expect(buildHarnessResumeCommand("codex", null)).toBe("codex resume --last");
  });

  it("resumes Opencode by session id with --session", () => {
    expect(buildHarnessResumeCommand("opencode", "abc123")).toBe("opencode --session 'abc123'");
  });

  it("falls back to Opencode's --continue when no session id is known", () => {
    expect(buildHarnessResumeCommand("opencode", null)).toBe("opencode --continue");
  });

  it("returns null for a harness with no known resume support, with or without a session id", () => {
    expect(buildHarnessResumeCommand("custom-harness", "abc123")).toBeNull();
    expect(buildHarnessResumeCommand("custom-harness", null)).toBeNull();
  });

  it("quotes a session id that needs shell quoting, same as prompt quoting", () => {
    expect(buildHarnessResumeCommand("claude-code", "it's a session")).toBe(
      "claude --resume 'it'\\''s a session'",
    );
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
