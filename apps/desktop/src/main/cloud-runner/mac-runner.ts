/**
 * This Mac as one of the signed-in person's runners (VC-895): the state
 * machine desktop main runs — connected in a Volli Cloud launch, and
 * registration only while a local launch moves a project in. No Electron
 * import: power, the account, the sealed store and the connection all come in
 * as ports, so it runs under plain Node in its tests.
 *
 * **Registering.** Signed in, with no sealed link for this person and no
 * tombstone: `runners.registerThisMac` with the person's own access token, no
 * approval step (the person is present and signed in on the machine being
 * added). The grant is sealed before anything uses it, and a non-secret
 * record (`MacRunnerRecord`) remembers the runner's id, so a Mac that lost its
 * sealed credential (keychain loss, an inventory reset) registers as the
 * runner it replaces rather than as a duplicate. The record also names the
 * host it was written on: a profile restored onto another Mac does not
 * replace the original's runner.
 *
 * **Linked.** The connection (`./connection.ts`) heartbeats; the snapshot
 * reads `online` while beats land, `offline` while the backend cannot be
 * reached (work here keeps running), `asleep` between a sleep and its wake.
 * On sleep it reports `asleep` best-effort; on wake it reconnects, refreshes
 * its token and beats at once.
 *
 * **Registration only.** `MacRunnerOptions.registrationOnly` keeps all of the
 * above and connects nothing: desktop main composes it in a local launch when
 * a person starts moving a project to Volli Cloud (VC-998), because a move is
 * accepted under this Mac's runner identity, while a local launch runs no
 * cloud job. Registration, sealing, the record, tombstones, epochs and the
 * account switch are the same code; a linked identity publishes `offline`
 * (registered, deliberately not connected) and nothing ever exchanges a
 * runner token, heartbeats, runs a job or reports power. A registration the
 * backend could not be reached for still retries, bounded at most every five
 * minutes, until the caller stops it — main's job when the move ends. Because
 * nothing is connected, nothing here learns that the runner was removed
 * elsewhere: the move's own backend call is where a replaced runner surfaces.
 *
 * **Ending.** Each link gets an epoch; anything an older epoch finishes
 * (a rotation, a registration) after it ended is dropped, so nothing the
 * person ended comes back.
 * - Signing out (or another person signing in) stops the runner (`stopped`)
 *   and keeps the sealed credential: signing back in resumes the same runner.
 * - Removed from elsewhere, or cut off for credential reuse: the link is
 *   cleared and a tombstone recorded. It never registers itself again after
 *   that; "Add this Mac again" ({@link MacRunner.addThisMac}) is the person's.
 * - "Remove" on this Mac asks the backend first, then does the same.
 */
import type { RunnerLink, RunnerLinkLoss, RunnerLinkStore } from "@volli/host-core/cloud-runner";
import type { PowerPort } from "@volli/host-core/ports";
import { watchSleep } from "@volli/host-core/cloud-runner";
import {
  THIS_MAC_RUNNER_OFF,
  type AccountSnapshot,
  type ThisMacRunnerProblem,
  type ThisMacRunnerSnapshot,
  type ThisMacRunnerState,
} from "@volli/shared";
import type { RunnerHostFacts } from "@volli/shared/cloud";

import { BackendRefusedError } from "../account/backend";
import type { MacRunnerBackend } from "./backend";
import type { ConnectRunner, RunnerConnection } from "./connection";

/** What this Mac remembers about its runner outside the sealed store. Never a secret. */
export interface MacRunnerRecord {
  /** The runner it registered as; `null` before the first registration landed. */
  readonly runnerId: string | null;
  /** The machine the record was written on (`MacRunnerOptions.machine`). */
  readonly machine: string;
  /** A registration sent and not yet answered: a retry sends the same id, so it is never a second runner. */
  readonly registrationId: string | null;
  /** Set once the runner was removed or cut off: this Mac does not add itself back. */
  readonly tombstone: ThisMacRunnerProblem | null;
}

export interface MacRunnerRecordStore {
  read(): MacRunnerRecord | null;
  write(record: MacRunnerRecord): void;
}

