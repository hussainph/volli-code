/**
 * The one harness config file Volli cannot keep out of the user's repository.
 *
 * Everything else a harness needs is written under `<userData>/harness/<slug>/`
 * and pointed at by an environment variable or an argv flag. `cursor-agent`
 * has no such variable: it reads project hooks from `.cursor/hooks.json`
 * relative to its working directory and nowhere else that is per-ticket. So
 * this writes inside the checkout — which is defensible only because the
 * checkout is a worktree Volli created for one ticket, and only under three
 * rules the whole module exists to enforce:
 *
 * 1. **Never in the user's own checkout.** Callers pass a worktree path; a
 *    scratch session in the project root gets nothing, and cursor there simply
 *    reports nothing (see the caller).
 * 2. **Never in `git status`.** A file the agent can see is a file the agent can
 *    `git add`, and a Volli socket path committed to the user's branch is a
 *    defect that outlives the session. Two halves: a path git already TRACKS is
 *    refused outright (a write would show as a modification, which no ignore
 *    rule suppresses), and an untracked one is excluded.
 * 3. **Never clobber.** A `.cursor/hooks.json` the user wrote keeps its hooks;
 *    Volli's entries are folded in beside them and replace only their own
 *    previous selves (`mergeCursorHooks`).
 *
 * ── On `info/exclude`, and a thing worth knowing ──
 * Git resolves `info/exclude` against the COMMON directory, not the worktree's
 * own git dir: `<repo>/.git/worktrees/<name>/info/exclude` is read by nothing
 * (verified — `info` is on git's common list, `info/sparse-checkout` being the
 * one per-worktree exception). So the entry necessarily lands in
 * `<repo>/.git/info/exclude`, shared with the main checkout. It is still the
 * right file — uncommitted, personal, exactly what git provides for this — but
 * it is repo-wide rather than worktree-local, so the pattern is written as one
 * narrow fenced block naming the exact paths and nothing else.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { buildLaunchConfig, mergeWorkspaceFile } from "@volli/shared";
import type { HarnessAdapter, HarnessId, HarnessWorkspaceFile } from "@volli/shared";

import { writeGeneratedFile } from "./harness-runtime";
import type { RunGit } from "./worktree";
import { isInside } from "./worktree/paths";

/** Opens and closes the fenced block in `.git/info/exclude`. */
const EXCLUDE_BEGIN = "# volli:begin harness-workspace";
const EXCLUDE_END = "# volli:end harness-workspace";

export interface HarnessWorkspaceInput {
  /** The ticket's worktree — never a project root, never a renderer-supplied cwd. */
  worktreePath: string;
  adapters: readonly HarnessAdapter[];
  socketPath: string;
  /** The generated `volli` launcher a fired hook invokes. */
  shimPath: string;
  git: RunGit;
}

/** A workspace file Volli declined to write, and the reason a human needs. */
export interface RefusedWorkspaceFile {
  harnessId: HarnessId;
  path: string;
  reason: string;
}

export interface HarnessWorkspaceResult {
  written: string[];
  refused: RefusedWorkspaceFile[];
}

