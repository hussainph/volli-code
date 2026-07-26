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

  it("marks an inspected path updated when a later external revision arrives", () => {
    const inspected = reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
      type: "inspect",
      path: "src/ticket.tsx",
      revision: "opaque-revision-1",
    });

    const after = reduceChangeRecency(inspected, {
      type: "external-revision",
      path: "src/ticket.tsx",
      revision: "opaque-revision-2",
    });

    expect(after).toEqual({
      paths: {
        "src/ticket.tsx": {
          seenRevision: "opaque-revision-1",
          updatedRevision: "opaque-revision-2",
        },
      },
    });
  });

  it("adopts a known local-save echo without marking the path updated", () => {
    const inspected = reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
      type: "inspect",
      path: "src/ticket.tsx",
      revision: "opaque-revision-1",
    });

    const after = reduceChangeRecency(inspected, {
      type: "local-save-echo",
      path: "src/ticket.tsx",
      revision: "opaque-revision-2",
    });

    expect(after).toEqual({
      paths: {
        "src/ticket.tsx": {
          seenRevision: "opaque-revision-2",
          updatedRevision: null,
        },
      },
    });
  });

  it("clears stale awareness and records the newly seen revision when reopened", () => {
    const updated = reduceChangeRecency(
      reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
        type: "inspect",
        path: "src/ticket.tsx",
        revision: "opaque-revision-1",
      }),
      {
        type: "external-revision",
        path: "src/ticket.tsx",
        revision: "opaque-revision-2",
      },
    );

    const after = reduceChangeRecency(updated, {
      type: "inspect",
      path: "src/ticket.tsx",
      revision: "opaque-revision-2",
    });

    expect(after).toEqual({
      paths: {
        "src/ticket.tsx": {
          seenRevision: "opaque-revision-2",
          updatedRevision: null,
        },
      },
    });
  });

  it("keeps same revisions and uninspected paths quiet", () => {
    const inspected = reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
      type: "inspect",
      path: "src/ticket.tsx",
      revision: "opaque-revision-1",
    });

    expect(
      reduceChangeRecency(inspected, {
        type: "external-revision",
        path: "src/ticket.tsx",
        revision: "opaque-revision-1",
      }),
    ).toBe(inspected);
    expect(
      reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
        type: "external-revision",
        path: "src/uninspected.tsx",
        revision: "opaque-revision-2",
      }),
    ).toBe(EMPTY_CHANGE_RECENCY_STATE);
    expect(
      reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
        type: "local-save-echo",
        path: "src/uninspected.tsx",
        revision: "opaque-revision-2",
      }),
    ).toBe(EMPTY_CHANGE_RECENCY_STATE);
  });
});
