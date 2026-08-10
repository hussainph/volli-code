import { describe, expect, it } from "vite-plus/test";

import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  type AuthorityRuleId,
  type AuthoritySnapshot,
  type PolicyCommandSegment,
  type PolicyDecision,
  type PolicyToolCall,
} from "./authority";
import { evaluate } from "./authority-policy";

const WORKSPACE = "/Users/dev/code/volli";

function snapshot(overrides: Partial<AuthoritySnapshot> = {}): AuthoritySnapshot {
  return {
    mode: "auto",
    location: "worktree",
    tools: ["read", "edit", "write", "execute"],
    rulePackId: BUILTIN_RULE_PACK_ID,
    rulePackHash: BUILTIN_RULE_PACK_HASH,
    classifierModel: null,
    fallback: { consecutiveDenials: 3, sessionDenials: 15 },
    ...overrides,
  };
}

function call(overrides: Partial<PolicyToolCall> = {}): PolicyToolCall {
  return { tool: "execute", reads: [], writes: [], command: null, ...overrides };
}

function segment(
  program: string,
  args: readonly string[] = [],
  io: Partial<PolicyCommandSegment> = {},
): PolicyCommandSegment {
  return { program, args, paths: [], writes: [], env: [], ...io };
}

function exec(...segments: readonly PolicyCommandSegment[]): PolicyToolCall {
  const raw = segments.map((one) => [one.program, ...one.args].join(" ")).join(" && ");
  return call({ command: { raw, segments } });
}

function decide(
  toolCall: PolicyToolCall,
  overrides: Partial<AuthoritySnapshot> = {},
): PolicyDecision {
  return evaluate(toolCall, snapshot(overrides), { workspacePath: WORKSPACE });
}

/** The rule that refused, or "allow" — keeps the table of cases below readable. */
function ruleOf(
  toolCall: PolicyToolCall,
  overrides: Partial<AuthoritySnapshot> = {},
): AuthorityRuleId | "allow" {
  const decision = decide(toolCall, overrides);
  return decision.outcome === "allow" ? "allow" : decision.rule;
}

describe("evaluate", () => {
  it("allows a call that no rule objects to", () => {
    expect(decide(call({ tool: "read", reads: [`${WORKSPACE}/src/app.ts`] }))).toEqual({
      outcome: "allow",
    });
  });

  it("skips every command rule when the call is not process execution", () => {
    expect(ruleOf(call({ tool: "write", writes: [`${WORKSPACE}/src/app.ts`] }))).toBe("allow");
  });
});

describe("tool.not-bundled", () => {
  it("refuses a tool the Session was not given", () => {
    const decision = decide(call({ tool: "write" }), { tools: ["read"] });
    expect(decision).toMatchObject({ outcome: "deny", rule: "tool.not-bundled" });
    expect(decision.outcome === "deny" && decision.reason).toContain("read");
  });

  it("refuses a tool Volli does not offer at all", () => {
    expect(ruleOf(call({ tool: "web_search" }))).toBe("tool.not-bundled");
  });

  it("names an empty bundle rather than trailing off", () => {
    const decision = decide(call({ tool: "read" }), { tools: [] });
    expect(decision.outcome === "deny" && decision.reason).toContain("none");
  });

  it("allows a tool that is in the bundle", () => {
    expect(ruleOf(call({ tool: "read" }), { tools: ["read"] })).toBe("allow");
  });
});

describe("path.outside-workspace", () => {
  it("refuses a read above the workspace", () => {
    const decision = decide(call({ tool: "read", reads: ["/etc/passwd"] }));
    expect(decision).toMatchObject({ outcome: "deny", rule: "path.outside-workspace" });
    expect(decision.outcome === "deny" && decision.reason).toContain("/etc/passwd");
  });

  it("refuses a write to a sibling whose name merely starts with the workspace path", () => {
    expect(ruleOf(call({ tool: "write", writes: [`${WORKSPACE}-evil/secrets`] }))).toBe(
      "path.outside-workspace",
    );
  });

  it("refuses a redirect outside the workspace", () => {
    expect(ruleOf(exec(segment("echo", ["hi"], { writes: ["/tmp/out"] })))).toBe(
      "path.outside-workspace",
    );
  });

  it("does not judge command operands, which the sandbox scopes instead", () => {
    expect(ruleOf(exec(segment("ls", ["/usr/bin"], { paths: ["/usr/bin"] })))).toBe("allow");
    expect(ruleOf(exec(segment("cat", ["/etc/hosts"], { paths: ["/etc/hosts"] })))).toBe("allow");
    expect(
      ruleOf(
        exec(
          segment("/opt/homebrew/bin/node", ["script.js"], {
            paths: ["/opt/homebrew/bin/node", `${WORKSPACE}/script.js`],
          }),
        ),
      ),
    ).toBe("allow");
  });

  it("allows a redirect to a device sink", () => {
    for (const sink of [
      "/dev/null",
      "/dev/stdout",
      "/dev/stderr",
      "/dev/tty",
      "/dev/zero",
      "/dev/fd/3",
    ]) {
      expect(ruleOf(exec(segment("cmd", [], { writes: [sink] })))).toBe("allow");
    }
  });

  it("allows the workspace root itself and anything beneath it", () => {
    expect(
      ruleOf(call({ tool: "read", reads: [WORKSPACE, `${WORKSPACE}/src/deep/nested/file.ts`] })),
    ).toBe("allow");
  });

  it("ignores a trailing slash on either side", () => {
    expect(ruleOf(call({ tool: "read", reads: [`${WORKSPACE}/src/`] }))).toBe("allow");
  });
});

