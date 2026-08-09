/**
 * Pure composition for the ticket Files navigator (decision #46).
 *
 * Ticket Files is a contextual rail index — referenced context from the Ticket
 * Body (`parseFileRefs`) and attachments, plus a compact flat listing of the
 * worktree. Deep repository tree navigation stays on the project-level Files
 * surface (decision #53/#54); this module never builds an indented tree.
 */

import {
  attachmentsSectionInput,
  baseNameOf,
  dirNameOf,
  parseFileRefs,
  type TicketAttachment,
} from "@volli/shared";

export type TicketFileRefSource = "body" | "attachment";

export interface TicketFileRefRow {
  relPath: string;
  /** Display label — attachment label when from attachments, else the basename. */
  label: string;
  source: TicketFileRefSource;
}

export interface TicketWorktreeEntry {
  relPath: string;
  kind: "file" | "directory";
}

export interface TicketFilesNavigatorInput {
  body: string;
  attachments: readonly TicketAttachment[];
  /** Already-flattened worktree entries (root listing and/or shallow walks). */
  worktreeEntries: readonly TicketWorktreeEntry[];
}

export interface TicketFilesNavigator {
  referenced: TicketFileRefRow[];
  worktree: TicketWorktreeEntry[];
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The Ticket Body's `@file` references as navigator rows, deduped by path and
 * path-sorted. Split out because the rail's Environment inspector needs exactly
 * this list without an attachment feed or a worktree listing, and it must not
 * re-derive what a body reference row is.
 */
export function bodyFileRefRows(body: string): TicketFileRefRow[] {
  const byPath = new Map<string, TicketFileRefRow>();
  for (const ref of parseFileRefs(body)) {
    byPath.set(ref.path, {
      relPath: ref.path,
      label: baseNameOf(ref.path),
      source: "body",
    });
  }
  return [...byPath.values()].toSorted((a, b) => comparePath(a.relPath, b.relPath));
}

/**
 * Build the Files navigator's two sections from body text, attachments, and
 * worktree entries. Attachment paths win over body refs when both name the
 * same relPath (the attachment carries a richer label).
 */
export function buildTicketFilesNavigator(input: TicketFilesNavigatorInput): TicketFilesNavigator {
  const byPath = new Map<string, TicketFileRefRow>(
    bodyFileRefRows(input.body).map((row) => [row.relPath, row]),
  );

  for (const file of attachmentsSectionInput(input.attachments).files) {
    byPath.set(file.relPath, {
      relPath: file.relPath,
      label: file.label,
      source: "attachment",
    });
  }

  const referenced = [...byPath.values()].toSorted((a, b) => comparePath(a.relPath, b.relPath));
  const worktree = input.worktreeEntries.toSorted((a, b) => comparePath(a.relPath, b.relPath));

  return { referenced, worktree };
}

/** Filename + muted parent for a Files row — same visual hierarchy as Changes. */
export function splitFilesPath(relPath: string): { filename: string; parentPath: string } {
  return { filename: baseNameOf(relPath), parentPath: dirNameOf(relPath) };
}
