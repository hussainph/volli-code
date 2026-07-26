import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_CHANGE_RECENCY_STATE,
  isChangeUpdated,
  reduceChangeRecency,
} from "./ticket-change-recency";

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

  it("treats a file literally named `constructor` as an ordinary, uninspected path", () => {
    // Path-keyed records are null-prototype: an `{}` literal would resolve
    // `paths["constructor"]` through Object.prototype and badge a file nobody
    // ever opened.
    expect(isChangeUpdated(EMPTY_CHANGE_RECENCY_STATE, "constructor")).toBe(false);
    expect(
      reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
        type: "external-revision",
        path: "constructor",
        revision: "opaque-revision-2",
      }),
    ).toBe(EMPTY_CHANGE_RECENCY_STATE);

    const inspected = reduceChangeRecency(EMPTY_CHANGE_RECENCY_STATE, {
      type: "inspect",
      path: "constructor",
      revision: "opaque-revision-1",
    });
    const updated = reduceChangeRecency(inspected, {
      type: "external-revision",
      path: "constructor",
      revision: "opaque-revision-2",
    });

    expect(isChangeUpdated(inspected, "constructor")).toBe(false);
    expect(isChangeUpdated(updated, "constructor")).toBe(true);
    // Every copy has to preserve the null prototype, spreads included.
    expect(Object.getPrototypeOf(EMPTY_CHANGE_RECENCY_STATE.paths)).toBeNull();
    expect(Object.getPrototypeOf(inspected.paths)).toBeNull();
    expect(Object.getPrototypeOf(updated.paths)).toBeNull();
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
