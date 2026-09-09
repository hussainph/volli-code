/**
 * The rail's search index against the panes it indexes.
 *
 * A settings row a person can SEE and cannot FIND is a setting that may as
 * well not be there, and the e2e audit that catches it
 * (`settings-search-smoke.mjs`, "every visible label finds this page") is a
 * sharded smoke that costs minutes. This is the same rule stated where it
 * costs milliseconds.
 */
import { describe, expect, it } from "vite-plus/test";
import { MODEL_TIER_ROWS } from "@volli/shared";

import { MODELS_CATEGORY_KEY, settingsGroups } from "./settings-groups";

function keywordsFor(key: string): readonly string[] {
  for (const group of settingsGroups()) {
    for (const category of group.categories) {
      if (category.key === key) return [category.label, ...(category.keywords ?? [])];
    }
  }
  throw new Error(`no settings category ${key}`);
}

describe("the Models category's search index", () => {
  it("finds every default-model row by its own label", () => {
    // The rail matches a lowercased substring, so the stored terms are
    // compared the same way the shell compares them.
    const terms = keywordsFor(MODELS_CATEGORY_KEY).map((term) => term.toLowerCase());

    for (const row of MODEL_TIER_ROWS) {
      expect(
        terms.some((term) => term.includes(row.label.toLowerCase())),
        `${row.label} is drawn in Model Access but nothing in the rail finds it`,
      ).toBe(true);
    }
  });
});

describe("the Storage category's search index", () => {
  it("finds the orphaned Pi log row by the label on screen", () => {
    const terms = keywordsFor("storage").map((term) => term.toLowerCase());

    expect(terms).toContain("orphaned logs");
  });
});
