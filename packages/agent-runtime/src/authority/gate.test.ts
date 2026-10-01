import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  isOverridableAuthorityRule,
  type AuthoritySnapshot,
  type CodingToolId,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { resolveCapabilityPolicy } from "./capability";
import { authorityVerdict } from "./gate";

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
    containment: "off",
    writableRoots: [],
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

  it("reads machine-wide off the denylist, a sibling of the workspace included (VC-45)", () => {
    const { raw, real } = workspace();
    writeFileSync(join(real, "..", "SIBLING.txt"), "x");
    for (const path of ["../SIBLING.txt", "/etc/hosts"]) {
      expect(
        authorityVerdict({
          tool: "read",
          args: { path },
          authority: snapshot(),
          workspacePath: raw,
        }),
      ).toEqual({ outcome: "allow" });
    }
  });

  it("refuses the denylist even for a caller that resolved no policy", () => {
    const { raw } = workspace();
    const verdict = authorityVerdict({
      tool: "read",
      args: { path: join(homedir(), ".ssh", "id_ed25519") },
      authority: snapshot(),
      workspacePath: raw,
    });
    expect(verdict).toMatchObject({ outcome: "deny", cause: "path.credentials" });
    // The same path as a shell operand: one answer, whichever tool asks.
    expect(
      authorityVerdict({
        tool: "bash",
        args: { command: "cat ~/.ssh/id_ed25519" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toMatchObject({ outcome: "deny", cause: "path.credentials" });
  });

  it("lets the Session read its own saved tool output, and no other Session's (VC-469, VC-45)", () => {
    const { raw, real } = workspace();
    const sessions = join(real, "..", "sessions");
    const own = join(sessions, "--ws--", "own.tool-output");
    const sibling = join(sessions, "--ws--", "sibling.tool-output");
    for (const directory of [own, sibling]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "saved.txt"), "saved");
    }
    // A link inside the own root pointing into a sibling's: the read resolves to its target.
    symlinkSync(join(sibling, "saved.txt"), join(own, "link.txt"));
    // A link planted where a grant goes grants nothing, wherever it points.
    const pointed = join(sessions, "--ws--", "pointed.tool-output");
    symlinkSync(sibling, pointed);
    const capability = resolveCapabilityPolicy({
      workspacePath: raw,
      privateRoots: [sessions],
      grants: [own, pointed],
      sandboxCarveOuts: false,
    });
    const verdict = (tool: string, path: string) =>
      authorityVerdict({
        tool,
        args: { path, content: "x" },
        authority: snapshot(),
        workspacePath: raw,
        capability,
      });

    expect(verdict("read", join(own, "saved.txt"))).toEqual({ outcome: "allow" });
    expect(verdict("read", join(sibling, "saved.txt"))).toMatchObject({ cause: "path.private" });
    expect(verdict("read", join(own, "link.txt"))).toMatchObject({ cause: "path.private" });
    expect(verdict("read", join(pointed, "saved.txt"))).toMatchObject({ cause: "path.private" });
    // Never a write, even inside its own: a change to the host's data is no
    // private read, and no approval reaches it.
    expect(verdict("write", join(own, "saved.txt"))).toMatchObject({ cause: "path.host-data" });
  });

  it("never lets an approval change Volli's own data, while a read of it stays approvable (VC-480)", () => {
    const { raw, real } = workspace();
    const userData = join(real, "..", "userData");
    mkdirSync(userData);
    writeFileSync(join(userData, "volli.db"), "db");
    for (const declared of [[], [userData]]) {
      // A project that declared userData itself writable has declared nothing.
      const capability = resolveCapabilityPolicy({
        workspacePath: raw,
        writableRoots: declared,
        privateRoots: [userData],
        sandboxCarveOuts: false,
      });
      const judged = (tool: string, args: Record<string, unknown>) =>
        authorityVerdict({ tool, args, authority: snapshot(), workspacePath: raw, capability });
      const db = join(userData, "volli.db");
      for (const [tool, args] of [
        ["write", { path: db, content: "x" }],
        ["edit", { path: join(userData, "approvals.json"), edits: [] }],
        ["bash", { command: `sqlite3 ${db} "delete from approvals"` }],
        ["bash", { command: `printf x >> ${db}-wal` }],
        ["bash", { command: `cp evil.db ${db}` }],
      ] as const) {
        expect(judged(tool, args), `${tool} ${JSON.stringify(args)}`).toMatchObject({
          outcome: "deny",
          cause: "path.host-data",
        });
      }
      expect(judged("read", { path: db })).toMatchObject({ cause: "path.private" });
      expect(judged("bash", { command: `cat ${db}` })).toMatchObject({ cause: "path.private" });
    }
    expect(isOverridableAuthorityRule("path.host-data")).toBe(false);
    expect(isOverridableAuthorityRule("path.private")).toBe(true);
  });

  /**
   * The escalation smoke's trip, re-aimed (VC-45). It used to commit symlinks
   * aimed at ordinary files outside the tree, which `path.outside-workspace`
   * refused as reads; slice 1 makes those reads ordinary. Aimed at the host's
   * own credential file instead, every one is still refused — by
   * `path.credentials`, which no answer overrules, so no model decision and
   * no person's "yes" can reset the streak the smoke counts on.
   */
  it("refuses a symlink in the tree that points at the host's credential file, beyond any override", () => {
    const { raw, real } = workspace();
    const userData = join(real, "..", "userData");
    mkdirSync(userData);
    const credentials = join(userData, "mcp-credentials.json");
    writeFileSync(credentials, "probe");
    symlinkSync(credentials, join(real, "probe-1.txt"));
    const verdict = authorityVerdict({
      tool: "read",
      args: { path: "probe-1.txt" },
      authority: snapshot(),
      workspacePath: raw,
      capability: resolveCapabilityPolicy({
        workspacePath: raw,
        privateRoots: [userData],
        credentialPaths: [credentials],
        sandboxCarveOuts: false,
      }),
    });
    expect(verdict).toMatchObject({ outcome: "deny", cause: "path.credentials" });
    expect(isOverridableAuthorityRule("path.credentials")).toBe(false);
  });

  it("follows a link in a shell operand before the .. after it, as the kernel will (VC-45 review, B1)", () => {
    const { raw, real } = workspace();
    const home = join(real, "..", "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(home, "Library", "Caches"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    symlinkSync(join(home, "Library", "Caches"), join(real, "s"));
    const capability = resolveCapabilityPolicy({
      workspacePath: raw,
      home,
      sandboxCarveOuts: false,
    });
    // Lexically `<ws>/../.ssh/id_ed25519`, nothing denied; through `s`, the key.
    expect(
      authorityVerdict({
        tool: "bash",
        args: { command: "cat s/../../.ssh/id_ed25519" },
        authority: snapshot(),
        workspacePath: raw,
        capability,
      }),
    ).toMatchObject({ outcome: "deny", cause: "path.credentials" });
  });

  it("names a hard link by the credential it is another name for (VC-45 review, B1)", () => {
    const { raw, real } = workspace();
    const home = join(real, "..", "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    linkSync(join(home, ".ssh", "id_ed25519"), join(real, "innocent.txt"));
    const capability = resolveCapabilityPolicy({
      workspacePath: raw,
      home,
      sandboxCarveOuts: false,
    });
    for (const [tool, args] of [
      ["read", { path: "innocent.txt" }],
      ["bash", { command: "cat innocent.txt" }],
    ] as const) {
      expect(
        authorityVerdict({ tool, args, authority: snapshot(), workspacePath: raw, capability }),
      ).toMatchObject({ outcome: "deny", cause: "path.credentials" });
    }
  });

  it("marks an overridable refusal the Session's own walls repeat, so nobody is asked a moot question", () => {
    const { raw } = workspace();
    const capability = resolveCapabilityPolicy({ workspacePath: raw, sandboxCarveOuts: true });
    const outside = (contained: boolean) =>
      authorityVerdict({
        tool: "write",
        args: { path: "../outside.txt", content: "x" },
        authority: snapshot(),
        workspacePath: raw,
        capability,
        contained,
      });
    expect(outside(true)).toMatchObject({ cause: "path.outside-workspace", walled: true });
    expect(outside(false)).not.toHaveProperty("walled");
    // A shell redirect the walls refuse is marked the same way.
    expect(
      authorityVerdict({
        tool: "bash",
        args: { command: "printf x > ../outside.txt" },
        authority: snapshot(),
        workspacePath: raw,
        capability,
        contained: true,
      }),
    ).toMatchObject({ cause: "path.outside-workspace", walled: true });
    // A private read is overridable, and the walls refuse it too: walled. A
    // recursive read ABOVE it is not — the kernel refuses only the private
    // entries, so the rest of the read would go ahead on a "yes".
    const host = join(raw, "..", "host");
    mkdirSync(join(host, "userData"), { recursive: true });
    writeFileSync(join(host, "userData", "volli.db"), "");
    const withHost = resolveCapabilityPolicy({
      workspacePath: raw,
      privateRoots: [join(host, "userData")],
      sandboxCarveOuts: true,
    });
    const contained = (command: string) =>
      authorityVerdict({
        tool: "bash",
        args: { command },
        authority: snapshot(),
        workspacePath: raw,
        capability: withHost,
        contained: true,
      });
    expect(contained(`cat ${join(host, "userData", "volli.db")}`)).toMatchObject({
      cause: "path.private",
      walled: true,
    });
    expect(contained(`grep -r token ${host}`)).toMatchObject({ cause: "path.private" });
    expect(contained(`grep -r token ${host}`)).not.toHaveProperty("walled");
    // A refusal the walls do NOT repeat stays a question: git writes .git/info
    // freely, and only the rule pack objects to a file tool doing it.
    expect(
      authorityVerdict({
        tool: "write",
        args: { path: ".git/info/exclude", content: "x" },
        authority: snapshot(),
        workspacePath: raw,
        capability,
        contained: true,
      }),
    ).not.toHaveProperty("walled");
    // A rule nobody may overrule needs no mark, even over a path the walls refuse.
    expect(
      authorityVerdict({
        tool: "bash",
        args: { command: "cat ~/.ssh/config" },
        authority: snapshot(),
        workspacePath: raw,
        capability,
        contained: true,
      }),
    ).not.toHaveProperty("walled");
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
        tool: "write",
        args: { path: "../SECRET.txt", content: "x" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toEqual({
      outcome: "deny",
      cause: "path.outside-workspace",
      reason: `${join(real, "../SECRET.txt")} is outside this Session's writable roots (${real}); every write must land inside one of them. Reading anywhere else is fine.`,
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
      // A shell profile is a secret since VC-45 — it is where tokens are
      // exported — so the denylist answers before the writable roots do.
      expect(verdict).toMatchObject({ cause: "path.private" });
      if (verdict.outcome === "deny") {
        expect(verdict.reason).toContain("needs the user's approval");
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
