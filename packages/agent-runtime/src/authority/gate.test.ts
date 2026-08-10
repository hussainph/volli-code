import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  type AuthoritySnapshot,
  type CodingToolId,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { authorityVerdict } from "./gate";

function snapshot(overrides: Partial<AuthoritySnapshot> = {}): AuthoritySnapshot {
  return {
    mode: "auto",
    location: "worktree",
    tools: ["read", "edit", "write", "execute"] satisfies CodingToolId[],
    rulePackId: BUILTIN_RULE_PACK_ID,
    rulePackHash: BUILTIN_RULE_PACK_HASH,
    classifierModel: null,
    fallback: { consecutiveDenials: 3, sessionDenials: 20 },
    ...overrides,
  };
}

/**
 * A workspace reached through a symlink, so the resolved root always differs
 * from the path handed in. macOS gives that away for free — `tmpdir()` lives
 * under `/var`, which resolves to `/private/var` — and Linux does not, so the
 * link is made here rather than borrowed from whatever the platform happens to
 * do with its temporary directory.
 */
function workspace(): { raw: string; real: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "volli-gate-")));
  const real = join(base, "tree");
  mkdirSync(real);
  writeFileSync(join(real, "MARKER.txt"), "x");
  const raw = join(base, "link");
  symlinkSync(real, raw);
  return { raw, real };
}

