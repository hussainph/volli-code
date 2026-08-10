import { describe, expect, it } from "vite-plus/test";
import { FIRST_CLASS_HARNESS_IDS, type HarnessAdapter, type HarnessId } from "@volli/shared";

import { activeHarness, harnessListings } from "./harness-catalog";

/** A registered manifest's adapter — the BYO half of the list. */
const adapter = (overrides: Partial<HarnessAdapter> = {}): HarnessAdapter => ({
  id: "my-agent" as HarnessId,
  label: "My Agent",
  command: "my-agent",
  promptFlag: "-p",
  surfaces: { skillsDir: null, commandsDir: null, instructionsFile: null },
  injection: { kind: "claude-settings-json", flag: "--settings" },
  sessionId: { kind: "reported" },
  resume: { byId: null, latest: null, userResumeTokens: [] },
  events: [{ event: "session.started", native: "SessionStart", delivery: "async" }],
  startupEvent: "session.started",
  sessionMarkers: [],
  launchSettings: [],
  ...overrides,
});

describe("harnessListings", () => {
  it("leads with every first-class harness, in the published order", () => {
    const builtIn = harnessListings([]);

    expect(builtIn.map((listing) => listing.id)).toEqual([...FIRST_CLASS_HARNESS_IDS]);
    expect(builtIn.every((listing) => listing.origin === "built-in")).toBe(true);
  });

  it("carries each built-in's own executable name, not its id", () => {
    const byId = new Map(harnessListings([]).map((listing) => [listing.id, listing]));

    expect(byId.get("claude-code")?.command).toBe("claude");
    expect(byId.get("cursor")?.command).toBe("cursor-agent");
    // The label the whole app displays, fixed at the house spelling.
    expect(byId.get("opencode")?.label).toBe("OpenCode");
  });

  it("appends registered manifests after the built-ins, sorted by label", () => {
    const listings = harnessListings([
      adapter({ id: "zeta" as HarnessId, label: "Zeta", command: "zeta" }),
      adapter({ id: "aider" as HarnessId, label: "Aider", command: "aider" }),
    ]);

    expect(listings.slice(FIRST_CLASS_HARNESS_IDS.length)).toEqual([
      { id: "aider", label: "Aider", command: "aider", origin: "registered" },
      { id: "zeta", label: "Zeta", command: "zeta", origin: "registered" },
    ]);
  });

  it("never lists a first-class harness twice, whatever main sends", () => {
    const listings = harnessListings([
      adapter({ id: "opencode" as HarnessId, label: "OpenCode", command: "opencode" }),
    ]);

    expect(listings.filter((listing) => listing.id === "opencode")).toHaveLength(1);
    expect(listings).toHaveLength(FIRST_CLASS_HARNESS_IDS.length);
  });
});

describe("activeHarness", () => {
  it("resolves the selected id", () => {
    expect(activeHarness(harnessListings([]), "cursor")?.id).toBe("cursor");
  });

  it("falls back to the first listing when the selection no longer exists", () => {
    // A registered manifest can lose its trust while settings are open.
    expect(activeHarness(harnessListings([]), "revoked")?.id).toBe(FIRST_CLASS_HARNESS_IDS[0]);
    expect(activeHarness(harnessListings([]), null)?.id).toBe(FIRST_CLASS_HARNESS_IDS[0]);
  });

  it("is null only when there is nothing to select", () => {
    expect(activeHarness([], "cursor")).toBeNull();
  });
});
