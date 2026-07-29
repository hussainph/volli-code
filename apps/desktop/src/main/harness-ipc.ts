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
 */

import { harnessTrustPrompt, HARNESS_CHANNELS, HARNESS_IPC, supportedEvents } from "@volli/shared";
import type {
  HarnessAdapter,
  HarnessIpcChannel,
  HarnessPendingResult,
  HarnessTrustSetInput,
  PendingHarnessManifest,
  Result,
} from "@volli/shared";

import type { DbHandle } from "./data-ipc";
import { recordHarnessTrust } from "./db/harness-registry-repo";
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
      const decided = decideRegisteredHarnesses(db, await scanHarnessManifests(deps.harnessesDir));
      return { ok: true, pending: await pendingManifests(decided, deps) };
    },

    "volli:harness-trust-set": async (input: HarnessTrustSetInput): Promise<Result> => {
      const scanned = await scanHarnessManifests(deps.harnessesDir);
      const entry = scanned.find((manifest) => manifest.slug === input.slug);
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
      return { ok: true };
    },
  };

  registerGuardedIpcHandlers(HARNESS_IPC, handlers);
}
