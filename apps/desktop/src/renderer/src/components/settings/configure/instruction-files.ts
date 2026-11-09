/**
 * Which repository instruction files a project actually has, read off the repo
 * root's own listing (VC-305).
 *
 * WHAT READS THEM. A Chat Session gets one of them in its prompt, recorded
 * once when the Session is born (VC-1054): `AGENTS.md` at the root of the
 * working copy it will run in, or `CLAUDE.md` when `AGENTS.md` is missing or
 * blank — one file, never both, capped at 64 KiB — and every prompt that
 * Session composes reuses that record, so an edit reaches new Sessions, not
 * running ones (`packages/host-core/src/repo-instructions.ts`; selection and
 * cap in `packages/shared/src/repo-instructions.ts`). That reader follows
 * symlinks, so a `CLAUDE.md` linked to `AGENTS.md` arrives once, as
 * `AGENTS.md`. For a worktree Ticket the working copy is the ticket's own
 * checkout, or the branch it will be cut from when it does not exist yet
 * (VC-1055) — not this project root. A terminal harness is different: the CLI
 * it launches loads its own file natively (Claude Code reads `CLAUDE.md`;
 * Codex, Cursor and OpenCode read `AGENTS.md` — the adapter notes in
 * `packages/shared/src/harness/*.ts`).
 *
 * THREE STATES, by what Volli can do with the entry:
 *
 *   file      a regular file. It can be previewed and revealed.
 *   link      a symlink — to the other file, elsewhere, a directory, or
 *             nothing. This pane's file reads refuse every symlink (`Path is
 *             a symlink`, host-core's `assertWithinRoot`), so it is revealed,
 *             never previewed, and is not claimed to resolve here — though
 *             the Session reader above follows it.
 *   missing   nothing by that exact name, or a real directory wearing it.
 */
import type { DirEntry } from "@volli/shared";

/** The two conventional repo-root instruction files, in the order they are listed. */
export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export type InstructionFileName = (typeof INSTRUCTION_FILE_NAMES)[number];

export interface InstructionFile {
  /** The file's name, which is also its path relative to the repo root. */
  name: InstructionFileName;
  state: "file" | "link" | "missing";
}

/** Each conventional instruction file's state, from the repo root's listing. */
export function instructionFiles(entries: readonly DirEntry[]): readonly InstructionFile[] {
  return INSTRUCTION_FILE_NAMES.map((name) => {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry?.link) return { name, state: "link" };
    return { name, state: entry?.kind === "file" ? "file" : "missing" };
  });
}
