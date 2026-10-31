/** Closed on backend write; clients map unknown access outcomes to waitlisted. */
export type PreviewAccess = "granted" | "waitlisted";

export const PREVIEW_WAITLIST_MESSAGE =
  "Volli Cloud is invite-only. You're on the waitlist; your local projects are unchanged.";

// Compatibility name for existing callers; the published text is the single authority.
export { PREVIEW_AGREEMENT_VERSION as PREVIEW_ENROLLMENT_AGREEMENT_VERSION } from "../preview-legal";
export const PREVIEW_AGREEMENT_REQUIRED_MESSAGE =
  "Sign out and accept the current Preview Agreement to continue.";

/**
 * What an invite does for the invitee's preview access (`invites.create` /
 * `invites.list`):
 * - `sponsored`: this invite carries the inviter's sponsored grant;
 * - `already_granted`: the invitee has preview access another way;
 * - `needs_access`: the invite carries none (the inviter's allowance is used
 *   up or off, or Volli withdrew this address's access).
 * Open on read: a client shows nothing for a value it does not know.
 */
export type InvitePreviewAccess = "sponsored" | "already_granted" | "needs_access";

/** How many people one preview person may sponsor unless an operator sets their own allowance. */
export const DEFAULT_PREVIEW_SPONSOR_SEATS = 5;

/** The operator's per-person allowance cap: a typo never becomes an unbounded grant. */
export const MAX_PREVIEW_SPONSOR_SEATS = 1000;