describe("path.git-internals", () => {
  it("refuses writing .git/config", () => {
    const decision = decide(call({ tool: "write", writes: [`${WORKSPACE}/.git/config`] }));
    expect(decision).toMatchObject({ outcome: "deny", rule: "path.git-internals" });
    expect(decision.outcome === "deny" && decision.reason).toContain("later commands");
  });

  it("refuses writing a hook", () => {
    expect(ruleOf(call({ tool: "write", writes: [`${WORKSPACE}/.git/hooks/pre-commit`] }))).toBe(
      "path.git-internals",
    );
  });

  it("refuses a redirect into a hook", () => {
    expect(
      ruleOf(exec(segment("echo", ["x"], { writes: [`${WORKSPACE}/.git/hooks/post-checkout`] }))),
    ).toBe("path.git-internals");
  });

  it("refuses writing anywhere else inside .git", () => {
    for (const path of [".git", ".git/COMMIT_EDITMSG", ".git/refs/heads/main", ".git/index"]) {
      expect(ruleOf(call({ tool: "write", writes: [`${WORKSPACE}/${path}`] }))).toBe(
        "path.git-internals",
      );
    }
  });

  it("allows reading any of it", () => {
    expect(
      ruleOf(
        call({
          tool: "read",
          reads: [`${WORKSPACE}/.git/config`, `${WORKSPACE}/.git/HEAD`],
        }),
      ),
    ).toBe("allow");
  });

  it("does not reach paths that merely start with .git", () => {
    expect(
      ruleOf(
        call({
          tool: "write",
          writes: [`${WORKSPACE}/.gitignore`, `${WORKSPACE}/.github/workflows/ci.yml`],
        }),
      ),
    ).toBe("allow");
  });

  it("refuses git config in its writing forms", () => {
    const decision = decide(
      exec(segment("git", ["config", "--local", "core.hooksPath", "../evil"])),
    );
    expect(decision).toMatchObject({ outcome: "deny", rule: "path.git-internals" });
    expect(decision.outcome === "deny" && decision.reason).toContain("--get");

    for (const flag of [
      "--add",
      "--unset",
      "--unset-all",
      "--replace-all",
      "--edit",
      "--rename-section",
      "--remove-section",
    ]) {
      expect(ruleOf(exec(segment("git", ["config", flag, "core.hooksPath"])))).toBe(
        "path.git-internals",
      );
    }
  });

  it("allows git config in its reading forms", () => {
    for (const args of [
      ["config", "--get", "core.hooksPath"],
      ["config", "--get-all", "remote.origin.url"],
      ["config", "--get-regexp", "^user\\."],
      ["config", "--list"],
      ["config", "core.hooksPath"],
    ]) {
      expect(ruleOf(exec(segment("git", args)))).toBe("allow");
    }
  });

  it("refuses hooks and config as command operands, in every case spelling", () => {
    for (const target of [
      ".git/hooks/pre-commit",
      ".GIT/hooks/pre-commit",
      ".git/HOOKS/pre-commit",
      ".git/config",
      ".GIT/CONFIG",
      ".git/hooks",
    ]) {
      const decision = decide(
        exec(
          segment("cp", ["evil.sh", target], {
            paths: [`${WORKSPACE}/evil.sh`, `${WORKSPACE}/${target}`],
          }),
        ),
      );
      expect(decision).toMatchObject({ outcome: "deny", rule: "path.git-internals" });
    }
  });

  it("refuses reading config by path, which is the accepted cost of that clause", () => {
    const decision = decide(
      exec(segment("cat", [".git/config"], { paths: [`${WORKSPACE}/.git/config`] })),
    );
    expect(decision).toMatchObject({ outcome: "deny", rule: "path.git-internals" });
    expect(decision.outcome === "deny" && decision.reason).toContain("git config --list");
  });

  it("reaches submodule plumbing, whose hooks execute the same way", () => {
    for (const target of [
      ".git/modules/sub/hooks/pre-commit",
      ".git/modules/sub/config",
      ".GIT/MODULES/sub/HOOKS/pre-commit",
      ".git/modules/outer/modules/inner/hooks/pre-push",
    ]) {
      expect(
        ruleOf(
          exec(
            segment("cp", ["evil.sh", target], {
              paths: [`${WORKSPACE}/evil.sh`, `${WORKSPACE}/${target}`],
            }),
          ),
        ),
      ).toBe("path.git-internals");
    }
  });

  it("leaves the rest of .git nameable, since git takes such operands routinely", () => {
    for (const target of [
      ".git/HEAD",
      ".git/refs/heads/main",
      ".git",
      ".git/configuration",
      ".git/modules",
      ".git/modules/sub/refs/heads/main",
    ]) {
      expect(ruleOf(exec(segment("cat", [target], { paths: [`${WORKSPACE}/${target}`] })))).toBe(
        "allow",
      );
    }
  });

  it("refuses inline config that makes git run something unlexed", () => {
    const decision = decide(exec(segment("git", ["-c", "alias.zz=!rm -rf ~", "zz"])));
    expect(decision).toMatchObject({ outcome: "deny", rule: "path.git-internals" });
    expect(decision.outcome === "deny" && decision.reason).toContain("never inspected");

    for (const args of [
      ["-c", "credential.helper=!leak", "fetch"],
      ["-c", "core.hooksPath=/elsewhere", "status"],
      ["-c", "core.HOOKSPATH=./evil", "commit"],
      ["--config-env=alias.zz=EVIL", "zz"],
      ["--config-env", "alias.zz=EVIL", "zz"],
    ]) {
      expect(ruleOf(exec(segment("git", args)))).toBe("path.git-internals");
    }
  });

  it("allows inline config that only changes how git presents itself", () => {
    for (const args of [
      ["-c", "core.pager=cat", "log"],
      ["-c", "user.name=Agent", "commit", "-m", "x"],
      ["-c", "advice.detachedHead=false", "checkout", "abc123"],
      ["-c", "novalue", "status"],
      ["-c"],
    ]) {
      expect(ruleOf(exec(segment("git", args)))).toBe("allow");
    }
  });

  it("reads git 2.46's subcommand form rather than counting its operands", () => {
    expect(ruleOf(exec(segment("git", ["config", "get", "user.name"])))).toBe("allow");
    expect(ruleOf(exec(segment("git", ["config", "list", "--show-origin"])))).toBe("allow");
    expect(ruleOf(exec(segment("git", ["config", "--global", "get", "user.name"])))).toBe("allow");

    for (const form of ["set", "unset", "edit", "remove-section", "rename-section"]) {
      expect(ruleOf(exec(segment("git", ["config", form, "core.hooksPath", "x"])))).toBe(
        "path.git-internals",
      );
    }
  });
});

