/**
 * Reading a workspace's repository instruction file (VC-1054) — the one read
 * behind the `repository instructions` resource a structured Session is born
 * with. Selection, cap and truncation are `@volli/shared`'s
 * `repoInstructionsResource`; this module only fetches the candidates.
 *
 * WHERE FROM (VC-1055). A Session records the file its own working copy holds.
 * For a Project, Board or no-worktree Session that is the project root, read
 * off disk. For a worktree Ticket it is the ticket's checkout — but birth runs
 * before the first attach, and the first attach is what cuts that checkout
 * (`location.ts` → `ensure`). So when the checkout already exists it is read
 * off disk, and when it does not, the file is read from the git ref `ensure`
 * will cut it from: the ticket's own branch when that branch already exists
 * (`git worktree add <path> <branch>`), else the resolved base's start point
 * (`git worktree add -b <branch> <path> <startPoint>`). That committed blob is
 * exactly what the fresh checkout will contain, whatever the main checkout has
 * uncommitted or checked out.
 *
 * Reading the ref at birth, rather than deferring the read until `prepare` has
 * cut the checkout, keeps the record where VC-16 put it: written durably inside
 * the mint, beside the skills it shares one input with, before any attach can
 * compose a prompt — and answerable by `prompt baseline`, which never prepares
 * a worktree.
 *
 * SYMLINKS. A disk read follows them the way any reader does, so a `CLAUDE.md`
 * linked to `AGENTS.md` is read once (`AGENTS.md` wins). In a git tree a
 * symlink's blob is its target path, not the content, so the ref read follows
 * in-tree targets itself; a target outside the tree, dangling, or looping
 * reads as missing.
 *
 * The failure policy is the skills index's: nobody asked for this file, so a
 * missing one is the normal case and an unreadable one costs the resource,
 * never the Session. A read that fails for any reason but absence is logged
 * and skipped.
 */
import { existsSync, promises as fsp } from "node:fs";
import { join, posix } from "node:path";
import {
  errorMessage,
  REPO_INSTRUCTIONS_FILES,
  repoInstructionsResource,
  type PromptResource,
  type RepoInstructionsSource,
} from "@volli/shared";

import { hostLogger } from "./log/root";
import { refExists, resolveBaseBranch } from "./worktree/base";
import { resolveWorktreeIdentity } from "./worktree/identity";
import type { RunGitAsync } from "./worktree/types";

const log = hostLogger("repo-instructions");

async function readCandidate(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      log.warn("repository instructions unreadable", { path, reason: errorMessage(error) });
    }
    return null;
  }
}

/**
 * The repository instructions at `workspaceDir`'s root, as the resource a
 * Session records at birth, or `null` when there are none to send.
 */
export async function readRepoInstructions(workspaceDir: string): Promise<PromptResource | null> {
  const sources: RepoInstructionsSource[] = [];
  for (const file of REPO_INSTRUCTIONS_FILES) {
    const text = await readCandidate(join(workspaceDir, file));
    if (text !== null) sources.push({ file, text });
  }
  return repoInstructionsResource(sources);
}

/** How many symlinks one candidate may pass through before it reads as missing. */
const MAX_SYMLINK_HOPS = 8;

/** One `git ls-tree` entry: mode, object type and id. */
interface TreeEntry {
  mode: string;
  type: string;
  object: string;
}

/** `git ls-tree -z <ref> -- <paths>`, keyed by path. */
async function lsTree(
  git: RunGitAsync,
  repoDir: string,
  ref: string,
  paths: readonly string[],
): Promise<Map<string, TreeEntry>> {
  const out = await git(["ls-tree", "-z", "--full-tree", ref, ...paths], repoDir);
  const entries = new Map<string, TreeEntry>();
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(" ");
    if (mode === undefined || type === undefined || object === undefined) continue;
    entries.set(record.slice(tab + 1), { mode, type, object });
  }
  return entries;
}

/** A symlink target resolved against the link's directory, or `null` when it leaves the tree. */
function inTreeTarget(linkPath: string, target: string): string | null {
  if (target.length === 0 || posix.isAbsolute(target)) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  if (resolved === ".." || resolved.startsWith("../") || resolved === ".") return null;
  return resolved;
}

