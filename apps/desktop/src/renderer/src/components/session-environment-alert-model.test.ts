import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../ipc/contract";

import {
  projectEnvironmentReadiness,
  sessionEnvironmentMeasurement,
  type ProjectEnvironmentScope,
} from "./session-environment-alert-model";

const ALL_TOOLS_FOUND = {
  git: "/usr/bin/git",
  gh: "/opt/homebrew/bin/gh",
  node: "/opt/homebrew/bin/node",
  pnpm: "/opt/homebrew/bin/pnpm",
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
        tools: { ...ALL_TOOLS_FOUND },
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
    const missingEverything = { tools: { git: null, gh: null, node: null, pnpm: null } };
    expect(topNotice(status("probe-failed", "adopted", missingEverything))).toBeNull();
    expect(topNotice(status("adopted", "probe-failed", missingEverything))).toBeNull();
    // `pending` is not a failure: the second pass runs after the first window
    // precisely so nothing waits on it.
    expect(topNotice(status("probe-failed", "pending", missingEverything))).toBeNull();
  });

  it("raises one plainly-worded fault when both passes failed and commands are missing", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: { git: "/usr/bin/git", gh: null, node: null, pnpm: "/opt/homebrew/bin/pnpm" },
    });

    expect(topNotice(measured)).toEqual({
      fault: "login-path-unreadable",
      key: "login-path-unreadable",
      title: "Volli couldn't read your terminal's PATH",
      detail:
        "Sessions can't find gh and node, so some commands may be missing. " +
        "Fix now asks your terminal again — Sessions you start afterwards get the result.",
    });
  });

  it("names a single missing command without a list", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: { ...ALL_TOOLS_FOUND, gh: null },
    });

    expect(topNotice(measured)?.detail).toContain("Sessions can't find gh,");
  });

  // The banner is somebody's first minute in the product. "Login-shell passes",
  // "adoption", "provenance" and `volli doctor --fix` are Settings → CLI and
  // doctor vocabulary (VC-159, item 3).
  it("speaks no internal vocabulary and prescribes no CLI incantation", () => {
    const alert = topNotice(
      status("probe-failed", "probe-failed", { tools: { ...ALL_TOOLS_FOUND, gh: null } }),
    );
    const copy = `${alert?.title} ${alert?.detail}`;

    for (const word of ["pass", "adoption", "provenance", "probe", "doctor", "--fix"]) {
      expect(copy.toLowerCase()).not.toContain(word);
    }
  });

  it("shows every missing project requirement as soon as a project is selected", () => {
    const measured = status("adopted", "already-complete", {
      tools: { git: "/usr/bin/git", gh: null, node: null, pnpm: "/opt/homebrew/bin/pnpm" },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toEqual({
      fault: null,
      key: "readiness:Acme:gh,node:absent",
      title: "Sessions aren't ready for Acme",
      detail:
        "Missing from the Session PATH: gh, node. If they are installed, open Settings → CLI to repair the Session PATH. Dependencies are not installed. Run pnpm install before starting a Session.",
    });
  });

  // The dismissal key is what was MEASURED, so a copy edit can never revive a
  // notice somebody already put away — the defect the fault half of VC-159
  // fixed durably, and the reason this half no longer compares prose.
  it("keys a readiness notice on its facts, not on its sentence", () => {
    const withGh = status("adopted", "already-complete", {
      tools: { ...ALL_TOOLS_FOUND, gh: null },
      dependencies: "installed",
    });
    const withGhAndNode = status("adopted", "already-complete", {
      tools: { ...ALL_TOOLS_FOUND, gh: null, node: null },
      dependencies: "installed",
    });

    const first = projectEnvironmentReadiness(withGh, { name: "Acme" });
    expect(first?.key).toBe("readiness:Acme:gh:installed");
    // Different project, different facts: neither shares a dismissal.
    expect(projectEnvironmentReadiness(withGh, { name: "Other" })?.key).not.toBe(first?.key);
    expect(projectEnvironmentReadiness(withGhAndNode, { name: "Acme" })?.key).not.toBe(first?.key);

    // A folder whose dependency state was never established (no lockfile to
    // judge) is its own key — not the same notice as one measured as installed.
    const unknownDependencies = status("adopted", "already-complete", {
      tools: { ...ALL_TOOLS_FOUND, gh: null },
      dependencies: null,
    });
    expect(projectEnvironmentReadiness(unknownDependencies, { name: "Acme" })?.key).toBe(
      "readiness:Acme:gh:unknown",
    );
  });

  // The command comes from the workspace's own lockfile: a yarn workspace must
  // never be told to pnpm install (VC-94 review).
  it("names the workspace's own install command, not a hardcoded one", () => {
    const measured = status("adopted", "already-complete", {
      dependencies: "absent",
      installCommand: "yarn install",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })?.detail).toBe(
      "Dependencies are not installed. Run yarn install before starting a Session.",
    );
  });

  it("falls back to npm install when no lockfile named a package manager", () => {
    const measured = status("adopted", "already-complete", {
      dependencies: "absent",
      installCommand: null,
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })?.detail).toBe(
      "Dependencies are not installed. Run npm install before starting a Session.",
    );
  });

  it("reports missing tools without a dependency sentence when dependencies are fine", () => {
    const measured = status("adopted", "already-complete", {
      tools: { ...ALL_TOOLS_FOUND, gh: null },
      dependencies: "installed",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })?.detail).toBe(
      "Missing from the Session PATH: gh. If they are installed, open Settings → CLI to repair the Session PATH.",
    );
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
      tools: { ...ALL_TOOLS_FOUND, gh: null },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    const alert = topNotice(measured, { name: "Acme" });
    expect(alert?.fault).toBe("login-path-unreadable");
    expect(alert?.detail).not.toContain("pnpm install");
  });

  // Outranked is not the same as swallowed. The readiness notice is still
  // MEASURED and still second in line, so dismissing the fault reveals what the
  // project is missing rather than burying a fact nobody dismissed — and no
  // repair to the PATH would have installed those dependencies anyway.
  it("keeps the outranked readiness notice behind the fault instead of dropping it", () => {
    const measurement = sessionEnvironmentMeasurement(
      status("probe-failed", "probe-failed", {
        tools: { ...ALL_TOOLS_FOUND, gh: null },
        dependencies: "absent",
        installCommand: "pnpm install",
      }),
      { name: "Acme" },
    );

    expect(measurement.notices.map((notice) => notice.fault)).toEqual([
      "login-path-unreadable",
      null,
    ]);
    expect(measurement.notices[1]?.detail).toContain("pnpm install");
  });

  // What the durable dismissals are reconciled against: every fault MEASURED,
  // never the one notice on screen. A fault reported as gone while it is still
  // happening would have its dismissal dropped and speak again later.
  it("reports the faults it measured, and reports none on a healthy read", () => {
    expect(
      sessionEnvironmentMeasurement(
        status("probe-failed", "probe-failed", { tools: { ...ALL_TOOLS_FOUND, gh: null } }),
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
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    expect(topNotice(measured, { name: "Acme" })).toEqual({
      fault: null,
      key: "readiness:Acme::absent",
      title: "Sessions aren't ready for Acme",
      detail: "Dependencies are not installed. Run pnpm install before starting a Session.",
    });
  });
});
