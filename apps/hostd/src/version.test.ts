import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { HOSTD_VERSION } from "./version";

describe("hostd's version", () => {
  it("is the release line in the root manifest", () => {
    const root = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(HOSTD_VERSION).toBe(root.version);
  });
});
