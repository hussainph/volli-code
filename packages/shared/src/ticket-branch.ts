/** Branch-naming convention for ticket worktrees: `volli/<TICKET-ID>-<slug>`. */

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
 * Build the worktree branch name for a ticket. The ticket id is used verbatim
 * (case preserved); the title is slugified. When the slug is empty the branch
 * omits the trailing separator.
 */
export function ticketBranchName(ticketId: string, title: string): string {
  const slug = slugify(title);
  return slug ? `volli/${ticketId}-${slug}` : `volli/${ticketId}`;
}
