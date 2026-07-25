import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME, THEME_TOKEN_NAMES } from "@volli/shared";
import type { ThemeDefinition } from "@volli/shared";

import { getGlobalTheme, getRawGlobalTheme, setGlobalTheme } from "./theme-repo";
import { getProjectById, insertProject, updateProjectThemeOverride } from "./projects-repo";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

describe("global theme (app_state kv)", () => {
  it("reports null until a theme has been chosen", () => {
    ctx = openTestDb();
    expect(getGlobalTheme(ctx.db)).toBeNull();
  });

  it("round-trips the authored definition", () => {
    ctx = openTestDb();
    const theme: ThemeDefinition = { ...DEFAULT_THEME, name: "Sea", slug: "sea", seed: "#3a7d9a" };

    setGlobalTheme(ctx.db, theme, 1000);

    expect(getGlobalTheme(ctx.db)).toEqual(theme);
  });

  it("replaces rather than accumulates on a second write", () => {
    ctx = openTestDb();
    setGlobalTheme(ctx.db, DEFAULT_THEME, 1000);
    setGlobalTheme(ctx.db, { ...DEFAULT_THEME, slug: "sea" }, 2000);

    expect(getGlobalTheme(ctx.db)?.slug).toBe("sea");
    expect(ctx.db.prepare("SELECT COUNT(*) as n FROM app_state").get()).toEqual({ n: 1 });
  });

  // docs/plans/theming-engine.md § Derived rules: the resolved token set is
  // derived at render time and stored NOWHERE. Asserted against what actually
  // landed in the row, not against what the writer intended to send.
  it("never persists a resolved token set", () => {
    ctx = openTestDb();
    const smuggled = {
      ...DEFAULT_THEME,
      tokens: Object.fromEntries(THEME_TOKEN_NAMES.map((name) => [name, "#000000"])),
    } as ThemeDefinition;

    setGlobalTheme(ctx.db, smuggled, 1000);

    const stored = getRawGlobalTheme(ctx.db);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("--");
    expect(stored).not.toContain("tokens");
  });

  it("degrades to null on a stored value that is not a readable theme", () => {
    ctx = openTestDb();
    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('theme', ?, 0)")
      .run("{ not json");

    expect(getGlobalTheme(ctx.db)).toBeNull();
  });
});

describe("project theme override", () => {
  function seedProject(): string {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    return project.id;
  }

  it("inherits on every surface by default", () => {
    const id = seedProject();
    expect(getProjectById(ctx.db, id)?.themeOverride).toBeNull();
  });

  it("stores one surface at a time, leaving the others inheriting", () => {
    const id = seedProject();

    const updated = updateProjectThemeOverride(
      ctx.db,
      id,
      {
        appThemeSlug: null,
        terminalThemeName: "Catppuccin Mocha",
        editorThemeId: null,
        seed: null,
      },
      1000,
    );

    expect(updated?.themeOverride).toEqual({
      appThemeSlug: null,
      terminalThemeName: "Catppuccin Mocha",
      editorThemeId: null,
      seed: null,
    });
    expect(getProjectById(ctx.db, id)?.themeOverride?.terminalThemeName).toBe("Catppuccin Mocha");
  });

  it("stores the auto-tint seed independently of the surface slugs", () => {
    const id = seedProject();

    updateProjectThemeOverride(
      ctx.db,
      id,
      { appThemeSlug: null, terminalThemeName: null, editorThemeId: null, seed: "#6e8b5e" },
      1000,
    );

    expect(getProjectById(ctx.db, id)?.themeOverride).toEqual({
      appThemeSlug: null,
      terminalThemeName: null,
      editorThemeId: null,
      seed: "#6e8b5e",
    });
  });

  it("clears every surface back to inherit on null", () => {
    const id = seedProject();
    updateProjectThemeOverride(
      ctx.db,
      id,
      { appThemeSlug: "sea", terminalThemeName: "Nord", editorThemeId: "nord", seed: "#3a7d9a" },
      1000,
    );

    const cleared = updateProjectThemeOverride(ctx.db, id, null, 2000);

    expect(cleared?.themeOverride).toBeNull();
  });

  it("reports an all-null override as inheriting rather than as an empty object", () => {
    const id = seedProject();

    const updated = updateProjectThemeOverride(
      ctx.db,
      id,
      { appThemeSlug: null, terminalThemeName: null, editorThemeId: null, seed: null },
      1000,
    );

    expect(updated?.themeOverride).toBeNull();
  });

  it("bumps row_version and updated_at like every other project write", () => {
    const id = seedProject();
    const before = ctx.db.prepare("SELECT row_version FROM projects WHERE id = ?").get(id) as {
      row_version: number;
    };

    updateProjectThemeOverride(
      ctx.db,
      id,
      { appThemeSlug: "sea", terminalThemeName: null, editorThemeId: null, seed: null },
      4242,
    );

    expect(
      ctx.db.prepare("SELECT row_version, updated_at FROM projects WHERE id = ?").get(id),
    ).toEqual({ row_version: before.row_version + 1, updated_at: 4242 });
  });

  it("is a no-op for an unknown project", () => {
    seedProject();
    expect(updateProjectThemeOverride(ctx.db, "nope", null, 1000)).toBeUndefined();
  });
});
