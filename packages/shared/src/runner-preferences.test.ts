import { describe, expect, it } from "vite-plus/test";
import { isAppStateKey } from "./app-state-keys";
import { RUNNER_RESIDENT_APP_STATE_KEY, runnerStaysAvailable } from "./runner-preferences";

describe("runner availability preference", () => {
  it("defaults on and only explicit false opts out", () => {
    for (const value of [undefined, null, "", "true", "invalid"])
      expect(runnerStaysAvailable(value)).toBe(true);
    expect(runnerStaysAvailable("false")).toBe(false);
    expect(isAppStateKey(RUNNER_RESIDENT_APP_STATE_KEY)).toBe(true);
  });
});