/** File text, or `null` when nothing is there. Never reads THROUGH a symlink. */
async function textAt(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const entry = await handle.stat();
    if (!entry.isFile()) throw new Error(`Refusing to manage non-regular file ${path}`);
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new Error(`Refusing to manage non-regular file ${path}`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Whether git has `relPath` in the index for this worktree. A tracked path is
 * the one case no ignore rule can rescue: writing to it produces a modification
 * in `git status` and in every `git add -A` the agent runs.
 *
 * `ls-files` without `--error-unmatch`, so "not tracked" is empty output rather
 * than a non-zero exit — the runner collapses every failure into one error type,
 * and a repository that cannot be read must not be indistinguishable from a path
 * that is merely absent from the index. A failure answers TRACKED, because the
 * cost of the two wrong answers is not symmetric: refusing to write costs cursor
 * its events for one session, and writing wrongly costs the user a dirty diff.
 */
function isTracked(git: RunGit, worktreePath: string, relPath: string): boolean {
  try {
    return git(["ls-files", "-z", "--", relPath], worktreePath).length > 0;
  } catch {
    return true;
  }
}

/**
 * The repository's common git directory — where `info/exclude` actually lives
 * for a linked worktree. Git may answer relatively (`.git`) for a main
 * checkout, so the result is resolved against the worktree.
 */
function commonGitDir(git: RunGit, worktreePath: string): string {
  const answer = git(["rev-parse", "--git-common-dir"], worktreePath).trim();
  return isAbsolute(answer) ? answer : resolve(worktreePath, answer);
}

/**
 * The exclude file's text with Volli's block set to exactly `patterns`, or
 * `null` when it already says that. Idempotent by construction: the block is
 * replaced wholesale rather than appended to, so a worktree booted a hundred
 * times leaves one block.
 */
export function excludeWithBlock(current: string, patterns: readonly string[]): string | null {
  const block = [EXCLUDE_BEGIN, ...patterns, EXCLUDE_END].join("\n");
  const fence = new RegExp(`${EXCLUDE_BEGIN}[\\s\\S]*?${EXCLUDE_END}`);
  const next = fence.test(current)
    ? current.replace(fence, () => block)
    : `${current.replace(/\n+$/, "")}${current.trim().length > 0 ? "\n\n" : ""}${block}\n`;
  return next === current ? null : next;
}

/**
 * Materializes every harness file that has to live in the ticket's worktree,
 * refreshing them on each session boot — the hook command line carries this
 * launch's socket path, and a file written by a previous run of the app names a
 * socket that is gone.
 *
 * Refusals are returned rather than thrown: one harness whose config Volli will
 * not touch must not abort a session boot for a different harness, and the
 * caller surfaces them.
 */
export async function ensureHarnessWorkspaceFiles(
  input: HarnessWorkspaceInput,
): Promise<HarnessWorkspaceResult> {
  const result: HarnessWorkspaceResult = { written: [], refused: [] };
  const excluded: string[] = [];

  for (const adapter of input.adapters) {
    const config = buildLaunchConfig(adapter, {
      socketPath: input.socketPath,
      hookArgv: [input.shimPath, "hook", adapter.id],
    });
    for (const file of config.workspaceFiles) {
      const refuse = (reason: string): void => {
        result.refused.push({ harnessId: adapter.id, path: file.path, reason });
      };
      const absolute = join(input.worktreePath, file.path);
      if (!isInside(input.worktreePath, absolute)) {
        refuse("path escapes the worktree");
        continue;
      }
      if (isTracked(input.git, input.worktreePath, file.path)) {
        refuse("git tracks this file — writing it would show up in the ticket's diff");
        continue;
      }
      const merged = await mergeExisting(file, absolute);
      if (!merged.ok) {
        refuse(merged.reason);
        continue;
      }
      await writeGeneratedFile(absolute, merged.content, 0o600);
      result.written.push(absolute);
      // Anchored to the repository root: an unanchored `hooks.json` would hide
      // a file of that name anywhere in the tree, in every worktree.
      excluded.push(`/${file.path}`);
    }
  }

  if (excluded.length > 0) {
    await ensureExcluded(input.git, input.worktreePath, excluded);
  }
  return result;
}

async function mergeExisting(
  file: HarnessWorkspaceFile,
  absolute: string,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  let existing: string | null;
  try {
    existing = await textAt(absolute);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return mergeWorkspaceFile(file, existing);
}

async function ensureExcluded(
  git: RunGit,
  worktreePath: string,
  patterns: readonly string[],
): Promise<void> {
  const excludePath = join(commonGitDir(git, worktreePath), "info", "exclude");
  const current = (await textAt(excludePath)) ?? "";
  const next = excludeWithBlock(current, patterns);
  if (next !== null) await writeGeneratedFile(excludePath, next, 0o644);
}
