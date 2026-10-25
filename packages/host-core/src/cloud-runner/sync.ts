/**
 * One runner's cloud sync, composed: the backend link, the fact drain, the
 * inbox worker and the presence loop over it, and what each does when the
 * link comes back.
 *
 * On every reconnect the drain resends from each cursor and the worker
 * renews the leases it holds before it claims (a late completion from the
 * newest lease is still accepted, so renewing first keeps running work).
 * The presence loop re-publishes its own live state when its next beat
 * succeeds.
 */
import type { BackendLink } from "./backend-link";
import type { AcceptCall, AcceptReply, FactDrain } from "./drain";
import type {
  InboxBackend,
  InboxWake,
  InboxWorker,
  JobCompleteAnswer,
  JobRenewAnswer,
} from "./inbox";
import type { RunnerPresence } from "./presence";
import { hostLogger } from "../log/root";
import type { ClaimedJob } from "@volli/shared/cloud";

/** The backend's runner functions, by name. */
export const RUNNER_SYNC_FUNCTIONS = {
  accept: "sessions:accept",
  claim: "runnerJobs:claim",
  renew: "runnerJobs:renew",
  complete: "runnerJobs:complete",
  wake: "runnerJobs:wake",
} as const;

/** `sessions.accept` over the link, at the priority the drain chose. */
export function acceptOverLink(link: Pick<BackendLink, "mutate">): AcceptCall {
  return (args, options) =>
    link.mutate(RUNNER_SYNC_FUNCTIONS.accept, args, options) as Promise<AcceptReply>;
}

/** The inbox mutations over the link's control lane. */
export function inboxOverLink(link: Pick<BackendLink, "call">): InboxBackend {
  return {
    claim: async (args) => (await link.call(RUNNER_SYNC_FUNCTIONS.claim, args)) as ClaimedJob[],
    renew: async (args) => (await link.call(RUNNER_SYNC_FUNCTIONS.renew, args)) as JobRenewAnswer,
    complete: async (args) =>
      (await link.call(RUNNER_SYNC_FUNCTIONS.complete, args)) as JobCompleteAnswer,
  };
}

/** The inbox's wake subscription (`runnerJobs.wake`) over the link. */
export function wakeOverLink(link: Pick<BackendLink, "subscribe">) {
  return (onChange: (wake: InboxWake) => void) =>
    link.subscribe(RUNNER_SYNC_FUNCTIONS.wake, {}, (value) => onChange(value as InboxWake));
}

export interface RunnerSync {
  /** The wake sequence after the link is back: resend facts, renew leases, then claim. */
  catchUp(): Promise<void>;
  /** Pause only new claims while the Mac sleeps; running jobs retain their leases and journal. */
  suspend(): void;
  /** Called after wake has refreshed the token and published online. */
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export function startRunnerSync(parts: {
  link: Pick<BackendLink, "onStatus" | "close"> & Partial<Pick<BackendLink, "status">>;
  drain: FactDrain;
  inbox: InboxWorker;
  presence: RunnerPresence;
}): RunnerSync {
  const { link, drain, inbox, presence } = parts;
  let connected = link.status === undefined || link.status.state === "connected";
  let suspended = false;
  let stopped = false;
  let epoch = 0;
  let tail = Promise.resolve();
  function catchUp(): Promise<void> {
    const mine = epoch;
    // Reconnects and an explicit wake share one control lane. No wake query,
    // poll or finishing job may race its new claim ahead of lease renewal.
    const next = tail.then(async () => {
      if (stopped || suspended || !connected || mine !== epoch) return;
      inbox.pauseClaims?.();
      await inbox.renewInFlight();
      if (stopped || suspended || !connected || mine !== epoch) return;
      inbox.resumeClaims?.();
      await inbox.claimNow();
      if (stopped || suspended || !connected || mine !== epoch) return;
      drain.resumeAll();
    });
    tail = next.catch((error: unknown) => {
      hostLogger("runner-sync").warn("Runner reconnect recovery failed", { error });
    });
    return next;
  }
  inbox.pauseClaims?.();
  const off = link.onStatus((status) => {
    connected = status.state === "connected";
    epoch += 1;
    inbox.pauseClaims?.();
    if (connected) void catchUp();
  });
  drain.start();
  void inbox.start();
  void presence.start();
  if (connected) void catchUp();
  return {
    catchUp,
    suspend() {
      suspended = true;
      epoch += 1;
      inbox.pauseClaims?.();
    },
    async resume() {
      suspended = false;
      await catchUp();
    },
    async stop() {
      stopped = true;
      epoch += 1;
      off();
      inbox.pauseClaims?.();
      await presence.stop();
      inbox.stop();
      drain.stop();
      await link.close();
    },
  };
}
