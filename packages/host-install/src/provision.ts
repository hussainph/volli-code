/**
 * The step machine for adding a host (VC-700), whatever the provider:
 *
 *     connect → probe → deliver → install → start → enroll → link
 *
 * A **provider** answers each step for its kind of host. SSH is the first
 * (`ssh-provider.ts`: deliver is an upload, link is a tunnel). A
 * bring-your-own-account provider (a Fly Sprite, a Cloudflare container)
 * would deliver an image and link over its own route; it plugs in here
 * without touching this file, and its enrollment still goes through hostd's
 * verifier port (guardrail 1).
 *
 * **Typed and resumable.** The state is plain JSON: the request, each
 * finished step's result, the person's decisions and why it stopped. It holds
 * no secret; secrets ride in `ProvisionSecrets`, in memory, per call.
 * `advance` runs from the first step without a result until the host is
 * added, a step fails, or the person must answer. `retry` clears the failed
 * step and everything after it; `answer` records a decision. A provider's
 * steps must be idempotent, so running one twice is always safe.
 *
 * **Logging.** Every step logs its start and its end with `component:
 * host-install`, the host, the provider and the step, never a secret.
 */
import type { HostdEnrollResult } from "./contract";
import {
  STEP_ORDER,
  type ProvisionAnswer,
  type ProvisionFailure,
  type ProvisionQuestion,
  type StepId,
} from "./failures";
import { componentLogger, type InstallLogger } from "./logger";
import type { HostKeyOffer } from "./ssh";

export interface DeviceIdentity {
  /** P-256 SPKI, base64url: the public half only. */
  readonly publicKey: string;
  readonly fingerprint: string;
  /** The label the host shows for this Mac. */
  readonly name: string;
}

export interface ProvisionRequest {
  /** The name the person sees for the host: `box`, `hetzner-1`. */
  readonly host: string;
  readonly appVersion: string;
  readonly device: DeviceIdentity;
  /** The host id this Mac pinned for this host before, if any. */
  readonly pinnedHostId: string | null;
  readonly requiredDiskBytes?: number;
  /** Artifact targets this build can install (`supportedTargets(pin)`). */
  readonly supportedTargets?: readonly string[];
}

/**
 * What finished steps leave behind. Each provider types its own; every one
 * ends in the same two facts the desktop needs: who the host is and this
 * device's enrollment (`enroll`), and where the client link connects (`link`).
 */
export interface ProvisionResults {
  readonly connect?: unknown;
  readonly probe?: unknown;
  readonly deliver?: unknown;
  readonly install?: unknown;
  readonly start?: unknown;
  readonly enroll?: HostdEnrollResult;
  readonly link?: { readonly url: string };
}

export interface ProvisionDecisions {
  /** The fingerprints the person accepted, exactly: a different key is asked about again. */
  readonly acceptedHostKeys?: readonly string[];
  readonly existing?: "update" | "adopt";
  readonly alreadyPaired?: boolean;
  /** The person settled for a host that runs as them rather than give sudo a password. */
  readonly userInstall?: boolean;
  readonly repin?: boolean;
}

export type ProvisionStop =
  | { readonly kind: "failed"; readonly failure: ProvisionFailure }
  | { readonly kind: "question"; readonly question: ProvisionQuestion };

export interface ProvisionState<R extends ProvisionResults = ProvisionResults> {
  readonly request: ProvisionRequest;
  readonly results: R;
  readonly decisions: ProvisionDecisions;
  readonly status: "ready" | "stopped" | "done";
  readonly stop: ProvisionStop | null;
}

/** What the caller holds in memory for this flow, and only for it. */
export interface ProvisionSecrets {
  sudoPassword: string | null;
}

/** A step's result (and any decision it settled), or why the machine stops. */
export type StepOutcome =
  | { readonly result: unknown; readonly decisions?: ProvisionDecisions }
  | ProvisionStop;

export interface ProvisionContext<R extends ProvisionResults = ProvisionResults> {
  readonly state: ProvisionState<R>;
  readonly secrets: ProvisionSecrets;
  readonly logger: InstallLogger;
}

/** One kind of host: SSH today; a provider's own API later. */
export interface HostProvider<R extends ProvisionResults = ProvisionResults> {
  /** For the log and the support report: `ssh`. */
  readonly id: string;
  /** Runs one step; must be idempotent. */
  run(step: StepId, context: ProvisionContext<R>): Promise<StepOutcome>;
}

