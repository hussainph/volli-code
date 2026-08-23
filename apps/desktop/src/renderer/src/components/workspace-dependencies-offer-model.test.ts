import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../ipc/contract";

import { workspaceDependenciesOffer } from "./workspace-dependencies-offer-model";

function status(
  overrides: Partial<CliToolStatus["environment"]["session"]> = {},
): Pick<CliToolStatus, "environment"> {
  return {
    environment: {
      loginPath: "/usr/bin",
      session: {
        path: "/volli/bin:/usr/bin",
        provenance: "adopted",
        interactiveProvenance: "already-complete",
        tools: {
          git: "/usr/bin/git",
          gh: "/opt/homebrew/bin/gh",
          node: "/opt/homebrew/bin/node",
          pnpm: "/opt/homebrew/bin/pnpm",
        },
        dependencies: "absent",
        installCommand: "pnpm install",
        ...overrides,
      },
      systemPathIssues: [],
      credentialHelperIssues: [],
    },
  };
}

describe("workspaceDependenciesOffer", () => {
  it("offers the workspace's own install command when its dependencies are absent", () => {
    expect(workspaceDependenciesOffer(status(), false)).toEqual({
      installCommand: "pnpm install",
    });
    // The lockfile decides, so a yarn workspace is never offered a pnpm run.
    expect(workspaceDependenciesOffer(status({ installCommand: "yarn install" }), false)).toEqual({
      installCommand: "yarn install",
    });
  });

  it("says nothing about a workspace with nothing to install", () => {
    expect(workspaceDependenciesOffer(status({ dependencies: "installed" }), false)).toBeNull();
    expect(
      workspaceDependenciesOffer(status({ dependencies: null, installCommand: null }), false),
    ).toBeNull();
  });

  // An offer is a button, and a button with no command behind it would be the
  // bare warning this whole surface exists to stop showing.
  it("makes no offer it could not carry out", () => {
    expect(workspaceDependenciesOffer(status({ installCommand: null }), false)).toBeNull();
  });

  it("stays quiet once the answer has been given", () => {
    expect(workspaceDependenciesOffer(status(), true)).toBeNull();
  });
});
