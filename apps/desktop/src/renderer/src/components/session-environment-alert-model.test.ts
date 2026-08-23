import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../ipc/contract";

import {
  projectEnvironmentReadiness,
  sessionEnvironmentMeasurement,
  type ProjectEnvironmentScope,
} from "./session-environment-alert-model";

// A git checkout with a pnpm lockfile — requiredTools defaults to git, node,
// pnpm below. yarn and bun are measured-but-absent, which no project here
// requires, so their absence must never become a fault (VC-157).
const DEFAULT_TOOLS = {
  git: "/usr/bin/git",
  gh: "/opt/homebrew/bin/gh",
  node: "/opt/homebrew/bin/node",
  npm: "/opt/homebrew/bin/npm",
  pnpm: "/opt/homebrew/bin/pnpm",
  yarn: null,
  bun: null,
};

function status(
  provenance: CliToolStatus["environment"]["session"]["provenance"],
  interactiveProvenance: CliToolStatus["environment"]["session"]["interactiveProvenance"],
  overrides: Partial<CliToolStatus["environment"]["session"]> = {},
): Pick<CliToolStatus, "environment"> {
  return {
    environment: {
      loginPath: "/usr/bin:/opt/homebrew/bin",
      session: {
        path: "/volli/bin:/usr/bin:/opt/homebrew/bin",
        provenance,
        interactiveProvenance,
        tools: { ...DEFAULT_TOOLS },
        requiredTools: ["git", "node", "pnpm"],
        dependencies: null,
        installCommand: null,
        ...overrides,
      },
      systemPathIssues: [],
    },
  };
}

/**
 * The one notice a reader with no dismissals would see. The measurement now
 * returns every notice it raised, ranked, because dismissing the top one must
 * reveal the next rather than bury it — these cases are about the ranking, so
 * they read the head of the list.
 */
function topNotice(
  measured: Pick<CliToolStatus, "environment">,
  project: ProjectEnvironmentScope | null = null,
) {
  return sessionEnvironmentMeasurement(measured, project).notices[0] ?? null;
}

