import { describe, expect, it } from "vite-plus/test";

import { EMPTY_CHANGE_RECENCY_STATE, reduceChangeRecency } from "./ticket-change-recency";

describe("reduceChangeRecency", () => {
  it("records the exact revision only after a deliberate file or diff inspection", () => {
    const after = reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
      type: "inspect",
      path: "src/ticket.tsx",
      revision: "opaque-revision-1",
    });

    expect(after).toEqual({
      paths: {
        "src/ticket.tsx": {
          seenRevision: "opaque-revision-1",
          updatedRevision: null,
        },
      },
    });
  });
});
