/**
 * Volli Cloud's link, as the host-connection store reads it (VC-889): in a
 * launch that shows Volli Cloud's board, one host record, "Volli Cloud",
 * serves every project, and its link says whether the board can be written
 * to. Everything that reads the host store (the read-only gate, the Island,
 * the chip's badge) then works for the cloud board unchanged.
 *
 * The link is a projection of what the window's Convex client and the
 * account say ({@link cloudLinkView}), in the host store's vocabulary:
 *
 * - `connecting` until the client has connected once;
 * - `open` while the socket is up, the sign-in accepted, the OS online and no
 *   write has gone unanswered;
 * - `reconnecting` for {@link HOST_OFFLINE_AFTER_MS} after any of those
 *   stops holding, then `offline` (read-only) until it holds again. The OS
 *   saying it is offline is believed at once;
 * - `incompatible` (read-only) when Volli Cloud refused the sign-in, or the
 *   sign-in ended in this launch.
 *
 * A write that has gone unanswered for {@link CLOUD_STALL_AFTER_MS} counts as
 * a dropped link: Convex's own dead-socket detection waits a minute, and a
 * write is the first thing to notice. Power resume does the same for a
 * moment, since a socket from before sleep may be dead without saying so.
 *
 * NO BOARD DATA. Like every host source, this holds a connection state and a
 * name, never a project's contents.
 */
import { create } from "zustand";
import type { AccountBackendState, AccountState } from "@volli/shared";

import {
  CLOUD_HOST,
  CLOUD_HOST_ID,
  HOST_OFFLINE_AFTER_MS,
  type HostConnectionSource,
  type HostLinkView,
  type HostSourceRecord,
  type HostSourceSnapshot,
  type ProjectLink,
} from "./host-connection";
import type { ProjectListSource } from "./host-sources";

/** How long a write may go unanswered on a socket that says it is up before the link counts as dropped. */
export const CLOUD_STALL_AFTER_MS = 5_000;

/** How long after the machine wakes the link reads as on its way back. */
export const CLOUD_RESUME_SETTLE_MS = HOST_OFFLINE_AFTER_MS;

/**
 * The client's connection, read through one adapter: Convex marks its
 * `ConnectionState` unstable ("may lose properties"), so nothing else reads it.
 */
export interface CloudConnection {
  readonly connected: boolean;
  readonly everConnected: boolean;
  readonly inflightMutations: number;
  /** When the oldest request still unanswered was sent (epoch ms), or `null`. */
  readonly oldestInflightAt: number | null;
}

/**
 * {@link CloudConnection} from Convex's `ConnectionState`. A field that went
 * missing reads as the safe answer: not connected, nothing in flight.
 */
export function readConnection(state: unknown): CloudConnection {
  const value = (state ?? {}) as Record<string, unknown>;
  const oldest = value["timeOfOldestInflightRequest"];
  return {
    connected: value["isWebSocketConnected"] === true,
    everConnected: value["hasEverConnected"] === true,
    inflightMutations:
      typeof value["inflightMutations"] === "number" ? value["inflightMutations"] : 0,
    oldestInflightAt: oldest instanceof Date ? oldest.getTime() : null,
  };
}

/** Everything the link reads. */
export interface CloudLinkInput {
  /** The window's Convex client: not made yet, running, or closed for good (the sign-in ended). */
  readonly client: "starting" | "running" | "closed";
  readonly connection: CloudConnection | null;
  /** What the client's auth said last (`onAuthChange`); `null` before it has said. */
  readonly authenticated: boolean | null;
  /** The account as main reports it; `null` before the first snapshot. */
  readonly account: {
    readonly state: AccountState;
    readonly backend: AccountBackendState | null;
    /** Why the last attempt failed: `null` after a sign-out the person chose. */
    readonly failure: string | null;
  } | null;
  /** Whether the OS says it is online (`navigator.onLine` and its events). */
  readonly online: boolean;
  /** When the machine last woke (epoch ms), `null` if it has not this launch. */
  readonly resumedAt: number | null;
  /**
   * When the board on screen was last seen live, while it is the offline
   * snapshot (VC-889, D3); `null` while the board is the live one.
   */
  readonly snapshotAt: number | null;
}

