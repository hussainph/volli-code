import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  clearStoredHarnessCommand,
  setStoredHarnessCommand,
  storedHarnessCommand,
} from "./harness-command-repo";
import { openTestDb } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

describe("storedHarnessCommand", () => {
  it("is null when nothing was ever stored", () => {
    ctx = openTestDb();

    expect(storedHarnessCommand(ctx.db, "opencode")).toBeNull();
  });

  it("returns the raw value a set stored, unresolved", () => {
    ctx = openTestDb();

    setStoredHarnessCommand(ctx.db, "opencode", "/opt/homebrew/bin/opencode", 1000);

    expect(storedHarnessCommand(ctx.db, "opencode")).toBe("/opt/homebrew/bin/opencode");
  });

  it("keys by harness id, so two harnesses never share a row", () => {
    ctx = openTestDb();

    setStoredHarnessCommand(ctx.db, "opencode", "/opt/homebrew/bin/opencode", 1000);
    setStoredHarnessCommand(ctx.db, "claude-code", "/opt/homebrew/bin/claude", 1000);

    expect(storedHarnessCommand(ctx.db, "opencode")).toBe("/opt/homebrew/bin/opencode");
    expect(storedHarnessCommand(ctx.db, "claude-code")).toBe("/opt/homebrew/bin/claude");
  });

  it("upserts rather than accumulating", () => {
    ctx = openTestDb();

    setStoredHarnessCommand(ctx.db, "opencode", "opencode-old", 1000);
    setStoredHarnessCommand(ctx.db, "opencode", "opencode-new", 2000);

    expect(storedHarnessCommand(ctx.db, "opencode")).toBe("opencode-new");
  });

  it("clears back to unset", () => {
    ctx = openTestDb();
    setStoredHarnessCommand(ctx.db, "opencode", "/opt/homebrew/bin/opencode", 1000);

    clearStoredHarnessCommand(ctx.db, "opencode");

    expect(storedHarnessCommand(ctx.db, "opencode")).toBeNull();
  });

  it("treats clearing an already-unset harness as a no-op", () => {
    ctx = openTestDb();

    expect(() => {
      clearStoredHarnessCommand(ctx.db, "opencode");
    }).not.toThrow();
    expect(storedHarnessCommand(ctx.db, "opencode")).toBeNull();
  });
});
