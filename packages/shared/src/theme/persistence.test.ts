import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_THEME } from "./definition";
import type { ThemeCanvas, ThemeDefinition } from "./definition";
import type { ShippedEditorThemeId } from "./editor-themes";
import {
  EMPTY_PROJECT_THEME_OVERRIDE,
  isProjectThemeOverride,
  isProjectThemeOverrideEmpty,
  isThemeDefinition,
  parseThemeJson,
  serializeGlobalTheme,
  parseGlobalEditorThemeId,
  serializeGlobalEditorThemeId,
  THEME_APP_STATE_KEY,
  THEME_EDITOR_APP_STATE_KEY,
} from "./persistence";

describe("global theme persistence", () => {
  it("stores the authored definition under the `theme` app_state key", () => {
    expect(THEME_APP_STATE_KEY).toBe("theme");
  });

  it("stores the global editor theme id under a dedicated app_state key", () => {
    expect(THEME_EDITOR_APP_STATE_KEY).toBe("theme_editor");
  });

  it("round-trips a global editor theme id and treats absent/empty as derive-from-app", () => {
    expect(parseGlobalEditorThemeId(serializeGlobalEditorThemeId("nord"))).toBe("nord");
    expect(parseGlobalEditorThemeId(serializeGlobalEditorThemeId(null))).toBeNull();
    expect(parseGlobalEditorThemeId(undefined)).toBeNull();
    expect(parseGlobalEditorThemeId(null)).toBeNull();
    expect(parseGlobalEditorThemeId("")).toBeNull();
  });

  it("treats a non-catalog editor theme id as derive-from-app", () => {
    expect(parseGlobalEditorThemeId("volli-dark")).toBeNull();
    expect(parseGlobalEditorThemeId("not-a-theme")).toBeNull();
    expect(parseGlobalEditorThemeId("vs-dark")).toBeNull();
    expect(serializeGlobalEditorThemeId("volli-dark" as ShippedEditorThemeId)).toBe("");
    expect(serializeGlobalEditorThemeId("not-a-theme" as ShippedEditorThemeId)).toBe("");
  });

  it("round-trips an authored definition", () => {
    expect(parseThemeJson(serializeGlobalTheme(DEFAULT_THEME))).toEqual(DEFAULT_THEME);
  });

  // docs/plans/theming-engine.md § Derived rules, first bullet: the resolved
  // token set is DERIVED at render time and persisted nowhere. VS Code's
  // most-complained-about theming bug is auto-switching writing the resolved
  // theme back over the user's authored intent.
  it("never persists a resolved token set", () => {
    const smuggled = {
      ...DEFAULT_THEME,
      tokens: { "--background": "#15100e", "--foreground": "#f5f5f5" },
    } as ThemeDefinition;
    const json = serializeGlobalTheme(smuggled);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed["tokens"]).toBeUndefined();
    expect(json).not.toContain("--");
    expect(Object.keys(parsed).toSorted()).toEqual(
      ["accent", "appearance", "canvas", "grain", "name", "overrides", "seed", "slug"].toSorted(),
    );
  });

  it("keeps the theme's own sparse authored overrides — those are intent, not resolution", () => {
    const authored: ThemeDefinition = {
      ...DEFAULT_THEME,
      overrides: { "--border-strong": "#4a3227" },
    };
    const parsed = parseThemeJson(serializeGlobalTheme(authored));
    expect(parsed?.overrides).toEqual({ "--border-strong": "#4a3227" });
  });

  it("reports null for a missing, malformed, or wrong-shaped value", () => {
    expect(parseThemeJson(undefined)).toBeNull();
    expect(parseThemeJson("")).toBeNull();
    expect(parseThemeJson("{ not json")).toBeNull();
    expect(parseThemeJson('{"name":"X"}')).toBeNull();
    expect(parseThemeJson("[]")).toBeNull();
  });

  it("guards a definition's shape", () => {
    expect(isThemeDefinition(DEFAULT_THEME)).toBe(true);
    expect(isThemeDefinition({ ...DEFAULT_THEME, seed: 42 })).toBe(false);
    expect(isThemeDefinition({ ...DEFAULT_THEME, canvas: { kind: "hologram" } })).toBe(false);
    expect(isThemeDefinition({ ...DEFAULT_THEME, overrides: { "--border": 3 } })).toBe(false);
    expect(isThemeDefinition({ ...DEFAULT_THEME, appearance: "sepia" })).toBe(false);
    expect(isThemeDefinition(null)).toBe(false);
  });

  it("rejects a seed or accent that is not a hex color", () => {
    const badSeed = { ...DEFAULT_THEME, seed: "blue" };
    const badAccent = { ...DEFAULT_THEME, accent: "not-a-color" };

    expect(isThemeDefinition(badSeed)).toBe(false);
    expect(isThemeDefinition(badAccent)).toBe(false);
    expect(parseThemeJson(JSON.stringify(badSeed))).toBeNull();
    expect(parseThemeJson(JSON.stringify(badAccent))).toBeNull();
  });
});

