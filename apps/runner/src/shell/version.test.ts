import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { RUNNER_VERSION } from "./version";

describe("the runner's version", () => {
  it("is the release line in the root manifest", () => {
    const root = JSON.parse(
      readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(RUNNER_VERSION).toBe(root.version);
  });
});
