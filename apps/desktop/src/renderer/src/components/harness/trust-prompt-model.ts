/**
 * What the renderer does with a manifest waiting on a human: read the queue,
 * record one answer, read the queue again.
 *
 * The re-read after every verdict is the whole design, not a refresh for
 * tidiness. Main files a verdict against the HASH it was given and refuses one
 * about bytes that have since changed, so "did this answer land?" and "is this
 * manifest still asking?" are the same question — and asking it once, of the
 * disk, is what makes a manifest edited under the open dialog come back as a new
 * question rather than inherit an answer nobody gave about it.
 *
 * Pure of React and of `window.api`: the bridge arrives as {@link HarnessTrustApi},
 * so the dialog above stays view glue and the behaviour is testable without a DOM.
 */

import { errorMessage, shellSingleQuote } from "@volli/shared";
import type {
  BrokenHarnessManifest,
  HarnessTrustVerdict,
  PendingHarnessManifest,
  Result,
} from "@volli/shared";
import type { HarnessPendingResult } from "@volli/shared";

/** The two calls this model needs — `window.api.harness` satisfies it. */
export interface HarnessTrustApi {
  pending(): Promise<HarnessPendingResult>;
  setTrust(input: {
    slug: string;
    manifestSha256: string;
    decision: HarnessTrustVerdict;
  }): Promise<Result>;
}

/**
 * The manifests still asking, plus whatever went wrong on the way — never one
 * without the other. An empty queue paired with a `null` error is the only
 * shape that means "nothing is waiting"; an empty queue with an error means
 * Volli could not find out, and the caller has to say so. `broken` is the
 * third population: manifests that cannot ask because they did not parse,
 * which the caller owes their author a word about.
 */
export interface HarnessTrustQueue {
  pending: PendingHarnessManifest[];
  broken: BrokenHarnessManifest[];
  error: string | null;
}

/**
 * One line naming a manifest that failed to parse and why, for the toast that
 * is the only place its author will hear about it.
 */
export function brokenHarnessMessage(manifest: BrokenHarnessManifest): string {
  const reasons = manifest.errors
    .map((error) => (error.path === "" ? error.message : `${error.path} ${error.message}`))
    .join("; ");
  return `${manifest.manifestPath} isn't a valid manifest: ${reasons}`;
}

/**
 * The command line the confirmation names, as one copy-pasteable line.
 *
 * Quoted per word, and only where quoting is needed: an injected settings
 * payload is a JSON blob full of spaces and braces, and running the words
 * together unquoted would show a command line that is not the one that runs.
 */
export function harnessCommandLine(manifest: PendingHarnessManifest): string {
  return manifest.argv
    .map((word) => (/^[\w./:=-]+$/.test(word) ? word : shellSingleQuote(word)))
    .join(" ");
}

/** Everything waiting on a human right now. */
export async function loadPendingHarnesses(api: HarnessTrustApi): Promise<HarnessTrustQueue> {
  try {
    const result = await api.pending();
    return result.ok
      ? { pending: result.pending, broken: result.broken, error: null }
      : { pending: [], broken: [], error: result.error };
  } catch (error) {
    return { pending: [], broken: [], error: errorMessage(error) };
  }
}

/**
 * Records one verdict and answers with what is still waiting.
 *
 * The refusal wins over a failed re-read: the refusal is what the user's click
 * produced, and a re-read that fails in the same breath is a second symptom of
 * the same outage — reporting it instead would bury the only message that says
 * why the button did nothing.
 */
export async function recordTrustVerdict(
  api: HarnessTrustApi,
  manifest: PendingHarnessManifest,
  decision: HarnessTrustVerdict,
): Promise<HarnessTrustQueue> {
  let refusal: string | null = null;
  try {
    const result = await api.setTrust({
      slug: manifest.slug,
      manifestSha256: manifest.manifestSha256,
      decision,
    });
    if (!result.ok) refusal = result.error;
  } catch (error) {
    refusal = errorMessage(error);
  }
  const queue = await loadPendingHarnesses(api);
  return { pending: queue.pending, broken: queue.broken, error: refusal ?? queue.error };
}
