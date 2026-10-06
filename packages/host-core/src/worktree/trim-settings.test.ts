import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { DEFAULT_TRIM_KEEP_PATTERNS } from "./trim";
import { defaultTrimSettings, getTrimSettings, setTrimSettings } from "./trim-settings";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

describe("trim settings (VC-340)", () => {
  it("ships the preserved-configuration defaults, with the automatic trim on", () => {
    expect(getTrimSettings(ctx.db)).toEqual({
      keepPatterns: [...DEFAULT_TRIM_KEEP_PATTERNS],
      trimOnFinish: true,
    });
  });

  it("round-trips an opt-out", () => {
    expect(setTrimSettings(ctx.db, { trimOnFinish: false }, 1).trimOnFinish).toBe(false);
    expect(getTrimSettings(ctx.db).trimOnFinish).toBe(false);
    // The allowlist is untouched by a partial update.
    expect(getTrimSettings(ctx.db).keepPatterns).toEqual([...DEFAULT_TRIM_KEEP_PATTERNS]);
  });

  it("round-trips an extended allowlist, trimming and deduping what it stores", () => {
    const stored = setTrimSettings(
      ctx.db,
      { keepPatterns: [" *.sqlite ", "*.sqlite", "", ".env"] },
      1,
    );
    expect(stored.keepPatterns).toEqual(["*.sqlite", ".env"]);
    expect(getTrimSettings(ctx.db).keepPatterns).toEqual(["*.sqlite", ".env"]);
  });

  it("refuses to store an empty allowlist, because that makes keys disposable", () => {
    const stored = setTrimSettings(ctx.db, { keepPatterns: ["   ", ""] }, 1);
    expect(stored.keepPatterns).toEqual([...DEFAULT_TRIM_KEEP_PATTERNS]);
  });

  it("falls back to the defaults on a corrupt stored blob", () => {
    ctx.db
      .prepare(
        "INSERT INTO app_state (key, value, updated_at) VALUES ('volli:worktree-trim', '{oops', 1)",
      )
      .run();
    expect(getTrimSettings(ctx.db)).toEqual(defaultTrimSettings());
  });

  it("falls back per field when the stored blob is only partly written", () => {
    ctx.db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at)
           VALUES ('volli:worktree-trim', '{"keepPatterns":[42]}', 1)`,
      )
      .run();
    expect(getTrimSettings(ctx.db)).toEqual(defaultTrimSettings());
  });
});
