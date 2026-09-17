/**
 * The two lookups, asserted as a table.
 *
 * The thing worth pinning is not which path string a vendor has — that is the
 * vendor's own artwork and a test of it would only restate the file. It is that
 * the two vocabularies AGREE: `codex` and `openai-codex` are one company seen
 * from the harness side and the provider side, and a build where they drew two
 * different marks would put the same vendor on a row twice over.
 */
import { describe, expect, it } from "vite-plus/test";
import { FIRST_CLASS_HARNESS_IDS, type HarnessId } from "@volli/shared";

import { harnessVendorMark, providerVendorMark, VENDOR_MARKS } from "./vendor-marks";

describe("vendor marks", () => {
  it("draws every first-class harness, each with its own artwork", () => {
    const marks = FIRST_CLASS_HARNESS_IDS.map((id) => harnessVendorMark(id));

    for (const mark of marks) expect(mark).not.toBeNull();
    // Told apart with every word hidden — the acceptance the band is judged on.
    expect(new Set(marks.map((mark) => mark?.path)).size).toBe(FIRST_CLASS_HARNESS_IDS.length);
  });

  it("names no mark for a Session that runs no CLI, and none it could invent for a custom one", () => {
    expect(harnessVendorMark(null)).toBeNull();
    // A bring-your-own slug: a second generic symbol would only teach a reader
    // a glyph that says "not one of the four".
    expect(harnessVendorMark("my-custom-harness" as HarnessId)).toBeNull();
  });

  it("draws the four providers a structured Session can be billed through", () => {
    expect(providerVendorMark("anthropic")).toBe(VENDOR_MARKS.anthropic);
    expect(providerVendorMark("openai-codex")).toBe(VENDOR_MARKS.openai);
    expect(providerVendorMark("opencode-go")).toBe(VENDOR_MARKS.opencode);
    expect(providerVendorMark("zai")).toBe(VENDOR_MARKS.zai);
  });

  it("agrees with itself across the two vocabularies", () => {
    // The whole reason both tables live in one module. A harness and the
    // provider behind the same vendor must be one drawing.
    expect(harnessVendorMark("claude-code")).toBe(providerVendorMark("anthropic"));
    expect(harnessVendorMark("codex")).toBe(providerVendorMark("openai-codex"));
    expect(harnessVendorMark("opencode")).toBe(providerVendorMark("opencode-go"));
  });

  it("stays silent about a provider this build has no artwork for", () => {
    // 39 providers ship through pi and four of them have a mark here. The rest
    // keep the status dot rather than a lettermark: a band of Sessions is
    // scanned for status, and two kinds of thing in that column is one too many.
    expect(providerVendorMark(null)).toBeNull();
    expect(providerVendorMark("acme-ai")).toBeNull();
  });
});
