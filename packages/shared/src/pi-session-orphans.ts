/** The explicit Pi cleanup names only items from one main-owned inventory. */
export interface PiSessionOrphanReclaimInput {
  scanRevision: string;
  itemIds: string[];
}

/** One confirmed, currently-unreferenced Pi sidecar proposed by a read-only scan. */
export interface PiSessionOrphanCandidate {
  itemId: string;
  path: string;
  sessionId: string;
  sizeBytes: number;
}

/** A jsonl-shaped entry the scanner refused to treat as a deletion candidate. */
export interface PiSessionOrphanSkipped {
  path: string;
  reason: string;
}

/** The exact proposal displayed before Pi cleanup can be confirmed. */
export interface PiSessionOrphanInventory {
  revision: string;
  scannedAt: number;
  candidates: PiSessionOrphanCandidate[];
  candidateCount: number;
  /** What removing every candidate frees: the sidecars and the saved tool output beside them. */
  candidateBytes: number;
  skipped: PiSessionOrphanSkipped[];
  /**
   * Long tool results saved across every Session (VC-469): how much there is
   * now, and the bound past which the oldest are removed first.
   */
  toolOutput: { files: number; bytes: number; limitBytes: number };
}

/** One reviewed candidate main kept after its mandatory pre-unlink re-check. */
export interface PiSessionOrphanKept {
  candidate: PiSessionOrphanCandidate;
  reason: string;
}

/** What one explicit Pi cleanup actually did. */
export interface PiSessionOrphanReclaimReport {
  removed: PiSessionOrphanCandidate[];
  kept: PiSessionOrphanKept[];
  removedCount: number;
  removedBytes: number;
}
