import { errorMessage, type DirEntry, type ListDirectoryResult } from "@volli/shared";

/** One directory level's listing state. `undefined` = not fetched yet. */
export type Listing = DirEntry[] | "loading" | { error: string } | undefined;

/**
 * The one place that discriminates the error member. Every narrowing site
 * routes through this so a future object-shaped `Listing` member can't
 * silently fall into an error branch by structural elimination.
 */
export function isListingError(listing: Listing): listing is { error: string } {
  return typeof listing === "object" && !Array.isArray(listing);
}

/** Maps an IPC listing result onto `Listing` — the ok/error split used at every fetch site. */
export function toListing(result: ListDirectoryResult): Listing {
  return result.ok ? result.entries : { error: result.error };
}

/** Maps a thrown/rejected fetch onto the error member of `Listing`. */
export function errorListing(error: unknown): Listing {
  return { error: errorMessage(error) };
}

/** A level should fetch when it's expanded and hasn't fetched (or refetched) yet. */
export function shouldFetchListing(expanded: boolean, children: Listing): boolean {
  return expanded && children === undefined;
}

/**
 * A cached ERROR is retried on the next expand — a transient failure
 * (e.g. losing the root-sync race, or a momentary EACCES/EMFILE) shouldn't
 * stick until the whole tree is remounted.
 */
export function shouldRetryListing(open: boolean, children: Listing): boolean {
  return open && isListingError(children);
}
