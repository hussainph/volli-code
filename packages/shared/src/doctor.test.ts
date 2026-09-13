import { describe, expect, it } from "vite-plus/test";
import {
  doctorCheckHeadline,
  doctorSummary,
  legacyDoctorFailureTitle,
  runDoctorChecks as runChecks,
} from "./doctor";
import type {
  DoctorCheck,
  DoctorCheckFault,
  DoctorDoorContext,
  DoctorFacts,
  DoctorObservation,
} from "./doctor";

const BIN = "/ud/bin";

function observation(overrides: Partial<DoctorObservation> = {}): DoctorObservation {
  const sessionId = overrides.sessionId === undefined ? "s-1" : overrides.sessionId;
  return {
    pathEntries: [BIN, "/usr/bin", "/bin"],
    sessionId,
    zdotDir: "/ud/shell/zsh",
    resolved: {
      claude: `${BIN}/claude`,
      git: "/usr/bin/git",
      gh: "/opt/homebrew/bin/gh",
      node: "/opt/homebrew/bin/node",
      npm: "/opt/homebrew/bin/npm",
      pnpm: "/opt/homebrew/bin/pnpm",
      yarn: "/opt/homebrew/bin/yarn",
      bun: "/opt/homebrew/bin/bun",
    },
    volliPath: `${BIN}/volli`,
    // The Volli checkout the caller usually stands in: a git repository with
    // a pnpm lockfile. `gh` is measured beside these and required by none.
    requiredTools: ["git", "node", "pnpm"],
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
    orphanProcesses: { total: 0, reapable: 0 },
    ...overrides,
  };
}

function door(overrides: Partial<DoctorDoorContext> = {}): DoctorDoorContext {
  return { authenticatedSessionId: null, ...overrides };
}

function doctorChecks(
  observed: DoctorObservation,
  known: DoctorFacts,
  context: DoctorDoorContext = door({
    authenticatedSessionId: observed.sessionId === "s-1" ? "s-1" : null,
  }),
): DoctorCheck[] {
  return runChecks(observed, known, context);
}

function find(checks: DoctorCheck[], id: string): DoctorCheck {
  const check = checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check;
}

/** The same lookup, narrowed to a finding. */
function fault(checks: DoctorCheck[], id: string): DoctorCheckFault {
  const check = find(checks, id);
  if (check.status === "ok") throw new Error(`check ${id} passed`);
  return check;
}

