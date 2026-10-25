/**
 * The person's runners as Settings → Runners reads them (VC-895), from two
 * sources:
 *
 * - **This Mac**: main's `runners.subscribeThisMac` stream while the pane is
 *   mounted. Only main holds this Mac's runner credential, so adding this Mac
 *   again and removing it go through main (`runners.addThisMac`,
 *   `runners.removeThisMac`); main keeps a removed Mac from adding itself back.
 * - **Every runner**: the window's own Volli Cloud client (`runners.list`),
 *   renamed and removed with `runners.rename` and `runners.remove`.
 *
 * A runner's status is an open set on read: a status this build does not
 * name is shown as the backend wrote it.
 */
import * as React from "react";
import type { ThisMacRunnerSnapshot } from "@volli/shared";

import { cloudSession, followCloudSession, type CloudSession } from "@renderer/lib/cloud-client";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { cloudFailure, type Watched } from "@renderer/stores/cloud-board/source";
import type { StatusDotState } from "@renderer/components/ui/status-dot";

/** What the tier client offers this hook: `runners.*`, as tRPC types it. */
export interface RunnersRpc {
  readonly runners: {
    readonly subscribeThisMac: {
      subscribe(
        input: undefined,
        handlers: { onData(data: ThisMacRunnerSnapshot): void; onError(error: unknown): void },
      ): { unsubscribe(): void };
    };
    readonly addThisMac: { mutate(): Promise<unknown> };
    readonly removeThisMac: { mutate(): Promise<unknown> };
  };
}

/** One of the person's runners, as the pane reads `runners.list`: kind and status stay open. */
export interface RunnerRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly statusChangedAt: number;
}

export type Loaded<Value> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: Value }
  | { readonly kind: "failed"; readonly message: string };

/** Follows the cloud launch's one client: `followCloudSession`, or a test's own. */
export type FollowSession = (listener: (session: CloudSession | null) => void) => () => void;

export interface RunnerCommands {
  /** Answers the name the backend kept (it normalises it). */
  rename(runnerId: string, name: string): Promise<string>;
  /** Removes another of the person's runners. */
  remove(runnerId: string): Promise<unknown>;
  addThisMac(): Promise<unknown>;
  removeThisMac(): Promise<unknown>;
}

export const NOT_CONNECTED = "Volli Cloud isn’t connected.";

const failureOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message !== "" ? error.message : fallback;

/** A runner write through the window's client, refused while its socket is down. */
async function write<Answer>(
  current: () => CloudSession | null,
  run: (session: CloudSession) => Promise<Answer>,
): Promise<Answer> {
  const session = current();
  if (session === null || !session.client.connectionState().isWebSocketConnected) {
    throw new Error(NOT_CONNECTED);
  }
  try {
    return await run(session);
  } catch (error) {
    throw new Error(cloudFailure(error).message, { cause: error });
  }
}

function runnerCommands(rpc: RunnersRpc, current: () => CloudSession | null): RunnerCommands {
  return {
    rename: async (runnerId, name) =>
      (
        await write(current, ({ client, api }) =>
          client.mutation(api.runners.rename, { runnerId, name }),
        )
      ).name,
    remove: (runnerId) =>
      write(current, ({ client, api }) => client.mutation(api.runners.remove, { runnerId })),
    addThisMac: () => rpc.runners.addThisMac.mutate(),
    removeThisMac: () => rpc.runners.removeThisMac.mutate(),
  };
}

/** This Mac's snapshot while mounted; a failed stream says so and offers a retry. */
function useThisMac(rpc: RunnersRpc, attempt: number): Loaded<ThisMacRunnerSnapshot> {
  const [view, setView] = React.useState<Loaded<ThisMacRunnerSnapshot>>({ kind: "loading" });
  React.useEffect(() => {
    setView({ kind: "loading" });
    const subscription = rpc.runners.subscribeThisMac.subscribe(undefined, {
      onData: (value) => setView({ kind: "ready", value }),
      onError: (error) =>
        setView({ kind: "failed", message: failureOf(error, "Couldn’t read this Mac.") }),
    });
    return () => subscription.unsubscribe();
  }, [rpc, attempt]);
  return view;
}