export function initialProvisionState<R extends ProvisionResults = ProvisionResults>(
  request: ProvisionRequest,
): ProvisionState<R> {
  return { request, results: {} as R, decisions: {}, status: "ready", stop: null };
}

/** The step to run next, or `null` when all have results. */
export function nextStep(state: ProvisionState<ProvisionResults>): StepId | null {
  return STEP_ORDER.find((step) => state.results[step] === undefined) ?? null;
}

/** Drops `from` and every step after it, so they run again. */
function without<R extends ProvisionResults>(results: R, from: StepId): R {
  const kept = STEP_ORDER.slice(0, STEP_ORDER.indexOf(from)).filter((step) => step in results);
  return Object.fromEntries(kept.map((step) => [step, results[step]])) as unknown as R;
}

/** Clears a failure so `advance` runs its step (or `from`, earlier) again. */
export function retry<R extends ProvisionResults>(
  state: ProvisionState<R>,
  from?: StepId,
): ProvisionState<R> {
  const step = from ?? (state.stop?.kind === "failed" ? state.stop.failure.step : nextStep(state));
  return {
    ...state,
    results: step === null ? state.results : without(state.results, step),
    status: "ready",
    stop: null,
  };
}

export function fingerprintsOf(offer: HostKeyOffer): string[] {
  return offer.fingerprints.map((entry) => entry.fingerprint).toSorted();
}

/** Records the person's answer to the question the state stopped on. */
export function answer<R extends ProvisionResults>(
  state: ProvisionState<R>,
  reply: ProvisionAnswer,
): ProvisionState<R> {
  const decisions = { ...state.decisions };
  switch (reply.kind) {
    case "accept-host-key":
      if (state.stop?.kind === "question" && state.stop.question.kind === "host-key") {
        decisions.acceptedHostKeys = fingerprintsOf(state.stop.question.offer);
      }
      break;
    case "update":
    case "adopt":
      decisions.existing = reply.kind;
      break;
    case "open":
      decisions.alreadyPaired = true;
      break;
    case "user-install":
      decisions.userInstall = true;
      break;
    case "repair":
      decisions.repin = true;
      break;
    case "sudo-password":
      // The password itself goes to `advance`'s secrets, never into state.
      break;
  }
  return { ...state, decisions, status: "ready", stop: null };
}

export interface AdvanceOptions {
  readonly logger: InstallLogger;
  readonly secrets?: ProvisionSecrets;
  /** A step began; the UI shows its verb. */
  readonly onStep?: (step: StepId) => void;
}

const isStop = (outcome: StepOutcome): outcome is ProvisionStop => "kind" in outcome;

/** Runs steps until done, failed, or waiting on the person. */
export async function advance<R extends ProvisionResults>(
  initial: ProvisionState<R>,
  provider: HostProvider<R>,
  options: AdvanceOptions,
): Promise<ProvisionState<R>> {
  if (initial.status === "stopped") return initial;
  const { request } = initial;
  const secrets = options.secrets ?? { sudoPassword: null };
  const results: Record<string, unknown> = { ...(initial.results as Record<string, unknown>) };
  let decisions = initial.decisions;
  const now = (): ProvisionState<R> => ({
    request,
    results: results as unknown as R,
    decisions,
    status: "ready",
    stop: null,
  });
  const logger = componentLogger(options.logger, { host: request.host, provider: provider.id });
  for (let step = nextStep(now()); step !== null; step = nextStep(now())) {
    options.onStep?.(step);
    const started = Date.now();
    logger.info("step started", { step });
    const outcome = await provider.run(step, { state: now(), secrets, logger });
    const ms = Date.now() - started;
    if (isStop(outcome)) {
      if (outcome.kind === "failed") {
        logger.warn("step failed", {
          step,
          ms,
          code: outcome.failure.code,
          failure: outcome.failure,
        });
      } else {
        logger.info("step needs an answer", { step, ms, question: outcome.question.kind });
      }
      return { ...now(), status: "stopped", stop: outcome };
    }
    logger.info("step finished", { step, ms });
    results[step] = outcome.result;
    decisions = outcome.decisions ?? decisions;
  }
  logger.info("host added");
  return { ...now(), status: "done" };
}
