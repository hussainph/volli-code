/**
 * Whether a registered manifest may launch, and what a human is shown before it
 * ever does.
 *
 * A manifest declares a command line Volli will execute, which is a different
 * kind of file from a skill doc. Four rules govern it; two of them are shapes
 * `parseHarnessManifest` refuses outright (a bare `command`, a Volli-owned
 * filename), and the other two live here:
 *
 *  - A manifest is inert until trusted. New, or changed by one byte, does not
 *    launch — {@link harnessTrustDecision} is keyed on the manifest's hash, so
 *    an edit revokes the verdict that was made about the previous bytes.
 *  - Trust requires explicit confirmation of what will run.
 *    {@link harnessTrustPrompt} assembles exactly that, from the same values the
 *    launch itself is built from rather than a re-description of them.
 *
 * Pure, and keyed on hashes rather than paths, so the decision is testable with
 * no filesystem — the {@link managedWriteDecision} idiom applied to a second
 * kind of file.
 */
import type { HarnessAdapter, HarnessEvent } from "./types";
import { supportedEvents } from "./types";

/** What a user recorded about a specific version of a manifest. */
export type HarnessTrustVerdict = "trusted" | "blocked";

/**
 * Whether `value` is a verdict a human could have given. `reconfirm` is
 * deliberately not one: it is what Volli CONCLUDES about bytes nobody has ruled
 * on, so accepting it across the IPC boundary would let a renderer record an
 * answer that was never given.
 */
export function isHarnessTrustVerdict(value: unknown): value is HarnessTrustVerdict {
  return value === "trusted" || value === "blocked";
}

/**
 * What to do with a manifest right now. `reconfirm` is not a soft yes: it means
 * the manifest does not launch until a human answers, which is the same
 * practical outcome as `blocked` and a different thing to say to the user.
 */
export type HarnessTrustDecision = "trusted" | "reconfirm" | "blocked";

export function harnessTrustDecision(input: {
  /** SHA-256 of the manifest bytes on disk now, or `null` when it is gone. */
  currentHash: string | null;
  /** The hash the recorded verdict was made about. */
  recordedHash: string | null;
  /** The recorded verdict, or `null` when nobody has ruled on this harness. */
  recordedVerdict: HarnessTrustVerdict | null;
}): HarnessTrustDecision {
  if (input.currentHash === null) return "blocked";
  if (input.recordedVerdict === null || input.currentHash !== input.recordedHash) {
    return "reconfirm";
  }
  return input.recordedVerdict;
}

/**
 * Everything the confirmation must state: which harness, which binary, the exact
 * argv, and what it claims it will report. Assembled from the resolved binary and
 * the built launch config, so the dialog cannot describe a launch that differs
 * from the one that follows it.
 */
export interface HarnessTrustPrompt {
  slug: string;
  label: string;
  /** The executable Volli resolved on PATH — the claim `command` alone cannot make. */
  binaryPath: string;
  /** The full command line, binary first. Every word after it comes from a declared argv array. */
  argv: readonly string[];
  /** What the manifest claims it will deliver. Claims gate nothing; see the verified ledger. */
  claimedEvents: readonly HarnessEvent[];
}

/**
 * What Volli actually knows about one capability.
 *
 * **verified** — it has been delivered at least once, and only these drive
 * automatic board moves and notifications. **unconfirmed** — claimed, never
 * seen; the capability is shown, and shown as unconfirmed. **absent** — neither.
 */
export type HarnessEventStatus = "verified" | "unconfirmed" | "absent";

/**
 * Verification, not trust, is what a capability rests on. A declaration gates
 * nothing — the verified set is consulted first and a claim only ever changes
 * `absent` into `unconfirmed`, so a manifest gains nothing by lying, and an
 * event that arrives without having been claimed is verified all the same
 * because delivery is the evidence.
 */
export function harnessEventStatus(
  event: HarnessEvent,
  ledger: { declared: ReadonlySet<HarnessEvent>; verified: ReadonlySet<HarnessEvent> },
): HarnessEventStatus {
  if (ledger.verified.has(event)) return "verified";
  return ledger.declared.has(event) ? "unconfirmed" : "absent";
}

export function harnessTrustPrompt(
  adapter: HarnessAdapter,
  input: { binaryPath: string; launchArgv: readonly string[] },
): HarnessTrustPrompt {
  return {
    slug: adapter.id,
    label: adapter.label,
    binaryPath: input.binaryPath,
    argv: [input.binaryPath, ...input.launchArgv],
    claimedEvents: [...supportedEvents(adapter)],
  };
}