describe("case folding", () => {
  it("refuses .GIT and .VOLLI, which name the real directories on macOS", () => {
    expect(ruleOf(call({ tool: "write", writes: [`${WORKSPACE}/.GIT/hooks/pre-commit`] }))).toBe(
      "path.git-internals",
    );
    expect(ruleOf(call({ tool: "write", writes: [`${WORKSPACE}/.VOLLI/state.json`] }))).toBe(
      "path.volli-internals",
    );
    expect(ruleOf(exec(segment("rm", ["-rf", ".GIT"], { paths: [`${WORKSPACE}/.GIT`] })))).toBe(
      "command.destructive-removal",
    );
  });

  it("refuses uppercase program names, which PATH resolves the same", () => {
    expect(ruleOf(exec(segment("RM", ["-rf", "/Users/dev"], { paths: ["/Users/dev"] })))).toBe(
      "command.destructive-removal",
    );
    expect(ruleOf(exec(segment("GIT", ["-C", "/Users/dev/other", "status"])))).toBe(
      "command.git-escapes-workspace",
    );
    expect(ruleOf(exec(segment("SUDO", ["ls"])))).toBe("command.platform-weakening");
    expect(ruleOf(exec(segment("CSRUTIL", ["disable"])))).toBe("command.platform-weakening");
    expect(ruleOf(exec(segment("LAUNCHCTL", ["load", "x"])))).toBe("command.persistence");
    expect(ruleOf(exec(segment("CURL", ["-k", "https://example.com"])))).toBe(
      "command.tls-weakening",
    );
  });

  it("folds git subcommands too", () => {
    expect(ruleOf(exec(segment("git", ["REBASE", "main"])), { location: "main-checkout" })).toBe(
      "command.git-discards-work",
    );
    expect(ruleOf(exec(segment("git", ["CONFIG", "SET", "core.hooksPath", "x"])))).toBe(
      "path.git-internals",
    );
  });

  it("still distinguishes genuinely different names", () => {
    expect(ruleOf(call({ tool: "write", writes: [`${WORKSPACE}/.GITIGNORE`] }))).toBe("allow");
    expect(ruleOf(exec(segment("SUDOKU", ["--solve"])))).toBe("allow");
  });

  it("does not fold workspace containment, where folding would under-deny", () => {
    // A case-variant sibling of the workspace is a different directory on a
    // case-sensitive volume, and must not be mistaken for the workspace itself.
    expect(ruleOf(call({ tool: "read", reads: [`${WORKSPACE.toUpperCase()}/secret`] }))).toBe(
      "path.outside-workspace",
    );
    expect(
      ruleOf(exec(segment("echo", ["x"], { writes: [`${WORKSPACE.toUpperCase()}/out`] }))),
    ).toBe("path.outside-workspace");
    expect(
      ruleOf(exec(segment("rm", ["-rf", "x"], { paths: [`${WORKSPACE.toUpperCase()}/build`] }))),
    ).toBe("command.destructive-removal");
    expect(ruleOf(exec(segment("git", ["-C", `${WORKSPACE.toUpperCase()}/sub`, "status"])))).toBe(
      "command.git-escapes-workspace",
    );
  });
});

