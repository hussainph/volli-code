import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_PROJECT_THEME_OVERRIDE,
  PROJECT_COLORS,
  type ProjectThemeOverride,
} from "@volli/shared";

import {
  autoTintChoice,
  projectAppChoice,
  projectEditorChoice,
  projectTerminalOverlayEdits,
  withProjectAppChoice,
  withProjectEditorChoice,
} from "./project-appearance-model";

function override(over: Partial<ProjectThemeOverride> = {}): ProjectThemeOverride {
  return { ...EMPTY_PROJECT_THEME_OVERRIDE, ...over };
}

describe("projectAppChoice", () => {
  it("reads no override at all as Inherit", () => {
    expect(projectAppChoice(null)).toEqual({ kind: "inherit" });
  });

  it("reads an override that sets no app field as Inherit", () => {
    expect(projectAppChoice(override({ editorThemeId: "nord" }))).toEqual({ kind: "inherit" });
  });

  it("reads a stored seed as the auto-tint choice", () => {
    expect(projectAppChoice(override({ seed: "#E8652A" }))).toEqual({
      kind: "auto-tint",
      seed: "#E8652A",
    });
  });

  it("reads a named theme as the theme choice", () => {
    expect(projectAppChoice(override({ appThemeSlug: "sunset" }))).toEqual({
      kind: "theme",
      slug: "sunset",
    });
  });

  it("prefers the named theme over a retained seed, exactly as the app is painted", () => {
    // resolveActiveTheme resolves the slug first; a control that said
    // "auto-tint" here would describe a window that isn't tinted.
    expect(projectAppChoice(override({ appThemeSlug: "sunset", seed: "#E8652A" }))).toEqual({
      kind: "theme",
      slug: "sunset",
    });
  });
});

describe("projectEditorChoice", () => {
  it("reads no override at all as Inherit", () => {
    expect(projectEditorChoice(null)).toEqual({ kind: "inherit" });
  });

  it("reads a null editor id as Inherit", () => {
    expect(projectEditorChoice(override({ appThemeSlug: "sunset" }))).toEqual({ kind: "inherit" });
  });

  it("reads a stored catalog id as the theme choice", () => {
    expect(projectEditorChoice(override({ editorThemeId: "nord" }))).toEqual({
      kind: "theme",
      themeId: "nord",
    });
  });
});

describe("withProjectAppChoice", () => {
  it("clears the slug AND the seed on Inherit", () => {
    // Dropping only the slug would leave the project tinted by its seed —
    // "a seed and no slug" IS the auto-tint state.
    expect(
      withProjectAppChoice(override({ appThemeSlug: "sunset", seed: "#E8652A" }), {
        kind: "inherit",
      }),
    ).toBeNull();
  });

  it("keeps the override alive when another surface still overrides", () => {
    expect(
      withProjectAppChoice(override({ appThemeSlug: "sunset", editorThemeId: "nord" }), {
        kind: "inherit",
      }),
    ).toEqual(override({ editorThemeId: "nord" }));
  });

  it("stores an auto-tint as a seed with no slug", () => {
    expect(
      withProjectAppChoice(override({ appThemeSlug: "sunset" }), {
        kind: "auto-tint",
        seed: "#5E7A8B",
      }),
    ).toEqual(override({ seed: "#5E7A8B" }));
  });

  it("retains a seed when a named theme is chosen, so auto-tint can be switched back on", () => {
    expect(
      withProjectAppChoice(override({ seed: "#E8652A" }), { kind: "theme", slug: "sunset" }),
    ).toEqual(override({ appThemeSlug: "sunset", seed: "#E8652A" }));
  });

  it("starts from all-inheriting when the project has no override yet", () => {
    expect(withProjectAppChoice(null, { kind: "theme", slug: "sunset" })).toEqual(
      override({ appThemeSlug: "sunset" }),
    );
    expect(withProjectAppChoice(null, { kind: "inherit" })).toBeNull();
  });
});

describe("withProjectEditorChoice", () => {
  it("stores a catalog id, leaving the app surface alone", () => {
    expect(
      withProjectEditorChoice(override({ appThemeSlug: "sunset" }), {
        kind: "theme",
        themeId: "nord",
      }),
    ).toEqual(override({ appThemeSlug: "sunset", editorThemeId: "nord" }));
  });

  it("collapses to no override when the editor was the last surface set", () => {
    expect(
      withProjectEditorChoice(override({ editorThemeId: "nord" }), { kind: "inherit" }),
    ).toBeNull();
  });

  it("starts from all-inheriting when the project has no override yet", () => {
    expect(withProjectEditorChoice(null, { kind: "theme", themeId: "nord" })).toEqual(
      override({ editorThemeId: "nord" }),
    );
  });
});

describe("autoTintChoice", () => {
  it("seeds the tint from the project's own rail color (#72)", () => {
    expect(autoTintChoice(2)).toEqual({ kind: "auto-tint", seed: PROJECT_COLORS[2] });
  });

  it("wraps a colorIndex past the end of the palette, as the rail does", () => {
    expect(autoTintChoice(PROJECT_COLORS.length)).toEqual({
      kind: "auto-tint",
      seed: PROJECT_COLORS[0],
    });
  });
});

describe("projectTerminalOverlayEdits", () => {
  it("writes the ghostty theme key for a named terminal theme", () => {
    expect(projectTerminalOverlayEdits({ kind: "theme", name: "Nord" })).toEqual({ theme: "Nord" });
  });

  it("REMOVES the key on Inherit, rather than writing a default over the user's config", () => {
    // The project overlay is the last layer in the chain (#67): leaving a key
    // behind would pin the terminal to whatever Volli last wrote.
    expect(projectTerminalOverlayEdits({ kind: "inherit" })).toEqual({ theme: null });
  });
});
