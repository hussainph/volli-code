import { afterEach, describe, expect, it } from "vite-plus/test";

import { deleteAppState, getAllAppState, setAppState } from "./app-state-repo";
import { openTestDb } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

describe("app_state kv", () => {
  it("upserts rather than accumulating", () => {
    ctx = openTestDb();

    setAppState(ctx.db, "theme", '{"a":1}', 1000);
    setAppState(ctx.db, "theme", '{"a":2}', 2000);

    expect(getAllAppState(ctx.db)).toEqual({ theme: '{"a":2}' });
  });

  it("removes a key so it stops appearing in the bootstrap payload", () => {
    ctx = openTestDb();
    setAppState(ctx.db, "volli:theme", "{}", 1000);
    setAppState(ctx.db, "appearance", "dark", 1000);

    deleteAppState(ctx.db, "volli:theme");

    // Gone, not emptied: an empty value is a payload every reader still has to
    // parse and reject, where a deleted key simply is not there.
    expect(getAllAppState(ctx.db)).toEqual({ appearance: "dark" });
  });

  it("treats an absent key as already removed", () => {
    ctx = openTestDb();

    expect(() => {
      deleteAppState(ctx.db, "never-written");
    }).not.toThrow();
    expect(getAllAppState(ctx.db)).toEqual({});
  });
});