describe("path.volli-internals", () => {
  it("refuses a write under .volli", () => {
    expect(
      ruleOf(call({ tool: "write", writes: [`${WORKSPACE}/.volli/artifacts/notes.md`] })),
    ).toBe("path.volli-internals");
  });

  it("allows reading it", () => {
    expect(ruleOf(call({ tool: "read", reads: [`${WORKSPACE}/.volli/artifacts/notes.md`] }))).toBe(
      "allow",
    );
  });

  it("does not confuse .vollibration with .volli", () => {
    expect(ruleOf(call({ tool: "write", writes: [`${WORKSPACE}/.vollibration/x`] }))).toBe("allow");
  });
});

describe("deleted rules", () => {
  it("allows writing dotfiles inside the workspace, which are project files here", () => {
    for (const name of [
      ".zshrc",
      ".zprofile",
      ".zshenv",
      ".bashrc",
      ".bash_profile",
      ".profile",
      ".config/fish/config.fish",
    ]) {
      expect(ruleOf(exec(segment("echo", ["x"], { writes: [`${WORKSPACE}/${name}`] })))).toBe(
        "allow",
      );
    }
  });

  it("allows writing a launch directory inside the workspace", () => {
    expect(
      ruleOf(
        exec(
          segment("cp", ["a", "b"], {
            writes: [`${WORKSPACE}/Library/LaunchAgents/com.example.plist`],
          }),
        ),
      ),
    ).toBe("allow");
  });

  it("still refuses the same paths in the home directory, via path.outside-workspace", () => {
    expect(ruleOf(exec(segment("echo", ["x"], { writes: ["/Users/dev/.zshrc"] })))).toBe(
      "path.outside-workspace",
    );
    expect(
      ruleOf(
        exec(segment("cp", ["a", "b"], { writes: ["/Users/dev/Library/LaunchAgents/x.plist"] })),
      ),
    ).toBe("path.outside-workspace");
  });
});