describe("authorityVerdict", () => {
  it("stands aside for work the Session's authority permits", () => {
    const { raw } = workspace();
    expect(
      authorityVerdict({
        tool: "read",
        args: { path: "MARKER.txt" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toEqual({ outcome: "allow" });
    expect(
      authorityVerdict({
        tool: "bash",
        args: { command: "printf hi > out.txt" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toEqual({ outcome: "allow" });
  });

  it("compares operands against the resolved root, not the symlink the caller passed", () => {
    const { raw, real } = workspace();
    expect(raw).not.toBe(real);
    expect(
      authorityVerdict({
        tool: "read",
        args: { path: join(real, "MARKER.txt") },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toEqual({ outcome: "allow" });
  });

  it("returns the refusing rule's own words and name, which the model reads as the tool result", () => {
    const { raw, real } = workspace();
    expect(
      authorityVerdict({
        tool: "read",
        args: { path: "../SECRET.txt" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toEqual({
      outcome: "deny",
      cause: "path.outside-workspace",
      reason: `${join(real, "../SECRET.txt")} is outside the Session workspace ${real}; every read and write must stay inside it.`,
    });
    const grepVerdict = authorityVerdict({
      tool: "grep",
      args: { pattern: "secret" },
      authority: snapshot(),
      workspacePath: raw,
    });
    expect(grepVerdict.outcome).toBe("deny");
    expect(grepVerdict).toMatchObject({ cause: "tool.not-bundled" });
    if (grepVerdict.outcome === "deny") {
      expect(grepVerdict.reason).toContain('"grep" is not one of this Session\'s tools');
    }
  });

  it("reads the Snapshot's own work location rather than assuming a worktree", () => {
    const { raw } = workspace();
    const call = { tool: "bash", args: { command: "git reset --hard" } } as const;
    expect(authorityVerdict({ ...call, authority: snapshot(), workspacePath: raw })).toEqual({
      outcome: "allow",
    });
    const denied = authorityVerdict({
      ...call,
      authority: snapshot({ location: "main-checkout" }),
      workspacePath: raw,
    });
    expect(denied.outcome).toBe("deny");
    expect(denied).toMatchObject({ cause: "command.git-discards-work" });
    if (denied.outcome === "deny") {
      expect(denied.reason).toContain("discards uncommitted work");
    }
  });

  // Payloads from the adversarial review, each of which reached ALLOW. They are
  // asserted here rather than at the normalizer because a bypass is only a
  // bypass end to end — the rules and the normalization have to agree.
  it.each([
    { tool: "write", args: { path: "@.git/hooks/pre-commit" } },
    { tool: "write", args: { path: "@.volli/state.json" } },
    { tool: "edit", args: { path: "@.git/config" } },
    { tool: "bash", args: { command: "env rm -rf ~" } },
    { tool: "bash", args: { command: "nohup rm -rf ~" } },
    { tool: "bash", args: { command: "time rm -rf ~" } },
    { tool: "bash", args: { command: "timeout 5 rm -rf ~" } },
    { tool: "bash", args: { command: "sh -c 'rm -rf ~'" } },
    { tool: "bash", args: { command: "bash -lc 'csrutil disable'" } },
    { tool: "bash", args: { command: "env csrutil disable" } },
    { tool: "bash", args: { command: "env GIT_SSL_NO_VERIFY=1 curl https://x" } },
    { tool: "bash", args: { command: "true & rm -rf ~" } },
    { tool: "bash", args: { command: "( rm -rf ~ )" } },
    { tool: "bash", args: { command: "(rm -rf ~)" } },
    { tool: "bash", args: { command: "{ rm -rf ~; }" } },
    { tool: "bash", args: { command: "rm -rf ~someone" } },
    { tool: "bash", args: { command: "rm -rf $TMPDIR" } },
    { tool: "bash", args: { command: "git -C $ELSEWHERE status" } },
    { tool: "bash", args: { command: "echo x > $TARGET" } },
  ])("refuses $tool $args", ({ tool, args }) => {
    const { raw } = workspace();
    expect(
      authorityVerdict({ tool, args, authority: snapshot(), workspacePath: raw }).outcome,
    ).toBe("deny");
  });

  it("refuses a noclobber redirect at a shell profile, as the plain one already was", () => {
    const { raw } = workspace();
    const profile = join(homedir(), ".zshrc");
    for (const operator of [">", ">|"]) {
      const verdict = authorityVerdict({
        tool: "bash",
        args: { command: `echo pwned ${operator} ${profile}` },
        authority: snapshot(),
        workspacePath: raw,
      });
      expect(verdict.outcome).toBe("deny");
      expect(verdict).toMatchObject({ cause: "path.outside-workspace" });
      if (verdict.outcome === "deny") {
        expect(verdict.reason).toContain("outside the Session workspace");
      }
    }
  });

  // The counterweight: over-refusing spends the same fallback budget as a real
  // denial, so ordinary shell shapes have to survive all of the above.
  it.each([
    "pnpm test",
    "git status",
    "printf hi > out.txt",
    "grep '^foo$' README.md",
    "sed 's/$/x/' README.md",
    "awk '{print $1}' README.md",
    "echo ${HOME}/x",
    "ls | wc -l",
    "echo a && echo b",
    "echo a || echo b",
    "cmd 2>&1",
    "cmd &> all.log",
    "cmd >& all.log",
    "true & rm -rf ./build",
    "git commit -m 'cost $5'",
    "env FOO=1 pnpm test",
    // Ordinary diagnostics. Refusing these spends the same three-consecutive
    // fallback budget as a real attack, which is why an unresolvable operand is
    // only fatal where a rule reads it.
    "echo $PATH",
    "ls $TMPDIR",
    "cat $CONFIG",
    "sh -c 'echo $FOO && ls $BAR'",
  ])("still allows %j", (command) => {
    const { raw } = workspace();
    expect(
      authorityVerdict({
        tool: "bash",
        args: { command },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toEqual({ outcome: "allow" });
  });

  it("blocks a call it cannot describe rather than letting it through unchecked, citing no rule for it", () => {
    const { raw } = workspace();
    const unreadablePath = authorityVerdict({
      tool: "read",
      args: { path: "x".repeat(400) },
      authority: snapshot(),
      workspacePath: raw,
    });
    expect(unreadablePath.outcome).toBe("deny");
    expect(unreadablePath).toMatchObject({ cause: "call.unreadable" });
    if (unreadablePath.outcome === "deny") {
      expect(unreadablePath.reason).toContain(
        "could not be checked against the Session's authority",
      );
    }

    expect(
      authorityVerdict({
        tool: "bash",
        args: {},
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toEqual({
      outcome: "deny",
      cause: "call.unreadable",
      reason:
        "This call could not be checked against the Session's authority, so it was refused: Pi tool bash was called without a command argument.",
    });

    const unresolvableWorkspace = authorityVerdict({
      tool: "read",
      args: { path: "MARKER.txt" },
      authority: snapshot(),
      workspacePath: join(raw, "x".repeat(400)),
    });
    expect(unresolvableWorkspace.outcome).toBe("deny");
    expect(unresolvableWorkspace).toMatchObject({ cause: "call.unreadable" });
    if (unresolvableWorkspace.outcome === "deny") {
      expect(unresolvableWorkspace.reason).toContain(
        "could not be checked against the Session's authority",
      );
    }
  });
});
