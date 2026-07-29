/**
 * The seam between a manifest sitting on disk and a harness that can launch:
 * ask what is waiting on a human, and record what the human answered.
 *
 * `harness-registry.ts` has always been able to discover a manifest, hash it and
 * decide it, and `trustedHarnessAdapters` has always refused to yield one nobody
 * confirmed. Nothing asked. These two channels are the question.
 *
 * Three rules the surface keeps, none of which the renderer could keep for it:
 *
 *  - **The claim is assembled from the launch, not written about it.**
 *    {@link harnessTrustPrompt} is fed the binary this host resolves and the argv
 *    the wrapper really prepends, so the dialog cannot describe a launch that
 *    differs from the one it authorizes.
 *  - **A verdict is about bytes.** The hash the user was shown travels back with
 *    their answer and is checked against the file as it is NOW. A manifest edited
 *    while the dialog was open is refused rather than grandfathered, which leaves
 *    it pending — a new question about new bytes.
 *  - **The disk is re-read on every call.** Nothing is cached between the
 *    question and the answer, because the cache would be exactly the window an
 *    edit could slip through.
 *  - **A verdict and the files generated from it land together, or neither
 *    does.** Recording "trusted" changes nothing a launch can see; the wrappers
 *    do. See {@link HarnessIpcDeps.regenerateRuntime}.
 */

import {
  errorMessage,
  harnessTrustPrompt,
  HARNESS_CHANNELS,
  HARNESS_IPC,
  supportedEvents,
} from "@volli/shared";
import type {
  HarnessAdapter,
  HarnessIpcChannel,
  HarnessPendingResult,
  HarnessTrustSetInput,
  PendingHarnessManifest,
  Result,
} from "@volli/shared";

import type { DbHandle } from "./data-ipc";
import {
  getRegisteredHarness,
  recordHarnessTrust,
  restoreRegisteredHarness,
} from "./db/harness-registry-repo";
import { decideRegisteredHarnesses, scanHarnessManifests } from "./harness-registry";
import type { DecidedHarnessManifest } from "./harness-registry";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";
import type { IpcHandlerTable } from "./ipc-registry";

export interface HarnessIpcDeps {
  /** `~/.agents/harnesses` — walked fresh per call, never remembered between them. */
  harnessesDir: string;
  /**
   * The executable a manifest's `command` resolves to on this host, absolute, or
   * `null` when nothing by that name is installed. The same walk the generated
   * wrapper performs at run time, so the path shown is the file that will run.
   */
  resolveBinary(command: string): Promise<string | null>;
  /** The words a launch of `adapter` prepends — see `harnessLaunchArgv`. */
  launchArgv(adapter: HarnessAdapter): readonly string[];
  /**
   * Regenerates everything derived from the recorded verdicts: the PATH
   * wrappers, the per-harness config files, the shell chain — main's
   * `regenerateHarnessRuntime`, the same work boot and `volli doctor --fix` do.
   *
   * A verdict on its own is inert. Until this has run, the harness the user just
   * approved has no wrapper, so it launches unconfigured and reports nothing —
   * and the app says nothing about the difference. That is why it is a
   * dependency of this surface rather than something a caller may remember to do
   * afterwards, why it is awaited, and why a rejection here fails the write.
   */
  regenerateRuntime(): Promise<void>;
  now(): number;
}

/**
 * The manifests a human still owes an answer about.
 *
 * Three exclusions, each of them a question that cannot honestly be asked yet.
 * A manifest that did not parse has no command line to confirm. One already
 * ruled on is not pending — that is the whole point of recording the verdict.
 * And a manifest whose command is on no PATH entry would have the dialog name a
 * binary that does not exist; when the user installs it, it becomes pending,
 * and the file will be re-hashed then like every other.
 */
