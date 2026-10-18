/**
 * Which repository instruction files a project actually has, read off the repo
 * root's own listing (VC-305).
 *
 * WHAT READS THEM. A Chat Session's prompt is composed from the Session spec
 * and nothing on disk (`packages/agent-runtime/src/prompt.ts`): the Agent
 * Runtime injects neither file, and tells the agent to inspect the
 * repository's instructions itself. So for Chats no file is "the loaded one" —
 * whichever exists is read on demand, on equal footing. A terminal harness is
 * different: the CLI it launches loads its own file natively (Claude Code reads
 * `CLAUDE.md`; Codex, Cursor and OpenCode read `AGENTS.md` — the adapter notes
 * in `packages/shared/src/harness/*.ts`). Volli does not choose between them.
 *
 * THREE STATES, by what Volli can do with the entry:
 *
 *   file      a regular file. It can be previewed and revealed.
 *   link      a symlink — to the other file, elsewhere, a directory, or
 *             nothing. File reads refuse every symlink (`Path is a symlink`,
 *             host-core's `assertWithinRoot`), so it is revealed, never
 *             previewed, and is not claimed to resolve.
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