/** `runners.list` live through the window's client, while mounted. */
function useRunnerList(follow: FollowSession, attempt: number): Loaded<readonly RunnerRow[]> {
  const [view, setView] = React.useState<Loaded<readonly RunnerRow[]>>({ kind: "loading" });
  React.useEffect(() => {
    let stopWatch: (() => void) | null = null;
    const stopFollowing = follow((session) => {
      stopWatch?.();
      stopWatch = null;
      setView({ kind: "loading" });
      if (session === null) return;
      const watch = session.client.watchQuery(session.api.runners.list, {}) as Watched<
        readonly RunnerRow[]
      >;
      const read = () => {
        try {
          const rows = watch.localQueryResult();
          setView(rows === undefined ? { kind: "loading" } : { kind: "ready", value: rows });
        } catch (error) {
          setView({ kind: "failed", message: cloudFailure(error).message });
        }
      };
      stopWatch = watch.onUpdate(read);
      read();
    });
    return () => {
      stopWatch?.();
      stopFollowing();
    };
  }, [follow, attempt]);
  return view;
}

/** Everything Settings → Runners reads and sends. `rpc` and the client are a test's to replace. */
export function useRunners({
  rpc = sessionRpcClient(),
  follow = followCloudSession,
  current = cloudSession,
}: {
  rpc?: RunnersRpc;
  follow?: FollowSession;
  current?: () => CloudSession | null;
} = {}): {
  thisMac: Loaded<ThisMacRunnerSnapshot>;
  runners: Loaded<readonly RunnerRow[]>;
  commands: RunnerCommands;
  retry: () => void;
} {
  const [attempt, setAttempt] = React.useState(0);
  const thisMac = useThisMac(rpc, attempt);
  const runners = useRunnerList(follow, attempt);
  const commands = React.useMemo(() => runnerCommands(rpc, current), [rpc, current]);
  const retry = React.useCallback(() => setAttempt((count) => count + 1), []);
  return { thisMac, runners, commands, retry };
}

/* ── Status words ───────────────────────────────────────────────────────── */

/** `14:02` today, a date before that. */
export function sinceLabel(at: number, now: number = Date.now()): string {
  const then = new Date(at);
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  return sameDay
    ? then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface StatusWord {
  readonly state: StatusDotState;
  readonly label: string;
}

/** A runner's status as one short word or phrase, with its dot. Unknown statuses read as written. */
export function runnerStatus(
  runner: Pick<RunnerRow, "status" | "statusReason" | "statusChangedAt">,
  now?: number,
): StatusWord {
  switch (runner.status) {
    case "online":
      return { state: "ready", label: "Online" };
    case "offline":
      return { state: "idle", label: `Offline since ${sinceLabel(runner.statusChangedAt, now)}` };
    case "asleep":
      return { state: "parked", label: `Asleep since ${sinceLabel(runner.statusChangedAt, now)}` };
    case "stopped":
      return { state: "exited", label: "Volli is closed" };
    case "updating":
      return { state: "starting", label: "Updating" };
    case "revoked":
      return {
        state: "error",
        label: runner.statusReason === "credential_reuse" ? "Used from two places" : "Removed",
      };
    default:
      return { state: "idle", label: runner.status };
  }
}

/**
 * What this Mac's own snapshot says better than the list: it is still being
 * added, or it cannot reach Volli Cloud (so the list has not heard yet).
 * `null` where the list's status stands.
 */
export function thisMacStatus(snapshot: ThisMacRunnerSnapshot, now?: number): StatusWord | null {
  switch (snapshot.state) {
    case "unregistered":
    case "registering":
      return { state: "starting", label: "Adding…" };
    case "connecting":
      return { state: "starting", label: "Connecting…" };
    case "offline":
      return snapshot.since === null
        ? { state: "idle", label: "Offline" }
        : { state: "idle", label: `Offline since ${sinceLabel(snapshot.since, now)}` };
    default:
      return null;
  }
}

/** The one recovery a blocked Mac offers, or `null` when it is not blocked. */
export function thisMacRecovery(
  snapshot: ThisMacRunnerSnapshot,
): { readonly label: string; readonly failed: boolean } | null {
  if (snapshot.state === "removed") return { label: "Add this Mac again", failed: false };
  if (snapshot.state === "failed") return { label: "Try again", failed: true };
  return null;
}
