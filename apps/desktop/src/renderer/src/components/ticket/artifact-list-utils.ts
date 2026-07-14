/**
 * Pure helpers for the Artifacts tab (ticket-detail-mvp decisions #14/#17):
 * splitting a ticket's flat, two-tier `ArtifactEntry[]` (as returned by
 * `api.artifacts.list`) into its ticket/project sections, each sorted, plus
 * a stable row identity. Kept free of React so it's unit-testable without
 * mounting anything — the same role board-dnd.ts plays for the board.
 */
import { compareArtifactEntries, type ArtifactEntry } from "@volli/shared";

export interface GroupedArtifacts {
  ticket: ArtifactEntry[];
  project: ArtifactEntry[];
}

/** Splits a flat, two-tier artifact list into its ticket/project sections, each sorted via the shared `compareArtifactEntries`. */
export function groupArtifactsByTier(entries: readonly ArtifactEntry[]): GroupedArtifacts {
  const ticket: ArtifactEntry[] = [];
  const project: ArtifactEntry[] = [];
  for (const entry of entries) {
    (entry.tier === "ticket" ? ticket : project).push(entry);
  }
  ticket.sort(compareArtifactEntries);
  project.sort(compareArtifactEntries);
  return { ticket, project };
}

/** A stable row identity — `(tier, name)`, since a name isn't unique across tiers (the same file can exist at both). */
export function artifactKey(entry: Pick<ArtifactEntry, "tier" | "name">): string {
  return `${entry.tier}:${entry.name}`;
}
