export const FIXTURE_SCHEMA_VERSION = 1;
/**
 * The app's latest migration version, which a generated fixture must reach.
 *
 * Unlike {@link FIXTURE_SCHEMA_VERSION}, this is not a pin: it asserts that a
 * freshly generated fixture migrated all the way up, so it has to be raised
 * whenever a migration is added. VC-355 added 047 and 048.
 */
export const CURRENT_DB_SCHEMA_VERSION = 48;
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
