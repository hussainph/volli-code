import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../ipc/contract";

import {
  projectEnvironmentReadiness,
  sessionEnvironmentAlert,
} from "./session-environment-alert-model";

const REPAIR_HINT =
  "Run volli doctor --fix to re-run PATH adoption for new Sessions; this running Session keeps its startup environment.";

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
        tools: {
          git: "/usr/bin/git",
          gh: "/opt/homebrew/bin/gh",
          node: "/opt/homebrew/bin/node",
          pnpm: "/opt/homebrew/bin/pnpm",
        },
        dependencies: null,
        installCommand: null,
        ...overrides,
      },
      systemPathIssues: [],
      credentialHelperIssues: [],
    },
  };
}

describe("sessionEnvironmentAlert", () => {
  it("stays quiet for a completed healthy adoption", () => {
    expect(sessionEnvironmentAlert(status("adopted", "already-complete"))).toBeNull();
    expect(sessionEnvironmentAlert(status("already-complete", "pending"))).toBeNull();
  });

  it("makes a failed boot adoption visible even when the interactive pass recovered", () => {
    expect(sessionEnvironmentAlert(status("probe-failed", "adopted"))).toEqual({
      title: "Sessions couldn't read your login PATH",
      detail: `Sessions are using the app's inherited PATH. Commands available in your terminal may not run here. ${REPAIR_HINT}`,
    });
  });

  it("names the two-pass failure without pretending one pass repaired the other", () => {
    expect(sessionEnvironmentAlert(status("probe-failed", "probe-failed"))).toEqual({
      title: "Sessions couldn't read your login PATH",
      detail: `Both login-shell passes failed. Sessions are using the app's inherited PATH, so commands available in your terminal may not run here. ${REPAIR_HINT}`,
    });
  });

  it("surfaces an interactive-only failure because its shell tools can still be absent", () => {
    expect(sessionEnvironmentAlert(status("adopted", "probe-failed"))).toEqual({
      title: "Sessions couldn't read your interactive login PATH",
      detail: `Tools configured by your interactive shell, such as nvm or mise, may not be available in Sessions. ${REPAIR_HINT}`,
    });
  });

  it("shows every missing project requirement as soon as a project is selected", () => {
    const measured = status("adopted", "already-complete", {
      tools: { git: "/usr/bin/git", gh: null, node: null, pnpm: "/opt/homebrew/bin/pnpm" },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toEqual({
      title: "Sessions aren't ready for Acme",
      detail:
        "Missing from the Session PATH: gh, node. If they are installed, run volli doctor --fix to re-run PATH adoption for new Sessions. Dependencies are not installed. Run pnpm install before starting a Session.",
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
      tools: {
        git: "/usr/bin/git",
        gh: null,
        node: "/opt/homebrew/bin/node",
        pnpm: "/opt/homebrew/bin/pnpm",
      },
      dependencies: "installed",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })?.detail).toBe(
      "Missing from the Session PATH: gh. If they are installed, run volli doctor --fix to re-run PATH adoption for new Sessions.",
    );
  });

  it("is quiet about a ready project, and about readiness with no project in scope", () => {
    expect(projectEnvironmentReadiness(status("adopted", "already-complete"), null)).toBeNull();
    expect(
      projectEnvironmentReadiness(status("adopted", "already-complete"), { name: "Acme" }),
    ).toBeNull();
    // A probe failure with a selected but healthy project stays a probe alert.
    expect(sessionEnvironmentAlert(status("probe-failed", "pending"), { name: "Acme" })).toEqual({
      title: "Sessions couldn't read your login PATH",
      detail: `Sessions are using the app's inherited PATH. Commands available in your terminal may not run here. ${REPAIR_HINT}`,
    });
  });

  // The combined notice states every fact once and the repair once: the probe
  // half already ends with the repair hint, so the readiness half contributes
  // only its measurements (the duplicated sentence the VC-94 review caught).
  it("merges a probe failure with project facts without repeating the repair hint", () => {
    const measured = status("probe-failed", "pending", {
      tools: {
        git: "/usr/bin/git",
        gh: null,
        node: "/opt/homebrew/bin/node",
        pnpm: "/opt/homebrew/bin/pnpm",
      },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    const alert = sessionEnvironmentAlert(measured, { name: "Acme" });
    expect(alert).toEqual({
      title: "Sessions couldn't read your login PATH",
      detail: `Sessions are using the app's inherited PATH. Commands available in your terminal may not run here. ${REPAIR_HINT} Missing from the Session PATH: gh. Dependencies are not installed. Run pnpm install before starting a Session.`,
    });
    expect(alert?.detail.match(/volli doctor --fix/g)).toHaveLength(1);
  });
});
