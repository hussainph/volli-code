/** Closed on backend write; clients map unknown access outcomes to waitlisted. */
export type PreviewAccess = "granted" | "waitlisted";

export const PREVIEW_WAITLIST_MESSAGE =
  "Volli Cloud is invite-only. You're on the waitlist; your local projects are unchanged.";

// TODO: use PREVIEW_AGREEMENT_VERSION from ../preview-legal once PR #1014 lands.
export const PREVIEW_ENROLLMENT_AGREEMENT_VERSION = "preview-0.3-2026-10-25";
export const PREVIEW_AGREEMENT_REQUIRED_MESSAGE =
  "Sign out and accept the current Preview Agreement to continue.";