async function pendingManifests(
  decided: readonly DecidedHarnessManifest[],
  deps: HarnessIpcDeps,
): Promise<PendingHarnessManifest[]> {
  const waiting: PendingHarnessManifest[] = [];
  for (const entry of decided) {
    const adapter = entry.adapter;
    if (entry.decision !== "reconfirm" || adapter === null) continue;
    const binaryPath = await deps.resolveBinary(adapter.command);
    if (binaryPath === null) continue;
    waiting.push({
      ...harnessTrustPrompt(adapter, { binaryPath, launchArgv: deps.launchArgv(adapter) }),
      manifestPath: entry.manifestPath,
      manifestSha256: entry.manifestSha256,
    });
  }
  return waiting;
}

/**
 * Registers the harness-trust channels. A degraded db answers both with the open
 * failure: the verdict lives in SQLite, so there is no honest partial mode —
 * offering a confirmation that could not be recorded would ask the same question
 * again every launch, and answering "nothing is pending" would be a lie.
 */
export function registerHarnessIpcHandlers(handle: DbHandle, deps: HarnessIpcDeps): void {
  if (!handle.ok) {
    registerDegradedIpcHandlers(HARNESS_CHANNELS, handle.error);
    return;
  }

  const db = handle.db;

  const handlers: IpcHandlerTable<HarnessIpcChannel> = {
    "volli:harness-pending": async (): Promise<HarnessPendingResult> => {
      const scan = await scanHarnessManifests(deps.harnessesDir);
      // A directory that would not open measured nothing, and "nothing is
      // pending" is not what nothing measured means — it is the answer that
      // hides a harness waiting on a human. A truncated or partly unreadable
      // scan still answers with what it read: this list is what is waiting, not
      // a claim about everything that exists.
      if (scan.gap === "directory-unreadable") {
        return { ok: false, error: `Could not read ${deps.harnessesDir}.` };
      }
      const decided = decideRegisteredHarnesses(db, scan.manifests);
      return { ok: true, pending: await pendingManifests(decided, deps) };
    },

    "volli:harness-trust-set": async (input: HarnessTrustSetInput): Promise<Result> => {
      const scan = await scanHarnessManifests(deps.harnessesDir);
      if (scan.gap === "directory-unreadable") {
        return { ok: false, error: `Could not read ${deps.harnessesDir}.` };
      }
      const entry = scan.manifests.find((manifest) => manifest.slug === input.slug);
      if (entry === undefined) {
        return { ok: false, error: `No harness manifest for ${input.slug}.` };
      }
      // The answer was about the bytes the dialog rendered. Anything else is a
      // different manifest wearing the same slug, and it goes back on the
      // pending list rather than inheriting this verdict.
      if (entry.manifestSha256 !== input.manifestSha256) {
        return { ok: false, error: `${input.slug} changed on disk, so it needs confirming again.` };
      }
      if (entry.adapter === null) {
        return { ok: false, error: `${input.slug} isn't a valid manifest.` };
      }
      // The write has to come first: the regeneration reads the trusted set back
      // out of the db, so a verdict that is not committed yet is a verdict the
      // wrappers cannot be built from. Which makes the row, briefly, ahead of
      // the world it describes — hence the undo below.
      const previous = getRegisteredHarness(db, entry.slug);
      recordHarnessTrust(
        db,
        {
          slug: entry.slug,
          manifestPath: entry.manifestPath,
          manifestSha256: entry.manifestSha256,
          decision: input.decision,
          declaredEvents: [...supportedEvents(entry.adapter)],
        },
        deps.now(),
      );
      try {
        await deps.regenerateRuntime();
      } catch (error) {
        // Rolled back rather than reported and left standing, because the state
        // it would be left in is the dishonest one: a row reading "trusted" with
        // no wrapper behind it drops off the pending list, so the surface stops
        // asking about a harness that still cannot launch, and nothing in the app
        // distinguishes it from one that works. Restoring the previous verdict
        // puts the manifest back where it was — pending, and asked about again —
        // which is what "the decision did not take" actually looks like. The same
        // holds for a block: an unapplied one leaves the wrapper on disk, so the
        // db must not claim otherwise.
        restoreRegisteredHarness(db, entry.slug, previous);
        return {
          ok: false,
          error: `${input.slug} could not be set up, so the decision was not kept: ${errorMessage(error)}`,
        };
      }
      return { ok: true };
    },
  };

  registerGuardedIpcHandlers(HARNESS_IPC, handlers);
}
