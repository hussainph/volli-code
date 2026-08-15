/**
 * The seam between a manifest sitting on disk and a harness that can launch:
 * ask what is waiting on a human, record what the human answered, and report
 * what the answers so far add up to.
 *
 * `harness-registry.ts` has always been able to discover a manifest, hash it and
 * decide it, and `trustedHarnessAdapters` has always refused to yield one nobody
 * confirmed. Nothing asked. The first two channels are the question; the third
 * is the only way anything outside main hears that it was answered, since a
 * trusted manifest exists nowhere the renderer can look.
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

import type Database from "better-sqlite3";
import {
  errorMessage,
  expectsHarnessEvents,
  getHarnessAdapter,
  harnessChannelState,
  harnessTrustPrompt,
  HARNESS_EVENT_GRACE_MS,
  isFirstClassHarnessId,
  supportedEvents,
} from "@volli/shared";
import { HARNESS_CHANNELS, HARNESS_IPC } from "./ipc-descriptors";
import type { HarnessAdapter, HarnessChannelStatus } from "@volli/shared";
import type {
  HarnessIpcChannel,
  HarnessPendingResult,
  HarnessRegisteredResult,
  HarnessTrustSetInput,
  PendingHarnessManifest,
  Result,
} from "../ipc/contract";

import type { DbHandle } from "./data-ipc";
import { listHarnessChannels } from "./db/harness-channel-repo";
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
  /**
   * The registered harnesses a launch would accept right now — read from the
   * same resolved set the launch door checks against, never re-derived here.
   *
   * Re-scanning the disk for this would be the obvious thing and the wrong
   * one: it would answer about manifests whose wrappers this launch never
   * generated, and the composer would then offer a harness that `pty/ipc.ts`
   * refuses. One answer, one place it comes from — the same rule main's
   * `resolveHostAdapters` was written to keep.
   */
  launchableHarnesses(): readonly HarnessAdapter[];
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
 * What the two recorded timestamps say about each harness's event channel right
 * now.
 *
 * The adapter lookup is the part that cannot be skipped. A harness with no
 * boot-time event — codex, which has no session until there is a turn — is
 * indistinguishable, from two timestamps alone, between a broken channel and a
 * terminal nobody has typed into, so the derivation is told what the adapter
 * promises and declines to accuse one that promised nothing. An id neither the
 * built-ins nor the launchable set can describe gets the same treatment for the
 * same reason: {@link expectsHarnessEvents} answers `false` for `undefined`.
 */
function channelStates(db: Database.Database, deps: HarnessIpcDeps): HarnessChannelStatus[] {
  const registered = new Map(deps.launchableHarnesses().map((adapter) => [adapter.id, adapter]));
  const now = deps.now();
  return listHarnessChannels(db).map((channel) => {
    const adapter = getHarnessAdapter(channel.harnessId) ?? registered.get(channel.harnessId);
    return {
      harnessId: channel.harnessId,
      state: harnessChannelState(
        channel,
        expectsHarnessEvents(adapter),
        now,
        HARNESS_EVENT_GRACE_MS,
      ),
    };
  });
}

/**
 * Registers the harness-trust channels. A degraded db answers all of them with
 * the open failure: the verdict lives in SQLite, so there is no honest partial
 * mode — offering a confirmation that could not be recorded would ask the same
 * question again every launch, and answering "nothing is pending" (or "nothing
 * is registered", which is the same lie one channel along) would state as a
 * measurement what is really an inability to measure.
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
      return {
        ok: true,
        pending: await pendingManifests(decided, deps),
        // A manifest that did not parse is excluded from `pending` because
        // there is no command line to confirm — but excluded silently it is a
        // file its author cannot tell apart from one that worked. The errors
        // the parse produced ride along so a surface can say so.
        broken: scan.manifests
          .filter((manifest) => manifest.adapter === null)
          .map(({ slug, manifestPath, errors }) => ({ slug, manifestPath, errors })),
      };
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

    "volli:harness-registered": (): HarnessRegisteredResult => ({
      ok: true,
      // Whole adapters, minus the built-ins: the renderer ships those, and
      // sending them back would leave it deduplicating two sources of the same
      // four harnesses. A registered manifest cannot claim a first-class id in
      // the first place (the reserved namespaces), so dropping them here leaves
      // exactly the set the renderer has no other way to learn.
      harnesses: deps.launchableHarnesses().filter((adapter) => !isFirstClassHarnessId(adapter.id)),
      // The other half, and the one that DOES include the built-ins. Derived
      // here rather than sent as two integers because the comparison needs a
      // clock, main has one, and a renderer holding a snapshot would re-derive
      // a state whose inputs cannot change while it holds it — this read is
      // repeated every time a surface offering a harness opens, which is
      // exactly when the answer could have moved.
      channels: channelStates(db, deps),
    }),
  };

  registerGuardedIpcHandlers(HARNESS_IPC, handlers);
}
