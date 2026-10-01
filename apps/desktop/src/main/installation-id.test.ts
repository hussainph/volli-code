import { describe, expect, it } from "vite-plus/test";

import { getAppState, setAppState } from "./db/app-state-repo";
import { openTestDb } from "./db/test-helpers";
import { INSTALLATION_ID_APP_STATE_KEY, installationId } from "./installation-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("installationId", () => {
  it("mints a UUID on first use and answers the same one ever after", () => {
    const ctx = openTestDb();
    try {
      const first = installationId(ctx.db);
      expect(first).toMatch(UUID);
      expect(installationId(ctx.db)).toBe(first);
      expect(getAppState(ctx.db, INSTALLATION_ID_APP_STATE_KEY)).toBe(JSON.stringify(first));
    } finally {
      ctx.cleanup();
    }
  });

  it("replaces a stored value the sign-in would refuse", () => {
    const ctx = openTestDb();
    try {
      for (const damaged of ['"not-a-uuid"', "{", "42"]) {
        setAppState(ctx.db, INSTALLATION_ID_APP_STATE_KEY, damaged, 1);
        expect(
          installationId(ctx.db, {
            mint: () => "6f1c1a52-6a8e-4d55-9c3e-2f8f0f1d3b7a",
            now: () => 2,
          }),
        ).toBe("6f1c1a52-6a8e-4d55-9c3e-2f8f0f1d3b7a");
      }
    } finally {
      ctx.cleanup();
    }
  });
});
