import { describe, expect, it } from "vite-plus/test";
import { isSharedPreferenceKey, mergePreferenceSnapshot } from "../preference-patch";

const json = JSON.stringify;
describe("concurrent presentation preference snapshots", () => {
  it("merges independent main-window and Settings changes", () => {
    const base = { state: { sidebarWidth: 300, costVisible: true }, version: 1 };
    const current = { ...base, state: { ...base.state, sidebarWidth: 420 } };
    const next = { ...base, state: { ...base.state, costVisible: false } };
    expect(JSON.parse(mergePreferenceSnapshot(json(current), json(base), json(next)))).toEqual({
      state: { sidebarWidth: 420, costVisible: false }, version: 1,
    });
  });
  it("merges separate project style overrides and retains intentional deletions", () => {
    const base = { state: { projects: { a: "macos" }, motion: true } };
    const current = { state: { projects: { a: "macos", b: "modern" }, motion: true } };
    const next = { state: { projects: {}, motion: false } };
    expect(JSON.parse(mergePreferenceSnapshot(json(current), json(base), json(next)))).toEqual({
      state: { projects: { b: "modern" }, motion: false },
    });
  });
  it("uses last explicit intent on one field and treats arrays atomically", () => {
    expect(mergePreferenceSnapshot('{"a":3,"b":[1,2]}', '{"a":1,"b":[1]}', '{"a":2,"b":[3]}')).toBe('{"a":2,"b":[3]}');
  });
  it("does not resurrect unchanged fields after another writer removed them", () => {
    expect(mergePreferenceSnapshot('{"state":{}}', '{"state":{"a":1,"b":1}}', '{"state":{"a":1,"b":2}}')).toBe('{"state":{"b":2}}');
  });
  it("preserves string storage for missing, cleared, or malformed snapshots", () => {
    for (const current of [undefined, "corrupt"]) expect(mergePreferenceSnapshot(current, "{}", '{"a":1}')).toBe('{"a":1}');
    expect(mergePreferenceSnapshot("{}", undefined, "raw")).toBe("raw");
    expect(mergePreferenceSnapshot("{}", "bad", "raw")).toBe("raw");
    expect(mergePreferenceSnapshot("{}", "{}", "")).toBe("");
  });
  it("treats prototype-named JSON keys as data", () => {
    const next = '{"__proto__":{"polluted":true}}';
    expect(JSON.parse(mergePreferenceSnapshot("{}", "{}", next))).toEqual(JSON.parse(next));
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });
  it("limits merging to shared layout/style preferences, never navigation or drafts", () => {
    expect(isSharedPreferenceKey("volli:ui")).toBe(true);
    expect(isSharedPreferenceKey("volli:style")).toBe(true);
    expect(isSharedPreferenceKey("volli:workspace")).toBe(false);
    expect(isSharedPreferenceKey("volli:chat-drafts")).toBe(false);
  });
});
