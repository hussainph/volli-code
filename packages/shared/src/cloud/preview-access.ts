/** Closed on backend write; clients map unknown access outcomes to waitlisted. */
export type PreviewAccess = "granted" | "waitlisted";

export const PREVIEW_WAITLIST_MESSAGE =
  "Volli Cloud is invite-only. You're on the waitlist; your local projects are unchanged.";
