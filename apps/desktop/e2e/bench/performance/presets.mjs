export const FIXTURE_SCHEMA_VERSION = 1;
/**
 * The app's latest migration version, which a generated fixture must reach.
 *
 * Unlike {@link FIXTURE_SCHEMA_VERSION}, this is not a pin: it asserts that a
 * freshly generated fixture migrated all the way up, so it has to be raised
 * whenever a migration is added. VC-8 added 047; VC-355 added 048 and 049;
 * VC-380 added 050.
 */
export const CURRENT_DB_SCHEMA_VERSION = 50;
export const DEFAULT_SEED = 353_259_855;
export const REAL_BUSY_CORE_DEFAULT = 2;

/**
 * VC-353 fixture presets. `real` is the captured owner profile scale; the
 * surrounding presets keep the same ratios while providing a fast smoke and a
 * headroom arm. Counts are exact database rows, not estimates.
 */
export const PRESETS = Object.freeze({
  small: Object.freeze({
    sessions: 120,
    sessionEvents: 26_040,
    tickets: 40,
    ticketEvents: 547,
    sessionCommands: 856,
    liveWorktrees: 8,
    overlappingWorktrees: 3,
    maxSessionEvents: 1_200,
    transcriptMessages: 220,
    // The owner's 373 MB file held 173 MB of session_events and ~200 MB the
    // fixture cannot attribute row-for-row (indexes, months of churn, deleted
    // history). We reproduce the Session Event mass exactly and reproduce the
    // remaining physical file mass as free pages, which is what churn leaves
    // behind; this small budget is ten percent of that captured profile.
    targetFileBytes: 37_300_000,
    targetSessionEventBytes: 17_300_000,
  }),
  real: Object.freeze({
    sessions: 1_198,
    sessionEvents: 259_855,
    tickets: 392,
    ticketEvents: 5_361,
    sessionCommands: 8_541,
    liveWorktrees: 50,
    overlappingWorktrees: 17,
    maxSessionEvents: 1_668,
    transcriptMessages: 1_600,
    // The owner's 373 MB file held 173 MB of session_events and ~200 MB the
    // fixture cannot attribute row-for-row (indexes, months of churn, deleted
    // history). We reproduce the Session Event mass exactly and reproduce the
    // remaining physical file mass as free pages, which is what churn leaves
    // behind. This is an honest physical target, not a claim about equivalent
    // live content.
    targetFileBytes: 373_000_000,
    targetSessionEventBytes: 173_000_000,
  }),
  "2x": Object.freeze({
    sessions: 2_396,
    sessionEvents: 519_710,
    tickets: 784,
    ticketEvents: 10_722,
    sessionCommands: 17_082,
    liveWorktrees: 100,
    overlappingWorktrees: 34,
    maxSessionEvents: 3_336,
    transcriptMessages: 3_200,
    targetFileBytes: 746_000_000,
    targetSessionEventBytes: 346_000_000,
  }),
  ...ticketScalePresets(),
});

/**
 * VC-316 board-scale presets: `tickets-300`, `tickets-3k`, `tickets-10k`.
 *
 * These answer ONE question — what does a board cost per card — so they vary
 * the ticket count and hold everything else at the `small` preset's Session
 * mass. That is deliberate and it is a limitation worth stating: they are NOT
 * owner-profile fixtures and their absolute numbers are not comparable with
 * `real`'s. `real` stays the arm for anything about the whole app, and these
 * three are the arm for the board's own per-card slope, which is what the
 * ticket asks to see at 300 / 3,000 / 10,000.
 *
 * Session Events, transcripts and physical file mass stay at the `small`
 * budget so generating a ten-thousand-card board takes seconds rather than
 * scaling a 373 MB file by twenty-five. Ticket Events scale with the tickets
 * (two per ticket) because a ticket with no history is not a ticket the board
 * would ever hold.
 */
function ticketScalePresets() {
  const base = {
    sessions: 120,
    sessionEvents: 26_040,
    sessionCommands: 856,
    liveWorktrees: 8,
    overlappingWorktrees: 3,
    maxSessionEvents: 1_200,
    transcriptMessages: 220,
    targetFileBytes: 37_300_000,
    targetSessionEventBytes: 17_300_000,
  };
  const scaled = (tickets) =>
    Object.freeze({ ...base, tickets, ticketEvents: tickets * 2 });
  return {
    "tickets-300": scaled(300),
    "tickets-3k": scaled(3_000),
    "tickets-10k": scaled(10_000),
  };
}

/** Every preset name, in the order they are declared. */
export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

export function presetNamed(name) {
  const preset = PRESETS[name];
  if (preset === undefined) {
    throw new Error(
      `Unknown performance fixture preset ${JSON.stringify(name)}; expected ${PRESET_NAMES.join(", ")}`,
    );
  }
  return preset;
}
