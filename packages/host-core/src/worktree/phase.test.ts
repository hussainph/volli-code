import { afterEach, describe, expect, it } from "vite-plus/test";

import { clearPhase, getPhase, resetPhasesForTest, setPhase } from "./phase";
import type { WorktreePhase } from "./types";

afterEach(() => resetPhasesForTest());

describe("phase registry", () => {
  it("starts empty (never persisted; recomputed from disk on boot)", () => {
    expect(getPhase("t1")).toBeNull();
  });

  it("records the current phase and fires onPhase on every transition", () => {
    const seen: WorktreePhase[] = [];
    const onPhase = (_: string, phase: WorktreePhase) => seen.push(phase);
    setPhase("t1", "creating", onPhase);
    setPhase("t1", "copying", onPhase);
    setPhase("t1", "ready", onPhase);
    expect(seen).toEqual(["creating", "copying", "ready"]);
    expect(getPhase("t1")).toBe("ready");
  });

  it("keys phases per ticket", () => {
    setPhase("t1", "creating");
    setPhase("t2", "failed");
    expect(getPhase("t1")).toBe("creating");
    expect(getPhase("t2")).toBe("failed");
  });

  it("clears a ticket's phase", () => {
    setPhase("t1", "ready");
    clearPhase("t1");
    expect(getPhase("t1")).toBeNull();
  });
});
