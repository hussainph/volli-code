import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../ipc/contract";

import {
  projectEnvironmentReadiness,
  sessionEnvironmentMeasurement,
} from "./session-environment-alert-model";

const DEFAULT_TOOLS = {
  git: "/usr/bin/git",
  gh: "/opt/homebrew/bin/gh",
  node: "/opt/homebrew/bin/node",
  npm: "/opt/homebrew/bin/npm",
  pnpm: "/opt/homebrew/bin/pnpm",
  yarn: null,
  bun: null,
};
const MISSING_TOOLS = {
  git: null,
  gh: null,
  node: null,
  npm: null,
  pnpm: null,
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

const PROJECT = { id: "project-a", name: "Acme" };

describe("sessionEnvironmentMeasurement", () => {
  it("stays quiet for healthy adoption or a failed probe that still resolves git", () => {
    for (const measured of [
      status("adopted", "already-complete"),
      status("already-complete", "pending"),
      status("probe-failed", "probe-failed"),
    ]) {
      expect(sessionEnvironmentMeasurement(measured, PROJECT)).toEqual({
        faults: [],
        notices: [],
      });
    }
  });

  it("does not call one failed pass an app fault, including pending recovery", () => {
    for (const measured of [
      status("probe-failed", "adopted", { tools: MISSING_TOOLS }),
      status("adopted", "probe-failed", { tools: MISSING_TOOLS }),
      status("probe-failed", "pending", { tools: MISSING_TOOLS }),
    ]) {
      expect(sessionEnvironmentMeasurement(measured).faults).toEqual([]);
      expect(sessionEnvironmentMeasurement(measured).notices).toEqual([]);
      expect(sessionEnvironmentMeasurement(measured, PROJECT).notices[0]?.fault).toBeNull();
    }
  });

  it("raises a git-only app fault when both passes failed and repository git is missing", () => {
    expect(
      sessionEnvironmentMeasurement(
        status("probe-failed", "probe-failed", { tools: MISSING_TOOLS }),
      ),
    ).toEqual({
      faults: ["login-path-unreadable"],
      notices: [
        {
          fault: "login-path-unreadable",
          key: "login-path-unreadable",
          title: "Volli couldn't read your terminal's PATH",
          detail: "Sessions can't find git.",
        },
      ],
    });
  });

  it("keeps the app fault first and readiness behind it for independent dismissals", () => {
    const measurement = sessionEnvironmentMeasurement(
      status("probe-failed", "probe-failed", { tools: MISSING_TOOLS }),
      PROJECT,
    );
    expect(measurement.notices.map((notice) => notice.fault)).toEqual([
      "login-path-unreadable",
      null,
    ]);
    expect(measurement.notices[1]?.detail).toBe("Missing from the Session PATH: git");
  });

  it.each(["adopted", "probe-failed"] as const)(
    "ignores every non-git tool even when required and PATH adoption is %s",
    (provenance) => {
      for (const tool of ["node", "npm", "pnpm", "yarn", "bun"] as const) {
        const measured = status(provenance, "probe-failed", {
          tools: { ...MISSING_TOOLS, git: "/usr/bin/git" },
          requiredTools: ["git", tool],
          dependencies: "absent",
          installCommand: `${tool} install`,
        });
        expect(sessionEnvironmentMeasurement(measured, PROJECT)).toEqual({
          faults: [],
          notices: [],
        });
      }
    },
  );

  it("does not require git for a workspace that did not imply it", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: MISSING_TOOLS,
      requiredTools: ["node", "pnpm"],
    });
    expect(sessionEnvironmentMeasurement(measured, PROJECT)).toEqual({ faults: [], notices: [] });
  });

  it("does not mutate the full agent-facing environment evidence", () => {
    const measured = status("probe-failed", "probe-failed", {
      tools: MISSING_TOOLS,
      dependencies: "absent",
      installCommand: "pnpm install",
    });
    const before = structuredClone(measured);
    sessionEnvironmentMeasurement(measured, PROJECT);
    expect(measured).toEqual(before);
    expect(measured.environment.session.requiredTools).toEqual(["git", "node", "pnpm"]);
  });
});

describe("projectEnvironmentReadiness", () => {
  it("names only missing git, whatever other tools or dependencies are absent", () => {
    expect(
      projectEnvironmentReadiness(
        status("adopted", "already-complete", {
          tools: MISSING_TOOLS,
          dependencies: "absent",
          installCommand: "pnpm install",
        }),
        { name: "Acme" },
      ),
    ).toEqual({
      fault: null,
      key: "readiness:Acme:git",
      title: "Sessions aren't ready for Acme",
      detail: "Missing from the Session PATH: git",
    });
  });

  it("keeps the durable git-only key across renames and non-git measurement changes", () => {
    const gitMissing = status("adopted", "already-complete", {
      tools: { ...DEFAULT_TOOLS, git: null },
    });
    const allMissing = status("adopted", "already-complete", { tools: MISSING_TOOLS });
    const first = projectEnvironmentReadiness(gitMissing, PROJECT);
    expect(first?.key).toBe("readiness:project-a:git");
    expect(projectEnvironmentReadiness(allMissing, { ...PROJECT, name: "Renamed" })?.key).toBe(
      first?.key,
    );
    expect(
      projectEnvironmentReadiness(allMissing, { id: "project-b", name: "Acme" })?.key,
    ).not.toBe(first?.key);
  });

  it("stays quiet with no project, for ready git, and for dependencies alone", () => {
    expect(
      projectEnvironmentReadiness(
        status("adopted", "already-complete", { tools: MISSING_TOOLS }),
        null,
      ),
    ).toBeNull();
    for (const installCommand of ["pnpm install", "yarn install", null]) {
      expect(
        projectEnvironmentReadiness(
          status("adopted", "already-complete", { dependencies: "absent", installCommand }),
          PROJECT,
        ),
      ).toBeNull();
    }
  });
});
