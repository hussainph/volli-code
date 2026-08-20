import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../ipc/contract";

import { sessionEnvironmentAlert } from "./session-environment-alert-model";

function status(
  provenance: CliToolStatus["environment"]["session"]["provenance"],
  interactiveProvenance: CliToolStatus["environment"]["session"]["interactiveProvenance"],
): Pick<CliToolStatus, "environment"> {
  return {
    environment: {
      loginPath: "/usr/bin:/opt/homebrew/bin",
      session: {
        path: "/volli/bin:/usr/bin:/opt/homebrew/bin",
        provenance,
        interactiveProvenance,
      },
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
});