describe("command.tls-weakening", () => {
  it("refuses curl --insecure", () => {
    const decision = decide(exec(segment("curl", ["--insecure", "https://example.com"])));
    expect(decision).toMatchObject({ outcome: "deny", rule: "command.tls-weakening" });
    expect(decision.outcome === "deny" && decision.reason).toContain("certificate verification");
  });

  it("refuses curl -k, bundled with other short flags", () => {
    expect(ruleOf(exec(segment("curl", ["-sk", "https://example.com"])))).toBe(
      "command.tls-weakening",
    );
  });

  it("allows curl without it", () => {
    expect(ruleOf(exec(segment("curl", ["-s", "https://example.com"])))).toBe("allow");
  });

  it("refuses wget --no-check-certificate", () => {
    expect(ruleOf(exec(segment("wget", ["--no-check-certificate", "https://example.com"])))).toBe(
      "command.tls-weakening",
    );
  });

  it("allows wget without it", () => {
    expect(ruleOf(exec(segment("wget", ["https://example.com"])))).toBe("allow");
  });

  it("refuses git -c http.sslVerify=false whatever the casing or falsy spelling", () => {
    expect(ruleOf(exec(segment("git", ["-c", "http.sslVerify=false", "fetch"])))).toBe(
      "command.tls-weakening",
    );
    expect(ruleOf(exec(segment("git", ["-c", "http.sslverify=0", "fetch"])))).toBe(
      "command.tls-weakening",
    );
  });

  it("allows git -c http.sslVerify=true", () => {
    expect(ruleOf(exec(segment("git", ["-c", "http.sslVerify=true", "fetch"])))).toBe("allow");
  });

  it("refuses npm config set strict-ssl false", () => {
    expect(ruleOf(exec(segment("npm", ["config", "set", "strict-ssl", "false"])))).toBe(
      "command.tls-weakening",
    );
  });

  it("allows npm config set strict-ssl true", () => {
    expect(ruleOf(exec(segment("npm", ["config", "set", "strict-ssl", "true"])))).toBe("allow");
  });

  it("refuses the environment spellings", () => {
    for (const entry of [
      "NODE_TLS_REJECT_UNAUTHORIZED=0",
      "GIT_SSL_NO_VERIFY=1",
      "PYTHONHTTPSVERIFY=0",
    ]) {
      expect(ruleOf(exec(segment("node", ["build.js"], { env: [entry] })))).toBe(
        "command.tls-weakening",
      );
    }
  });

  it("allows an environment prefix that leaves verification on", () => {
    expect(
      ruleOf(exec(segment("node", ["build.js"], { env: ["NODE_TLS_REJECT_UNAUTHORIZED=1"] }))),
    ).toBe("allow");
  });
});

describe("command.persistence", () => {
  it("refuses each scheduling program", () => {
    for (const program of ["launchctl", "crontab", "systemctl", "at"]) {
      expect(ruleOf(exec(segment(program, ["load", "x"])))).toBe("command.persistence");
    }
  });

  it("sees through an absolute program path", () => {
    expect(ruleOf(exec(segment("/bin/launchctl", ["load", "x"])))).toBe("command.persistence");
  });

  it("names the program in the reason", () => {
    const decision = decide(exec(segment("crontab", ["-e"])));
    expect(decision).toMatchObject({ outcome: "deny", rule: "command.persistence" });
    expect(decision.outcome === "deny" && decision.reason).toContain("crontab");
  });

  it("allows a program whose name merely contains one", () => {
    expect(ruleOf(exec(segment("attach", ["--to", "x"])))).toBe("allow");
  });
});

describe("command.platform-weakening", () => {
  it("refuses each platform program", () => {
    for (const program of ["csrutil", "spctl", "nvram", "dscl", "sudo", "doas"]) {
      expect(ruleOf(exec(segment(program, ["status"])))).toBe("command.platform-weakening");
    }
  });

  it("sees through an absolute program path", () => {
    expect(ruleOf(exec(segment("/usr/bin/sudo", ["ls"])))).toBe("command.platform-weakening");
  });

  it("allows a program whose name merely contains one", () => {
    expect(ruleOf(exec(segment("sudoku", ["--solve"])))).toBe("allow");
  });
});

