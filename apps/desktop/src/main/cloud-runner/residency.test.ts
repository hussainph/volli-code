import { describe, expect, it } from "vite-plus/test";
import { THIS_MAC_RUNNER_OFF, THIS_MAC_RUNNER_STATES } from "@volli/shared";
import { keepCloudRunnerAvailable } from "./residency";

describe("cloud runner residency", () => {
  it("keeps only a registered usable runner, including while offline or asleep", () => {
    for (const state of THIS_MAC_RUNNER_STATES) {
      const runner = { ...THIS_MAC_RUNNER_OFF, state, runnerId: "this-runner" };
      const usable = ["online", "offline", "connecting", "asleep"].includes(state);
      expect(keepCloudRunnerAvailable(runner, undefined), state).toBe(usable);
      expect(keepCloudRunnerAvailable(runner, "false"), state).toBe(false);
      expect(keepCloudRunnerAvailable({ ...runner, runnerId: null }, "true"), state).toBe(false);
    }
  });
});
