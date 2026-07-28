import { afterEach, describe, expect, it } from "vite-plus/test";
import { THEME_TOKEN_NAMES } from "@volli/shared";
import type { Canvas } from "@volli/shared";

import {
  getFirstPaintHint,
  getGlobalAppearance,
  getGlobalCanvas,
  getRawGlobalTheme,
  setFirstPaintHint,
  setGlobalAppearance,
  setGlobalCanvas,
  getGlobalEditorThemeId,
  setGlobalEditorThemeId,
} from "./theme-repo";
import {
  getProjectById,
  insertProject,
  updateProjectAppearance,
  updateProjectCanvas,
  updateProjectThemeOverride,
} from "./projects-repo";

/** A minimal two-pool canvas — enough stops that `primaryIndex` is a real choice. */
function testCanvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    stops: [
      { hex: "#e8652a", x: 0.2, y: 0.15 },
      { hex: "#3a7d9a", x: 0.8, y: 0.9 },
    ],
    primaryIndex: 0,
    vibrancy: 0.6,
    grain: 0.15,
    ...overrides,
  };
}
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

describe("global editor theme id (app_state kv)", () => {
  it("reports null until an editor theme has been chosen", () => {
    ctx = openTestDb();
    expect(getGlobalEditorThemeId(ctx.db)).toBeNull();
  });

  it("round-trips an authored catalog id and clears back to derive-from-app", () => {
    ctx = openTestDb();

    setGlobalEditorThemeId(ctx.db, "nord", 1000);
    expect(getGlobalEditorThemeId(ctx.db)).toBe("nord");

    setGlobalEditorThemeId(ctx.db, null, 2000);
    expect(getGlobalEditorThemeId(ctx.db)).toBeNull();
  });

  it("degrades to null on a stored non-catalog editor theme id", () => {
    ctx = openTestDb();
    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('theme_editor', ?, 0)")
      .run("volli-dark");

    expect(getGlobalEditorThemeId(ctx.db)).toBeNull();
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
        terminalThemeName: "Catppuccin Mocha",
        editorThemeId: null,
      },
      1000,
    );

    expect(updated?.themeOverride).toEqual({
      terminalThemeName: "Catppuccin Mocha",
      editorThemeId: null,
    });
    expect(getProjectById(ctx.db, id)?.themeOverride?.terminalThemeName).toBe("Catppuccin Mocha");
  });

  // The dead `theme_app_slug`/`theme_seed` columns (migration 013) are no longer
  // reachable through `ProjectThemeOverride` — this write always lands `null` in
  // both, whatever the caller asks for.
  it("always writes null into the two dead migration-013 columns", () => {
    const id = seedProject();

    updateProjectThemeOverride(
      ctx.db,
      id,
      { terminalThemeName: "Nord", editorThemeId: "nord" },
      1000,
    );

    const row = ctx.db
      .prepare("SELECT theme_app_slug, theme_seed FROM projects WHERE id = ?")
      .get(id) as { theme_app_slug: string | null; theme_seed: string | null };
    expect(row).toEqual({ theme_app_slug: null, theme_seed: null });
  });

  it("clears every surface back to inherit on null", () => {
    const id = seedProject();
    updateProjectThemeOverride(
      ctx.db,
      id,
      { terminalThemeName: "Nord", editorThemeId: "nord" },
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
      { terminalThemeName: null, editorThemeId: null },
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
      { terminalThemeName: "Nord", editorThemeId: null },
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

describe("global canvas (app_state kv)", () => {
  it("reports null until a canvas has been authored", () => {
    ctx = openTestDb();
    expect(getGlobalCanvas(ctx.db)).toBeNull();
  });

  it("round-trips the authored canvas", () => {
    ctx = openTestDb();
    const canvas = testCanvas({ primaryIndex: 1, vibrancy: 0.42, grain: 0 });

    setGlobalCanvas(ctx.db, canvas, 1000);

    expect(getGlobalCanvas(ctx.db)).toEqual(canvas);
  });

  it("replaces rather than accumulates on a second write", () => {
    ctx = openTestDb();
    setGlobalCanvas(ctx.db, testCanvas(), 1000);
    setGlobalCanvas(ctx.db, testCanvas({ vibrancy: 0.9 }), 2000);

    expect(getGlobalCanvas(ctx.db)?.vibrancy).toBe(0.9);
    expect(ctx.db.prepare("SELECT COUNT(*) as n FROM app_state").get()).toEqual({ n: 1 });
  });

  // The resolved token set is derived at render time and stored NOWHERE.
  // Asserted against what actually landed in the row, not against what the
  // writer intended to send — every guard in this system tolerates extra
  // properties, so a by-reference copy would round-trip a smuggled ladder.
  it("never persists a resolved token set", () => {
    ctx = openTestDb();
    const smuggled = {
      ...testCanvas(),
      tokens: Object.fromEntries(THEME_TOKEN_NAMES.map((name) => [name, "#000000"])),
    } as Canvas;

    setGlobalCanvas(ctx.db, smuggled, 1000);

    const stored = getRawGlobalTheme(ctx.db);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("--");
    expect(stored).not.toContain("tokens");
  });

  it("strips extra keys from a stop as well as from the canvas", () => {
    ctx = openTestDb();
    const canvas = {
      ...testCanvas(),
      stops: [{ hex: "#e8652a", x: 0.2, y: 0.15, resolved: "#000000" }],
      primaryIndex: 0,
    } as unknown as Canvas;

    setGlobalCanvas(ctx.db, canvas, 1000);

    expect(getRawGlobalTheme(ctx.db)).not.toContain("resolved");
  });

  it("degrades to null on a stored value that is not a readable canvas", () => {
    ctx = openTestDb();
    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('theme', ?, 0)")
      .run("{ not json");

    expect(getGlobalCanvas(ctx.db)).toBeNull();
  });

  it("degrades to null on a primaryIndex that names no stop", () => {
    ctx = openTestDb();
    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('theme', ?, 0)")
      .run(JSON.stringify(testCanvas({ primaryIndex: 7 })));

    expect(getGlobalCanvas(ctx.db)).toBeNull();
  });

  // Decision 7: existing theme data resets to the shipped default rather than
  // being converted. It falls out of the guards — the seed-based system's
  // authored theme is not a canvas — so no migration has to translate anything.
  it("reads a database written by the seed-based system as unset", () => {
    ctx = openTestDb();
    ctx.db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('theme', ?, 0)").run(
      JSON.stringify({
        name: "Ember",
        slug: "ember",
        seed: "#e8652a",
        accent: null,
        grain: 0,
        canvas: { kind: "solid" },
        overrides: {},
        appearance: "dark",
      }),
    );

    expect(getGlobalCanvas(ctx.db)).toBeNull();
    expect(getRawGlobalTheme(ctx.db)).toContain("ember");
  });
});

describe("global appearance (app_state kv)", () => {
  it("reports null until an appearance has been chosen", () => {
    ctx = openTestDb();
    expect(getGlobalAppearance(ctx.db)).toBeNull();
  });

  it("round-trips each of the three choices", () => {
    ctx = openTestDb();
    for (const appearance of ["light", "dark", "auto"] as const) {
      setGlobalAppearance(ctx.db, appearance, 1000);
      expect(getGlobalAppearance(ctx.db)).toBe(appearance);
    }
  });

  it("degrades to null on a stored word outside the vocabulary", () => {
    ctx = openTestDb();
    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('appearance', ?, 0)")
      .run("sepia");

    expect(getGlobalAppearance(ctx.db)).toBeNull();
  });
});

describe("first-paint hint (app_state kv)", () => {
  it("reports null until the app has painted once", () => {
    ctx = openTestDb();
    expect(getFirstPaintHint(ctx.db)).toBeNull();
  });

  it("round-trips the resolved mode and the background it painted", () => {
    ctx = openTestDb();

    setFirstPaintHint(ctx.db, { appearance: "light", background: "#f4efe9" }, 1000);

    expect(getFirstPaintHint(ctx.db)).toEqual({ appearance: "light", background: "#f4efe9" });
  });

  // The hint is one enum and one hex — the two values main cannot derive
  // without a renderer. It is NOT a resolved token set, and nothing may make it
  // into one: a ladder stored here could out-vote the authored pair on the next
  // launch, which is the bug the never-persist rule is about.
  it("stores nothing beyond the mode and the one color", () => {
    ctx = openTestDb();
    const smuggled = {
      appearance: "dark",
      background: "#141210",
      tokens: { "--background": "#000000" },
    } as unknown as Parameters<typeof setFirstPaintHint>[1];

    setFirstPaintHint(ctx.db, smuggled, 1000);

    const stored = ctx.db
      .prepare("SELECT value FROM app_state WHERE key = 'first-paint'")
      .get() as { value: string };
    expect(JSON.parse(stored.value)).toEqual({ appearance: "dark", background: "#141210" });
  });

  it("degrades to null on an unresolved mode — `auto` is not a first paint", () => {
    ctx = openTestDb();
    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('first-paint', ?, 0)")
      .run(JSON.stringify({ appearance: "auto", background: "#141210" }));

    expect(getFirstPaintHint(ctx.db)).toBeNull();
  });

  it("degrades to null on a malformed payload rather than throwing", () => {
    ctx = openTestDb();
    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('first-paint', ?, 0)")
      .run("{ not json");

    expect(getFirstPaintHint(ctx.db)).toBeNull();
  });

  it("does not out-vote the authored pair — the canvas row is untouched by a paint", () => {
    ctx = openTestDb();
    const canvas = testCanvas();
    setGlobalCanvas(ctx.db, canvas, 1000);

    setFirstPaintHint(ctx.db, { appearance: "dark", background: "#000000" }, 2000);

    expect(getGlobalCanvas(ctx.db)).toEqual(canvas);
  });
});

describe("project canvas + appearance (migration 014)", () => {
  function seedProject(): string {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    return project.id;
  }

  it("inherits both halves by default", () => {
    const id = seedProject();
    const project = getProjectById(ctx.db, id);

    expect(project?.themeCanvas).toBeNull();
    expect(project?.themeAppearance).toBeNull();
  });

  it("round-trips a project's own canvas", () => {
    const id = seedProject();
    const canvas = testCanvas({ vibrancy: 0.3 });

    const updated = updateProjectCanvas(ctx.db, id, canvas, 1000);

    expect(updated?.themeCanvas).toEqual(canvas);
    expect(getProjectById(ctx.db, id)?.themeCanvas).toEqual(canvas);
  });

  it("never persists a resolved token set on the project row either", () => {
    const id = seedProject();
    const smuggled = { ...testCanvas(), tokens: { "--background": "#000000" } } as Canvas;

    updateProjectCanvas(ctx.db, id, smuggled, 1000);

    const stored = ctx.db.prepare("SELECT theme_canvas FROM projects WHERE id = ?").get(id) as {
      theme_canvas: string;
    };
    expect(stored.theme_canvas).not.toContain("tokens");
    expect(stored.theme_canvas).not.toContain("--");
  });

  it("scopes the canvas and the appearance separately", () => {
    const id = seedProject();

    updateProjectCanvas(ctx.db, id, testCanvas(), 1000);
    const afterAppearance = updateProjectAppearance(ctx.db, id, "light", 2000);

    // Overriding one must not clear the other — they are independent choices.
    expect(afterAppearance?.themeCanvas).toEqual(testCanvas());
    expect(afterAppearance?.themeAppearance).toBe("light");

    const cleared = updateProjectCanvas(ctx.db, id, null, 3000);
    expect(cleared?.themeCanvas).toBeNull();
    expect(cleared?.themeAppearance).toBe("light");
  });

  it("clears back to inheriting on null", () => {
    const id = seedProject();
    updateProjectAppearance(ctx.db, id, "dark", 1000);

    expect(updateProjectAppearance(ctx.db, id, null, 2000)?.themeAppearance).toBeNull();
  });

  it("degrades a corrupt stored canvas to inheriting rather than throwing", () => {
    const id = seedProject();
    ctx.db.prepare("UPDATE projects SET theme_canvas = ? WHERE id = ?").run("{ not json", id);

    expect(getProjectById(ctx.db, id)?.themeCanvas).toBeNull();
  });

  it("bumps row_version and updated_at like every other project write", () => {
    const id = seedProject();
    const before = ctx.db.prepare("SELECT row_version FROM projects WHERE id = ?").get(id) as {
      row_version: number;
    };

    updateProjectCanvas(ctx.db, id, testCanvas(), 4242);

    expect(
      ctx.db.prepare("SELECT row_version, updated_at FROM projects WHERE id = ?").get(id),
    ).toEqual({ row_version: before.row_version + 1, updated_at: 4242 });
  });

  it("is a no-op for an unknown project", () => {
    seedProject();
    expect(updateProjectCanvas(ctx.db, "nope", testCanvas(), 1000)).toBeUndefined();
    expect(updateProjectAppearance(ctx.db, "nope", "dark", 1000)).toBeUndefined();
  });
});
