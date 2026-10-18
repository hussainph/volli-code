/**
 * Which repository instruction files a project actually has.
 *
 * Read off the repo root's own listing rather than assumed: Configure →
 * Sessions used to draw `AGENTS.md` and `CLAUDE.md` as literal rows, so a repo
 * with neither, one or both looked identical (VC-305).
 *
 * THERE IS NO "EFFECTIVE" FILE TO PICK, and that is the runtime's rule, not an
 * omission here. The Agent Runtime composes every prompt from the Session spec
 * and discovers nothing on disk (`packages/agent-runtime/src/prompt.ts`): it
 * injects neither file. A Chat Session is told to inspect the repository's
 * instructions itself, so whichever of these exists is there to be read on
 * demand, equally. Marking one as loaded would be a claim the runtime does not
 * make.
 *
 * Exact names only. A `DirEntry` reads a symlink as a file (lstat semantics),
 * so the common `CLAUDE.md → AGENTS.md` link counts as present; a directory
 * that happens to carry one of these names does not.
 */
import type { DirEntry } from "@volli/shared";

/** The two conventional repo-root instruction files, in the order they are listed. */
export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export type InstructionFileName = (typeof INSTRUCTION_FILE_NAMES)[number];

export interface InstructionFile {
  /** The file's name, which is also its path relative to the repo root. */
  name: InstructionFileName;
  present: boolean;
}

/** Each conventional instruction file, present or missing, from the repo root's listing. */
export function instructionFiles(entries: readonly DirEntry[]): readonly InstructionFile[] {
  const files = new Set(
    entries.filter((entry) => entry.kind === "file").map((entry) => entry.name),
  );
  return INSTRUCTION_FILE_NAMES.map((name) => ({ name, present: files.has(name) }));
}
