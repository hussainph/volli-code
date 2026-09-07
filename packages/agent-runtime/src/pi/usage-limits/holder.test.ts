import { usageLimitsProbeFailed, type UsageLimits } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { UsageLimitsHolder } from "./holder";

const NOW = Date.parse("2026-03-01T12:00:00Z");

const good: UsageLimits = {
  checkedAt: NOW,
  windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 37 }],
};
const failed = usageLimitsProbeFailed(NOW + 1);

describe("UsageLimitsHolder", () => {
  it("publishes a first sighting from the turn stream", () => {
    const holder = new UsageLimitsHolder();
    holder.apply("anthropic", { observedAt: NOW, windows: good.windows });
    expect(holder.get("anthropic")).toEqual(good);
  });

  it("holds one provider's reading apart from another's", () => {
    const holder = new UsageLimitsHolder();
    holder.apply("anthropic", { observedAt: NOW, windows: good.windows });
    expect(holder.get("openai-codex")).toBeUndefined();
  });

  it("leaves what is published alone when an update changes nothing", () => {
    const holder = new UsageLimitsHolder();
    holder.apply("anthropic", { observedAt: NOW, windows: good.windows });
    const published = holder.get("anthropic");
    // A confirming header mid-turn, then one that names no window at all.
    holder.apply("anthropic", { observedAt: NOW + 5, windows: good.windows });
    holder.apply("anthropic", { observedAt: NOW + 5, windows: [] });
    // The very same object, so a reader comparing by identity sees no change.
    expect(holder.get("anthropic")).toBe(published);
  });

  it("settles a verdict against what is held, keeping a good read over a failed one", () => {
    const holder = new UsageLimitsHolder();
    expect(holder.settle("anthropic", { kind: "verdict", limits: good })).toBe(good);
    expect(holder.settle("anthropic", { kind: "verdict", limits: failed })).toBe(good);
    expect(holder.get("anthropic")).toBe(good);
  });

  it("reports the failure when there is no good read to keep", () => {
    const holder = new UsageLimitsHolder();
    expect(holder.settle("anthropic", { kind: "verdict", limits: failed })).toBe(failed);
    expect(holder.get("anthropic")).toBe(failed);
  });

  it("answers a held probe with what is published, without touching it", () => {
    const holder = new UsageLimitsHolder();
    expect(holder.settle("anthropic", { kind: "held" })).toBeUndefined();
    holder.settle("anthropic", { kind: "verdict", limits: good });
    expect(holder.settle("anthropic", { kind: "held" })).toBe(good);
    expect(holder.get("anthropic")).toBe(good);
  });

  it("drops a signed-out provider's bars rather than leaving yesterday's on screen", () => {
    const holder = new UsageLimitsHolder();
    holder.settle("anthropic", { kind: "verdict", limits: good });
    expect(holder.settle("anthropic", { kind: "cleared" })).toBeUndefined();
    expect(holder.get("anthropic")).toBeUndefined();
    // A second `cleared` has nothing to clear and is not an error.
    expect(holder.settle("anthropic", { kind: "cleared" })).toBeUndefined();
  });
});
