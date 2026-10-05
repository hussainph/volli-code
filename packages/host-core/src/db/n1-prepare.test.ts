import { describe, expect, it } from "vite-plus/test";

import { latestReleaseTag } from "../../scripts/n1/prepare.mjs";

describe("the N-1 release lane's choice of build (VC-633)", () => {
  it("takes the newest stable vX.Y.Z by version, never a canary", () => {
    expect(
      latestReleaseTag([
        "v0.2.0",
        "v0.10.0-canary.1",
        "v0.2.1-canary.7",
        "v0.9.3",
        "v0.2.1",
        "",
        "release-1",
      ]),
    ).toBe("v0.9.3");
    expect(latestReleaseTag(["v1.0.0", "v0.10.0"])).toBe("v1.0.0");
    expect(latestReleaseTag(["v0.2.1-canary.7"])).toBeNull();
  });
});
