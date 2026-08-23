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
          npm: "/opt/homebrew/bin/npm",
          pnpm: "/opt/homebrew/bin/pnpm",
          yarn: null,
          bun: null,
        },
        // A git checkout with a pnpm lockfile — the shape the fixed census
        // used to assume of every project on earth (VC-157).
        requiredTools: ["git", "node", "pnpm"],
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
      tools: {
        git: null,
        gh: "/opt/homebrew/bin/gh",
        node: null,
        npm: "/opt/homebrew/bin/npm",
        pnpm: "/opt/homebrew/bin/pnpm",
        yarn: null,
        bun: null,
      },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toEqual({
      title: "Sessions aren't ready for Acme",
      detail:
        "Missing from the Session PATH: git, node. If they are installed, run volli doctor --fix to re-run PATH adoption for new Sessions. Dependencies are not installed. Run pnpm install before starting a Session.",
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
        gh: "/opt/homebrew/bin/gh",
        node: null,
        npm: "/opt/homebrew/bin/npm",
        pnpm: "/opt/homebrew/bin/pnpm",
        yarn: null,
        bun: null,
      },
      dependencies: "installed",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })?.detail).toBe(
      "Missing from the Session PATH: node. If they are installed, run volli doctor --fix to re-run PATH adoption for new Sessions.",
    );
  });

  // VC-157's whole point: the alert speaks about the tools THIS project
  // implies, and a measurement nothing asked for is not a fault.
  describe("only the project's own requirements", () => {
    it("says nothing about a missing gh, which no project requires", () => {
      const measured = status("adopted", "already-complete", {
        tools: {
          git: "/usr/bin/git",
          gh: null,
          node: "/opt/homebrew/bin/node",
          npm: "/opt/homebrew/bin/npm",
          pnpm: "/opt/homebrew/bin/pnpm",
          yarn: null,
          bun: null,
        },
        dependencies: "installed",
      });

      expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toBeNull();
    });

    it("says nothing about pnpm for a yarn workspace", () => {
      const measured = status("adopted", "already-complete", {
        tools: {
          git: "/usr/bin/git",
          gh: null,
          node: "/opt/homebrew/bin/node",
          npm: null,
          pnpm: null,
          yarn: "/opt/homebrew/bin/yarn",
          bun: null,
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
        "Missing from the Session PATH: node. If they are installed, run volli doctor --fix to re-run PATH adoption for new Sessions.",
      );
    });
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
        node: null,
        npm: "/opt/homebrew/bin/npm",
        pnpm: "/opt/homebrew/bin/pnpm",
        yarn: null,
        bun: null,
      },
      dependencies: "absent",
      installCommand: "pnpm install",
    });

    const alert = sessionEnvironmentAlert(measured, { name: "Acme" });
    expect(alert).toEqual({
      title: "Sessions couldn't read your login PATH",
      detail: `Sessions are using the app's inherited PATH. Commands available in your terminal may not run here. ${REPAIR_HINT} Missing from the Session PATH: node. Dependencies are not installed. Run pnpm install before starting a Session.`,
    });
    expect(alert?.detail.match(/volli doctor --fix/g)).toHaveLength(1);
  });
});
