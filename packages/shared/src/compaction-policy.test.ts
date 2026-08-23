import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_COMPACTION_POLICY } from "./compaction-policy";

describe("the configured policy", () => {
  it("compacts automatically until told otherwise", () => {
    expect(DEFAULT_COMPACTION_POLICY).toEqual({ autoCompaction: true });
  });
});