describe("command.destructive-removal", () => {
  it("refuses recursive removal of the workspace root itself", () => {
    const decision = decide(exec(segment("rm", ["-rf", "."], { paths: [WORKSPACE] })));
    expect(decision).toMatchObject({ outcome: "deny", rule: "command.destructive-removal" });
    expect(decision.outcome === "deny" && decision.reason).toContain(WORKSPACE);
  });

  it("handles every spelling of the recursive flag", () => {
    for (const flag of ["-r", "-R", "--recursive", "-fr", "-rdf"]) {
      expect(ruleOf(exec(segment("rm", [flag, "."], { paths: [WORKSPACE] })))).toBe(
        "command.destructive-removal",
      );
    }
  });

  it("allows recursive removal of a directory inside the workspace", () => {
    expect(ruleOf(exec(segment("rm", ["-rf", "./build"], { paths: [`${WORKSPACE}/build`] })))).toBe(
      "allow",
    );
  });

  it("allows a non-recursive removal of the workspace root", () => {
    expect(ruleOf(exec(segment("rm", ["-f", "."], { paths: [WORKSPACE] })))).toBe("allow");
  });

  it("refuses removing .git or .volli, recursive flag or not", () => {
    const decision = decide(
      exec(segment("rm", [".git/index"], { paths: [`${WORKSPACE}/.git/index`] })),
    );
    expect(decision).toMatchObject({ outcome: "deny", rule: "command.destructive-removal" });
    expect(decision.outcome === "deny" && decision.reason).toContain(".volli");

    for (const dir of [".git", ".volli"]) {
      expect(ruleOf(exec(segment("rm", ["-rf", dir], { paths: [`${WORKSPACE}/${dir}`] })))).toBe(
        "command.destructive-removal",
      );
      expect(ruleOf(exec(segment("rm", [dir], { paths: [`${WORKSPACE}/${dir}/x`] })))).toBe(
        "command.destructive-removal",
      );
    }
  });

  it("allows removing a path that merely starts with .git or .volli", () => {
    expect(
      ruleOf(exec(segment("rm", [".gitignore"], { paths: [`${WORKSPACE}/.gitignore`] }))),
    ).toBe("allow");
    expect(
      ruleOf(
        exec(segment("rm", ["-rf", ".vollibration"], { paths: [`${WORKSPACE}/.vollibration`] })),
      ),
    ).toBe("allow");
  });

  it("ignores programs that are not rm", () => {
    expect(ruleOf(exec(segment("rsync", ["-r", "."], { paths: [WORKSPACE] })))).toBe("allow");
  });

  it("owns the operands path.outside-workspace no longer judges", () => {
    expect(ruleOf(exec(segment("rm", ["-rf", "/"], { paths: ["/"] })))).toBe(
      "command.destructive-removal",
    );
    expect(
      ruleOf(exec(segment("rm", ["-rf", "/usr/local/lib"], { paths: ["/usr/local/lib"] }))),
    ).toBe("command.destructive-removal");
  });
});

describe("command.git-escapes-workspace", () => {
  it("refuses -C pointing at another tree", () => {
    const decision = decide(exec(segment("git", ["-C", "/Users/dev/other", "status"])));
    expect(decision).toMatchObject({ outcome: "deny", rule: "command.git-escapes-workspace" });
    expect(decision.outcome === "deny" && decision.reason).toContain("-C /Users/dev/other");
  });

  it("refuses -C climbing out with a relative path", () => {
    expect(ruleOf(exec(segment("git", ["-C", "../other", "status"])))).toBe(
      "command.git-escapes-workspace",
    );
  });

  it("allows -C into a subdirectory", () => {
    expect(ruleOf(exec(segment("git", ["-C", "packages/shared", "status"])))).toBe("allow");
    expect(ruleOf(exec(segment("git", ["-C", `${WORKSPACE}/packages`, "status"])))).toBe("allow");
  });

  it("allows a trailing -C with no value", () => {
    expect(ruleOf(exec(segment("git", ["-C"])))).toBe("allow");
  });

  it("refuses --git-dir and --work-tree aimed elsewhere, in either spelling", () => {
    expect(ruleOf(exec(segment("git", ["--git-dir=/Users/dev/other/.git", "log"])))).toBe(
      "command.git-escapes-workspace",
    );
    expect(ruleOf(exec(segment("git", ["--work-tree=../other", "status"])))).toBe(
      "command.git-escapes-workspace",
    );
    expect(
      ruleOf(
        exec(
          segment("git", [
            "--git-dir",
            "/Users/dev/other/.git",
            "--work-tree",
            "/Users/dev/other",
            "status",
          ]),
        ),
      ),
    ).toBe("command.git-escapes-workspace");
    expect(ruleOf(exec(segment("git", ["--work-tree", "../other", "status"])))).toBe(
      "command.git-escapes-workspace",
    );
  });

  it("refuses --exec-path, which relocates the helpers git runs", () => {
    expect(ruleOf(exec(segment("git", ["--exec-path=/tmp/evil", "status"])))).toBe(
      "command.git-escapes-workspace",
    );
    expect(ruleOf(exec(segment("git", ["--exec-path", "/tmp/evil", "status"])))).toBe(
      "command.git-escapes-workspace",
    );
  });

  it("allows those flags pointing at this tree", () => {
    expect(ruleOf(exec(segment("git", ["--git-dir=.git", "log"])))).toBe("allow");
    expect(ruleOf(exec(segment("git", ["--git-dir", ".git", "log"])))).toBe("allow");
  });

  it("allows an unrelated flag carrying a value that looks like a path", () => {
    expect(ruleOf(exec(segment("git", ["--namespace=/tmp/ns", "status"])))).toBe("allow");
  });

  it("refuses worktree, clone, submodule and init landing outside", () => {
    expect(ruleOf(exec(segment("git", ["worktree", "add", "../other"])))).toBe(
      "command.git-escapes-workspace",
    );
    expect(ruleOf(exec(segment("git", ["clone", "https://example.com/x", "/tmp/x"])))).toBe(
      "command.git-escapes-workspace",
    );
    expect(
      ruleOf(exec(segment("git", ["submodule", "add", "https://example.com/x", "../vendor"]))),
    ).toBe("command.git-escapes-workspace");
    expect(ruleOf(exec(segment("git", ["init", "/elsewhere/newrepo"])))).toBe(
      "command.git-escapes-workspace",
    );
  });

  it("allows those subcommands when everything lands inside", () => {
    expect(ruleOf(exec(segment("git", ["submodule", "update", "--init"])))).toBe("allow");
    expect(ruleOf(exec(segment("git", ["clone", "https://example.com/x", "vendor/x"])))).toBe(
      "allow",
    );
    expect(ruleOf(exec(segment("git", ["init"])))).toBe("allow");
  });

  it("allows an ordinary subcommand, and git with no subcommand at all", () => {
    expect(ruleOf(exec(segment("git", ["--no-pager", "status"])))).toBe("allow");
    expect(ruleOf(exec(segment("git")))).toBe("allow");
  });

  it("ignores programs that are not git", () => {
    expect(ruleOf(exec(segment("gitk", ["--all"])))).toBe("allow");
  });
});

