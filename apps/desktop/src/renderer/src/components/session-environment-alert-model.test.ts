import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../ipc/contract";

import {
  projectEnvironmentReadiness,
  sessionEnvironmentAlert,
} from "./session-environment-alert-model";

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

  it("makes a failed boot adoption visible even when the interactive pass recovered", () => {
    expect(sessionEnvironmentAlert(status("probe-failed", "adopted"))).toEqual({
      title: "Sessions couldn't read your login PATH",
      detail:
        "Sessions are using the app's inherited PATH. Commands available in your terminal may not run here.",
    });
  });

  it("names the two-pass failure without pretending one pass repaired the other", () => {
    expect(sessionEnvironmentAlert(status("probe-failed", "probe-failed"))).toEqual({
      title: "Sessions couldn't read your login PATH",
      detail:
        "Both login-shell passes failed. Sessions are using the app's inherited PATH, so commands available in your terminal may not run here.",
    });
  });

  it("surfaces an interactive-only failure because its shell tools can still be absent", () => {
    expect(sessionEnvironmentAlert(status("adopted", "probe-failed"))).toEqual({
      title: "Sessions couldn't read your interactive login PATH",
      detail:
        "Tools configured by your interactive shell, such as nvm or mise, may not be available in Sessions.",
    });
  });

  it("shows every missing project requirement as soon as a project is selected", () => {
    const measured = status("adopted", "already-complete", {
      tools: { git: "/usr/bin/git", gh: null, node: null, pnpm: "/opt/homebrew/bin/pnpm" },
      dependencies: "absent",
    });

    expect(projectEnvironmentReadiness(measured, { name: "Acme" })).toEqual({
      title: "Sessions aren't ready for Acme",
      detail:
        "Missing from the Session PATH: gh, node. If they are installed, this is a PATH adoption failure. Dependencies are not installed. Run pnpm install before starting a Session.",
    });
  });

  it("keeps the project requirement detail when a launch-wide probe failure also needs attention", () => {
    const measured = status("probe-failed", "pending", {
      tools: {
        git: "/usr/bin/git",
        gh: null,
        node: "/opt/homebrew/bin/node",
        pnpm: "/opt/homebrew/bin/pnpm",
      },
    });

    expect(sessionEnvironmentAlert(measured, { name: "Acme" })).toMatchObject({
      title: "Sessions couldn't read your login PATH",
      detail: expect.stringContaining("Missing from the Session PATH: gh."),
    });
  });
});
