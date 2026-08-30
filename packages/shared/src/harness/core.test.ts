import { describe, expect, it } from "vite-plus/test";

import { FIRST_CLASS_HARNESS_IDS, parseHarnessId, type HarnessId } from "../ticket";
import {
  bindsStartupEvent,
  expectsHarnessEvents,
  HARNESS_EVENTS,
  supportedEvents,
  type HarnessAdapter,
} from "./types";
import {
  buildHarnessInstallPlan,
  CANONICAL_SKILL_FILES,
  fencedBlockPattern,
  fencedBody,
  harnessAdapters,
  harnessBaselineActions,
  managedWriteDecision,
  mergeFencedSection,
} from "./core";
import { VOLLI_COMMAND_DOC } from "./skill-content";
import { genericHarnessActions } from "./generic";

describe("mergeFencedSection", () => {
  it("writes an empty instructions file without leading blank lines", () => {
    expect(mergeFencedSection("", "Use Volli.", 1).content).toBe(
      "<!-- volli:begin v=1 -->\nUse Volli.\n<!-- volli:end -->\n",
    );
  });

  it("appends a managed block without changing existing user instructions", () => {
    expect(
      mergeFencedSection("# My rules\nKeep this.\n", "Use `volli identify` first.", 2),
    ).toEqual({
      changed: true,
      content:
        "# My rules\nKeep this.\n\n<!-- volli:begin v=2 -->\nUse `volli identify` first.\n<!-- volli:end -->\n",
    });
  });

  it("replaces only the existing managed block and skips a byte-identical rewrite", () => {
    const before = "before\n\n<!-- volli:begin v=1 -->\nold\n<!-- volli:end -->\n\nafter\n";
    const first = mergeFencedSection(before, "new", 2);
    expect(first).toEqual({
      changed: true,
      content: "before\n\n<!-- volli:begin v=2 -->\nnew\n<!-- volli:end -->\n\nafter\n",
    });
    expect(mergeFencedSection(first.content, "new", 2)).toEqual({
      changed: false,
      content: first.content,
    });
  });

  it("inserts a managed body containing $& / $$ verbatim", () => {
    const body = "Cost is $$5 and $& stays literal.";
    const appended = mergeFencedSection("# rules\n", body, 1);
    expect(appended.content).toContain(`<!-- volli:begin v=1 -->\n${body}\n<!-- volli:end -->`);

    const replaced = mergeFencedSection(appended.content, body, 1);
    expect(replaced).toEqual({ changed: false, content: appended.content });
  });

  it("writes hash-comment markers into a shell profile, where HTML comments are syntax errors", () => {
    const merged = mergeFencedSection(
      "export EDITOR=vim\n",
      'export PATH="$HOME/.local/bin:$PATH"',
      1,
      "hash",
    );
    expect(merged.content).toBe(
      'export EDITOR=vim\n\n# volli:begin v=1\nexport PATH="$HOME/.local/bin:$PATH"\n# volli:end\n',
    );
    expect(merged.content).not.toContain("<!--");

    const replaced = mergeFencedSection(merged.content, "export PATH=changed", 2, "hash");
    expect(replaced.content).toBe(
      "export EDITOR=vim\n\n# volli:begin v=2\nexport PATH=changed\n# volli:end\n",
    );
  });
});

describe("fence patterns", () => {
  it("recognizes the same block the merge writes, in both comment styles", () => {
    const html = mergeFencedSection("", "body", 3).content;
    expect(html.match(fencedBlockPattern())?.[0]).toContain("body");
    expect(fencedBody(html)).toBe("body");

    const hash = mergeFencedSection("", "body", 3, "hash").content;
    expect(hash.match(fencedBlockPattern("hash"))?.[0]).toContain("body");
    expect(fencedBody(hash, "hash")).toBe("body");

    // Cross-style: a zsh profile block must be invisible to the HTML patterns.
    expect(hash.match(fencedBlockPattern("html"))).toBeNull();
  });
});

