import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyLiveDocumentReconciliation,
  planLiveDocumentReconciliation,
} from "./live-document-reconciliation";

describe("planLiveDocumentReconciliation", () => {
  it("adopts disk quietly when the live model is clean", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "before\n",
        lastWrite: null,
        disk: {
          ok: true,
          text: "agent edit\n",
          revision: 2,
          truncated: false,
        },
      }),
    ).toEqual({
      kind: "apply",
      outcome: "adopt",
      baseline: "agent edit\n",
      value: "agent edit\n",
      revision: 2,
    });
  });

  it("keeps a local-only draft while advancing the observed disk revision", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "human draft\n",
        lastWrite: null,
        disk: {
          ok: true,
          text: "before\n",
          revision: 2,
          truncated: false,
        },
      }),
    ).toEqual({
      kind: "apply",
      outcome: "keep-local",
      baseline: "before\n",
      value: "human draft\n",
      revision: 2,
    });
  });

  it("merges disjoint human and agent edits onto the new disk baseline", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "first\nkeep\nlast\n",
        local: "human first\nkeep\nlast\n",
        lastWrite: null,
        disk: {
          ok: true,
          text: "first\nkeep\nagent last\n",
          revision: 3,
          truncated: false,
        },
      }),
    ).toEqual({
      kind: "apply",
      outcome: "merge",
      baseline: "first\nkeep\nagent last\n",
      value: "human first\nkeep\nagent last\n",
      revision: 3,
    });
  });

  it("advances a local-save echo baseline without losing typing made during the save", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "saved\nnew typing\n",
        lastWrite: "saved\n",
        disk: {
          ok: true,
          text: "saved\n",
          revision: 4,
          truncated: false,
        },
      }),
    ).toEqual({
      kind: "apply",
      outcome: "save-echo",
      baseline: "saved\n",
      value: "saved\nnew typing\n",
      revision: 4,
    });
  });

  it("preserves exact local and disk values when edits overlap", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "human\n",
        lastWrite: null,
        disk: {
          ok: true,
          text: "agent\n",
          revision: 5,
          truncated: false,
        },
      }),
    ).toEqual({
      kind: "conflict",
      reason: "overlap",
      local: "human\n",
      disk: "agent\n",
      revision: 5,
    });
  });

  it("keeps a dirty draft visible when the disk file becomes unreadable", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "human draft\n",
        lastWrite: null,
        disk: {
          ok: false,
          error: "File was deleted on disk.",
          revision: null,
        },
      }),
    ).toEqual({
      kind: "unreadable",
      error: "File was deleted on disk.",
      keepDraft: true,
      revision: null,
    });
  });

  it("never treats a truncated disk prefix as a writable baseline", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "human draft\n",
        lastWrite: null,
        disk: {
          ok: true,
          text: "truncated prefix",
          revision: 6,
          truncated: true,
        },
      }),
    ).toEqual({
      kind: "unreadable",
      error: "File is too large to reconcile safely.",
      keepDraft: true,
      revision: 6,
    });
  });

  it("advances the baseline when local and disk already match", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "saved\n",
        lastWrite: null,
        disk: {
          ok: true,
          text: "saved\n",
          revision: 7,
          truncated: false,
        },
      }),
    ).toEqual({
      kind: "apply",
      outcome: "unchanged",
      baseline: "saved\n",
      value: "saved\n",
      revision: 7,
    });
  });
});

describe("applyLiveDocumentReconciliation", () => {
  it("applies a disjoint result through one registry transaction", () => {
    const applyExternalUpdate = vi.fn();
    const lease = {
      model: { getValue: () => "human first\nkeep\nlast\n" },
      snapshot: () => ({ baseline: "first\nkeep\nlast\n" }),
      applyExternalUpdate,
      adoptCleanBaseline: vi.fn(),
    };

    const result = applyLiveDocumentReconciliation({
      lease,
      lastWrite: null,
      disk: {
        ok: true,
        text: "first\nkeep\nagent last\n",
        revision: 8,
        truncated: false,
      },
    });

    expect(result).toMatchObject({ kind: "apply", outcome: "merge" });
    expect(applyExternalUpdate).toHaveBeenCalledWith({
      baseline: "first\nkeep\nagent last\n",
      value: "human first\nkeep\nagent last\n",
      revision: 8,
    });
  });

  it("advances only the external revision for a conflict while retaining baseline A", () => {
    const applyExternalUpdate = vi.fn();
    const adoptCleanBaseline = vi.fn();
    const lease = {
      model: { getValue: () => "human\n" },
      snapshot: () => ({ baseline: "before\n" }),
      applyExternalUpdate,
      adoptCleanBaseline,
    };

    const result = applyLiveDocumentReconciliation({
      lease,
      lastWrite: null,
      disk: {
        ok: true,
        text: "agent\n",
        revision: 9,
        truncated: false,
      },
    });

    expect(result).toMatchObject({
      kind: "conflict",
      local: "human\n",
      disk: "agent\n",
      revision: 9,
    });
    expect(adoptCleanBaseline).toHaveBeenCalledWith({ value: "agent\n", revision: 9 });
    expect(applyExternalUpdate).not.toHaveBeenCalled();
    expect(lease.snapshot().baseline).toBe("before\n");
  });
});