export const INITIAL_CLOUD_LINK_INPUT: CloudLinkInput = Object.freeze({
  client: "starting",
  connection: null,
  authenticated: null,
  account: null,
  online: true,
  resumedAt: null,
  snapshotAt: null,
});

/** Why the link cannot serve right now, before any grace; `null` while it can. */
function trouble(input: CloudLinkInput, now: number): "down" | "os-offline" | null {
  if (!input.online) return "os-offline";
  const connection = input.connection!;
  if (!connection.connected) return "down";
  if (
    connection.inflightMutations > 0 &&
    connection.oldestInflightAt !== null &&
    now - connection.oldestInflightAt >= CLOUD_STALL_AFTER_MS
  ) {
    return "down";
  }
  if (input.resumedAt !== null && now - input.resumedAt < CLOUD_RESUME_SETTLE_MS) return "down";
  return null;
}

function signedOut(input: CloudLinkInput): boolean {
  return input.client === "closed" || input.account?.state === "signed-out";
}

/**
 * The one mapping from {@link CloudLinkInput} to the host store's link view,
 * given when the current outage began (`downSince`, kept by
 * {@link createCloudLinkTracker}).
 */
export function cloudLinkView(
  input: CloudLinkInput,
  context: { readonly now: number; readonly downSince: number | null },
): HostLinkView {
  if (signedOut(input)) {
    return {
      status: "incompatible",
      reason: "signed-out",
      // A closed client (the person signed out, or someone else signed in)
      // waits for its restart; a sign-in that ended on its own gets the same
      // person back without one.
      recovery: input.client === "closed" ? "relaunch" : "sign-in",
    };
  }
  if (input.authenticated === false || input.account?.backend === "refused") {
    return { status: "incompatible", reason: "sign-in-refused" };
  }
  // The offline snapshot is on screen: read-only, saying how old it is.
  if (input.snapshotAt !== null) {
    return { status: "offline", since: input.snapshotAt, retryAt: null, asOf: input.snapshotAt };
  }
  if (input.client === "starting" || input.connection === null) return { status: "connecting" };
  const problem = trouble(input, context.now);
  if (problem === null) {
    return input.connection.everConnected ? { status: "open" } : { status: "connecting" };
  }
  const since = context.downSince ?? context.now;
  if (problem === "os-offline") return { status: "offline", since, retryAt: null };
  if (context.now - since < HOST_OFFLINE_AFTER_MS) {
    // A first connection still being made is connecting; one that served before is coming back.
    return input.connection.everConnected ? { status: "reconnecting" } : { status: "connecting" };
  }
  return { status: "offline", since, retryAt: null };
}

/**
 * When {@link cloudLinkView}'s answer changes with no new input (epoch ms), or
 * `null`: the end of a grace, the moment an unanswered write counts as a
 * stall, the end of the settle after waking.
 */
export function cloudLinkViewChangesAt(
  input: CloudLinkInput,
  context: { readonly now: number; readonly downSince: number | null },
): number | null {
  const connection = input.connection;
  if (signedOut(input) || connection === null || input.client !== "running") return null;
  const moments: number[] = [];
  if (context.downSince !== null) moments.push(context.downSince + HOST_OFFLINE_AFTER_MS);
  if (connection.inflightMutations > 0 && connection.oldestInflightAt !== null) {
    moments.push(connection.oldestInflightAt + CLOUD_STALL_AFTER_MS);
  }
  if (input.resumedAt !== null) moments.push(input.resumedAt + CLOUD_RESUME_SETTLE_MS);
  const future = moments.filter((at) => at > context.now);
  return future.length === 0 ? null : Math.min(...future);
}

export interface CloudLinkTracker {
  /** Feeds the input now; answers the view and when to ask again. */
  view(input: CloudLinkInput, now: number): { link: HostLinkView; recheckAt: number | null };
}

/**
 * Keeps when the current outage began: it starts the first moment the link
 * cannot serve and ends when it can again; changes inside it do not restart
 * it. The same view keeps its object, so the host store's readers do not
 * redraw.
 */
export function createCloudLinkTracker(): CloudLinkTracker {
  let downSince: number | null = null;
  let last: HostLinkView | null = null;
  return {
    view(input, now) {
      const blocked =
        !signedOut(input) &&
        input.client === "running" &&
        input.connection !== null &&
        trouble(input, now) !== null;
      if (!blocked) downSince = null;
      else downSince ??= now;
      const context = { now, downSince };
      const link = cloudLinkView(input, context);
      if (last === null || JSON.stringify(last) !== JSON.stringify(link)) last = link;
      return { link: last, recheckAt: cloudLinkViewChangesAt(input, context) };
    },
  };
}

