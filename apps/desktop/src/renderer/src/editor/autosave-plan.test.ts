import { describe, expect, it } from "vite-plus/test";

import { AUTOSAVE_IDLE_MS, planAutosave } from "./autosave-plan";

const clean = { value: "body", baseline: "body", conflicted: false, writing: false };
const dirty = { ...clean, value: "body edited" };

describe("planAutosave", () => {
  it("saves a draft that has moved off its baseline", () => {
    expect(planAutosave(dirty)).toBe("save");
  });

  it("leaves a clean document alone", () => {
    // Writing identical bytes would churn the ticket record / the file's mtime
    // and read as an external change everywhere else the document is open.
    expect(planAutosave(clean)).toBe("skip-clean");
  });

  it("stays paused while the document is conflicted", () => {
    expect(planAutosave({ ...dirty, conflicted: true })).toBe("skip-conflicted");
  });

  it("coalesces rather than queues while a write is in flight", () => {
    expect(planAutosave({ ...dirty, writing: true })).toBe("skip-in-flight");
  });

  it("reports the conflict first when a paused document is also mid-write", () => {
    expect(planAutosave({ ...dirty, conflicted: true, writing: true })).toBe("skip-conflicted");
  });

  it("exports the shared idle interval both surfaces will import (PR 127)", () => {
    // Surfaces still hardcode 1500 locally in this PR on purpose; this constant
    // is the single source of truth they must converge on — never invent another.
    expect(AUTOSAVE_IDLE_MS).toBe(1500);
  });
});
