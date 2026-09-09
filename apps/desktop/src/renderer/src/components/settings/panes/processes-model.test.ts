import { describe, expect, it } from "vite-plus/test";
import type { OrphanProcessCandidate } from "@volli/shared";

import type { OrphanProcessInventory } from "../../../../../ipc/contract";
import { processRowMeta, processSummary, reapableIds } from "./processes-model";

const HOUR = 3_600_000;

function candidate(overrides: Partial<OrphanProcessCandidate> = {}): OrphanProcessCandidate {
  return {
    itemId: "ledger:4242:1",
    source: "ledger",
    stance: "reapable",
    pid: 4242,
    pgid: 4242,
    startedAt: 1,
    ageMs: 30 * HOUR,
    rssBytes: 2_900_000_000,
    command: "next dev",
    cwd: "/w/VC-341",
    tty: null,
    sessionId: "session-1",
    ticketId: "ticket-341",
    ticketDisplayId: "VC-341",
    worktreePath: "/w/VC-341",
    reason: "",
    ...overrides,
  };
}

function inventory(candidates: OrphanProcessCandidate[]): OrphanProcessInventory {
  return {
    revision: "rev-1",
    scannedAt: 0,
    candidates,
    reapableCount: candidates.filter((entry) => entry.stance === "reapable").length,
  };
}

describe("reapableIds", () => {
  it("never names a row Volli may not kill", () => {
    expect(
      reapableIds([candidate(), candidate({ itemId: "cwd:900:1", stance: "not-volli" })]),
    ).toEqual(["ledger:4242:1"]);
  });
});

describe("processSummary", () => {
  it("counts the two stances separately, because they are two different facts", () => {
    expect(processSummary(true, null)).toBe("Looking…");
    expect(processSummary(false, null)).toBe("Not scanned");
    expect(processSummary(false, inventory([]))).toBe("None");
    expect(processSummary(false, inventory([candidate()]))).toBe("1 to reap");
    expect(
      processSummary(
        false,
        inventory([candidate(), candidate({ itemId: "cwd:900:1", stance: "not-volli" })]),
      ),
    ).toBe("1 to reap, 1 not Volli's");
  });
});

const age = (ms: number) => `${Math.round(ms / HOUR)}h`;
const bytes = (value: number) => `${Math.round(value / 1_000_000)} MB`;

describe("processRowMeta", () => {
  it("says where the evidence came from, so a person can weigh it", () => {
    expect(processRowMeta(candidate(), age, bytes)).toBe(
      "pid 4242 · 30h · 2900 MB · started by Volli",
    );
    expect(
      processRowMeta(candidate({ source: "cwd", stance: "not-volli", tty: "s004" }), age, bytes),
    ).toBe("pid 4242 · 30h · 2900 MB · found by working directory · not Volli's");
  });
});
