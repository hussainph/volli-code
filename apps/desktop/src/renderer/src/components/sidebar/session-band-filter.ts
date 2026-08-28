import type {
  SessionListingFilter,
  SessionRowKind,
  SessionRowScope,
} from "@renderer/components/sidebar/active-session-listing";

/**
 * What the Previous band is currently showing.
 *
 * A checkbox per member rather than the model's `Set | null`, because every
 * menu checkbox needs a state even when its axis is not narrowed.
 */
export interface SessionBandFilter {
  kinds: Record<SessionRowKind, boolean>;
  scopes: Record<SessionRowScope, boolean>;
  showCleaned: boolean;
}

export const DEFAULT_SESSION_BAND_FILTER: SessionBandFilter = {
  kinds: { chat: true, terminal: true },
  scopes: { project: true, ticket: true },
  showCleaned: false,
};

const SESSION_ROW_KINDS = ["chat", "terminal"] as const satisfies readonly SessionRowKind[];
const SESSION_ROW_SCOPES = ["project", "ticket"] as const satisfies readonly SessionRowScope[];

/**
 * One checkbox axis as the listing model's `Set | null`. Everything checked
 * becomes `null` (not narrowed); nothing checked remains an empty set (show
 * nothing), rather than unexpectedly restoring the whole band.
 */
function narrowedAxis<T extends string>(
  members: readonly T[],
  checked: Record<T, boolean>,
): ReadonlySet<T> | null {
  const on = members.filter((member) => checked[member]);
  return on.length === members.length ? null : new Set(on);
}

/** The menu's checkbox state as the filter consumed by the listing model. */
export function sessionListingFilter(filter: SessionBandFilter): SessionListingFilter {
  return {
    kinds: narrowedAxis(SESSION_ROW_KINDS, filter.kinds),
    scopes: narrowedAxis(SESSION_ROW_SCOPES, filter.scopes),
    showCleaned: filter.showCleaned,
  };
}

/** Whether the trigger should signal that the Previous band differs from its default. */
export function isSessionBandFilterNarrowed(filter: SessionBandFilter): boolean {
  const listingFilter = sessionListingFilter(filter);
  return listingFilter.kinds !== null || listingFilter.scopes !== null || listingFilter.showCleaned;
}
