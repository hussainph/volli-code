/**
 * VC-456's script constants, kept apart from the composition so the analysis
 * can read them without loading SQLite, the Pi runtime or the Session runtime.
 */

/** A private-looking marker the privacy test proves never leaves the path's outputs. */
export const PRIVATE_CONTENT_CANARY = "vc456-private-prompt-and-tool-output-canary";

/**
 * The stand-in person's think time before answering, kept at VC-441's
 * authority wait so both fixtures script the same 12 ms. Everything the
 * measured wait holds beyond it is the real path's own round trip.
 */
export const AUTHORITY_THINK_MS = 12;

/**
 * Whether each Session has a live `SessionRuntime.subscribe` listener, as a
 * chat open in a tab does (`all`), or none, as for Sessions working in the
 * background (`none`). Not the product's Watch, which is one Session following
 * another Session or a Ticket.
 */
export type SubscriberMode = "all" | "none";