/** The inputs, as the window's client glue (`lib/cloud-client.ts`) feeds them. */
export interface CloudLinkInputState {
  readonly input: CloudLinkInput;
  update(patch: Partial<CloudLinkInput>): void;
}

export function createCloudLinkInputStore() {
  return create<CloudLinkInputState>()((set, get) => ({
    input: INITIAL_CLOUD_LINK_INPUT,
    update(patch) {
      const current = get().input;
      const changed = (Object.keys(patch) as (keyof CloudLinkInput)[]).some(
        (key) => JSON.stringify(patch[key]) !== JSON.stringify(current[key]),
      );
      if (changed) set({ input: { ...current, ...patch } });
    },
  }));
}

/** The app's one set of cloud link inputs. */
export const useCloudLinkInputs = createCloudLinkInputStore();

/** The name Volli Cloud's one host record carries everywhere it is shown. */
export const CLOUD_HOST_NAME = CLOUD_HOST.name;

/** A timer, injectable for tests. */
export interface CloudLinkClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: CloudLinkClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The `cloud` host-connection source: one host record, Volli Cloud, and a
 * claim on every project the projects store lists (in a launch that shows
 * Volli Cloud's board, those are all Volli Cloud's). It re-maps on every
 * input change and at the moment the view changes with time. It has nothing
 * to retry, update or sign in to: the client reconnects on its own, and the
 * sign-in is Settings → Account's.
 */
export function createCloudHostSource(options: {
  projects: ProjectListSource;
  inputs?: {
    getState(): Pick<CloudLinkInputState, "input">;
    subscribe(listener: () => void): () => void;
  };
  clock?: CloudLinkClock;
}): HostConnectionSource {
  const inputs = options.inputs ?? useCloudLinkInputs;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const tracker = createCloudLinkTracker();
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let snapshot: HostSourceSnapshot = { hosts: [], projects: {} };
  let host: HostSourceRecord | null = null;
  let claim: ProjectLink | null = null;
  let ids: readonly string[] = [];
  let stopFollowing: (() => void) | null = null;

  function read(): boolean {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    const { link, recheckAt } = tracker.view(inputs.getState().input, clock.now());
    if (recheckAt !== null) {
      timer = clock.setTimeout(
        () => {
          timer = null;
          if (read()) emit();
        },
        Math.max(0, recheckAt - clock.now()),
      );
    }
    const nextIds = options.projects.getState().projects.map((project) => project.id);
    const sameIds =
      nextIds.length === ids.length && nextIds.every((id, index) => id === ids[index]);
    if (host !== null && host.link === link && sameIds) return false;
    if (host === null || host.link !== link) {
      host = {
        id: CLOUD_HOST_ID,
        name: CLOUD_HOST_NAME,
        local: false,
        os: null,
        version: null,
        link,
        liveSessions: null,
        update: null,
        expiredSignIns: [],
      };
      claim = Object.freeze({ hostId: CLOUD_HOST_ID, link });
    }
    ids = nextIds;
    snapshot = {
      hosts: [host],
      projects: Object.fromEntries(nextIds.map((id) => [id, claim!])),
    };
    return true;
  }

  function emit(): void {
    for (const listener of listeners) listener();
  }

  read();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (stopFollowing === null) {
        const changed = () => {
          if (read()) emit();
        };
        const stopInputs = inputs.subscribe(changed);
        const stopProjects = options.projects.subscribe(changed);
        stopFollowing = () => {
          stopInputs();
          stopProjects();
        };
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        stopFollowing!();
        stopFollowing = null;
        if (timer !== null) {
          clock.clearTimeout(timer);
          timer = null;
        }
      };
    },
    retry() {},
    updateHost() {},
    cancelScheduledUpdate() {},
    signIn() {},
  };
}

/**
 * Whether the machine just woke: a periodic tick that arrives much later than
 * it was due means the process was suspended in between.
 */
export function wokeBetween(previousTick: number, now: number, intervalMs: number): boolean {
  return now - previousTick > intervalMs * 3;
}
