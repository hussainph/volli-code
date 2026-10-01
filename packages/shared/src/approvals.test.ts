import { describe, expect, it } from "vite-plus/test";

import {
  APPROVAL_AUTHORISERS,
  approvalActionDigit,
  approvalCopy,
  approvalCovers,
  commandScope,
  describeApproval,
  DENIED_BY_PERSON,
  gitScope,
  hardRefusalCopy,
  hardRefusalMessage,
  isApprovalInteraction,
  projectRememberable,
  readScope,
  steerMessage,
  wrapsCommands,
  writeApprovalKey,
  writeScope,
} from "./approvals";
import { AUTHORITY_RULE_IDS } from "./authority";

const cmd = (raw: string, ...segments: [string, ...string[]][]) => ({
  raw,
  segments: segments.map(([program, ...args]) => ({ program, args })),
});

describe("writeApprovalKey", () => {
  it("remembers the folder of a deep path", () => {
    expect(writeApprovalKey("/Users/me/code/docs/guides/a.md")).toBe("/Users/me/code/docs/guides");
  });

  it("keeps the exact file when the folder is the home, a top-level home folder or a system root", () => {
    expect(writeApprovalKey("/Users/me/a.md")).toBe("/Users/me/a.md");
    expect(writeApprovalKey("/Users/me/code/a.md")).toBe("/Users/me/code/a.md");
    expect(writeApprovalKey("/etc/hosts")).toBe("/etc/hosts");
    expect(writeApprovalKey("/hosts")).toBe("/hosts");
  });
});

describe("approvalCovers", () => {
  const scope = writeScope("/Users/me/code/docs/guides/a.md");

  it("covers a path under the folder and the folder itself, at segment boundaries", () => {
    const row = { operation: "write", key: "/Users/me/code/docs/guides" } as const;
    expect(approvalCovers(row, scope)).toBe(true);
    expect(approvalCovers(row, writeScope("/Users/me/code/docs/guides/sub/b.md"))).toBe(true);
    expect(approvalCovers(row, writeScope("/Users/me/code/docs/guides-evil/b.md"))).toBe(false);
  });

  it("never lets one operation cover another", () => {
    expect(approvalCovers({ operation: "read", key: "/Users/me/code/docs/guides" }, scope)).toBe(
      false,
    );
    expect(
      approvalCovers(
        { operation: "write", key: "/Users/me/code/docs/guides" },
        readScope("/Users/me/code/docs/guides/a.md"),
      ),
    ).toBe(false);
  });

  it("compares git shapes, exact commands and hosts exactly", () => {
    const git = gitScope("git push --force -C /x");
    expect(approvalCovers({ operation: "git", key: "git push --force -C /x" }, git)).toBe(true);
    expect(approvalCovers({ operation: "git", key: "git push -C /x" }, git)).toBe(false);
    const exact = commandScope("python3 build.py");
    expect(approvalCovers({ operation: "command", key: "python3 build.py" }, exact)).toBe(true);
    expect(approvalCovers({ operation: "command", key: "python3" }, exact)).toBe(false);
    expect(
      approvalCovers(
        { operation: "connect", key: "registry.npmjs.org" },
        {
          operation: "connect",
          target: "registry.npmjs.org",
          key: "registry.npmjs.org",
          summary: "",
        },
      ),
    ).toBe(true);
  });

  it("covers nothing for a scope that cannot be remembered", () => {
    expect(
      approvalCovers(
        { operation: "write", key: "/a/b/c/d" },
        { operation: "write", target: "/a/b/c/d/e", key: null, summary: "" },
      ),
    ).toBe(false);
  });
});

describe("describeApproval", () => {
  it("says every operation in one sentence, from the same fields the gate matches on", () => {
    expect(describeApproval({ operation: "write", key: "/a" })).toBe("Write to /a");
    expect(describeApproval({ operation: "read", key: "/a" })).toBe("Read /a");
    expect(describeApproval({ operation: "git", key: "git push" })).toBe("Run git push");
    expect(describeApproval({ operation: "command", key: "make" })).toBe("Run exactly: make");
    expect(describeApproval({ operation: "connect", key: "x.dev" })).toBe("Connect to x.dev");
    expect(describeApproval({ operation: "command", key: "x".repeat(200) })).toMatch(/\u2026$/u);
  });

  it("makes a scope's summary the same sentence a stored row would show", () => {
    const scope = writeScope("/Users/me/code/docs/guides/a.md");
    expect(scope.summary).toBe(describeApproval({ operation: "write", key: scope.key! }));
  });
});

