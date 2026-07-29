import { describe, expect, it } from "vite-plus/test";

import { parseHarnessId, type HarnessId } from "../ticket";
import { harnessTier, supportedEvents, type HarnessAdapter } from "./types";

/** A minimal Declared-tier adapter — nothing injected, nothing reported, no resume. */
function bareAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: parseHarnessId("my-harness") as HarnessId,
    label: "My Harness",
    command: "my-harness",
    promptFlag: null,
    detection: { executable: "my-harness" },
    surfaces: { skillsDir: null, commandsDir: null, instructionsFile: null },
    injection: { kind: "none" },
    sessionId: { kind: "none" },
    resume: { byId: null, latest: null, userResumeTokens: [] },
    events: [],
    launchSettings: [],
    ...overrides,
  };
}

describe("supportedEvents", () => {
  it("reports the canonical events, never the native names they arrived under", () => {
    const adapter = bareAdapter({
      events: [
        { event: "turn.completed", native: "Stop", delivery: "async", timeoutMs: 5000 },
        { event: "input.needed", native: "Notification", delivery: "async", timeoutMs: 5000 },
      ],
    });
    expect([...supportedEvents(adapter)]).toEqual(["turn.completed", "input.needed"]);
  });

  it("counts an event once however many native signals deliver it", () => {
    const adapter = bareAdapter({
      events: [
        {
          event: "input.needed",
          native: "hooks:PermissionRequest",
          delivery: "async",
          timeoutMs: 1,
        },
        { event: "input.needed", native: "notify:blocked", delivery: "async", timeoutMs: 1 },
      ],
    });
    expect(supportedEvents(adapter).size).toBe(1);
    expect(supportedEvents(adapter).has("input.needed")).toBe(true);
  });

  it("is empty for a harness that reports nothing", () => {
    expect(supportedEvents(bareAdapter()).size).toBe(0);
  });
});

describe("harnessTier", () => {
  const oneEvent = [
    { event: "turn.completed", native: "Stop", delivery: "async", timeoutMs: 5000 },
  ] as const;

  it("is hooked only when a harness can both be configured and report", () => {
    expect(
      harnessTier(
        bareAdapter({
          injection: { kind: "argv-settings-json", flag: "--settings" },
          events: oneEvent,
        }),
      ),
    ).toBe("hooked");
  });

  it("is not hooked when a harness declares events it has no way to be told about", () => {
    expect(harnessTier(bareAdapter({ events: oneEvent }))).toBe("declared");
  });

  it("is not hooked when a configurable harness reports nothing", () => {
    expect(
      harnessTier(bareAdapter({ injection: { kind: "argv-settings-json", flag: "--settings" } })),
    ).toBe("declared");
  });

  it("falls back to known when an unhooked harness can still resume", () => {
    expect(
      harnessTier(
        bareAdapter({ resume: { byId: ["--resume", "{id}"], latest: null, userResumeTokens: [] } }),
      ),
    ).toBe("known");
    expect(
      harnessTier(
        bareAdapter({ resume: { byId: null, latest: ["--continue"], userResumeTokens: [] } }),
      ),
    ).toBe("known");
  });

  it("is declared when a harness offers neither configuration nor resume", () => {
    expect(harnessTier(bareAdapter())).toBe("declared");
  });
});
