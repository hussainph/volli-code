import { describe, expect, it } from "vite-plus/test";

import { takeCliLaunchNotice } from "./cli-launch-notice";

describe("takeCliLaunchNotice", () => {
  it("returns the CLI launch message once and stays silent for normal boots", () => {
    expect(takeCliLaunchNotice(false)).toBeNull();
    expect(takeCliLaunchNotice(true)).toBe("Volli launched by an agent via the CLI");
    expect(takeCliLaunchNotice(true)).toBeNull();
  });
});
