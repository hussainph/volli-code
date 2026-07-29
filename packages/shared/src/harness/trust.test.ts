import { describe, expect, it } from "vite-plus/test";

import { buildLaunchConfig } from "./launch";
import { parseHarnessManifest } from "./manifest";
import {
  harnessEventStatus,
  harnessTrustDecision,
  harnessTrustPrompt,
  isHarnessTrustVerdict,
} from "./trust";
import type { HarnessAdapter, HarnessEvent } from "./types";

function registered(): HarnessAdapter {
  const parsed = parseHarnessManifest({
    manifestVersion: 1,
    slug: "my-harness",
    label: "My Harness",
    command: "my-harness",
    injection: { kind: "claude-settings-json", flag: "--settings" },
    events: [
      { event: "input.needed", native: "Notification", delivery: "async", timeoutMs: 5000 },
      { event: "turn.completed", native: "Stop", delivery: "async", timeoutMs: 5000 },
    ],
  });
  if (!parsed.ok) throw new Error("expected a valid manifest");
  return parsed.adapter;
}

describe("harnessTrustDecision", () => {
  it("holds a manifest nobody has ruled on yet", () => {
    expect(
      harnessTrustDecision({ currentHash: "a1", recordedHash: null, recordedVerdict: null }),
    ).toBe("reconfirm");
  });

  it("launches a trusted manifest that has not changed", () => {
    expect(
      harnessTrustDecision({ currentHash: "a1", recordedHash: "a1", recordedVerdict: "trusted" }),
    ).toBe("trusted");
  });

  it("re-asks when a trusted manifest changed by one byte", () => {
    expect(
      harnessTrustDecision({ currentHash: "a2", recordedHash: "a1", recordedVerdict: "trusted" }),
    ).toBe("reconfirm");
  });

  it("keeps refusing a manifest the user refused, unchanged", () => {
    expect(
      harnessTrustDecision({ currentHash: "a1", recordedHash: "a1", recordedVerdict: "blocked" }),
    ).toBe("blocked");
  });

  it("re-asks when a refused manifest has since been edited", () => {
    expect(
      harnessTrustDecision({ currentHash: "a2", recordedHash: "a1", recordedVerdict: "blocked" }),
    ).toBe("reconfirm");
  });

  it("blocks when there is no manifest left on disk to launch", () => {
    expect(
      harnessTrustDecision({ currentHash: null, recordedHash: "a1", recordedVerdict: "trusted" }),
    ).toBe("blocked");
  });
});

describe("isHarnessTrustVerdict", () => {
  it("accepts the two verdicts a human can give", () => {
    expect(isHarnessTrustVerdict("trusted")).toBe(true);
    expect(isHarnessTrustVerdict("blocked")).toBe(true);
  });

  it("refuses `reconfirm` — that is what Volli concludes, never what a human answered", () => {
    expect(isHarnessTrustVerdict("reconfirm")).toBe(false);
  });

  it("refuses anything that is not a verdict at all", () => {
    expect(isHarnessTrustVerdict(undefined)).toBe(false);
  });
});

describe("harnessTrustPrompt", () => {
  it("states the binary and the exact argv the launch will use, not a paraphrase of them", () => {
    const adapter = registered();
    const launch = buildLaunchConfig(adapter, {
      socketPath: "/tmp/volli.sock",
      hookArgv: ["/Applications/Volli.app/bin/volli", "hook", "my-harness"],
    });
    const prompt = harnessTrustPrompt(adapter, {
      binaryPath: "/opt/homebrew/bin/my-harness",
      launchArgv: launch.argv,
    });
    expect(prompt.slug).toBe("my-harness");
    expect(prompt.label).toBe("My Harness");
    expect(prompt.binaryPath).toBe("/opt/homebrew/bin/my-harness");
    expect(prompt.argv).toEqual(["/opt/homebrew/bin/my-harness", ...launch.argv]);
    expect(prompt.argv[1]).toBe("--settings");
  });

  it("names what the manifest claims it will report, once per canonical event", () => {
    const prompt = harnessTrustPrompt(registered(), { binaryPath: "/bin/mh", launchArgv: [] });
    expect(prompt.claimedEvents).toEqual(["input.needed", "turn.completed"]);
  });
});

describe("harnessEventStatus", () => {
  const declared = new Set<HarnessEvent>(["input.needed", "turn.completed"]);

  it("reads a delivered event as verified", () => {
    const verified = new Set<HarnessEvent>(["input.needed"]);
    expect(harnessEventStatus("input.needed", { declared, verified })).toBe("verified");
  });

  it("reads a claimed but never delivered event as unconfirmed", () => {
    expect(harnessEventStatus("turn.completed", { declared, verified: new Set() })).toBe(
      "unconfirmed",
    );
  });

  it("reads an event nobody claimed and nobody delivered as absent", () => {
    expect(harnessEventStatus("session.ended", { declared, verified: new Set() })).toBe("absent");
  });

  it("verifies an event that arrived without being claimed — delivery is the evidence", () => {
    const verified = new Set<HarnessEvent>(["session.ended"]);
    expect(harnessEventStatus("session.ended", { declared, verified })).toBe("verified");
  });
});