/** The text at `path` in `ref`'s tree, following in-tree symlinks; `null` when there is none. */
async function readBlobAt(
  git: RunGitAsync,
  repoDir: string,
  ref: string,
  first: TreeEntry | undefined,
  path: string,
): Promise<string | null> {
  let entry = first;
  let at = path;
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    if (entry === undefined || entry.type !== "blob") return null;
    // By object id, not `<ref>:<path>`: a bare blob carries no path for an
    // attribute (textconv) to apply to, so these are the committed bytes.
    const bytes = await git(["show", entry.object], repoDir);
    if (entry.mode !== "120000") return bytes;
    const next = inTreeTarget(at, bytes);
    if (next === null) return null;
    at = next;
    entry = (await lsTree(git, repoDir, ref, [at])).get(at);
  }
  return null;
}

/**
 * The repository instructions committed at `ref` in the repository at
 * `repoDir` — what a checkout of that ref holds at its root — or `null` when
 * there are none, or the ref cannot be read.
 */
export async function readRepoInstructionsAtRef(
  git: RunGitAsync,
  repoDir: string,
  ref: string,
): Promise<PromptResource | null> {
  try {
    const entries = await lsTree(git, repoDir, ref, REPO_INSTRUCTIONS_FILES);
    const sources: RepoInstructionsSource[] = [];
    for (const file of REPO_INSTRUCTIONS_FILES) {
      const text = await readBlobAt(git, repoDir, ref, entries.get(file), file);
      if (text === null) continue;
      sources.push({ file, text });
      // The first file with content wins, so the next one is never needed.
      if (text.trim().length > 0) break;
    }
    return repoInstructionsResource(sources);
  } catch (error) {
    log.warn("repository instructions unreadable", { repoDir, ref, reason: errorMessage(error) });
    return null;
  }
}

/** The board facts that decide which working copy a Ticket Session will run in. */
export interface TicketWorkspaceFacts {
  /** The main checkout: the root a no-worktree ticket runs in, and where its refs live. */
  checkoutPath: string;
  projectId: string;
  /** `~`, as the worktree module resolves it — the root of an unstamped worktree path. */
  home: string;
  displayId: string;
  title: string;
  usesWorktree: boolean;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  projectBaseBranch: string | null;
}

/**
 * The repository instructions a Ticket Session's own working copy holds, as
 * birth can know them (see the module comment): the main checkout for a ticket
 * that runs there, the ticket's checkout when it exists, and otherwise the ref
 * `ensure` will cut that checkout from. Identity and base resolve through the
 * worktree module's own functions, so the ref read is the one `git worktree
 * add` would check out.
 */
export async function readTicketRepoInstructions(
  git: RunGitAsync,
  facts: TicketWorkspaceFacts,
): Promise<PromptResource | null> {
  if (!facts.usesWorktree) return readRepoInstructions(facts.checkoutPath);
  const identity = resolveWorktreeIdentity({
    home: facts.home,
    projectPath: facts.checkoutPath,
    projectId: facts.projectId,
    displayId: facts.displayId,
    title: facts.title,
    persistedPath: facts.worktreePath,
    persistedBranch: facts.branch,
  });
  if (existsSync(identity.path)) return readRepoInstructions(identity.path);
  const branchRef = `refs/heads/${identity.branch}`;
  if (await refExists(git, facts.checkoutPath, branchRef)) {
    return readRepoInstructionsAtRef(git, facts.checkoutPath, branchRef);
  }
  const base = await resolveBaseBranch(git, {
    projectPath: facts.checkoutPath,
    ticketBaseBranch: facts.baseBranch,
    projectBaseBranch: facts.projectBaseBranch,
  }).catch(() => null);
  // No base means no worktree either: the first attach fails on its own, and
  // there is no working copy whose instructions could be recorded.
  if (base === null) return null;
  return readRepoInstructionsAtRef(git, facts.checkoutPath, base.startPoint);
}