describe("project theme override", () => {
  it("inherits on every surface by default", () => {
    expect(EMPTY_PROJECT_THEME_OVERRIDE).toEqual({
      appThemeSlug: null,
      terminalThemeName: null,
      editorThemeId: null,
      seed: null,
    });
    expect(isProjectThemeOverrideEmpty(EMPTY_PROJECT_THEME_OVERRIDE)).toBe(true);
    expect(
      isProjectThemeOverrideEmpty({ ...EMPTY_PROJECT_THEME_OVERRIDE, terminalThemeName: "Nord" }),
    ).toBe(false);
  });

  it("guards the per-surface shape", () => {
    expect(isProjectThemeOverride(EMPTY_PROJECT_THEME_OVERRIDE)).toBe(true);
    expect(
      isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "catppuccin-mocha" }),
    ).toBe(true);
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "nord" })).toBe(
      true,
    );
    expect(isProjectThemeOverride({ appThemeSlug: "x" })).toBe(false);
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, seed: 7 })).toBe(false);
    expect(isProjectThemeOverride(null)).toBe(false);
  });

  it("rejects a non-catalog editorThemeId while still allowing null inherit", () => {
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: null })).toBe(
      true,
    );
    expect(
      isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "volli-dark" }),
    ).toBe(false);
    expect(
      isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "not-a-theme" }),
    ).toBe(false);
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "" })).toBe(
      false,
    );
  });
});

const withCanvas = (canvas: unknown): unknown => ({ ...DEFAULT_THEME, canvas });

describe("the canvas guard", () => {
  it("accepts a gradient or mesh carrying string stops", () => {
    expect(isThemeDefinition(withCanvas({ kind: "gradient", stops: ["#2a1207", "#0d0d0d"] }))).toBe(
      true,
    );
    expect(isThemeDefinition(withCanvas({ kind: "mesh", stops: [] }))).toBe(true);
  });

  it("rejects a gradient whose stops are missing or not strings", () => {
    expect(isThemeDefinition(withCanvas({ kind: "gradient" }))).toBe(false);
    expect(isThemeDefinition(withCanvas({ kind: "mesh", stops: "#fff" }))).toBe(false);
    expect(isThemeDefinition(withCanvas({ kind: "gradient", stops: ["#fff", 7] }))).toBe(false);
  });

  it("rejects a canvas that is not an object at all", () => {
    expect(isThemeDefinition(withCanvas("solid"))).toBe(false);
    expect(isThemeDefinition(withCanvas(null))).toBe(false);
  });

  it("round-trips a gradient canvas through storage", () => {
    const themed: ThemeDefinition = {
      ...DEFAULT_THEME,
      canvas: { kind: "gradient", stops: ["#2a1207", "#0d0d0d"] },
    };
    expect(parseThemeJson(serializeGlobalTheme(themed))).toEqual(themed);
  });

  // The canvas was the one field serializeGlobalTheme copied by REFERENCE, and
  // every guard here tolerates extra properties — so it was a live route for
  // exactly the resolved-token smuggling the field-by-field rebuild exists to
  // stop. The rebuild has to go all the way down, not one level.
  it("cannot smuggle a resolved token set through the canvas either", () => {
    const smuggled = {
      ...DEFAULT_THEME,
      canvas: { kind: "solid", tokens: { "--background": "#000000" } },
    } as ThemeDefinition;
    const json = serializeGlobalTheme(smuggled);

    expect(json).not.toContain("--");
    expect(JSON.parse(json)).toMatchObject({ canvas: { kind: "solid" } });
    expect(Object.keys((JSON.parse(json) as { canvas: object }).canvas)).toEqual(["kind"]);
  });

  it("strips extras from a gradient/mesh canvas while keeping its authored stops", () => {
    const smuggled = {
      ...DEFAULT_THEME,
      canvas: { kind: "mesh", stops: ["#2a1207", "#0d0d0d"], tokens: { "--ring": "#fff" } },
    } as ThemeDefinition;
    const parsed = JSON.parse(serializeGlobalTheme(smuggled)) as { canvas: ThemeCanvas };

    expect(parsed.canvas).toEqual({ kind: "mesh", stops: ["#2a1207", "#0d0d0d"] });
  });

  // The three-stop ceiling is Arc's own, and the point past which adjacent
  // stops fall under the anti-banding floor (see theme/canvas.ts). It was
  // documented on ThemeCanvas from the start and enforced nowhere — this is the
  // boundary it belongs at, because a fourth stop has no position to sit at and
  // would be dropped silently further downstream.
  it("rejects a canvas carrying more stops than a canvas can have", () => {
    expect(
      isThemeDefinition(withCanvas({ kind: "gradient", stops: ["#160d0a", "#0d0705", "#060303"] })),
    ).toBe(true);
    expect(
      isThemeDefinition(
        withCanvas({ kind: "gradient", stops: ["#160d0a", "#0d0705", "#060303", "#040202"] }),
      ),
    ).toBe(false);
  });

  it("rejects a stop that is not a color", () => {
    // Every stop is painted, and `hexToOklch` throws on anything it cannot
    // parse — so an unparseable stop would take the whole render down rather
    // than degrade. A theme file is hand-editable; this is where that is caught.
    expect(isThemeDefinition(withCanvas({ kind: "gradient", stops: ["#1", "#2"] }))).toBe(false);
    expect(isThemeDefinition(withCanvas({ kind: "mesh", stops: ["rebeccapurple"] }))).toBe(false);
  });

  it("keeps an in-range set of authored stops exactly as authored", () => {
    // The cap is a ceiling on COUNT, not a licence to rewrite intent: what a
    // theme file says is what storage holds, and the legibility band is
    // enforced on read instead (theme/canvas.ts).
    const stops = ["#ffffff", "#0d0705", "#060303"];
    const themed: ThemeDefinition = { ...DEFAULT_THEME, canvas: { kind: "gradient", stops } };

    expect(parseThemeJson(serializeGlobalTheme(themed))?.canvas).toEqual({
      kind: "gradient",
      stops,
    });
  });
});
