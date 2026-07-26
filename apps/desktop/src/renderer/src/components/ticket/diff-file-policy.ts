/**
 * Pure seeding policy for a future DiffView: given a Change Set file and a
 * base-revision read, decide editor vs binary stub and how to seed Monaco's
 * original/modified sides. No React, Monaco, Electron, or hunk parsing —
 * Monaco DiffEditor owns diff computation later.
 *
 * Original identity (project/ticket/baseRevision/relPath) lives in
 * `DocumentIdentity` (`diff-base`); this module stays URI-agnostic and only
 * returns path + previousPath for the caller to wire.
 */

import type { ChangeSetFile } from "@volli/shared";

export type DiffPresentationKind = "editor" | "binary-stub";

export interface DiffSideSeed {
  /** null means empty side (no model content / empty string seed). */
  value: string | null;
  readOnly: boolean;
}

export interface DiffFilePolicy {
  kind: DiffPresentationKind;
  /** Human explanation when kind === "binary-stub". */
  stubReason?: string;
  original: DiffSideSeed;
  modified: DiffSideSeed;
  /** Path shown / used for modified identity. */
  path: string;
  /** Rename prior path when present. */
  previousPath: string | null;
}

/**
 * Outcome of reading the file at the Change Set base revision — mirrors
 * main's {@link ChangeSetBaseFile} without importing Electron types.
 */
export type DiffBaseRead = { content: string } | { missing: true } | { binary: true };

export interface DiffFilePolicyInput {
  file: Pick<ChangeSetFile, "status" | "path" | "previousPath" | "binary">;
  base: DiffBaseRead;
}

/** Seed Monaco original/modified sides from a Change Set file + base read. */
export function diffFilePolicy(input: DiffFilePolicyInput): DiffFilePolicy {
  const { file, base } = input;
  const previousPath = file.previousPath ?? null;

  // Binary Change Set rows and binary base blobs never open Monaco.
  if (file.binary || "binary" in base) {
    return {
      kind: "binary-stub",
      stubReason: "Binary file",
      path: file.path,
      previousPath,
      original: { value: null, readOnly: true },
      modified: { value: null, readOnly: true },
    };
  }

  // Added / untracked have no base blob — always seed an empty original.
  if (file.status === "added" || file.status === "untracked") {
    return {
      kind: "editor",
      path: file.path,
      previousPath,
      original: { value: null, readOnly: true },
      modified: { value: null, readOnly: false },
    };
  }

  if ("content" in base) {
    return {
      kind: "editor",
      path: file.path,
      previousPath,
      original: { value: base.content, readOnly: true },
      // Deleted: empty read-only modified. Otherwise live model owned elsewhere.
      modified: { value: null, readOnly: file.status === "deleted" },
    };
  }

  throw new Error("unimplemented");
}
