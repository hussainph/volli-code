export const FIXTURE_SCHEMA_VERSION = 1;
export const CURRENT_DB_SCHEMA_VERSION = 46;
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
});

export function presetNamed(name) {
  const preset = PRESETS[name];
  if (preset === undefined) {
    throw new Error(
      `Unknown performance fixture preset ${JSON.stringify(name)}; expected small, real, or 2x`,
    );
  }
  return preset;
}
