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
import { authorityClassifierEligible, authorityVerdict, describeCall } from "./gate";

function snapshot(overrides: Partial<AuthoritySnapshot> = {}): AuthoritySnapshot {
  return {
    mode: "auto",
    location: "worktree",
    enforcement: "enforce",
    judgmentMode: "ask",
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

describe("classifier routing order", () => {
  it("checks hard denial before read and workspace edit skips", () => {
    const { raw } = workspace();
    for (const tool of ["read", "edit", "write", "bash"]) {
      expect(
        authorityClassifierEligible({
          tool,
          args: { path: "MARKER.txt" },
          workspacePath: raw,
          verdict: { outcome: "deny", cause: "command.persistence", reason: "hard" },
        }),
      ).toBe(false);
    }
  });

  it("skips only reads and edits whose real paths are within the workspace", () => {
    const { raw, real } = workspace();
    const eligible = (tool: string, args: unknown, verdict = { outcome: "allow" as const }) =>
      authorityClassifierEligible({ tool, args, workspacePath: raw, verdict });
    expect(eligible("read", { path: "/outside/file" })).toBe(false);
    expect(eligible("edit", { path: "MARKER.txt" })).toBe(false);
    expect(eligible("write", { path: real })).toBe(false);
    expect(eligible("write", { path: "/outside/file" })).toBe(true);
    expect(eligible("bash", { command: "a && b" })).toBe(true);
    expect(eligible("web_fetch", { url: "https://example.com" })).toBe(true);
    expect(eligible("edit", {})).toBe(true);
    const link = join(real, "outside");
    symlinkSync(tmpdir(), link);
    expect(eligible("edit", { path: join(link, "external.txt") })).toBe(true);
    expect(
      authorityClassifierEligible({
        tool: "bash",
        args: { command: "git reset --hard" },
        workspacePath: raw,
        verdict: { outcome: "deny", cause: "command.git-discards-work", reason: "soft" },
      }),
    ).toBe(true);
  });
});

describe("authorityVerdict", () => {
  it("does not allow a soft redirect denial to mask a hard command rule under per-call review", () => {
    const { raw } = workspace();
    for (const command of [
      "curl -k https://example.com > /tmp/review-output.txt",
      "sudo whoami > /tmp/review-output.txt",
    ]) {
      const verdict = authorityVerdict({
        tool: "bash",
        args: { command },
        authority: snapshot(),
        workspacePath: raw,
        hardDeniesFirst: true,
      });
      expect(verdict).toMatchObject({ outcome: "deny" });
      expect(
        authorityClassifierEligible({
          tool: "bash",
          args: { command },
          workspacePath: raw,
          verdict,
        }),
      ).toBe(false);
    }
  });
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

  it("lets the Session read its own saved tool output, and only while that is a real directory (VC-469)", () => {
    const { raw, real } = workspace();
    const base = join(real, "..");
    const saved = join(base, "sessions", "s.tool-output");
    const file = join(saved, "tc-1.0a1b2c3d.txt");
    const verdict = (path: string, readableRoots?: readonly string[]) =>
      authorityVerdict({
        tool: "read",
        args: { path },
        authority: snapshot(),
        workspacePath: raw,
        ...(readableRoots === undefined ? {} : { readableRoots }),
      }).outcome;

    // Not made yet: there is nothing in it to read, and it grants nothing.
    expect(verdict(file, [saved])).toBe("deny");
    mkdirSync(saved, { recursive: true });
    writeFileSync(file, "saved");
    expect(verdict(file, [saved])).toBe("allow");
    expect(verdict(file)).toBe("deny");
    // Never a write, even inside it.
    expect(
      authorityVerdict({
        tool: "write",
        args: { path: file, content: "x" },
        authority: snapshot(),
        workspacePath: raw,
        readableRoots: [saved],
      }).outcome,
    ).toBe("deny");
    // A link planted where the directory goes grants nothing, wherever it points.
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "secret.txt"), "s");
    const pointed = join(base, "sessions", "pointed.tool-output");
    symlinkSync(elsewhere, pointed);
    expect(verdict(join(pointed, "secret.txt"), [pointed])).toBe("deny");
  });

  it("follows no link out of a readable root, and grants no sibling attachment's output (VC-469)", () => {
    const { raw, real } = workspace();
    const sessions = join(real, "..", "sessions", "--ws--");
    const own = join(sessions, "own.tool-output");
    const sibling = join(sessions, "sibling.tool-output");
    for (const directory of [own, sibling]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "saved.txt"), "saved");
    }
    const secret = join(real, "..", "secret.txt");
    writeFileSync(secret, "s");
    // A link inside the root, pointing out of it: the read resolves to its target.
    symlinkSync(secret, join(own, "link.txt"));
    const verdict = (path: string) =>
      authorityVerdict({
        tool: "read",
        args: { path },
        authority: snapshot(),
        workspacePath: raw,
        readableRoots: [own],
      }).outcome;

    expect(verdict(join(own, "saved.txt"))).toBe("allow");
    expect(verdict(join(own, "link.txt"))).toBe("deny");
    expect(verdict(join(sibling, "saved.txt"))).toBe("deny");
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
  });

  it("lets an interaction tool through the gate untouched, arguments and all", () => {
    const { raw } = workspace();

    // VC-3's guarantee, at the seam that would have broken it. The gate
    // normalizes a name it has no mapping for into a call with no path, no
    // command and no environment, and every rule in the pack then reads an
    // empty list. Nothing here is special-cased for `ask_user`: it is allowed
    // because there is nothing about it to refuse.
    for (const tool of ["ask_user", "web_fetch", "web_search"]) {
      expect(
        authorityVerdict({
          tool,
          // Arguments no coding tool would survive: an absolute path outside the
          // workspace, spelled as this tool's own field. A gate that guessed at
          // an unmapped tool's arguments would refuse this; this one does not
          // read them, because it does not know what they mean.
          args: { question: "/etc/passwd", url: "/etc/passwd", query: "/etc/passwd" },
          authority: snapshot(),
          workspacePath: raw,
        }),
      ).toEqual({ outcome: "allow" });
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

describe("protection mode (VC-480)", () => {
  it("carries every violation and the command's stages only when asked to", () => {
    const { raw } = workspace();
    const args = { command: "true && echo x > /tmp/volli-protect/out && launchctl list" };
    const plain = authorityVerdict({
      tool: "bash",
      args,
      authority: snapshot(),
      workspacePath: raw,
    });
    expect(plain.outcome === "deny" && plain.violations).toBeUndefined();
    const verdict = authorityVerdict({
      tool: "bash",
      args,
      authority: snapshot(),
      workspacePath: raw,
      protection: true,
    });
    if (verdict.outcome !== "deny") throw new Error("expected a refusal");
    expect(verdict.violations?.map((violation) => violation.rule)).toEqual([
      "path.outside-workspace",
      "command.persistence",
    ]);
    expect(verdict.stages).toEqual(["true", "echo x", "launchctl list"]);
  });

  it("keeps main's readable tool-output exception in Protection without granting writes", () => {
    const { raw, real } = workspace();
    const saved = join(real, "..", "s.tool-output");
    mkdirSync(saved);
    const file = join(saved, "output.txt");
    writeFileSync(file, "output");
    for (const protection of [false, true]) {
      expect(
        authorityVerdict({
          tool: "read",
          args: { path: file },
          authority: snapshot(),
          workspacePath: raw,
          readableRoots: [saved],
          protection,
        }),
      ).toEqual({ outcome: "allow" });
    }
    const write = authorityVerdict({
      tool: "write",
      args: { path: file, content: "x" },
      authority: snapshot(),
      workspacePath: raw,
      readableRoots: [saved],
      protection: true,
    });
    expect(write).toMatchObject({
      outcome: "deny",
      violations: [
        { rule: "path.outside-workspace", scopes: [{ operation: "write", target: file }] },
      ],
    });
  });

  it("leaves a single command's stages off", () => {
    const { raw } = workspace();
    const verdict = authorityVerdict({
      tool: "write",
      args: { path: "/tmp/volli-protect/out", content: "x" },
      authority: snapshot(),
      workspacePath: raw,
      protection: true,
    });
    if (verdict.outcome !== "deny") throw new Error("expected a refusal");
    expect(verdict.stages).toBeUndefined();
    expect(verdict.violations?.[0].rule).toBe("path.outside-workspace");
  });
});

describe("describeCall", () => {
  it("shows a command as typed and a file tool as its path", () => {
    expect(describeCall("execute", { command: "git push" })).toBe("git push");
    expect(describeCall("write", { path: "/a/b" })).toBe("write  /a/b");
    expect(describeCall("edit", { file_path: "/a/c" })).toBe("edit  /a/c");
    expect(describeCall("read", { filePath: "/a/d" })).toBe("read  /a/d");
    expect(describeCall("read", {})).toBe("read");
    expect(describeCall("read", null)).toBe("read");
  });
});
