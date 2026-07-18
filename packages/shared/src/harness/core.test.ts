import { describe, expect, it } from "vite-plus/test";

import { buildHarnessInstallPlan, managedWriteDecision, mergeFencedSection } from "./core";
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

describe("buildHarnessInstallPlan", () => {
  it("does nothing when no supported harness is detected", () => {
    expect(buildHarnessInstallPlan({ home: "/home/dev", detected: [] })).toEqual([]);
  });

  it("shares one canonical skill, adds only harness deltas, and never creates a Codex prompt", () => {
    const plan = buildHarnessInstallPlan({
      home: "/home/dev",
      detected: ["claude-code", "codex", "opencode"],
    });
    const paths = plan.map((action) => action.path);

    expect(paths).toContain("/home/dev/.agents/skills/volli/SKILL.md");
    expect(paths).toContain("/home/dev/.agents/skills/volli/cli.md");
    expect(paths).toContain("/home/dev/.agents/skills/volli/orchestration.md");
    expect(plan).toContainEqual({
      kind: "symlink",
      path: "/home/dev/.claude/skills/volli",
      target: "/home/dev/.agents/skills/volli",
      managed: true,
    });
    expect(paths).toContain("/home/dev/.config/opencode/command/volli.md");
    expect(paths.some((path) => path.includes(".codex/prompts"))).toBe(false);
    expect(paths.some((path) => path.includes("/custom/"))).toBe(false);
  });

  it("normalizes a trailing home slash and de-duplicates harnesses", () => {
    const plan = buildHarnessInstallPlan({
      home: "/home/dev/",
      detected: ["codex", "codex"],
    });
    expect(plan).toHaveLength(3);
    expect(plan[0]?.path).toBe("/home/dev/.agents/skills/volli/SKILL.md");
  });
});

describe("genericHarnessActions", () => {
  it("describes a fenced managed instructions block", () => {
    expect(genericHarnessActions("/home/dev/AGENTS.md")).toEqual([
      expect.objectContaining({ kind: "fenced", path: "/home/dev/AGENTS.md", version: 1 }),
    ]);
  });
});