describe("runDoctorChecks — PATH position", () => {
  it("passes only when the bin dir is actually first", () => {
    expect(find(doctorChecks(observation(), facts()), "path-position").status).toBe("ok");
  });

  // The exact outage this command exists for: membership held the whole time.
  it("fails on membership without primacy, and says what is shadowing it", () => {
    const entries = ["/opt/homebrew/bin", "/usr/local/bin", BIN];
    const check = find(
      doctorChecks(observation({ pathEntries: entries }), facts()),
      "path-position",
    );

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("position 3 of 3");
    expect(check.detail).toContain("/opt/homebrew/bin");
  });

  it("uses singular wording when exactly one entry shadows it", () => {
    const check = find(
      doctorChecks(observation({ pathEntries: ["/usr/bin", BIN] }), facts()),
      "path-position",
    );
    expect(check.detail).toContain("1 entry shadows it");
  });

  it("fails when the bin dir is absent entirely", () => {
    const check = find(
      doctorChecks(observation({ pathEntries: ["/usr/bin"] }), facts()),
      "path-position",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not on PATH at all");
  });
});

describe("runDoctorChecks — resolution", () => {
  it("passes when the harness name reaches the wrapper", () => {
    expect(find(doctorChecks(observation(), facts()), "resolves-claude").status).toBe("ok");
  });

  // A harness resolving to the user's OWN install is not a fault. Volli's
  // wrapper is how Volli observes events, but a person who installed `claude`
  // themselves and expects `claude` to run it is getting what they asked for —
  // and doctor telling them to repair a working machine is doctor being wrong.
  it("passes, naming the binary, when the name reaches the user's own install", () => {
    const check = find(
      doctorChecks(observation({ resolved: { claude: "/Users/x/.local/bin/claude" } }), facts()),
      "resolves-claude",
    );
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("/Users/x/.local/bin/claude");
  });

  it("offers no remedy for it, because there is nothing to repair", () => {
    const check = find(
      doctorChecks(observation({ resolved: { claude: "/Users/x/.local/bin/claude" } }), facts()),
      "resolves-claude",
    );
    expect(check.remedy).toBeUndefined();
    expect(check.detail).not.toContain("reports no events");
  });

  it("warns rather than failing when the command resolves nowhere", () => {
    const check = find(
      doctorChecks(observation({ resolved: { claude: null } }), facts()),
      "resolves-claude",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("resolves to nothing");
  });

  // A wrapper nobody tried to resolve. Reporting it as resolving to nothing is
  // the diagnostic inventing a negative about a harness that may work fine.
  it("says so when no resolution was reported, rather than calling it absent", () => {
    const check = find(doctorChecks(observation({ resolved: {} }), facts()), "resolves-claude");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("no resolution was reported");
    expect(check.detail).not.toContain("resolves to nothing");
  });
});

describe("runDoctorChecks — session tools", () => {
  it("passes each tool that resolves on the reported PATH, with its absolute path", () => {
    const check = find(doctorChecks(observation(), facts()), "tool-gh");
    expect(check.status).toBe("ok");
    expect(check.detail).toBe("/opt/homebrew/bin/gh");
  });

  // The check cannot distinguish "not installed" from "installed but the
  // session PATH never adopted it", so the remedy must name both causes and
  // the discriminator — never a bare "install git".
  it("fails a required tool's measured absence with a remedy naming both causes", () => {
    const check = find(doctorChecks(observation({ resolved: { git: null } }), facts()), "tool-git");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("resolves to nothing");
    expect(check.remedy).toContain("xcode-select --install");
    expect(check.remedy).toContain("volli doctor --fix");
    expect(check.remedy).toContain("volli identify");
  });

  it("points every missing required tool at the same PATH repair", () => {
    const base = observation();
    for (const tool of ["git", "node", "npm", "pnpm", "yarn", "bun"] as const) {
      const check = find(
        doctorChecks(
          observation({
            resolved: { ...base.resolved, [tool]: null },
            requiredTools: [tool],
          }),
          facts(),
        ),
        `tool-${tool}`,
      );
      expect(check.status).toBe("fail");
      expect(check.remedy).toContain("volli doctor --fix");
    }
  });

  // VC-94's exact shape: git answers from the bare launchd PATH's /usr/bin
  // while node is gone, so the session looks operational — it can commit —
  // and cannot install. Both facts must be visible in the same report.
  it("reports git present and node missing together, which is the incident's shape", () => {
    const base = observation();
    const checks = doctorChecks(
      observation({ resolved: { ...base.resolved, node: null } }),
      facts(),
    );
    expect(find(checks, "tool-git").status).toBe("ok");
    expect(find(checks, "tool-node").status).toBe("fail");
  });

  // A caller that never measured a required tool is silence, not absence;
  // reporting it as absent would be the diagnostic inventing a negative.
  it("warns rather than failing when no resolution was reported", () => {
    const check = find(doctorChecks(observation({ resolved: {} }), facts()), "tool-node");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("no resolution was reported");
    expect(check.detail).not.toContain("resolves to nothing");
  });
});

// VC-157: the census measures every tool and the project decides which
// absences are faults. A repo that never runs `gh` or `pnpm` must not wear
// their absence as a failure — reporting is not alarming.
describe("runDoctorChecks — tools this project does not require", () => {
  it("reports a missing gh as a measurement, and says where its absence is judged", () => {
    const check = find(
      doctorChecks(observation({ resolved: { ...observation().resolved, gh: null } }), facts()),
      "tool-gh",
    );
    expect(check.status).toBe("ok");
    expect(check.title).toBe("`gh` is not required by this project");
    expect(check.detail).toContain("resolves to nothing on this PATH");
    expect(check.detail).toContain("when a PR action actually needs it");
    expect(check.remedy).toBeUndefined();
  });

  it("never faults the package managers a yarn workspace does not name", () => {
    const checks = doctorChecks(
      observation({
        resolved: { claude: `${BIN}/claude`, git: "/usr/bin/git", node: "/opt/node" },
        requiredTools: ["git", "node", "yarn"],
      }),
      facts(),
    );
    expect(find(checks, "tool-pnpm").status).toBe("ok");
    expect(find(checks, "tool-pnpm").detail).toContain("nothing here asks for it");
    expect(find(checks, "tool-yarn").status).toBe("warn");
  });

  // A Python or Go repo: git is the only implication, and a host with no
  // Node toolchain at all reports a clean bill.
  it("passes a repo that implies only git, whatever else is missing", () => {
    const checks = doctorChecks(
      observation({
        resolved: {
          claude: `${BIN}/claude`,
          git: "/usr/bin/git",
          gh: null,
          node: null,
          pnpm: null,
        },
        requiredTools: ["git"],
      }),
      facts(),
    );
    expect(checks.filter((check) => check.id.startsWith("tool-") && check.status !== "ok")).toEqual(
      [],
    );
  });

  // A caller that named no requirements gets a pure report: with nothing
  // known to be needed, an absence has no consequence to name.
  it("reports an unmeasured, unrequired tool without inventing a finding", () => {
    const check = find(
      doctorChecks(observation({ resolved: {}, requiredTools: [] }), facts()),
      "tool-node",
    );
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("no resolution was reported");
    expect(check.detail).toContain("nothing here asks for it");
  });
});

describe("runDoctorChecks — shell integration", () => {
  it("fails when this shell's ZDOTDIR is not the generated one", () => {
    const check = find(doctorChecks(observation({ zdotDir: null }), facts()), "shell-init");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("unset");
  });

  it("fails when the chain was never written", () => {
    const check = find(
      doctorChecks(observation(), facts({ shellInitPresent: false })),
      "shell-init",
    );
    expect(check.status).toBe("fail");
  });

  // "unset" is a measurement. Saying it about a field that never arrived is
  // the diagnostic asserting a fact nobody established.
  it("distinguishes an unreported ZDOTDIR from one that is genuinely unset", () => {
    const check = find(doctorChecks(observation({ zdotDir: undefined }), facts()), "shell-init");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("was not reported");
    expect(check.detail).not.toContain("unset");
  });

  // bash and fish: a real, permanent, partial state — not a failure.
  it("warns for a shell with no post-startup hook", () => {
    const check = find(doctorChecks(observation(), facts({ shellInitDir: null })), "shell-init");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("only Volli-started agents are wrapped");
  });
});

describe("runDoctorChecks — session", () => {
  it("is content outside a session, and says the other checks are shell-local", () => {
    const check = find(doctorChecks(observation({ sessionId: null }), facts()), "session");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("not in a Volli session");
  });

  it("distinguishes an authenticated live caller from a genuinely ended session", () => {
    const live = find(
      doctorChecks(
        observation({ sessionId: "s-1" }),
        facts({ liveSessionIds: ["s-1"] }),
        door({ authenticatedSessionId: "s-1" }),
      ),
      "session",
    );
    const ended = find(
      doctorChecks(observation({ sessionId: "gone" }), facts({ liveSessionIds: [] }), door()),
      "session",
    );

    expect(live).toMatchObject({ status: "ok", detail: "s-1" });
    expect(ended.status).toBe("warn");
    expect(ended.detail).toContain("has ended");
    expect(ended.remedy).toContain("Open or resume a live Session");
  });

  it("does not call an unauthenticated claim for another live session healthy", () => {
    const check = find(
      doctorChecks(observation({ sessionId: "s-1" }), facts({ liveSessionIds: ["s-1"] }), door()),
      "session",
    );

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("not authenticated");
    expect(check.detail).not.toContain("has ended");
    expect(check.remedy).toContain("Run `volli doctor` from inside the live Session attachment");
  });
});

describe("runDoctorChecks — other findings", () => {
  it("reports a refused wrapper as a warning naming what it would have shadowed", () => {
    const check = find(
      doctorChecks(
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
      doctorChecks(
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
      doctorChecks(
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
      doctorChecks(
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
      doctorChecks(
        observation(),
        facts({ reporting: [{ harnessId: "cursor", declared: 0, verified: 0 }] }),
      ),
      "reporting-cursor",
    );
    expect(check.status).toBe("ok");
  });

  it("reports how many running processes no live Session owns", () => {
    // VC-341: the audit that opened the ticket found ten of these, and nothing
    // on the machine could name a single one of them.
    expect(
      find(doctorChecks(observation(), facts({ orphanProcesses: undefined })), "orphan-processes"),
    ).toMatchObject({ status: "warn", detail: "the process sweep did not run this launch" });
    expect(find(doctorChecks(observation(), facts()), "orphan-processes")).toMatchObject({
      status: "ok",
      detail: "none",
    });
    // Listed but none of them Volli's: a person's own shell in a worktree is
    // context, not a fault.
    expect(
      find(
        doctorChecks(observation(), facts({ orphanProcesses: { total: 2, reapable: 0 } })),
        "orphan-processes",
      ),
    ).toMatchObject({ status: "ok", detail: "2 still running, none of them Volli's to reap" });
    const found = find(
      doctorChecks(observation(), facts({ orphanProcesses: { total: 10, reapable: 7 } })),
      "orphan-processes",
    );
    expect(found.status).toBe("warn");
    expect(found.detail).toBe("10 still running, 7 of them Volli's");
    expect(found.remedy).toContain("Settings");
  });

  it("mentions skill conflicts only when there are some", () => {
    expect(doctorChecks(observation(), facts()).some((c) => c.id === "skills")).toBe(false);
    const check = find(
      doctorChecks(observation(), facts({ skillConflicts: ["~/.claude/skills/volli"] })),
      "skills",
    );
    expect(check.status).toBe("warn");
  });

  it("warns when volli resolves to a different install's shim", () => {
    const check = find(
      doctorChecks(observation({ volliPath: "/usr/local/bin/volli" }), facts()),
      "volli-cli",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("not this app's shim");
  });

  it("fails when volli resolves to nothing at all", () => {
    const check = find(doctorChecks(observation({ volliPath: null }), facts()), "volli-cli");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("resolves to nothing");
  });

  // "agents cannot reach the planner" is a strong claim to make about a field
  // that never arrived.
  it("warns instead of failing when no volli path was reported", () => {
    const check = find(doctorChecks(observation({ volliPath: undefined }), facts()), "volli-cli");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("no `volli` path was reported");
  });
});

describe("runDoctorChecks — ordering", () => {
  it("puts failures first, then warnings, so the worst thing is read first", () => {
    const checks = doctorChecks(
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

/**
 * VC-293. A finding's heading has to name the finding. These titles used to be
 * the check's positive claim, so a fault list read as a list of things that
 * were fine. Detail remains a measurement for the support report; each heading
 * now states the outcome a person can scan.
 */
describe("runDoctorChecks — failure titles", () => {
  it("names which PATH failure happened, not the claim that did not hold", () => {
    const absent = fault(
      doctorChecks(observation({ pathEntries: ["/usr/bin"] }), facts()),
      "path-position",
    );
    const shadowed = fault(
      doctorChecks(observation({ pathEntries: ["/usr/bin", BIN] }), facts()),
      "path-position",
    );

    expect(absent.failureTitle).toBe("Volli bin is missing from PATH");
    expect(shadowed.failureTitle).toBe("Volli bin is not first on PATH");
    expect(absent.title).toBe("Volli's bin is first on PATH");
  });

  it("separates a shell with no integration, missing files, silence, and a stale terminal", () => {
    const findings = [
      fault(doctorChecks(observation(), facts({ shellInitDir: null })), "shell-init"),
      fault(doctorChecks(observation(), facts({ shellInitPresent: false })), "shell-init"),
      fault(doctorChecks(observation({ zdotDir: undefined }), facts()), "shell-init"),
      fault(doctorChecks(observation({ zdotDir: null }), facts()), "shell-init"),
    ];

    expect(findings.map((finding) => finding.failureTitle)).toEqual([
      "This shell has no Volli integration hook",
      "Shell integration files are missing",
      "Shell integration could not be checked",
      "This terminal has stale shell integration",
    ]);
    expect(findings.every((finding) => Boolean(finding.remedy))).toBe(true);
  });

  it("tells a missing `volli` apart from another install's and from silence", () => {
    const findings = [
      fault(doctorChecks(observation({ volliPath: undefined }), facts()), "volli-cli"),
      fault(doctorChecks(observation({ volliPath: null }), facts()), "volli-cli"),
      fault(doctorChecks(observation({ volliPath: "/usr/local/bin/volli" }), facts()), "volli-cli"),
    ];

    expect(findings.map((finding) => finding.failureTitle)).toEqual([
      "`volli`'s location was not reported",
      "`volli` is missing from PATH",
      "`volli` belongs to another Volli install",
    ]);
    expect(findings.every((finding) => Boolean(finding.remedy))).toBe(true);
  });

  it("names the tool that a session cannot run", () => {
    const missing = fault(
      doctorChecks(observation({ resolved: { git: null } }), facts()),
      "tool-git",
    );
    const unreported = fault(doctorChecks(observation({ resolved: {} }), facts()), "tool-node");

    expect(missing.failureTitle).toBe("`git` is missing from the session PATH");
    expect(unreported.failureTitle).toBe("`node` availability was not reported");
  });

  it("names what a harness command resolves to, or fails to", () => {
    const nowhere = fault(
      doctorChecks(observation({ resolved: { claude: null } }), facts()),
      "resolves-claude",
    );
    const unreported = fault(
      doctorChecks(observation({ resolved: {} }), facts()),
      "resolves-claude",
    );

    expect(nowhere.failureTitle).toBe("`claude` resolves to nothing");
    expect(unreported.failureTitle).toBe("`claude`'s resolution was not reported");
    expect(nowhere.remedy).toBeTruthy();
    expect(unreported.remedy).toBeTruthy();
  });

  it("gives each wrapper refusal its own heading", () => {
    const refusal = (
      command: string,
      reason: DoctorFacts["refused"][number]["reason"],
    ): DoctorCheckFault =>
      fault(
        doctorChecks(
          observation(),
          facts({ refused: [{ command, resolvedPath: `/usr/bin/${command}`, reason }] }),
        ),
        `refused-${command}`,
      );

    expect(refusal("git", "shadows-system-command").failureTitle).toBe(
      "`git` is not wrapped — the name belongs to a system command",
    );
    expect(refusal("claude", "name-already-owned").failureTitle).toBe(
      "`claude` is not wrapped — another harness owns the name",
    );
    expect(refusal("codex", "argv-not-transportable").failureTitle).toBe(
      "`codex` is not wrapped — its launch arguments cannot be carried",
    );
  });

  it("distinguishes an ended Session from an unauthenticated caller", () => {
    const ended = fault(
      doctorChecks(observation({ sessionId: "gone" }), facts({ liveSessionIds: [] }), door()),
      "session",
    );
    const unauthenticated = fault(
      doctorChecks(observation({ sessionId: "s-1" }), facts({ liveSessionIds: ["s-1"] }), door()),
      "session",
    );

    expect(ended.failureTitle).toBe("This terminal's Session has ended");
    expect(unauthenticated.failureTitle).toBe("This terminal is not authenticated for its Session");
  });

  it("names the harness whose events never arrived and the edited skill files", () => {
    const reporting = fault(
      doctorChecks(
        observation(),
        facts({ reporting: [{ harnessId: "codex", declared: 4, verified: 0 }] }),
      ),
      "reporting-codex",
    );
    const skills = fault(
      doctorChecks(observation(), facts({ skillConflicts: ["~/.claude/skills/volli"] })),
      "skills",
    );

    expect(reporting.failureTitle).toBe("codex has reported no events yet");
    expect(skills.failureTitle).toBe("Managed skill files were left as you edited them");
  });

  it("names unavailable and reapable orphan process results", () => {
    const unavailable = fault(
      doctorChecks(observation(), facts({ orphanProcesses: undefined })),
      "orphan-processes",
    );
    const reapable = fault(
      doctorChecks(observation(), facts({ orphanProcesses: { total: 3, reapable: 2 } })),
      "orphan-processes",
    );

    expect(unavailable.failureTitle).toBe("Orphaned processes could not be checked");
    expect(reapable.failureTitle).toBe("Volli-owned orphaned processes are still running");
    expect(unavailable.remedy).toBeTruthy();
    expect(reapable.remedy).toBeTruthy();
  });

  it("gives every finding a failure title distinct from its passing claim and a repair", () => {
    const checks = doctorChecks(
      observation({
        pathEntries: ["/usr/bin"],
        zdotDir: null,
        resolved: { claude: null, git: null },
        volliPath: null,
        sessionId: "gone",
      }),
      facts({
        liveSessionIds: [],
        orphanProcesses: { total: 1, reapable: 1 },
        refused: [
          { command: "cursor", resolvedPath: "/usr/bin/cursor", reason: "shadows-system-command" },
        ],
        reporting: [{ harnessId: "codex", declared: 4, verified: 0 }],
        skillConflicts: ["~/.claude/skills/volli"],
      }),
    );

    const findings = checks.filter((check) => check.status !== "ok");
    expect(findings.length).toBeGreaterThan(5);
    for (const finding of findings) {
      expect(finding.failureTitle).not.toBe(finding.title);
      expect(finding.failureTitle.length).toBeGreaterThan(0);
      expect(finding.remedy).toBeTruthy();
      expect(doctorCheckHeadline(finding)).toBe(finding.failureTitle);
    }
  });
});

describe("doctorCheckHeadline", () => {
  it("reads a passing check by its claim", () => {
    expect(
      doctorCheckHeadline({ id: "a", title: "Everything is wired", status: "ok", detail: "d" }),
    ).toBe("Everything is wired");
  });

  it("reads a finding by what went wrong", () => {
    expect(
      doctorCheckHeadline({
        id: "a",
        title: "Everything is wired",
        failureTitle: "The wire is cut",
        status: "fail",
        detail: "d",
      }),
    ).toBe("The wire is cut");
  });

  it("marks an older finding's passing claim as not having held", () => {
    expect(legacyDoctorFailureTitle("Everything is wired")).toBe(
      "Check did not pass — Everything is wired",
    );
  });
});

describe("doctorSummary", () => {
  it("says so plainly when everything passed", () => {
    expect(doctorSummary(doctorChecks(observation(), facts()))).toMatch(
      /^All \d+ checks passed\.$/,
    );
  });

  it("counts failures and warnings separately", () => {
    const checks = doctorChecks(
      observation({ pathEntries: ["/usr/bin", BIN], sessionId: "gone" }),
      facts(),
    );
    expect(doctorSummary(checks)).toContain("1 failed");
    expect(doctorSummary(checks)).toContain("warning");
  });

  it("omits the warning clause when there are only failures", () => {
    expect(
      doctorSummary([
        { id: "a", title: "t", failureTitle: "f", status: "fail", detail: "d", remedy: "r" },
      ]),
    ).toBe("1 failed of 1 checks.");
  });

  it("omits the failure clause when there are only warnings", () => {
    expect(
      doctorSummary([
        { id: "a", title: "t", failureTitle: "f", status: "warn", detail: "d", remedy: "r" },
      ]),
    ).toBe("1 warning of 1 checks.");
  });

  it("pluralizes multiple warnings", () => {
    expect(
      doctorSummary([
        { id: "a", title: "t", failureTitle: "f", status: "warn", detail: "d", remedy: "r" },
        { id: "b", title: "t", failureTitle: "f", status: "warn", detail: "d", remedy: "r" },
      ]),
    ).toBe("2 warnings of 2 checks.");
  });

  it("uses singular wording for exactly one warning", () => {
    const checks = doctorChecks(observation({ sessionId: "gone" }), facts());
    expect(doctorSummary(checks)).toContain("1 warning of");
  });
});