describe("command.git-discards-work", () => {
  const MAIN = { location: "main-checkout" } as const;

  it("refuses git reset --hard in a main checkout", () => {
    const decision = decide(exec(segment("git", ["reset", "--hard"])), MAIN);
    expect(decision).toMatchObject({ outcome: "deny", rule: "command.git-discards-work" });
    expect(decision.outcome === "deny" && decision.reason).toContain("main checkout");
  });

  it("allows the same command in a worktree, which is disposable", () => {
    expect(ruleOf(exec(segment("git", ["reset", "--hard"])))).toBe("allow");
  });

  it("refuses the other resets that can clobber the tree", () => {
    for (const flag of ["--keep", "--merge"]) {
      expect(ruleOf(exec(segment("git", ["reset", flag, "HEAD~1"])), MAIN)).toBe(
        "command.git-discards-work",
      );
    }
  });

  it("allows a reset that keeps the work", () => {
    expect(ruleOf(exec(segment("git", ["reset", "--soft", "HEAD~1"])), MAIN)).toBe("allow");
    expect(ruleOf(exec(segment("git", ["reset", "HEAD~1"])), MAIN)).toBe("allow");
  });

  it("refuses discarding the working tree with checkout", () => {
    for (const args of [
      ["checkout", "--", "."],
      ["checkout", "."],
      ["checkout", "--", "src/"],
      ["checkout", "HEAD", "--", "."],
      ["checkout", "-f", "main"],
      ["checkout", "--force", "main"],
    ]) {
      expect(ruleOf(exec(segment("git", args)), MAIN)).toBe("command.git-discards-work");
    }
  });

  it("allows switching branches with checkout", () => {
    expect(ruleOf(exec(segment("git", ["checkout", "main"])), MAIN)).toBe("allow");
    expect(ruleOf(exec(segment("git", ["checkout", "-b", "feature/x"])), MAIN)).toBe("allow");
    expect(ruleOf(exec(segment("git", ["checkout", "--"])), MAIN)).toBe("allow");
  });

  it("refuses restoring the working tree", () => {
    for (const args of [
      ["restore", "."],
      ["restore", "--worktree", "src/app.ts"],
      ["restore", "-W", "src/app.ts"],
      ["restore", "--staged", "--worktree", "src/app.ts"],
    ]) {
      expect(ruleOf(exec(segment("git", args)), MAIN)).toBe("command.git-discards-work");
    }
  });

  it("allows a restore that only unstages", () => {
    expect(ruleOf(exec(segment("git", ["restore", "--staged", "src/app.ts"])), MAIN)).toBe("allow");
    expect(ruleOf(exec(segment("git", ["restore", "-S", "src/app.ts"])), MAIN)).toBe("allow");
  });

  it("refuses a switch that discards changes", () => {
    expect(ruleOf(exec(segment("git", ["switch", "--discard-changes", "main"])), MAIN)).toBe(
      "command.git-discards-work",
    );
    expect(ruleOf(exec(segment("git", ["switch", "-f", "main"])), MAIN)).toBe(
      "command.git-discards-work",
    );
  });

  it("allows an ordinary switch", () => {
    expect(ruleOf(exec(segment("git", ["switch", "main"])), MAIN)).toBe("allow");
  });

  it("refuses a forced clean, with or without -d", () => {
    expect(ruleOf(exec(segment("git", ["clean", "-fd"])), MAIN)).toBe("command.git-discards-work");
    expect(ruleOf(exec(segment("git", ["clean", "-f"])), MAIN)).toBe("command.git-discards-work");
    expect(ruleOf(exec(segment("git", ["clean", "--force"])), MAIN)).toBe(
      "command.git-discards-work",
    );
  });

  it("allows a clean that cannot delete anything without force", () => {
    expect(ruleOf(exec(segment("git", ["clean", "-dn"])), MAIN)).toBe("allow");
  });

  it("refuses dropping and clearing the stash", () => {
    expect(ruleOf(exec(segment("git", ["stash", "drop"])), MAIN)).toBe("command.git-discards-work");
    expect(ruleOf(exec(segment("git", ["stash", "clear"])), MAIN)).toBe(
      "command.git-discards-work",
    );
  });

  it("allows pushing to the stash", () => {
    expect(ruleOf(exec(segment("git", ["stash", "push"])), MAIN)).toBe("allow");
  });

  it("refuses starting a rebase, and amending", () => {
    expect(ruleOf(exec(segment("git", ["rebase", "main"])), MAIN)).toBe(
      "command.git-discards-work",
    );
    expect(ruleOf(exec(segment("git", ["rebase"])), MAIN)).toBe("command.git-discards-work");
    expect(ruleOf(exec(segment("git", ["commit", "--amend", "--no-edit"])), MAIN)).toBe(
      "command.git-discards-work",
    );
  });

  it("allows finishing a rebase already in flight", () => {
    for (const flag of ["--abort", "--continue", "--skip", "--quit"]) {
      expect(ruleOf(exec(segment("git", ["rebase", flag])), MAIN)).toBe("allow");
    }
  });

  it("allows an ordinary commit", () => {
    expect(ruleOf(exec(segment("git", ["commit", "-m", "wip"])), MAIN)).toBe("allow");
  });

  it("allows a git invocation with no subcommand, and programs that are not git", () => {
    expect(ruleOf(exec(segment("git", ["--version"])), MAIN)).toBe("allow");
    expect(ruleOf(exec(segment("hub", ["reset", "--hard"])), MAIN)).toBe("allow");
  });

  it("allows a read-only subcommand", () => {
    expect(ruleOf(exec(segment("git", ["status"])), MAIN)).toBe("allow");
  });
});

