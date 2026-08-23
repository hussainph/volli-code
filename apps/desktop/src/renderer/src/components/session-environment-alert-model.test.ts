import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../ipc/contract";

import {
  projectEnvironmentReadiness,
  sessionEnvironmentAlert,
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

describe("sessionEnvironmentAlert", () => {
  it("stays quiet for a completed healthy adoption", () => {
    expect(sessionEnvironmentAlert(status("adopted", "already-complete"))).toBeNull();
    expect(sessionEnvironmentAlert(status("already-complete", "pending"))).toBeNull();
  });

  // The whole of VC-159/R7's first half: only the fault a person can feel gets
  // to interrupt them. Everything below is still reported in Settings → CLI.
  it("says nothing about a probe failure that cost a Session nothing", () => {
    expect(sessionEnvironmentAlert(status("probe-failed", "probe-failed"))).toBeNull();
  });

  it("says nothing when only one pass failed, however much is missing", () => {
    const missingEverything = { tools: { git: null, gh: null, node: null, pnpm: null } };
    expect(
      sessionEnvironmentAlert(status("probe-failed", "adopted", missingEverything)),
    ).toBeNull();
    expect(
      sessionEnvironmentAlert(status("adopted", "probe-failed", missingEverything)),
    ).toBeNull();
    // `pending` is not a failure: the second pass runs after the first window
    // precisely so nothing waits on it.
    expect(
      sessionEnvironmentAlert(status("probe-failed", "pending", missingEverything)),
    ).toBeNull();
  });

  it("raises one plainly-worded fault when both passes failed and commands are missing", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: { git: "/usr/bin/git", gh: null, node: null, pnpm: "/opt/homebrew/bin/pnpm" },
    });

    expect(sessionEnvironmentAlert(measured)).toEqual({
      fault: "login-path-unreadable",
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

    expect(sessionEnvironmentAlert(measured)?.detail).toContain("Sessions can't find gh,");
  });

  // The banner is somebody's first minute in the product. "Login-shell passes",
  // "adoption", "provenance" and `volli doctor --fix` are Settings → CLI and
  // doctor vocabulary (VC-159, item 3).
  it("speaks no internal vocabulary and prescribes no CLI incantation", () => {
    const alert = sessionEnvironmentAlert(
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
      title: "Sessions aren't ready for Acme",
      detail:
        "Missing from the Session PATH: gh, node. If they are installed, open Settings → CLI to repair the Session PATH. Dependencies are not installed. Run pnpm install before starting a Session.",
    });
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
  // diagnosis onto the first — it waits until the fault is gone.
  it("lets the app fault outrank the project's readiness rather than merging them", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: { ...ALL_TOOLS_FOUND, gh: null },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    const alert = sessionEnvironmentAlert(measured, { name: "Acme" });
    expect(alert?.fault).toBe("login-path-unreadable");
    expect(alert?.detail).not.toContain("pnpm install");
  });

  it("surfaces the project's own shortfall once no app fault is in the way", () => {
    const measured = status("adopted", "already-complete", {
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    expect(sessionEnvironmentAlert(measured, { name: "Acme" })).toEqual({
      fault: null,
      title: "Sessions aren't ready for Acme",
      detail: "Dependencies are not installed. Run pnpm install before starting a Session.",
    });
  });
});
