/**
 * Branch-naming convention for ticket worktrees: `volli/<TICKET-ID>-<slug>`.
 * `<TICKET-ID>` is the ticket's *display* id (e.g. `"VC-12"`, from
 * `displayTicketId` in `ticket.ts`) — worktree branches, like presentation,
 * never use the ticket's opaque UUID.
 */

const MAX_SLUG_LENGTH = 48;

/** `-`, by code point. */
const HYPHEN = 0x2d;

/**
 * Strips leading and trailing `-` by index. The regex form (`/^-+|-+$/g`)
 * backtracks quadratically on a long run of hyphens — a title is the user's
 * own text, so that is only a hang-your-own-app risk, but two scans are both
 * cheaper and plainer (CodeQL js/polynomial-redos).
 */
function trimHyphens(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === HYPHEN) start += 1;
  while (end > start && text.charCodeAt(end - 1) === HYPHEN) end -= 1;
  return text.slice(start, end);
}

/**
 * Lowercase `text`, collapse every run of non-`[a-z0-9]` characters into a
 * single hyphen, trim leading/trailing hyphens, and truncate to
 * {@link MAX_SLUG_LENGTH} characters without leaving a trailing hyphen.
 */
export function slugify(text: string): string {
  const slug = trimHyphens(text.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  // The truncated slug can only pick up a *trailing* hyphen — it starts at
  // index 0 of an already-trimmed slug — so one trim covers both cuts.
  return trimHyphens(slug.slice(0, MAX_SLUG_LENGTH));
}

/**
 * Build the worktree branch name for a ticket. `ticketId` is the ticket's
 * *display* id (e.g. `"VC-12"`), not its opaque UUID, and is used verbatim
 * (case preserved); the title is slugified. When the slug is empty the
 * branch omits the trailing separator.
 */
export function ticketBranchName(ticketId: string, title: string): string {
  const slug = slugify(title);
  return slug ? `volli/${ticketId}-${slug}` : `volli/${ticketId}`;
}

/**
 * `volli/<DISPLAY-ID>` then either the end or `-<slug>`. The display id is a
 * ticket prefix (`isValidPrefix`: a letter then up to four letters or digits,
 * never a hyphen) and a ticket number, so the first `-<digits>` closes it and
 * no slug can be mistaken for part of the id: `volli/VC-2-3-things` is VC-2's.
 */
const TICKET_BRANCH = /^volli\/([A-Z][A-Z0-9]{0,4}-\d+)(?:-|$)/;

/**
 * The display id a ticket branch names (`"VC-12"` for `volli/VC-12-mcp-server`
 * or `volli/VC-12`), or `null` for a branch outside the convention. The slug is
 * deliberately ignored: it is the title as it read when the branch was cut, and
 * a retitle or an agent's own `git switch -c volli/VC-12-narrower-fix` changes
 * it without changing whose work the branch carries.
 */
export function ticketBranchDisplayId(branch: string): string | null {
  return TICKET_BRANCH.exec(branch)?.[1] ?? null;
}

/**
 * What a ticket's own worktree directory is checked out on, measured against
 * the branch the ticket expects there:
 *
 * - `expected` — the branch the ticket records (or would name).
 * - `adopt` — a different branch of the SAME ticket (its display id parses out
 *   of it). This is the ticket's work, moved: an agent in the worktree cut a
 *   narrower branch, or the slug drifted with a retitle. The checkout is what
 *   is true, so the ticket takes it on rather than refusing to open.
 * - `foreign` — a branch that is not this ticket's: another ticket's, or one
 *   outside the `volli/` convention. Whose work it is cannot be known from
 *   here, so it is refused, never adopted and never switched away from.
 * - `detached` — no branch at all. Refused too: there is no branch to record,
 *   and a Session opened there would commit onto nothing, leaving its work
 *   reachable only through the reflog.
 */
export type TicketWorktreeCheckout =
  | { kind: "expected" }
  | { kind: "adopt"; branch: string }
  | { kind: "foreign"; branch: string }
  | { kind: "detached" };

export function classifyTicketWorktreeCheckout(input: {
  /** The ticket's display id, e.g. `"VC-12"`. */
  displayId: string;
  /** The branch the ticket records for its worktree, or would name for it. */
  expectedBranch: string;
  /** The branch checked out in the ticket's worktree, `null` for a detached HEAD. */
  checkedOutBranch: string | null;
}): TicketWorktreeCheckout {
  const branch = input.checkedOutBranch;
  if (branch === null) return { kind: "detached" };
  if (branch === input.expectedBranch) return { kind: "expected" };
  return ticketBranchDisplayId(branch) === input.displayId
    ? { kind: "adopt", branch }
    : { kind: "foreign", branch };
}

/** git-reserved ref characters (`~ ^ : ? * [ \`), by code point. */
const RESERVED_REF_CODES = new Set([0x7e, 0x5e, 0x3a, 0x3f, 0x2a, 0x5b, 0x5c]);

/**
 * Whether `name` is a valid git branch / ref name — the subset of
 * `git check-ref-format` rules that matters for a user-entered branch field,
 * so a persisted `branch`/`baseBranch` can be validated on both the renderer
 * and the main-process write path. Rejects: empty; a leading `-` (looks like a
 * flag); `..`; any ASCII control character or space (incl. DEL); any of
 * `~ ^ : ? * [ \`; a leading or trailing `/`; a `.lock` suffix on any
 * component; `@{`; the single character `@`; and a trailing `.`. Pure — no
 * Node imports.
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0) return false;
  if (name === "@") return false;
  if (name.startsWith("-")) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".")) return false;
  if (name.includes("..")) return false;
  if (name.includes("@{")) return false;
  if (name.endsWith(".lock") || name.includes(".lock/")) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
    if (RESERVED_REF_CODES.has(code)) return false;
  }
  return true;
}
