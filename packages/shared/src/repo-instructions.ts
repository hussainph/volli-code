/**
 * Repository instructions — the workspace's own `AGENTS.md` (or `CLAUDE.md`)
 * as the {@link PromptResource} a structured Session is born with (VC-1054).
 *
 * Plain Pi and Claude Code load a repository's instruction file on their own.
 * A Volli Session's prompt is composed only from product-owned layers and the
 * resources recorded for it, so the file arrives the way the skills index
 * does: read once at birth, recorded as part of the Session's
 * `prompt-resources` input, and rendered as one delimited RESOURCE section on
 * every attach from that record — never from a second disk read.
 *
 * Source, deliberately narrow: the workspace root only. Pi also reads a
 * global `~/.pi/agent/AGENTS.md` and walks parent directories, and neither is
 * taken here. The global file is one person's harness configuration rather
 * than the project's, and a parent walk from a ticket worktree under
 * `~/.volli/worktrees/` would reach directories that belong to no repository.
 * Per directory, the convention Pi and Claude Code share applies: `AGENTS.md`
 * when it has content, `CLAUDE.md` only when it does not — one file, so a
 * repository that keeps the two identical (or symlinked) is injected once.
 *
 * Pure string work, like `skill.ts`: host-core reads the files and hands the
 * text here, so the selection, the cap and the truncation note are one tested
 * function no host can spell differently.
 */
import type { PromptResource } from "./agent-runtime";

/**
 * The resource's name. Unspellable as a skill slug — the `/name` grammar has
 * no space — so no installed skill can collide with it in the RESOURCE
 * delimiter, the transcript's started-with badges, or the baseline breakdown,
 * which recognizes the section by this name.
 */
export const REPO_INSTRUCTIONS_RESOURCE_NAME = "repository instructions";

/** The instruction files read from the workspace root, in preference order. */
export const REPO_INSTRUCTIONS_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** One of {@link REPO_INSTRUCTIONS_FILES}. */
export type RepoInstructionsFile = (typeof REPO_INSTRUCTIONS_FILES)[number];

/**
 * The byte ceiling on the file's injected content: 64 KiB, ~16k estimated
 * tokens. Instruction files are project-sized, not Volli-sized, so this is a
 * guard against a runaway file rather than a budget — generous enough that a
 * real, long house-rules file arrives whole. Over it, the content is cut on a
 * line boundary and a note names the file so the agent can read the rest.
 */
export const REPO_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

/** One instruction file as the host read it; absent files are simply not passed. */
export interface RepoInstructionsSource {
  file: RepoInstructionsFile;
  text: string;
}

/** UTF-8 byte length without a Node or DOM import. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * The longest run of whole lines whose UTF-8 encoding fits `maxBytes`, newline
 * included — a cut that never splits a line or a code point.
 */
function headWithinBytes(text: string, maxBytes: number): string {
  let used = 0;
  let end = 0;
  for (const line of text.split("\n")) {
    const cost = utf8Bytes(line) + 1;
    if (used + cost > maxBytes) break;
    used += cost;
    end += line.length + 1;
  }
  return text.slice(0, end).trimEnd();
}

/**
 * The repository instructions a Session is born with, or `null` when the
 * workspace has none worth sending.
 *
 * `sources` are the files that exist and were readable, in any order; the
 * first of {@link REPO_INSTRUCTIONS_FILES} with non-blank content wins. An
 * empty `AGENTS.md` falls through to `CLAUDE.md` rather than shadowing it,
 * because a blank file instructs nothing.
 */
export function repoInstructionsResource(
  sources: readonly RepoInstructionsSource[],
  maxBytes: number = REPO_INSTRUCTIONS_MAX_BYTES,
): PromptResource | null {
  for (const file of REPO_INSTRUCTIONS_FILES) {
    const source = sources.find((candidate) => candidate.file === file);
    if (source === undefined) continue;
    const content = source.text.trim();
    if (content.length === 0) continue;
    const header = `From ${file} at the workspace root, as it read when this Session started.`;
    const total = utf8Bytes(content);
    if (total <= maxBytes)
      return { name: REPO_INSTRUCTIONS_RESOURCE_NAME, text: `${header}\n\n${content}` };
    const head = headWithinBytes(content, maxBytes);
    const note = `[Truncated: ${file} is ${total} bytes and only the first ${utf8Bytes(head)} are shown. Read ${file} at the workspace root for the rest.]`;
    return {
      name: REPO_INSTRUCTIONS_RESOURCE_NAME,
      text: [header, ...(head.length === 0 ? [] : [head]), note].join("\n\n"),
    };
  }
  return null;
}

/** Whether a recorded resource is the repository instructions. */
export function isRepoInstructionsResource(resource: PromptResource): boolean {
  return resource.name === REPO_INSTRUCTIONS_RESOURCE_NAME;
}