describe("sessionEnvironmentMeasurement", () => {
  it("stays quiet for a completed healthy adoption", () => {
    expect(topNotice(status("adopted", "already-complete"))).toBeNull();
    expect(topNotice(status("already-complete", "pending"))).toBeNull();
  });

  // The whole of VC-159/R7's first half: only the fault a person can feel gets
  // to interrupt them. Everything below is still reported in Settings → CLI.
  it("says nothing about a probe failure that cost a Session nothing", () => {
    expect(topNotice(status("probe-failed", "probe-failed"))).toBeNull();
  });

  it("says nothing when only one pass failed, however much is missing", () => {
    const missingEverything = {
      tools: { git: null, gh: null, node: null, npm: null, pnpm: null, yarn: null, bun: null },
    };
    expect(topNotice(status("probe-failed", "adopted", missingEverything))).toBeNull();
    expect(topNotice(status("adopted", "probe-failed", missingEverything))).toBeNull();
    // `pending` is not a failure: the second pass runs after the first window
    // precisely so nothing waits on it.
    expect(topNotice(status("probe-failed", "pending", missingEverything))).toBeNull();
  });

  it("raises one plainly-worded fault when both passes failed and commands are missing", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: { ...DEFAULT_TOOLS, node: null, pnpm: null },
    });

    expect(topNotice(measured)).toEqual({
      fault: "login-path-unreadable",
      key: "login-path-unreadable",
      title: "Volli couldn't read your terminal's PATH",
      detail:
        "Sessions can't find node and pnpm, so some commands may be missing. " +
        "Fix now asks your terminal again — Sessions you start afterwards get the result.",
    });
  });

  // The fault names what this project actually needs (VC-157): a missing `gh`
  // is measured and reported in Settings, but no project requires it, so it
  // can neither raise the fault nor pad its sentence.
  it("judges the fault by required tools only, never the whole census", () => {
    expect(
      topNotice(status("probe-failed", "probe-failed", { tools: { ...DEFAULT_TOOLS, gh: null } })),
    ).toBeNull();

    const measured = status("probe-failed", "probe-failed", {
      tools: { ...DEFAULT_TOOLS, gh: null, node: null },
    });
    expect(topNotice(measured)?.detail).toContain("Sessions can't find node,");
  });

  it("names a single missing command without a list", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: { ...DEFAULT_TOOLS, node: null },
    });

    expect(topNotice(measured)?.detail).toContain("Sessions can't find node,");
  });

  // The banner is somebody's first minute in the product. "Login-shell passes",
  // "adoption", "provenance" and `volli doctor --fix` are Settings → CLI and
  // doctor vocabulary (VC-159, item 3).
  it("speaks no internal vocabulary and prescribes no CLI incantation", () => {
    const alert = topNotice(
      status("probe-failed", "probe-failed", { tools: { ...DEFAULT_TOOLS, node: null } }),
    );
    const copy = `${alert?.title} ${alert?.detail}`;

    for (const word of ["pass", "adoption", "provenance", "probe", "doctor", "--fix"]) {
      expect(copy.toLowerCase()).not.toContain(word);
    }
  });

  it("shows every missing project requirement as soon as a project is selected", () => {
    const measured = status("adopted", "already-complete", {
      tools: { ...DEFAULT_TOOLS, git: null, node: null },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toEqual({
      fault: null,
      key: "readiness:Acme:git,node",
      title: "Sessions aren't ready for Acme",
      detail:
        "Missing from the Session PATH: git, node. If they are installed, open Settings → CLI to repair the Session PATH.",
    });
  });

  // The dismissal key is what was MEASURED, so a copy edit can never revive a
  // notice somebody already put away — the defect the fault half of VC-159
  // fixed durably, and the reason this half no longer compares prose.
  it("keys a readiness notice on its facts, not on its sentence", () => {
    const withNode = status("adopted", "already-complete", {
      tools: { ...DEFAULT_TOOLS, node: null },
    });
    const withNodeAndPnpm = status("adopted", "already-complete", {
      tools: { ...DEFAULT_TOOLS, node: null, pnpm: null },
    });

    const first = projectEnvironmentReadiness(withNode, { name: "Acme" });
    expect(first?.key).toBe("readiness:Acme:node");
    // Different project, different facts: neither shares a dismissal.
    expect(projectEnvironmentReadiness(withNode, { name: "Other" })?.key).not.toBe(first?.key);
    expect(projectEnvironmentReadiness(withNodeAndPnpm, { name: "Acme" })?.key).not.toBe(
      first?.key,
    );
  });

  // VC-156: a fresh checkout without node_modules is a normal state of the
  // world, not a fault, and the red banner that called it one was the first
  // thing a new project showed its owner. The fact now reaches the agent's
  // prompt and a neutral offer beside the project; nothing reaches this alert.
  it("says nothing at all about uninstalled dependencies", () => {
    for (const installCommand of ["pnpm install", "yarn install", null]) {
      const measured = status("adopted", "already-complete", {
        dependencies: "absent",
        installCommand,
      });

      expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toBeNull();
      expect(topNotice(measured, { name: "Acme" })).toBeNull();
    }
  });

  it("reports missing tools whatever the workspace's dependency state is", () => {
    const measured = status("adopted", "already-complete", {
      tools: { ...DEFAULT_TOOLS, node: null },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })?.detail).toBe(
      "Missing from the Session PATH: node. If they are installed, open Settings → CLI to repair the Session PATH.",
    );
  });

  // VC-157's whole point: the alert speaks about the tools THIS project
  // implies, and a measurement nothing asked for is not a fault.
  describe("only the project's own requirements", () => {
    it("says nothing about a missing gh, which no project requires", () => {
      const measured = status("adopted", "already-complete", {
        tools: { ...DEFAULT_TOOLS, gh: null },
        dependencies: "installed",
      });

      expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toBeNull();
    });

    it("says nothing about pnpm for a yarn workspace", () => {
      const measured = status("adopted", "already-complete", {
        tools: {
          ...DEFAULT_TOOLS,
          gh: null,
          npm: null,
          pnpm: null,
          yarn: "/opt/homebrew/bin/yarn",
        },
        requiredTools: ["git", "node", "yarn"],
        dependencies: "installed",
      });

      expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toBeNull();
    });

    // The reported case: a Python repo on a host with no gh and no JS
    // toolchain wore a permanent red banner for tools it never runs.
    it("is silent for a repo with no JavaScript manifest and no gh installed", () => {
      const measured = status("adopted", "already-complete", {
        tools: {
          git: "/usr/bin/git",
          gh: null,
          node: null,
          npm: null,
          pnpm: null,
          yarn: null,
          bun: null,
        },
        requiredTools: ["git"],
        dependencies: null,
      });

      expect(projectEnvironmentReadiness(measured, { name: "Harbor" })).toBeNull();
    });

    // Reporting is not alarming, but a JS workspace genuinely without node
    // still is: the ticket keeps this one loud.
    it("still warns when a JavaScript workspace is missing node itself", () => {
      const measured = status("adopted", "already-complete", {
        tools: {
          git: "/usr/bin/git",
          gh: null,
          node: null,
          npm: null,
          pnpm: null,
          yarn: "/opt/homebrew/bin/yarn",
          bun: null,
        },
        requiredTools: ["git", "node", "yarn"],
        dependencies: "installed",
      });

      expect(projectEnvironmentReadiness(measured, { name: "Acme" })?.detail).toBe(
        "Missing from the Session PATH: node. If they are installed, open Settings → CLI to repair the Session PATH.",
      );
    });
  });

  it("is quiet about a ready project, and about readiness with no project in scope", () => {
    expect(projectEnvironmentReadiness(status("adopted", "already-complete"), null)).toBeNull();
    expect(
      projectEnvironmentReadiness(status("adopted", "already-complete"), { name: "Acme" }),
    ).toBeNull();
  });

  // One notice at a time (VC-159): the fault already explains why those tools
  // are unreachable, so the project's readiness sentence does not pile a second
  // diagnosis onto the first — it queues behind it.
  it("lets the app fault outrank the project's readiness rather than merging them", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: { ...DEFAULT_TOOLS, node: null },
    });

    const alert = topNotice(measured, { name: "Acme" });
    expect(alert?.fault).toBe("login-path-unreadable");
    expect(alert?.detail).not.toContain("Missing from the Session PATH");
  });

  // Outranked is not the same as swallowed. The readiness notice is still
  // MEASURED and still second in line, so dismissing the fault reveals what the
  // project is missing rather than burying a fact nobody dismissed.
  it("keeps the outranked readiness notice behind the fault instead of dropping it", () => {
    const measurement = sessionEnvironmentMeasurement(
      status("probe-failed", "probe-failed", { tools: { ...DEFAULT_TOOLS, node: null } }),
      { name: "Acme" },
    );

    expect(measurement.notices.map((notice) => notice.fault)).toEqual([
      "login-path-unreadable",
      null,
    ]);
    expect(measurement.notices[1]?.detail).toContain("Missing from the Session PATH: node");
  });

  // What the durable dismissals are reconciled against: every fault MEASURED,
  // never the one notice on screen. A fault reported as gone while it is still
  // happening would have its dismissal dropped and speak again later.
  it("reports the faults it measured, and reports none on a healthy read", () => {
    expect(
      sessionEnvironmentMeasurement(
        status("probe-failed", "probe-failed", { tools: { ...DEFAULT_TOOLS, node: null } }),
      ).faults,
    ).toEqual(["login-path-unreadable"]);

    const healthy = sessionEnvironmentMeasurement(status("adopted", "already-complete"), {
      name: "Acme",
    });
    expect(healthy.faults).toEqual([]);
    expect(healthy.notices).toEqual([]);
  });

  it("surfaces the project's own shortfall once no app fault is in the way", () => {
    const measured = status("adopted", "already-complete", {
      tools: { ...DEFAULT_TOOLS, node: null },
    });

    expect(topNotice(measured, { name: "Acme" })).toEqual({
      fault: null,
      key: "readiness:Acme:node",
      title: "Sessions aren't ready for Acme",
      detail:
        "Missing from the Session PATH: node. If they are installed, open Settings → CLI to repair the Session PATH.",
    });
  });
});