describe("projectRememberable", () => {
  it("allows paths and git shapes, never an exact command or nothing", () => {
    expect(projectRememberable([writeScope("/a/b/c/d/e")])).toBe(true);
    expect(projectRememberable([gitScope("git push")])).toBe(true);
    expect(projectRememberable([commandScope("sh -c x")])).toBe(false);
    expect(projectRememberable([writeScope("/a/b/c/d/e"), commandScope("x")])).toBe(false);
    expect(projectRememberable([])).toBe(false);
  });
});

describe("wrapsCommands", () => {
  it("flags substitution, shells, runners and interpreters with an inline program", () => {
    expect(wrapsCommands(cmd("echo $(id)", ["echo"]))).toBe(true);
    expect(wrapsCommands(cmd("echo `id`", ["echo"]))).toBe(true);
    expect(wrapsCommands(cmd("bash -c x", ["bash", "-c", "x"]))).toBe(true);
    expect(wrapsCommands(cmd("/usr/bin/xargs rm", ["/usr/bin/xargs", "rm"]))).toBe(true);
    expect(wrapsCommands(cmd("npx foo", ["npx", "foo"]))).toBe(true);
    expect(wrapsCommands(cmd("find . -exec rm {} ;", ["find", ".", "-exec", "rm"]))).toBe(true);
    expect(wrapsCommands(cmd("pnpm dlx x", ["pnpm", "dlx", "x"]))).toBe(true);
    expect(wrapsCommands(cmd("python3 -c 1", ["python3", "-c", "1"]))).toBe(true);
  });

  it("leaves ordinary commands alone", () => {
    expect(wrapsCommands(cmd("git status", ["git", "status"]))).toBe(false);
    expect(wrapsCommands(cmd("find . -name x", ["find", ".", "-name", "x"]))).toBe(false);
    expect(wrapsCommands(cmd("pnpm test", ["pnpm", "test"]))).toBe(false);
    expect(wrapsCommands(cmd("python3 x.py", ["python3", "x.py"]))).toBe(false);
    expect(wrapsCommands({ raw: "", segments: [] })).toBe(false);
  });
});

describe("copy", () => {
  it("has a title and a reason for every approvable rule and a fallback", () => {
    for (const cause of [
      "path.outside-workspace",
      "path.git-internals",
      "path.volli-internals",
      "command.git-escapes-workspace",
      "command.git-discards-work",
      "budget.delegation-children",
    ] as const) {
      const copy = approvalCopy(cause);
      expect(copy.title.endsWith("?")).toBe(true);
      expect(copy.because.length).toBeGreaterThan(0);
    }
  });

  it("explains every rule that cannot be approved, and never offers a way out", () => {
    for (const cause of [...AUTHORITY_RULE_IDS, "call.unreadable"] as const) {
      const copy = hardRefusalCopy(cause);
      expect(copy.heading).toMatch(/^(Never allowed|Blocked)/u);
      const message = hardRefusalMessage(cause, "the rule's words");
      expect(message).toContain(copy.heading);
      expect(message).toContain("can't be approved");
      expect(message).toContain("the rule's words");
    }
  });

  it("words a denial for the model", () => {
    expect(steerMessage("  use /tmp  ")).toBe('The person denied this and said: "use /tmp"');
    expect(DENIED_BY_PERSON).toMatch(/denied/u);
  });

  it("reserves the classifier as an authoriser without any rule writing it", () => {
    expect(APPROVAL_AUTHORISERS).toContain("classifier");
  });
});

describe("approval metadata and actions", () => {
  const approval = { asked: "a\u241eb", because: "b", reason: "r", stages: [], held: null };
  it("recognises only adapter-produced approval metadata, regardless of model option ids", () => {
    expect(isApprovalInteraction({ approval })).toBe(true);
    const modelQuestion = { options: [{ id: "once" }, { id: "steer" }], approval: undefined };
    expect(isApprovalInteraction(modelQuestion)).toBe(false);
    expect(isApprovalInteraction({})).toBe(false);
  });

  it.each([
    ["once", 1],
    ["session", 2],
    ["project", 3],
    ["reject", 4],
    ["steer", 5],
    ["other", null],
  ] as const)("fixes %s to digit %s", (id, digit) => expect(approvalActionDigit(id)).toBe(digit));
});