describe("fencedBody", () => {
  it("reads a body a Windows editor saved with CRLF line endings", () => {
    // The guard that protects hand edits hashes this body. A strict `\n` would
    // return null here, which reads as "unmanaged" and overwrites the edits.
    expect(fencedBody("<!-- volli:begin v=1 -->\r\nmy hand edits\r\n<!-- volli:end -->\r\n")).toBe(
      "my hand edits",
    );
    expect(fencedBody("# volli:begin v=1\r\nexport PATH=mine\r\n# volli:end\r\n", "hash")).toBe(
      "export PATH=mine",
    );
  });

  it("reads a body with no newline adjacent to either marker", () => {
    expect(fencedBody("<!-- volli:begin v=1 -->body<!-- volli:end -->")).toBe("body");
    expect(fencedBody("# volli:begin v=1 body# volli:end", "hash")).toBe("body");
  });

  it("strips exactly one line ending next to each marker", () => {
    expect(fencedBody("<!-- volli:begin v=1 -->\n\nbody\n\n<!-- volli:end -->")).toBe("\nbody\n");
  });

  it("keeps an empty body empty rather than reaching past a marker", () => {
    expect(fencedBody("<!-- volli:begin v=1 -->\n<!-- volli:end -->")).toBe("");
    expect(fencedBody("<!-- volli:begin v=1 -->\r\n<!-- volli:end -->")).toBe("");
  });

  it("is null when a marker is missing", () => {
    expect(fencedBody("nothing managed here\n")).toBeNull();
    expect(fencedBody("<!-- volli:begin v=1 -->\nbody, but no end marker\n")).toBeNull();
  });

  it("answers a newline-heavy file with no end marker in milliseconds", () => {
    // The `BEGIN\r?\n?(body)\r?\n?END` regex this replaced backtracked
    // quadratically here: every `\n` could belong to the body or to a
    // separator (CodeQL js/polynomial-redos).
    const unterminated = `<!-- volli:begin v=1 -->${"\n".repeat(100_000)}`;
    const started = performance.now();
    expect(fencedBody(unterminated)).toBeNull();
    expect(fencedBody(`# volli:begin v=1${"\r\n".repeat(100_000)}`, "hash")).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("managedWriteDecision", () => {
  it("writes pristine managed files but protects user-edited managed files", () => {
    expect(
      managedWriteDecision({ currentHash: "old", recordedHash: "old", desiredHash: "new" }),
    ).toBe("write");
    expect(
      managedWriteDecision({ currentHash: "edited", recordedHash: "old", desiredHash: "new" }),
    ).toBe("conflict");
    expect(
      managedWriteDecision({ currentHash: "new", recordedHash: "old", desiredHash: "new" }),
    ).toBe("skip");
    expect(
      managedWriteDecision({ currentHash: null, recordedHash: null, desiredHash: "new" }),
    ).toBe("write");
  });
});

describe("harnessAdapters", () => {
  it("covers every first-class harness with its own executable to detect", () => {
    expect(harnessAdapters.map((adapter) => adapter.id).toSorted()).toEqual(
      [...FIRST_CLASS_HARNESS_IDS].toSorted(),
    );
    expect(harnessAdapters.every((adapter) => adapter.command.length > 0)).toBe(true);
    const claude = harnessAdapters.find((adapter) => adapter.id === "claude-code");
    expect(claude?.command).toBe("claude");
  });
});

const NO_SURFACES = { skillsDir: null, commandsDir: null, instructionsFile: null } as const;

/** A Declared-tier adapter that reads nothing, so each test adds only the surface it is about. */
function bareAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: parseHarnessId("my-harness") as HarnessId,
    label: "My Harness",
    command: "my-harness",
    promptFlag: null,
    surfaces: NO_SURFACES,
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

function adapterFor(id: string): HarnessAdapter {
  const found = harnessAdapters.find((adapter) => adapter.id === id);
  if (!found) throw new Error(`no adapter for ${id}`);
  return found;
}

describe("first-class harness capabilities", () => {
  it("names a bare executable for every harness, so a trust dialog's claim is literally true", () => {
    for (const adapter of harnessAdapters) {
      expect(adapter.command).not.toMatch(/[/\s]/);
      expect(adapter.command.length).toBeGreaterThan(0);
    }
  });

  // Each value is a live measurement against the mode Volli actually launches —
  // the interactive TUI, never a headless `-p`/`exec`, which is where three of
  // these four disagree with themselves. Written down so a binding cannot be
  // removed while the claim it supports stays behind, which is the only way this
  // field goes back to lying.
  it("claims a launch-time event only where one was observed, and binds every one it claims", () => {
    const claimed = Object.fromEntries(
      harnessAdapters.map((adapter) => [adapter.id, adapter.startupEvent]),
    );
    expect(claimed).toEqual({
      "claude-code": "session.started",
      cursor: "session.started",
      opencode: "session.started",
      // Codex has no session until the first turn: a trusted config fires
      // nothing at TUI boot. See `codex.ts`.
      codex: null,
    });
    for (const adapter of harnessAdapters) {
      expect([adapter.id, bindsStartupEvent(adapter)]).toEqual([adapter.id, true]);
    }
  });

  // The line the whole silence model turns on, stated for the four binaries
  // rather than for a synthetic adapter: only these three may ever be called
  // not-reporting, and codex may not, however long it sits there. Measured
  // against the running binaries, not read off the adapters.
  it("holds three of the four built-ins to a reporting promise, and never codex", () => {
    expect(
      Object.fromEntries(
        harnessAdapters.map((adapter) => [adapter.id, expectsHarnessEvents(adapter)]),
      ),
    ).toEqual({ "claude-code": true, cursor: true, opencode: true, codex: false });
  });

  it("templates every by-id resume on exactly one {id} token", () => {
    for (const adapter of harnessAdapters) {
      const template = adapter.resume.byId;
      if (!template) continue;
      expect(template.filter((token) => token.includes("{id}"))).toHaveLength(1);
    }
  });

  it("claims a user's own resume flags for every harness that can resume at all", () => {
    for (const adapter of harnessAdapters) {
      if (!adapter.resume.byId && !adapter.resume.latest) continue;
      expect(adapter.resume.userResumeTokens.length).toBeGreaterThan(0);
    }
  });

  it("hooks claude-code on inline settings JSON and a session id we mint", () => {
    const claude = adapterFor("claude-code");
    expect(expectsHarnessEvents(claude)).toBe(true);
    expect(claude.injection).toEqual({ kind: "claude-settings-json", flag: "--settings" });
    expect(claude.sessionId).toEqual({ kind: "argv", flag: "--session-id", format: "uuid" });
    expect([...supportedEvents(claude)].toSorted()).toEqual([...HARNESS_EVENTS].toSorted());
  });

  it("silences claude-code's own notifications so they never double up with Volli's", () => {
    expect(adapterFor("claude-code").launchSettings).toContainEqual({
      path: "preferredNotifChannel",
      value: "notifications_disabled",
    });
  });

  it("reaches codex turn completion by a mechanism its other events do not share", () => {
    const codex = adapterFor("codex");
    const turnCompleted = codex.events.find((binding) => binding.event === "turn.completed");
    const permission = codex.events.find((binding) => binding.event === "permission.requested");
    expect(turnCompleted?.native.split(":")[0]).toBe("notify");
    expect(permission?.native.split(":")[0]).toBe("hooks");
  });

  it("leaves cursor unable to report input.needed, which its source confirms rather than omits", () => {
    const cursor = adapterFor("cursor");
    expect(expectsHarnessEvents(cursor)).toBe(true);
    expect(supportedEvents(cursor).has("input.needed")).toBe(false);
    expect(supportedEvents(cursor).has("permission.requested")).toBe(false);
    expect(supportedEvents(cursor).has("turn.completed")).toBe(true);
    // Expected to report because its hooks land on the one rung cursor-agent
    // actually reads per project — not because a variable was pointed somewhere.
    expect(cursor.injection).toEqual({ kind: "cursor-hooks-file" });
  });

  it("learns opencode's session id from its events instead of minting one at launch", () => {
    const opencode = adapterFor("opencode");
    expect(opencode.sessionId).toEqual({ kind: "reported" });
    expect(opencode.injection).toEqual({
      kind: "opencode-plugin",
      envVar: "OPENCODE_CONFIG",
      filename: "opencode.json",
    });
    expect(supportedEvents(opencode).has("input.needed")).toBe(true);
  });
});

describe("harnessBaselineActions", () => {
  it("delivers the skill pack by symlink when a harness reads a skills directory", () => {
    expect(
      harnessBaselineActions({
        home: "/home/dev",
        adapters: [bareAdapter({ surfaces: { ...NO_SURFACES, skillsDir: "{home}/.x/skills" } })],
      }),
    ).toEqual([
      {
        kind: "symlink",
        path: "/home/dev/.x/skills/volli",
        target: "/home/dev/.agents/skills/volli",
        managed: true,
      },
    ]);
  });

  it("falls back to a slash-command doc only when there is no skills directory to use", () => {
    const withBoth = harnessBaselineActions({
      home: "/home/dev",
      adapters: [
        bareAdapter({
          surfaces: { ...NO_SURFACES, skillsDir: "{home}/.x/skills", commandsDir: "{home}/.x/cmd" },
        }),
      ],
    });
    expect(withBoth.map((action) => action.kind)).toEqual(["symlink"]);

    const commandsOnly = harnessBaselineActions({
      home: "/home/dev",
      adapters: [bareAdapter({ surfaces: { ...NO_SURFACES, commandsDir: "{home}/.x/cmd" } })],
    });
    expect(commandsOnly).toEqual([
      {
        kind: "write",
        path: "/home/dev/.x/cmd/volli.md",
        content: VOLLI_COMMAND_DOC,
        managed: true,
      },
    ]);
  });

  it("writes one fenced block when two harnesses read the same instructions file", () => {
    const actions = harnessBaselineActions({
      home: "/home/dev",
      adapters: [
        bareAdapter({ surfaces: { ...NO_SURFACES, instructionsFile: "{home}/AGENTS.md" } }),
        bareAdapter({ surfaces: { ...NO_SURFACES, instructionsFile: "{home}/AGENTS.md" } }),
      ],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "fenced", path: "/home/dev/AGENTS.md" });
  });

  it("asks nothing of a harness that declares no surface at all", () => {
    expect(harnessBaselineActions({ home: "/home/dev", adapters: [bareAdapter()] })).toEqual([]);
  });
});

describe("buildHarnessInstallPlan", () => {
  it("does nothing when no supported harness is detected", () => {
    expect(buildHarnessInstallPlan({ home: "/home/dev", adapters: [] })).toEqual([]);
  });

  it("keeps the assets it already ships for claude-code and opencode byte-identical", () => {
    const claude = buildHarnessInstallPlan({
      home: "/home/dev",
      adapters: [adapterFor("claude-code")],
    }).slice(CANONICAL_SKILL_FILES);
    expect(claude).toEqual([
      {
        kind: "symlink",
        path: "/home/dev/.claude/skills/volli",
        target: "/home/dev/.agents/skills/volli",
        managed: true,
      },
    ]);

    const opencode = buildHarnessInstallPlan({
      home: "/home/dev",
      adapters: [adapterFor("opencode")],
    }).slice(CANONICAL_SKILL_FILES);
    expect(opencode).toEqual([
      {
        kind: "write",
        path: "/home/dev/.config/opencode/command/volli.md",
        content: VOLLI_COMMAND_DOC,
        managed: true,
      },
    ]);
  });

  it("shares one canonical skill and never creates a Codex prompt", () => {
    const plan = buildHarnessInstallPlan({
      home: "/home/dev",
      adapters: [
        adapterFor("claude-code"),
        adapterFor("codex"),
        adapterFor("cursor"),
        adapterFor("opencode"),
      ],
    });
    const paths = plan.map((action) => action.path);

    expect(paths).toContain("/home/dev/.agents/skills/volli/SKILL.md");
    expect(paths).toContain("/home/dev/.agents/skills/volli/cli.md");
    expect(paths).toContain("/home/dev/.agents/skills/volli/concepts.md");
    expect(paths).toContain("/home/dev/.agents/skills/volli/changes.md");
    expect(paths).toContain("/home/dev/.agents/skills/volli/orchestration.md");
    expect(paths).toContain("/home/dev/.agents/skills/volli/plugin.md");
    expect(paths.some((path) => path.includes(".codex/prompts"))).toBe(false);
  });

  it("ships the manifest schema beside the skill, so an agent can register a harness", () => {
    const plan = buildHarnessInstallPlan({
      home: "/home/dev",
      adapters: [adapterFor("claude-code")],
    });
    expect(plan.slice(0, CANONICAL_SKILL_FILES).map((action) => action.path)).toEqual([
      "/home/dev/.agents/skills/volli/SKILL.md",
      "/home/dev/.agents/skills/volli/cli.md",
      "/home/dev/.agents/skills/volli/concepts.md",
      "/home/dev/.agents/skills/volli/changes.md",
      "/home/dev/.agents/skills/volli/orchestration.md",
      "/home/dev/.agents/skills/volli/plugin.md",
    ]);
  });

  it("does not fence global AGENTS.md for codex or cursor — skills carry session context", () => {
    const plan = buildHarnessInstallPlan({
      home: "/home/dev",
      adapters: [adapterFor("codex"), adapterFor("cursor")],
    });
    const fenced = plan.filter((action) => action.kind === "fenced").map((action) => action.path);
    expect(fenced).toEqual([]);
    expect(plan.filter((action) => action.kind === "symlink").map((action) => action.path)).toEqual(
      ["/home/dev/.codex/skills/volli", "/home/dev/.cursor/skills/volli"],
    );
  });

  it("gives a registered adapter exactly what a built-in with the same surfaces gets", () => {
    // The adapter a trusted manifest parses into — reachable by no id lookup,
    // which is why this plan takes adapters at all.
    const registered = bareAdapter({
      surfaces: {
        skillsDir: "{home}/.my-harness/skills",
        commandsDir: null,
        instructionsFile: "{home}/.my-harness/AGENTS.md",
      },
    });
    const plan = buildHarnessInstallPlan({ home: "/home/dev", adapters: [registered] });

    expect(plan.slice(0, CANONICAL_SKILL_FILES).map((action) => action.path)).toEqual([
      "/home/dev/.agents/skills/volli/SKILL.md",
      "/home/dev/.agents/skills/volli/cli.md",
      "/home/dev/.agents/skills/volli/concepts.md",
      "/home/dev/.agents/skills/volli/changes.md",
      "/home/dev/.agents/skills/volli/orchestration.md",
      "/home/dev/.agents/skills/volli/plugin.md",
    ]);
    expect(plan.slice(CANONICAL_SKILL_FILES)).toEqual([
      {
        kind: "symlink",
        path: "/home/dev/.my-harness/skills/volli",
        target: "/home/dev/.agents/skills/volli",
        managed: true,
      },
      expect.objectContaining({ kind: "fenced", path: "/home/dev/.my-harness/AGENTS.md" }),
    ]);
  });

  it("installs the canonical pack for a registered harness alone, with no built-in present", () => {
    const registered = bareAdapter({
      surfaces: { ...NO_SURFACES, commandsDir: "{home}/.my-harness/commands" },
    });
    expect(buildHarnessInstallPlan({ home: "/home/dev", adapters: [registered] })).toHaveLength(
      CANONICAL_SKILL_FILES + 1,
    );
  });

  it("normalizes a trailing home slash and de-duplicates harnesses", () => {
    const plan = buildHarnessInstallPlan({
      home: "/home/dev/",
      adapters: [adapterFor("codex"), adapterFor("codex")],
    });
    expect(plan.filter((action) => action.path.includes(".codex"))).toHaveLength(1);
    expect(plan[0]?.path).toBe("/home/dev/.agents/skills/volli/SKILL.md");
  });

  it("de-duplicates two DIFFERENT harnesses that claim the same surface path", () => {
    const surfaces = { ...NO_SURFACES, instructionsFile: "{home}/AGENTS.md" };
    const plan = buildHarnessInstallPlan({
      home: "/home/dev",
      adapters: [
        bareAdapter({ surfaces }),
        bareAdapter({ id: parseHarnessId("other-harness") as HarnessId, surfaces }),
      ],
    });
    expect(plan).toHaveLength(CANONICAL_SKILL_FILES + 1);
  });
});

describe("genericHarnessActions", () => {
  it("describes a fenced managed instructions block", () => {
    expect(genericHarnessActions("/home/dev/AGENTS.md")).toEqual([
      expect.objectContaining({ kind: "fenced", path: "/home/dev/AGENTS.md", version: 2 }),
    ]);
  });
});