describe("rule order", () => {
  it("cites the earliest rule when several would fire", () => {
    const gitInternalsAndVolli = call({
      tool: "write",
      writes: [`${WORKSPACE}/.volli/state.json`, `${WORKSPACE}/.git/config`],
    });
    expect(ruleOf(gitInternalsAndVolli)).toBe("path.git-internals");

    const unbundledAndOutside = call({ tool: "write", reads: ["/etc/passwd"] });
    expect(ruleOf(unbundledAndOutside, { tools: ["read"] })).toBe("tool.not-bundled");
  });

  it("checks every segment of a chain, not just the first", () => {
    expect(ruleOf(exec(segment("ls"), segment("echo", ["x"], { writes: ["/tmp/out"] })))).toBe(
      "path.outside-workspace",
    );
    expect(ruleOf(exec(segment("ls"), segment("rm", ["-rf", "/"], { paths: ["/"] })))).toBe(
      "command.destructive-removal",
    );
    expect(ruleOf(exec(segment("ls"), segment("launchctl", ["load", "x"])))).toBe(
      "command.persistence",
    );
    expect(ruleOf(exec(segment("ls"), segment("git", ["-C", "/elsewhere", "log"])))).toBe(
      "command.git-escapes-workspace",
    );
    expect(
      ruleOf(exec(segment("ls"), segment("git", ["rebase", "main"])), {
        location: "main-checkout",
      }),
    ).toBe("command.git-discards-work");
    expect(ruleOf(exec(segment("ls"), segment("curl", ["-k", "https://example.com"])))).toBe(
      "command.tls-weakening",
    );
    expect(
      ruleOf(exec(segment("ls"), segment("git", ["config", "--unset", "core.hooksPath"]))),
    ).toBe("path.git-internals");
    expect(ruleOf(exec(segment("ls"), segment("csrutil", ["disable"])))).toBe(
      "command.platform-weakening",
    );
  });

  it("allows a harmless chain end to end", () => {
    expect(
      ruleOf(
        exec(
          segment("/opt/homebrew/bin/pnpm", ["install"], { paths: ["/opt/homebrew/bin/pnpm"] }),
          segment("pnpm", ["test"], {
            paths: [`${WORKSPACE}/packages/shared`],
            writes: ["/dev/null"],
          }),
        ),
      ),
    ).toBe("allow");
  });
});