/** The account as the runner reads it. */
export interface MacRunnerAccount {
  subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
  /** The person's access token, or `null` when signed out. Rejects when it cannot be refreshed now. */
  accessToken(): Promise<string | null>;
}

export interface MacRunnerTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MacRunnerOptions {
  /** The person this launch is for (the launch marker's user). */
  readonly userId: string;
  readonly account: MacRunnerAccount;
  readonly store: RunnerLinkStore;
  readonly record: MacRunnerRecordStore;
  readonly backend: MacRunnerBackend;
  readonly connect: ConnectRunner;
  /** What registering sends: the host facts, and the name to ask for. */
  host(): Promise<{ facts: RunnerHostFacts; name: string | null }>;
  /**
   * This machine, stably (a hash of its hardware id): only the machine a
   * record was written on registers as its runner's replacement, so a profile
   * restored onto another Mac never takes over the original's runner.
   */
  machine(): Promise<string>;
  readonly power: PowerPort;
  /**
   * Register and keep this Mac's runner identity, and nothing else (a local
   * launch's move to Volli Cloud, VC-998): the same sealed store, record,
   * tombstones and epochs, but no connection, token exchange, heartbeat, job
   * or power report. A linked identity publishes `offline`. `false` (the
   * default) is the full runner a Volli Cloud launch composes.
   */
  readonly registrationOnly?: boolean;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly timers?: MacRunnerTimers;
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface MacRunner {
  snapshot(): ThisMacRunnerSnapshot;
  subscribe(listener: (snapshot: ThisMacRunnerSnapshot) => void): () => void;
  /** Starts following the account; registers or connects when it can. */
  start(): void;
  /** Registers again after a removal, or retries a failed registration. */
  addThisMac(): Promise<void>;
  /** Removes this Mac from the person's runners; it stays removed until {@link addThisMac}. */
  removeThisMac(): Promise<void>;
  /** The capabilities changed (menu-bar mode closed the browser, or a window reopened it). */
  refreshCapabilities(): void;
  /** At quit: `stopped` reported (bounded), the connection closed. */
  stop(): Promise<void>;
}

/** The first retry of a registration that could not reach the backend, doubling to the cap. */
export const MAC_RUNNER_RETRY = { firstMs: 15_000, maxMs: 5 * 60_000 } as const;

const DEFAULT_TIMERS: MacRunnerTimers = {
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The blocked state in one sentence. `name` is the runner's, when known. */
export function problemMessage(problem: ThisMacRunnerProblem, name: string | null): string {
  const mac = name ?? "This Mac";
  switch (problem) {
    case "removed":
      return `${mac} was removed from your account.`;
    case "credential_reuse":
      return `${mac} was used from two places, so Volli Cloud disconnected it.`;
    case "replaced":
      return `${mac} was added again from another copy of Volli.`;
    case "credentials_locked":
      return "Volli couldn't read this Mac's saved runner credential.";
    case "unreachable":
      return "Couldn't reach Volli Cloud to add this Mac.";
    case "refused":
      return "Volli Cloud didn't add this Mac.";
  }
}

type Who = "me" | "pending" | "out";

function whoIn(snapshot: AccountSnapshot, userId: string): Who {
  if (snapshot.state === "restoring" || snapshot.state === "signing-in") return "pending";
  if (snapshot.state !== "signed-in") return "out";
  // Signed in while the backend has not answered yet (offline): the saved sign-in is this launch's.
  const id = snapshot.account?.userId ?? null;
  return id === null || id === userId ? "me" : "out";
}

/** Why a revoked runner was cut off, from the person's own list; `removed` when it is gone from it. */
function revokedProblem(reason: string | null): ThisMacRunnerProblem {
  if (reason === "credential_reuse") return "credential_reuse";
  if (reason === "replaced") return "replaced";
  return "removed";
}

export function createMacRunner(options: MacRunnerOptions): MacRunner {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const timers = options.timers ?? DEFAULT_TIMERS;
  const registrationOnly = options.registrationOnly === true;
  const listeners = new Set<(snapshot: ThisMacRunnerSnapshot) => void>();
  let snapshot: ThisMacRunnerSnapshot = THIS_MAC_RUNNER_OFF;
  /** Advanced by every begin and end: work begun under an older one drops its result. */
  let epoch = 0;
  /** Advanced by every removal: a registration that lands after one is undone, never sealed. */
  let removals = 0;
  let who: Who = "pending";
  let started = false;
  let link: RunnerLink | null = null;
  let connection: RunnerConnection | null = null;
  /** The connection being stopped: nothing new connects before it is done with the credential. */
  let ending: Promise<void> = Promise.resolve();
  /** The one registration in flight: a new begin waits for it rather than sending another. */
  let registering: Promise<void> | null = null;
  let asleep: { since: number } | null = null;
  let waking = false;
  let retryTimer: unknown = null;
  let retryMs: number = MAC_RUNNER_RETRY.firstMs;
  let offAccount: (() => void) | null = null;
  let offPower: (() => void) | null = null;
  let stopping: Promise<void> | null = null;
  let machine: Promise<string> | null = null;
  const thisMachine = () => (machine ??= options.machine());

  const knownRunnerId = () => link?.runnerId ?? options.record.read()?.runnerId ?? null;

  function publish(next: Omit<ThisMacRunnerSnapshot, "since"> & { since?: number | null }) {
    const since =
      next.since !== undefined
        ? next.since
        : next.state === snapshot.state
          ? snapshot.since
          : next.state === "off"
            ? null
            : now();
    const value: ThisMacRunnerSnapshot = { ...next, since };
    if (JSON.stringify(value) === JSON.stringify(snapshot)) return;
    snapshot = value;
    for (const listener of listeners) listener(value);
  }

  function publishState(state: ThisMacRunnerState, since?: number | null) {
    publish({
      state,
      runnerId: knownRunnerId(),
      runnerName: link?.name ?? null,
      waitingFacts: connection?.waitingFacts ?? 0,
      problem: null,
      message: null,
      ...(since === undefined ? {} : { since }),
    });
  }

  function publishProblem(
    state: "removed" | "failed",
    problem: ThisMacRunnerProblem,
    message?: string,
  ) {
    publish({
      state,
      runnerId: knownRunnerId(),
      runnerName: link?.name ?? null,
      waitingFacts: 0,
      problem,
      message: message ?? problemMessage(problem, link?.name ?? null),
    });
  }

  /** The linked state, derived from the connection. */
  function publishLinked() {
    if (connection === null) return;
    if (asleep !== null) return publishState("asleep", asleep.since);
    // Until the wake sequence has beaten, what the connection says is from before the sleep.
    if (waking) return publishState("connecting");
    const status = connection.status;
    if (status.state === "offline") return publishState("offline", status.since);
    if (status.state === "connected" && connection.beating) return publishState("online");
    publishState("connecting");
  }

  function cancelRetry() {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }

  /**
   * Ends the current epoch at once (synchronously) and its connection in the
   * background; `report`: say `stopped` first (a clean stop). Whatever starts
   * next waits for `ending`, so two connections never present one credential.
   */
  function endEpoch(report: boolean): number {
    epoch += 1;
    cancelRetry();
    const closing = connection;
    connection = null;
    if (closing !== null) {
      const done = (report ? closing.stop() : closing.close()).catch(() => {});
      ending = Promise.all([ending, done]).then(() => {});
    }
    return epoch;
  }

  /** A store that answers nothing and saves nothing once `mine` ended: a late rotation never restores a removed link. */
  function fenced(mine: number): RunnerLinkStore {
    return {
      load: async () => (mine === epoch ? options.store.load() : null),
      save: async (next) => {
        if (mine !== epoch) throw new Error("This runner link has ended.");
        await options.store.save(next);
        if (mine === epoch && link !== null) link = { ...link, generation: next.generation };
      },
      clear: () => options.store.clear(),
    };
  }

  /**
   * Linked. A cloud launch's runner (`registrationOnly` off) connects here and
   * heartbeats; a registration-only one publishes the identity and connects
   * nothing, so no token, beat, job or power report leaves this Mac.
   */
  function connect(mine: number, linked: RunnerLink) {
    link = linked;
    if (registrationOnly) {
      publishState("offline");
      return;
    }
    connection = options.connect({
      store: fenced(mine),
      runnerId: linked.runnerId,
      onLost: (reason) => void lost(mine, reason),
      onChange: () => {
        if (mine === epoch) publishLinked();
      },
    });
    publishLinked();
    connection.start();
  }

  async function tombstone(runnerId: string | null, problem: ThisMacRunnerProblem) {
    options.record.write({
      runnerId,
      machine: await thisMachine(),
      registrationId: null,
      tombstone: problem,
    });
  }

  async function lost(mine: number, reason: RunnerLinkLoss) {
    if (mine !== epoch) return;
    const ended = link;
    endEpoch(false);
    options.log.warn("this Mac's runner link ended", { reason, runnerId: ended?.runnerId });
    await options.store.clear().catch((error: unknown) => {
      options.log.warn("could not clear this Mac's runner link", { error });
    });
    if (reason !== "revoked") {
      // The sealed credential is gone or unknown to the backend, and the
      // runner was not cut off: register again as its replacement.
      void begin();
      return;
    }
    link = ended;
    let problem: ThisMacRunnerProblem = "removed";
    try {
      const token = await options.account.accessToken();
      if (token !== null && ended !== null) {
        const status = await options.backend.runnerStatus(token, ended.runnerId);
        problem = status === null ? "removed" : revokedProblem(status.statusReason);
      }
    } catch (error) {
      // Offline: "removed" says enough until the person looks.
      options.log.warn("could not ask why this Mac's runner was cut off", { error });
    }
    if (epoch !== mine + 1) return;
    await tombstone(ended?.runnerId ?? null, problem);
    publishProblem("removed", problem);
  }

  function scheduleRetry() {
    cancelRetry();
    const mine = epoch;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (mine === epoch && who === "me") void begin();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, MAC_RUNNER_RETRY.maxMs);
  }

  async function register(mine: number, record: MacRunnerRecord | null) {
    publishState("registering");
    const removalsAtStart = removals;
    const here = await thisMachine();
    // Only the machine the record was written on replaces its runner.
    const mineRecord = record !== null && record.machine === here ? record : null;
    const registrationId = mineRecord?.registrationId ?? newId();
    options.record.write({
      runnerId: mineRecord?.runnerId ?? null,
      machine: here,
      registrationId,
      tombstone: null,
    });
    let token: string | null = null;
    let grant;
    try {
      const host = await options.host();
      token = await options.account.accessToken();
      if (token === null) {
        if (mine === epoch) publishState("unregistered");
        return;
      }
      grant = await options.backend.registerThisMac(token, {
        host: host.facts,
        name: host.name,
        replacesRunnerId: mineRecord?.runnerId ?? null,
        registrationId,
      });
    } catch (error) {
      if (mine !== epoch) return;
      if (error instanceof BackendRefusedError) {
        options.log.warn("Volli Cloud refused to register this Mac", { code: error.code });
        publishProblem("failed", "refused", error.message);
        return;
      }
      options.log.warn("could not register this Mac", { error });
      publishProblem("failed", "unreachable");
      scheduleRetry();
      return;
    }
    if (removals !== removalsAtStart) {
      // The person removed this Mac while it was being added: undo it, keep the tombstone.
      await tombstone(grant.runnerId, "removed");
      await options.backend.removeRunner(token, grant.runnerId).catch((error: unknown) => {
        options.log.warn("could not remove a runner registered during its removal", { error });
      });
      return;
    }
    const linked: RunnerLink = {
      runnerId: grant.runnerId,
      name: grant.name,
      credential: grant.credential,
      generation: grant.generation,
    };
    // Sealed even if the epoch moved on (a sign-out keeps the credential); used only if not.
    try {
      await options.store.save(linked);
    } catch (error) {
      options.log.warn("could not seal this Mac's runner credential", { error });
      if (mine === epoch) publishProblem("failed", "credentials_locked");
      return;
    }
    options.record.write({
      runnerId: linked.runnerId,
      machine: here,
      registrationId: null,
      tombstone: null,
    });
    options.log.info("registered this Mac as a runner", { runnerId: linked.runnerId });
    retryMs = MAC_RUNNER_RETRY.firstMs;
    if (mine === epoch) connect(mine, linked);
  }

  /**
   * Starts a fresh epoch: connect the sealed link, or register when there is
   * none and the person is signed in (`me`), not merely restoring.
   */
  async function begin() {
    const mine = endEpoch(false);
    await ending;
    if (registering !== null) await registering;
    if (mine !== epoch) return;
    let sealed: RunnerLink | null;
    try {
      sealed = await options.store.load();
    } catch (error) {
      if (mine !== epoch) return;
      options.log.warn("could not read this Mac's runner credential", { error });
      publishProblem("failed", "credentials_locked");
      return;
    }
    if (mine !== epoch) return;
    if (sealed !== null) {
      connect(mine, sealed);
      return;
    }
    link = null;
    const record = options.record.read();
    if (record?.tombstone != null) {
      publishProblem("removed", record.tombstone);
      return;
    }
    if (who !== "me") {
      // Registering waits for the sign-in to finish (`onAccount`).
      publishState("unregistered");
      return;
    }
    const run = register(mine, record).finally(() => {
      if (registering === run) registering = null;
    });
    registering = run;
    await run;
  }

  function onAccount(next: AccountSnapshot) {
    const was = who;
    who = whoIn(next, options.userId);
    if (who === was && started) return;
    if (who === "out") {
      // Signed out: stop, and keep the sealed credential for the next sign-in.
      endEpoch(true);
      link = null;
      publish(THIS_MAC_RUNNER_OFF);
      return;
    }
    // At start, a restoring sign-in may already connect a sealed link (it is
    // this launch's person's); anything else starts once the sign-in is done.
    if (!started) {
      void begin();
      return;
    }
    if (who === "me" && (snapshot.state === "off" || snapshot.state === "unregistered")) {
      void begin();
    }
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    start() {
      if (started || stopping !== null) return;
      offPower = watchSleep(options.power, {
        onSleep: () => {
          asleep = { since: now() };
          publishLinked();
          void connection?.power.suspend();
        },
        onWake: () => {
          asleep = null;
          const live = connection;
          if (live !== null) {
            waking = true;
            publishLinked();
            void live.power.resume().finally(() => {
              waking = false;
              if (connection === live) publishLinked();
            });
          } else if (snapshot.state === "failed" && snapshot.problem === "unreachable") {
            // Waking is the moment the network comes back: try now, not at the next retry.
            retryMs = MAC_RUNNER_RETRY.firstMs;
            void begin();
          }
        },
      });
      offAccount = options.account.subscribe(onAccount);
      started = true;
    },
    async addThisMac() {
      if (who === "out") throw new Error("Sign in to Volli Cloud to add this Mac.");
      if (
        snapshot.state !== "removed" &&
        snapshot.state !== "failed" &&
        snapshot.state !== "unregistered"
      ) {
        return;
      }
      const record = options.record.read();
      if (record !== null && record.tombstone !== null) {
        options.record.write({ ...record, tombstone: null });
      }
      retryMs = MAC_RUNNER_RETRY.firstMs;
      await begin();
    },
    async removeThisMac() {
      const runnerId = knownRunnerId();
      if (runnerId !== null && snapshot.state !== "removed") {
        const token = await options.account.accessToken();
        if (token === null) throw new Error("Sign in to Volli Cloud to remove this Mac.");
        // The backend first: if it fails, nothing here changed.
        await options.backend.removeRunner(token, runnerId);
      }
      removals += 1;
      const removed = link;
      endEpoch(false);
      // The tombstone first: a sealed store that cannot be cleared now (a locked keychain) must not bring it back.
      await tombstone(runnerId, "removed");
      await options.store.clear().catch((error: unknown) => {
        options.log.warn("could not clear this Mac's runner link", { error });
      });
      link = removed;
      publishProblem("removed", "removed");
    },
    refreshCapabilities: () => connection?.refreshCapabilities(),
    stop() {
      stopping ??= (async () => {
        offAccount?.();
        offPower?.();
        endEpoch(true);
        await ending;
      })();
      return stopping;
    },
  };
}
