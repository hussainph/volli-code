import { describe, expect, it } from "vite-plus/test";
import { doctorSummary, runDoctorChecks } from "./doctor";
import type { DoctorCheck, DoctorFacts, DoctorObservation } from "./doctor";

const BIN = "/ud/bin";

function observation(overrides: Partial<DoctorObservation> = {}): DoctorObservation {
  return {
    pathEntries: [BIN, "/usr/bin", "/bin"],
    sessionId: "s-1",
    zdotDir: "/ud/shell/zsh",
    resolved: { claude: `${BIN}/claude` },
    volliPath: `${BIN}/volli`,
    ...overrides,
  };
}

function facts(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    binDir: BIN,
    wrappers: { claude: `${BIN}/claude` },
    refused: [],
    shellInitDir: "/ud/shell/zsh",
    shellInitPresent: true,
    shimPath: `${BIN}/volli`,
    liveSessionIds: ["s-1"],
    reporting: [{ harnessId: "claude-code", declared: 8, verified: 8 }],
    skillConflicts: [],
    ...overrides,
  };
}

function find(checks: DoctorCheck[], id: string): DoctorCheck {
  const check = checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check;
}

describe("runDoctorChecks — PATH position", () => {
  it("passes only when the bin dir is actually first", () => {
    expect(find(runDoctorChecks(observation(), facts()), "path-position").status).toBe("ok");
  });

  // The exact outage this command exists for: membership held the whole time.
  it("fails on membership without primacy, and says what is shadowing it", () => {
    const entries = ["/opt/homebrew/bin", "/usr/local/bin", BIN];
    const check = find(
      runDoctorChecks(observation({ pathEntries: entries }), facts()),
      "path-position",
    );

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("position 3 of 3");
    expect(check.detail).toContain("/opt/homebrew/bin");
  });

  it("uses singular wording when exactly one entry shadows it", () => {
    const check = find(
      runDoctorChecks(observation({ pathEntries: ["/usr/bin", BIN] }), facts()),
      "path-position",
    );
    expect(check.detail).toContain("1 entry shadows it");
  });

  it("fails when the bin dir is absent entirely", () => {
    const check = find(
      runDoctorChecks(observation({ pathEntries: ["/usr/bin"] }), facts()),
      "path-position",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not on PATH at all");
  });
});

describe("runDoctorChecks — resolution", () => {
  it("passes when the harness name reaches the wrapper", () => {
    expect(find(runDoctorChecks(observation(), facts()), "resolves-claude").status).toBe("ok");
  });

  // Configuration can be perfect while this is wrong — that is the whole point.
  it("fails when the name reaches the user's own install instead", () => {
    const check = find(
      runDoctorChecks(observation({ resolved: { claude: "/Users/x/.local/bin/claude" } }), facts()),
      "resolves-claude",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("/Users/x/.local/bin/claude");
    expect(check.detail).toContain("reports no events");
  });

  it("warns rather than failing when the command resolves nowhere", () => {
    const check = find(
      runDoctorChecks(observation({ resolved: { claude: null } }), facts()),
      "resolves-claude",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("resolves to nothing");
  });

  // A wrapper nobody tried to resolve. Reporting it as resolving to nothing is
  // the diagnostic inventing a negative about a harness that may work fine.
  it("says so when no resolution was reported, rather than calling it absent", () => {
    const check = find(runDoctorChecks(observation({ resolved: {} }), facts()), "resolves-claude");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("no resolution was reported");
    expect(check.detail).not.toContain("resolves to nothing");
  });
});

describe("runDoctorChecks — shell integration", () => {
  it("fails when this shell's ZDOTDIR is not the generated one", () => {
    const check = find(runDoctorChecks(observation({ zdotDir: null }), facts()), "shell-init");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("unset");
  });

  it("fails when the chain was never written", () => {
    const check = find(
      runDoctorChecks(observation(), facts({ shellInitPresent: false })),
      "shell-init",
    );
    expect(check.status).toBe("fail");
  });

  // "unset" is a measurement. Saying it about a field that never arrived is
  // the diagnostic asserting a fact nobody established.
  it("distinguishes an unreported ZDOTDIR from one that is genuinely unset", () => {
    const check = find(runDoctorChecks(observation({ zdotDir: undefined }), facts()), "shell-init");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("was not reported");
    expect(check.detail).not.toContain("unset");
  });

  // bash and fish: a real, permanent, partial state — not a failure.
  it("warns for a shell with no post-startup hook", () => {
    const check = find(runDoctorChecks(observation(), facts({ shellInitDir: null })), "shell-init");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("only Volli-started agents are wrapped");
  });
});

describe("runDoctorChecks — session", () => {
  it("is content outside a session, and says the other checks are shell-local", () => {
    const check = find(runDoctorChecks(observation({ sessionId: null }), facts()), "session");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("not in a Volli session");
  });

  // An environment that outlived its session — the tmux/daemon leak.
  it("warns when VOLLI_SESSION names a session that has ended", () => {
    const check = find(runDoctorChecks(observation({ sessionId: "gone" }), facts()), "session");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("has ended");
    expect(check.remedy).toContain("outlived its session");
  });
});

describe("runDoctorChecks — other findings", () => {
  it("reports a refused wrapper as a warning naming what it would have shadowed", () => {
    const check = find(
      runDoctorChecks(
        observation(),
        facts({
          refused: [
            { command: "git", resolvedPath: "/usr/bin/git", reason: "shadows-system-command" },
          ],
        }),
      ),
      "refused-git",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("/usr/bin/git");
    expect(check.remedy).toContain("shadow a system tool");
  });

  // Every refusal ends in an unwrapped harness, so the outcome cannot be what
  // distinguishes them — a message that named the shadow rule for a collision
  // would send the user to check a system tool that was never involved.
  it("says a refused wrapper's own reason rather than the shadow rule for all three", () => {
    const owned = find(
      runDoctorChecks(
        observation(),
        facts({
          refused: [
            { command: "claude", resolvedPath: "/data/bin/claude", reason: "name-already-owned" },
          ],
        }),
      ),
      "refused-claude",
    );
    expect(owned.detail).toContain("already owns the name");
    expect(owned.remedy).toContain("one file per name");

    const argv = find(
      runDoctorChecks(
        observation(),
        facts({
          refused: [
            { command: "codex", resolvedPath: "/data/bin/codex", reason: "argv-not-transportable" },
          ],
        }),
      ),
      "refused-codex",
    );
    expect(argv.detail).toContain("newline or an empty word");
    expect(argv.remedy).toContain("declared flags");
  });

  it("warns about a harness that declares events but has never delivered one", () => {
    const check = find(
      runDoctorChecks(
        observation(),
        facts({ reporting: [{ harnessId: "codex", declared: 4, verified: 0 }] }),
      ),
      "reporting-codex",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("none seen yet");
  });

  it("has nothing to verify for a harness that declares no events", () => {
    const check = find(
      runDoctorChecks(
        observation(),
        facts({ reporting: [{ harnessId: "cursor", declared: 0, verified: 0 }] }),
      ),
      "reporting-cursor",
    );
    expect(check.status).toBe("ok");
  });

  it("mentions skill conflicts only when there are some", () => {
    expect(runDoctorChecks(observation(), facts()).some((c) => c.id === "skills")).toBe(false);
    const check = find(
      runDoctorChecks(observation(), facts({ skillConflicts: ["~/.claude/skills/volli"] })),
      "skills",
    );
    expect(check.status).toBe("warn");
  });

  it("warns when volli resolves to a different install's shim", () => {
    const check = find(
      runDoctorChecks(observation({ volliPath: "/usr/local/bin/volli" }), facts()),
      "volli-cli",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("not this app's shim");
  });

  it("fails when volli resolves to nothing at all", () => {
    const check = find(runDoctorChecks(observation({ volliPath: null }), facts()), "volli-cli");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("resolves to nothing");
  });

  // "agents cannot reach the planner" is a strong claim to make about a field
  // that never arrived.
  it("warns instead of failing when no volli path was reported", () => {
    const check = find(
      runDoctorChecks(observation({ volliPath: undefined }), facts()),
      "volli-cli",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("no `volli` path was reported");
  });
});

describe("runDoctorChecks — ordering", () => {
  it("puts failures first, then warnings, so the worst thing is read first", () => {
    const checks = runDoctorChecks(
      observation({ pathEntries: ["/usr/bin", BIN], sessionId: "gone" }),
      facts(),
    );
    const statuses = checks.map((check) => check.status);
    expect(statuses).toEqual(
      [...statuses].toSorted((a, b) => {
        const rank = { fail: 0, warn: 1, ok: 2 } as const;
        return rank[a] - rank[b];
      }),
    );
    expect(statuses[0]).toBe("fail");
  });
});

describe("doctorSummary", () => {
  it("says so plainly when everything passed", () => {
    expect(doctorSummary(runDoctorChecks(observation(), facts()))).toMatch(
      /^All \d+ checks passed\.$/,
    );
  });

  it("counts failures and warnings separately", () => {
    const checks = runDoctorChecks(
      observation({ pathEntries: ["/usr/bin", BIN], sessionId: "gone" }),
      facts(),
    );
    expect(doctorSummary(checks)).toContain("1 failed");
    expect(doctorSummary(checks)).toContain("warning");
  });

  it("omits the warning clause when there are only failures", () => {
    expect(doctorSummary([{ id: "a", title: "t", status: "fail", detail: "d" }])).toBe(
      "1 failed of 1 checks.",
    );
  });

  it("omits the failure clause when there are only warnings", () => {
    expect(doctorSummary([{ id: "a", title: "t", status: "warn", detail: "d" }])).toBe(
      "1 warning of 1 checks.",
    );
  });

  it("pluralizes multiple warnings", () => {
    expect(
      doctorSummary([
        { id: "a", title: "t", status: "warn", detail: "d" },
        { id: "b", title: "t", status: "warn", detail: "d" },
      ]),
    ).toBe("2 warnings of 2 checks.");
  });

  it("uses singular wording for exactly one warning", () => {
    const checks = runDoctorChecks(observation({ sessionId: "gone" }), facts());
    expect(doctorSummary(checks)).toContain("1 warning of");
  });
});
