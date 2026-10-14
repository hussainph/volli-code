/**
 * The rail's search index against the panes it indexes.
 *
 * A settings row a person can SEE and cannot FIND is a setting that may as
 * well not be there, and the e2e audit that catches it
 * (`settings-search-smoke.mjs`, "every visible label finds this page") is a
 * sharded smoke that costs minutes. This is the same rule stated where it
 * costs milliseconds.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { EXPERIMENTS, MODEL_TIER_ROWS, resolveExperiments } from "@volli/shared";

import { MODELS_CATEGORY_KEY, settingsGroups } from "./settings-groups";

function keywordsFor(key: string): readonly string[] {
  for (const group of settingsGroups()) {
    for (const category of group.categories) {
      if (category.key === key) return [category.label, ...(category.keywords ?? [])];
    }
  }
  throw new Error(`no settings category ${key}`);
}

describe("Settings → General", () => {
  it("offers window preferences, with no app-wide Protection experiment or search entry", () => {
    const general = settingsGroups()
      .flatMap((group) => group.categories)
      .find((category) => category.key === "general");
    expect(general).toBeDefined();
    const html = renderToStaticMarkup(general?.content);

    expect(html).toContain("Show the project switcher");
    expect(html).toContain("Keep the sidebar open");
    expect(html).not.toContain("Protection");
    expect(html).not.toContain("experimental");
    expect(keywordsFor("general").some((term) => term.includes("protection"))).toBe(false);
  });
});

function categories(experiments: ReturnType<typeof resolveExperiments> | null) {
  return settingsGroups(undefined, { experiments }).flatMap((group) => group.categories);
}

describe("Settings → Experimental", () => {
  it("omits the empty Experimental category on stable and shows it on dev/canary or an env opt-in", () => {
    expect(categories(null).some(({ key }) => key === "experimental")).toBe(false);
    expect(
      categories(resolveExperiments({ cloud: true }, [], "stable")).some(
        ({ key }) => key === "experimental",
      ),
    ).toBe(false);
    for (const kind of ["dev", "canary"] as const) {
      expect(
        categories(resolveExperiments({}, [], kind)).some(({ key }) => key === "experimental"),
      ).toBe(true);
    }
    expect(
      categories(resolveExperiments({}, ["cloud"], "stable")).some(
        ({ key }) => key === "experimental",
      ),
    ).toBe(true);
  });
  it("lists the registry in System and makes its flag discoverable from the rail", () => {
    const system = settingsGroups(undefined, {
      experiments: resolveExperiments({}, [], "canary"),
    }).find((group) => group.key === "system");
    const experimental = system?.categories.find((category) => category.key === "experimental");
    expect(experimental).toBeDefined();
    if (!experimental) throw new Error("no Experimental category under System");

    expect(experimental.label).toBe("Experimental");
    const terms = [experimental.label, ...(experimental.keywords ?? [])].map((term) =>
      term.toLowerCase(),
    );
    expect(terms).toContain("cloud");
    expect(terms).toContain("feature flags");

    const html = renderToStaticMarkup(experimental.content);
    for (const experiment of EXPERIMENTS) {
      expect(html).toContain(experiment.label);
      expect(html).toContain(experiment.description);
      expect(
        terms.some((term) => term.includes(experiment.label.toLowerCase())),
        `${experiment.label} is drawn in Experimental but nothing in the rail finds it`,
      ).toBe(true);
    }
  });
});

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

  it("finds the Code Mode section by its labels and the words someone looks for it by (VC-471)", () => {
    const terms = keywordsFor(MODELS_CATEGORY_KEY).map((term) => term.toLowerCase());

    // The section title and switch ("Code Mode"), the row behind Advanced,
    // and what a person who has only heard of it types.
    for (const label of ["Code Mode", "Pin a model", "codemode", "sandbox", "javascript"]) {
      expect(
        terms.some((term) => term.includes(label.toLowerCase())),
        `${label} should find Settings → Models`,
      ).toBe(true);
    }
  });
});

describe("the Storage category's search index", () => {
  it("finds the orphaned Pi log row by the label on screen", () => {
    const terms = keywordsFor("storage").map((term) => term.toLowerCase());

    expect(terms).toContain("orphaned logs");
  });

  it("finds the saved tool output row by the label on screen (VC-469)", () => {
    expect(keywordsFor("storage").map((term) => term.toLowerCase())).toContain("saved tool output");
  });

  it("finds every label the Running processes section draws (VC-341)", () => {
    // The three strings that section puts on screen. The rail matches a
    // lowercased substring, so each visible label must be inside some term.
    const terms = keywordsFor("storage").map((term) => term.toLowerCase());

    for (const label of ["Running processes", "No Session owns", "Reap under memory pressure"]) {
      expect(
        terms.some((term) => term.includes(label.toLowerCase())),
        `${label} is drawn in Settings → Storage but nothing in the rail finds it`,
      ).toBe(true);
    }
  });
});

describe("retired review settings", () => {
  it("offers no review or display-hint entries while retaining classify", () => {
    expect(keywordsFor("appearance")).not.toContain("show auto mode hints");
    expect(keywordsFor("appearance")).not.toContain("auto mode hints");
    const terms = keywordsFor(MODELS_CATEGORY_KEY);
    expect(terms).not.toContain("shadow review");
    expect(terms).not.toContain("block reason");
    expect(terms).toContain("classify");
  });
});
