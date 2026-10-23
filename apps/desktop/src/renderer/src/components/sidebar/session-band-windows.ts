/**
 * The clock windows the sidebar's two Session bands are cut by, in a leaf of
 * their own: no imports, so anything that needs the same answer can read it
 * without loading the band builder's whole graph. The performance fixture
 * (`e2e/bench/performance/fixture.mjs`) schedules its Sessions against these
 * through a Node-side Vite server that cannot evaluate the renderer's terminal
 * imports, so a constant kept beside `buildActiveSessionListing` would have to
 * be copied there instead — and a copy is how the fixture's bands went empty
 * once already (VC-415). `active-session-listing.ts` re-exports all three.
 */

/**
 * How long a Session that has gone quiet stays in Active. Long enough that
 * stepping away from a running agent does not reshuffle the list under you,
 * short enough that Active still means "recent".
 */
export const ACTIVE_QUIET_WINDOW_MS = 30 * 60_000;

/**
 * How long a ticket's Sessions linger in Previous after it lands in Done. The
 * ticket is finished; its Sessions are the trace of finishing it, and stay
 * reachable for one hour of "wait, what did it actually do".
 */
export const DONE_LINGER_MS = 60 * 60_000;

/** How old a Previous row gets before it counts as concluded business. */
export const PREVIOUS_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
