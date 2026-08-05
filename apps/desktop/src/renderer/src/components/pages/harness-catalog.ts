/**
 * The list the Harness Runtimes settings category selects from, and the words
 * its binary row refuses a candidate with.
 *
 * The list is assembled HERE rather than in main because neither side holds all
 * of it. `volli:harness-registered` deliberately omits the built-ins — the
 * renderer compiles every first-class adapter in, so sending them back would
 * leave it deduplicating two sources of the same four harnesses — while a
 * registered manifest is only knowable from main. The renderer is the one place
 * both halves exist, so it is the only place the union can be formed.
 *
 * Pure so it can be tested without a preload bridge: the view above it is a
 * projection of this, and every rule that decides what a user sees (which
 * harnesses, in what order, under which origin, and what a refusal says) lives
 * on this side of the seam.
 */
import {
  FIRST_CLASS_HARNESS_IDS,
  harnessAdapters,
  type HarnessAdapter,
  type HarnessCommandFailureReason,
} from "@volli/shared";

/** Where a harness came from: shipped with the app, or a manifest someone registered and trusted. */
export type HarnessOrigin = "built-in" | "registered";

/**
 * One selectable harness, reduced to the facts this surface can state honestly
 * today. Deliberately not the whole {@link HarnessAdapter}: capabilities,
 * event bindings and resume argv are real, but nothing in settings acts on
 * them, and a pane that lists fields nobody can change is padding.
 */
export interface HarnessListing {
  readonly id: string;
  readonly label: string;
  /** The bare executable name a launch resolves — the adapter's own `command`. */
  readonly command: string;
  readonly origin: HarnessOrigin;
}

/**
 * The first-class ids, as a set, so the built-in half is defined by the
 * published constant rather than by whatever the adapter registry happens to
 * contain. It also de-duplicates the registered half: a manifest cannot claim a
 * first-class id (the reserved namespaces refuse it) and main filters them out
 * again, but a duplicate here would render the same harness twice, and the
 * cheapest place to be sure is the place that forms the union.
 */
const FIRST_CLASS_IDS: ReadonlySet<string> = new Set(FIRST_CLASS_HARNESS_IDS);

/** The built-in half, in registry order — pinned to {@link FIRST_CLASS_HARNESS_IDS} by test. */
const BUILT_IN_LISTINGS: readonly HarnessListing[] = harnessAdapters
  .filter((adapter) => FIRST_CLASS_IDS.has(adapter.id))
  .map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    command: adapter.command,
    origin: "built-in" as const,
  }));

/**
 * Every harness this host can launch: the built-ins first, in the order they
 * are published, then the registered manifests by label.
 *
 * Built-ins lead because they are the same four on every install, so their
 * positions are learnable; the registered tail is per-machine and sorted so it
 * at least does not reshuffle between reads. Blocked manifests are absent —
 * they never reach `registered()` — and that is the whole v1 story: this
 * surface shows what can launch, not what was ruled on.
 */
export function harnessListings(registered: readonly HarnessAdapter[]): readonly HarnessListing[] {
  const custom = registered
    .filter((adapter) => !FIRST_CLASS_IDS.has(adapter.id))
    .map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      command: adapter.command,
      origin: "registered" as const,
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
  return [...BUILT_IN_LISTINGS, ...custom];
}

/**
 * The listing a selection resolves to: the selected one, else the first.
 *
 * The fallback is what keeps a selected id from outliving its harness — a
 * manifest whose trust is revoked while settings are open leaves a selection
 * pointing at nothing, and the pane must show a harness rather than a blank.
 */
export function activeHarness(
  listings: readonly HarnessListing[],
  selectedId: string | null,
): HarnessListing | null {
  return listings.find((listing) => listing.id === selectedId) ?? listings[0] ?? null;
}

/**
 * The one line a refused binary override gets, per typed reason.
 *
 * Each says what is wrong and the single thing to do about it, and they are
 * kept distinct because the four are genuinely different situations —
 * `path-unavailable` is the host failing to read a login-shell PATH at all,
 * which says nothing about what was typed, so its recovery is to retry and
 * never to retype.
 */
const COMMAND_FAILURE_LINES: Record<HarnessCommandFailureReason, string> = {
  "not-found": "Not on PATH — check the name.",
  "not-executable": "Not an executable file — check the path.",
  "not-resolvable": "Broken link — point at the real file.",
  "path-unavailable": "Couldn't read the login-shell PATH — try again.",
};

/** {@link COMMAND_FAILURE_LINES} for `reason`. */
export function harnessCommandFailureLine(reason: HarnessCommandFailureReason): string {
  return COMMAND_FAILURE_LINES[reason];
}

/**
 * Whether a refusal from `volli:harness-command-set` actually carries one of
 * the four verdicts {@link COMMAND_FAILURE_LINES} has words for.
 *
 * `HarnessCommandSetResult` declares `reason` required on its failure arm, and
 * that is honest about the handler — but the handler is not the only thing that
 * answers the channel. The IPC envelope around it composes refusals of its own
 * that the contract type never sees: `registerGuardedIpcHandlers` answers
 * `{ ok: false, error }` when the arg guard rejects or the body throws, and
 * `registerDegradedIpcHandlers` answers the same for every harness channel when
 * the boot-time database open failed. Both are missing `reason` entirely, and
 * because the type promises it is there, TypeScript will not flag a single
 * reader of it.
 *
 * Trusting the type is what makes that a silent failure rather than a loud one:
 * `undefined` is not `null`, so the failure branch renders, and
 * {@link harnessCommandFailureLine} of `undefined` is `undefined`, so what
 * renders is an empty red line — a refusal a human can neither read nor act on,
 * while the `error` string main did send is dropped on the floor. Narrow here
 * instead, and let a refusal that fails this test fall back to that string.
 */
export function isHarnessCommandFailureReason(
  value: unknown,
): value is HarnessCommandFailureReason {
  return typeof value === "string" && Object.hasOwn(COMMAND_FAILURE_LINES, value);
}
