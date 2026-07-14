/**
 * Branch-naming convention for ticket worktrees: `volli/<TICKET-ID>-<slug>`.
 * `<TICKET-ID>` is the ticket's *display* id (e.g. `"VC-12"`, from
 * `displayTicketId` in `ticket.ts`) — worktree branches, like presentation,
 * never use the ticket's opaque UUID.
 */

const MAX_SLUG_LENGTH = 48;

/**
 * Lowercase `text`, collapse every run of non-`[a-z0-9]` characters into a
 * single hyphen, trim leading/trailing hyphens, and truncate to
 * {@link MAX_SLUG_LENGTH} characters without leaving a trailing hyphen.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
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
