import type { TicketRetentionState } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { resolveRetention } from "./worktree-retention-model";

function state(overrides: Partial<TicketRetentionState> = {}): TicketRetentionState {
  return {
    ticketId: "t1",
    prUrl: null,
    prState: null,
    hasConflicts: false,
    failingChecks: [],
    archiveReady: false,
    reason: null,
    keep: false,
    dismissed: false,
    ...overrides,
  };
}

describe("resolveRetention — archive-readiness", () => {
  it("is an empty view when there's no retention state yet", () => {
    const view = resolveRetention(null, 14);
    expect(view.archiveReady).toBe(false);
    expect(view.kept).toBe(false);
    expect(view.reasonLine).toBeNull();
    expect(view.notices).toEqual([]);
  });

  it("offers Archive & clean with a 'PR merged' line when a merged PR is ready", () => {
    const view = resolveRetention(
      state({ prState: "merged", archiveReady: true, reason: "pr-merged" }),
      14,
    );
    expect(view.archiveReady).toBe(true);
    expect(view.reasonLine).toBe("PR merged");
  });

  it("offers Archive & clean with an 'In Done for N+ days' line when the TTL expired", () => {
    const view = resolveRetention(state({ archiveReady: true, reason: "ttl-expired" }), 14);
    expect(view.archiveReady).toBe(true);
    expect(view.reasonLine).toBe("In Done for 14+ days");
  });

  it("falls back to a TTL-less line when the TTL days are unknown", () => {
    const view = resolveRetention(state({ archiveReady: true, reason: "ttl-expired" }), null);
    expect(view.reasonLine).toBe("In Done long enough to archive");
  });

  it("suppresses the reason line while archive-ready is off (e.g. dismissed this launch)", () => {
    // A dismissed prompt keeps its reason in the backend state but is not ready.
    const view = resolveRetention(
      state({ reason: "pr-merged", prState: "merged", archiveReady: false, dismissed: true }),
      14,
    );
    expect(view.archiveReady).toBe(false);
    expect(view.reasonLine).toBeNull();
  });
});

describe("resolveRetention — keep pin", () => {
  it("reports the quiet kept state when the durable Keep pin is set", () => {
    // Keep is a hard exemption: the backend never marks a kept ticket archive-ready.
    const view = resolveRetention(state({ keep: true, archiveReady: false }), 14);
    expect(view.kept).toBe(true);
    expect(view.archiveReady).toBe(false);
    expect(view.reasonLine).toBeNull();
  });
});

describe("resolveRetention — surfacing (never gating)", () => {
  it("surfaces a merge-conflict notice without any gating detail", () => {
    const view = resolveRetention(state({ prState: "open", hasConflicts: true }), 14);
    expect(view.notices).toEqual([{ text: "PR has merge conflicts", detail: null }]);
  });

  it("surfaces a singular failing-check notice with the check name as tooltip detail", () => {
    const view = resolveRetention(state({ prState: "open", failingChecks: ["lint"] }), 14);
    expect(view.notices).toEqual([{ text: "1 check failing", detail: "lint" }]);
  });

  it("pluralizes and joins multiple failing checks into the tooltip detail", () => {
    const view = resolveRetention(
      state({ prState: "open", failingChecks: ["lint", "typecheck", "test"] }),
      14,
    );
    expect(view.notices).toEqual([{ text: "3 checks failing", detail: "lint, typecheck, test" }]);
  });

  it("surfaces both a conflict and failing checks together, conflict first", () => {
    const view = resolveRetention(
      state({ prState: "open", hasConflicts: true, failingChecks: ["lint"] }),
      14,
    );
    expect(view.notices).toEqual([
      { text: "PR has merge conflicts", detail: null },
      { text: "1 check failing", detail: "lint" },
    ]);
  });

  it("still surfaces conflicts alongside an archive-ready merged PR", () => {
    const view = resolveRetention(
      state({ prState: "merged", archiveReady: true, reason: "pr-merged", hasConflicts: true }),
      14,
    );
    expect(view.archiveReady).toBe(true);
    expect(view.reasonLine).toBe("PR merged");
    expect(view.notices).toEqual([{ text: "PR has merge conflicts", detail: null }]);
  });
});
