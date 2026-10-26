/**
 * The runner's link on its machine (its id and refresh credential), and the two
 * ways a box gets one.
 *
 * A linked runner holds its `runnerId` and an opaque refresh credential. The
 * credential rotates on every token exchange, so the store must write each
 * new one durably (atomically, before the token it came with is used) and
 * keep it out of anything a backup or a copied data dir carries. Where it
 * lives is the host's choice, behind {@link RunnerLinkStore}: a sealed
 * file on a Linux box, the keychain-backed keyring on a Mac.
 */
import {
  RUNNER_LINK_POLL_INTERVAL_MS,
  RUNNER_LINK_REQUEST_TTL_MS,
  type RunnerHostFacts,
  type RunnerId,
  type RunnerLinkGrant,
} from "@volli/shared/cloud";

import type { RunnerLinkClient } from "./link-client";

export interface RunnerLink {
  runnerId: RunnerId;
  name: string;
  /** The current refresh credential. Never logged. */
  credential: string;
  generation: number;
}

/**
 * Where the identity lives. ONE token source per identity per machine: two
 * processes exchanging the same credential look exactly like a stolen copy,
 * and the backend revokes the runner. `save` must be atomic (temp + fsync +
 * rename, or the keychain's own write), and should refuse an identity whose
 * `generation` is not newer than the stored one, so a stale writer cannot
 * roll the credential back.
 */
export interface RunnerLinkStore {
  /** The identity, or `null` when this machine is not linked. */
  load(): Promise<RunnerLink | null>;
  /** Durable before it resolves: a crash right after must find this credential. */
  save(identity: RunnerLink): Promise<void>;
  /** Forget the link (removed, revoked, or `volli-runner unlink`). */
  clear(): Promise<void>;
}

function linkOf(grant: RunnerLinkGrant): RunnerLink {
  return {
    runnerId: grant.runnerId,
    name: grant.name,
    credential: grant.credential,
    generation: grant.generation,
  };
}

/** `volli-runner link --token vrt_…`: one request, then the identity is saved. */
export async function linkWithInstallToken(input: {
  client: RunnerLinkClient;
  store: RunnerLinkStore;
  host: RunnerHostFacts;
  installToken: string;
  name?: string | null;
}): Promise<RunnerLink> {
  const grant = await input.client.link({
    installToken: input.installToken,
    host: input.host,
    name: input.name ?? null,
  });
  const identity = linkOf(grant);
  await input.store.save(identity);
  return identity;
}

export type DeviceLinkOutcome =
  | { status: "linked"; link: RunnerLink }
  | { status: "denied" | "expired" | "cancelled" };

/**
 * `volli-runner link` with no token: print a code, wait for the person to
 * approve it in Settings, save the identity. Transient poll failures are
 * retried at the poll interval until the code expires.
 */
export async function linkWithDeviceCode(input: {
  client: RunnerLinkClient;
  store: RunnerLinkStore;
  host: RunnerHostFacts;
  /** Shows the code to the person at the box. */
  showCode(userCode: string, expiresAt: number): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  signal?: AbortSignal;
}): Promise<DeviceLinkOutcome> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = await input.client.startDeviceLink(input.host);
  // On this machine's clock, which may disagree with the server's `expiresAt`.
  const deadline = now() + RUNNER_LINK_REQUEST_TTL_MS;
  input.showCode(started.userCode, started.expiresAt);
  const interval = Math.max(started.intervalMs, RUNNER_LINK_POLL_INTERVAL_MS);
  for (;;) {
    if (input.signal?.aborted) return { status: "cancelled" };
    await sleep(interval);
    if (input.signal?.aborted) return { status: "cancelled" };
    // The server says `expired` too; this bounds the wait when it cannot be reached.
    if (now() > deadline) return { status: "expired" };
    let poll;
    try {
      poll = await input.client.pollDeviceLink({
        requestId: started.requestId,
        pollSecret: started.pollSecret,
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // The poll limit refills in four seconds; the normal five-second
      // interval backs off without losing a code that is awaiting approval.
      if (code === "unavailable" || code === "rate_limited") continue;
      throw error;
    }
    if (poll.status === "pending") continue;
    if (poll.status !== "linked") return { status: poll.status };
    const identity = linkOf(poll.grant);
    await input.store.save(identity);
    return { status: "linked", link: identity };
  }
}
