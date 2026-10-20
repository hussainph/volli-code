/**
 * Where the dev log viewer's lines come from (VC-699).
 *
 * - **This Mac**: Electron main, the in-process host and this window, read
 *   through the Session RPC bridge's `logs.tail` and `logs.follow`.
 * - **A remote host**: the same two operations over its host link's
 *   `host.logs` feature, no SSH session. Whoever owns a host link (the
 *   "Add a host over SSH" flow, VC-700) registers it here with
 *   {@link registerRemoteLogSource}; the viewer shows it for as long as it
 *   is registered.
 *
 * A source reads the host's recent page first, then follows from its cursor;
 * a `gap` (lines the host no longer holds) is passed on, never hidden.
 */
import * as React from "react";
import type { HostLogEntry, HostLogsBatch } from "@volli/shared";

import { readHostError } from "@volli/host-protocol";

import { sessionRpcClient } from "../../lib/session-rpc-ipc-link";

/** What a source tells the viewer. */
export interface LogSourceHandlers {
  onLines(entries: readonly HostLogEntry[], gap: boolean): void;
  onStatus(status: LogSourceStatus, detail?: string): void;
}

export type LogSourceStatus = "connecting" | "live" | "failed";

export interface LogSource {
  /** Stable, and what each line is labelled by. */
  readonly id: string;
  /** What the viewer calls the machine: "This Mac", a host's name. */
  readonly label: string;
  /** Starts reading; returns the stop. */
  start(handlers: LogSourceHandlers): () => void;
}

/** Lines a source asks for in one read: the host caps it, and bounds it in bytes (VC-712). */
const LOG_PAGE = 500;

/** The id of this Mac's own source. */
export const LOCAL_SOURCE_ID = "this-mac";

/** A batch out of whatever envelope a tracked subscription frame arrived in. */
export function batchOf(value: unknown): HostLogsBatch | null {
  if (typeof value !== "object" || value === null) return null;
  if ("entries" in value) return value as HostLogsBatch;
  return "data" in value ? batchOf((value as { data: unknown }).data) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The tail-then-follow every source does, over two calls it is handed. */
function tailThenFollow(
  handlers: LogSourceHandlers,
  tail: () => Promise<unknown>,
  follow: (
    after: string,
    onBatch: (batch: HostLogsBatch) => void,
    onError: (error: unknown) => void,
  ) => () => void,
): () => void {
  let stopped = false;
  let stopFollow: (() => void) | null = null;
  handlers.onStatus("connecting");
  void tail().then(
    (value) => {
      const page = batchOf(value);
      if (stopped || page === null) return;
      handlers.onLines(page.entries, page.gap);
      handlers.onStatus("live");
      stopFollow = follow(
        page.cursor,
        (batch) => {
          if (!stopped) handlers.onLines(batch.entries, batch.gap);
        },
        (error) => {
          if (!stopped) handlers.onStatus("failed", messageOf(error));
        },
      );
    },
    (error: unknown) => {
      if (!stopped) handlers.onStatus("failed", messageOf(error));
    },
  );
  return () => {
    stopped = true;
    stopFollow?.();
  };
}

/** The slice of the Session RPC client this source reads. */
export interface LocalLogClient {
  readonly logs: {
    readonly tail: { query(input: { limit?: number }): Promise<unknown> };
    readonly follow: {
      subscribe(
        input: { after?: string },
        handlers: { onData?(value: unknown): void; onError?(error: unknown): void },
      ): { unsubscribe(): void };
    };
  };
}

/** This Mac's log, through the Session RPC bridge. */
export function localLogSource(client: () => LocalLogClient = sessionRpcClient): LogSource {
  return {
    id: LOCAL_SOURCE_ID,
    label: "This Mac",
    start: (handlers) =>
      tailThenFollow(
        handlers,
        () => client().logs.tail.query({ limit: LOG_PAGE }),
        (after, onBatch, onError) => {
          const subscription = client().logs.follow.subscribe(
            { after },
            {
              onData: (value) => {
                const batch = batchOf(value);
                if (batch !== null) onBatch(batch);
              },
              onError,
            },
          );
          return () => subscription.unsubscribe();
        },
      ),
  };
}

/** What a remote source needs of a host link (`@volli/host-protocol/client-link`'s `HostLink`). */
export interface LogSourceLink {
  query(path: string, input?: unknown): Promise<unknown>;
  subscribe(
    path: string,
    input: unknown,
    handlers: {
      onData(data: unknown): void;
      onResnapshot(error: unknown): void;
      onError(error: unknown): void;
      /** The host took the stream: it is live. */
      onStarted?(): void;
      /** It ended cleanly (a host that stopped serving it). */
      onComplete?(): void;
      /**
       * The link's stream budget refused the stream, or made it yield
       * (`subscription-limit`, AM1): the relay says so here while it waits for
       * a slot; a bare link says it as an error.
       */
      onLimited?(error: unknown): void;
    },
  ): { unsubscribe(): void };
}

/** One link a remote source may read over: its Workspace, and the link. */
export interface LogSourceLinkChoice {
  /** Stable for one link (its Workspace id): how the source knows the one it uses. */
  readonly key: string;
  readonly link: LogSourceLink;
}

/**
 * The links one remote host offers its log over (VC-712): each of its ready
 * Workspace links that grants `host.logs`, best first (the least loaded), and
 * what to show while none is ready.
 */
export interface LogSourceLinks {
  ready(): readonly LogSourceLinkChoice[];
  /** The dot while no link is ready: the host's own link state, worded. */
  waiting(): { readonly status: LogSourceStatus; readonly detail?: string };
  /** Called after any change that may change either. */
  subscribe(listener: () => void): () => void;
}

export interface HostLinkLogSourceTiming {
  /** How often a source whose every link is full reads the newest lines instead (AM1). */
  readonly pollMs?: number;
  /** How many of those reads before it asks for a live stream again. */
  readonly pollsPerFollowRetry?: number;
  /** How long after a failure it starts again. */
  readonly retryMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

const POLL_MS = 3_000;
const POLLS_PER_FOLLOW_RETRY = 10;
const RETRY_MS = 5_000;

/** What the dot says while a source reads by polling: live, with why it is not streaming. */
export const LOG_SOURCE_POLLING =
  "Live updates are paused while this host’s links are full; reading its newest lines every few seconds.";

/** The reason a host error names, from a relayed or a link's own error. */
function reasonOf(error: unknown): string | undefined {
  return readHostError(error).reason;
}

/** One fixed link, always ready: a host link a test or the lab holds directly. */
function fixedLinks(link: LogSourceLink): LogSourceLinks {
  const ready = [{ key: "link", link }] as const;
  return {
    ready: () => ready,
    /* v8 ignore next -- a fixed link is always ready: nothing waits for it. */
    waiting: () => ({ status: "connecting" }),
    subscribe: () => () => undefined,
  };
}

/**
 * A remote host's log over its links: `host.logs`, the newest page first,
 * then followed from its cursor (VC-699, VC-712).
 *
 * - **One link at a time, any ready one.** It reads over the first of
 *   `links.ready()`; when that link stops being ready (it closed, or its
 *   project went), it moves to the next and resumes after the last line it
 *   showed, so the host's backlog (bounded, with its `gap`) fills in.
 * - **A full link is never a blank source (AM1).** When a link's stream
 *   budget refuses the follow (`subscription-limit`), it tries the host's
 *   next ready link; when every one is full, it polls `logs.tail` after its
 *   cursor ({@link LOG_SOURCE_POLLING}) and asks for a stream again now and
 *   then.
 * - **The dot is the link's.** Live while it reads over a ready link;
 *   `links.waiting()` while none is ready; failed (and started again after a
 *   pause) when the host answered with an error.
 *
 * Every call it makes is guarded by identity: an answer for a link it has
 * since left, or after stop, is dropped. Stop ends everything at once.
 */
export function hostLinkLogSource(
  input: { id: string; label: string } & (
    | { link: LogSourceLink; links?: undefined }
    | { links: LogSourceLinks; link?: undefined }
  ),
  timing: HostLinkLogSourceTiming = {},
): LogSource {
  const links = input.links ?? fixedLinks(input.link);
  const pollMs = timing.pollMs ?? POLL_MS;
  const pollsPerRetry = timing.pollsPerFollowRetry ?? POLLS_PER_FOLLOW_RETRY;
  const retryMs = timing.retryMs ?? RETRY_MS;
  const setTimer = timing.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = timing.clearTimer ?? ((timer) => clearTimeout(timer as number));
  return {
    id: input.id,
    label: input.label,
    start(handlers) {
      /** The newest line shown: where any later read resumes. */
      let cursor: string | undefined;
      /** The link read over now; `null` while none is ready. */
      let using: LogSourceLinkChoice | null = null;
      /** Which attempt is current: a callback from an older one is dropped. */
      let attempt = 0;
      let stream: { unsubscribe(): void } | null = null;
      let timer: unknown;
      let polling = false;
      /** Links whose stream budget refused this source, until it asks again. */
      const full = new Set<string>();
      let said: string | null = null;

      const say = (status: LogSourceStatus, detail?: string): void => {
        const key = `${status}\u0000${detail ?? ""}`;
        if (key === said) return;
        said = key;
        handlers.onStatus(status, detail);
      };
      const show = (batch: HostLogsBatch): void => {
        handlers.onLines(batch.entries, batch.gap);
        cursor = batch.cursor;
      };
      // A follow and a poll come only after the first tail set the cursor.
      const after = (): { after: string } => ({ after: cursor! });

      /** Ends whatever the current attempt holds; its late callbacks are dropped (stop ends one too). */
      const leave = (): void => {
        attempt += 1;
        stream?.unsubscribe();
        stream = null;
        if (timer !== undefined) clearTimer(timer);
        timer = undefined;
        polling = false;
      };

      /** Chooses a link and reads over it: the first ready one the budget has not refused. */
      const choose = (): void => {
        leave();
        const ready = links.ready();
        if (ready.length === 0) {
          using = null;
          const waiting = links.waiting();
          say(waiting.status, waiting.detail);
          return;
        }
        const free = ready.find((choice) => !full.has(choice.key));
        if (free === undefined) {
          using = ready[0]!;
          poll(pollsPerRetry);
          return;
        }
        using = free;
        if (cursor === undefined) tail(free);
        else follow(free);
      };

      const failed = (error: unknown): void => {
        leave();
        say("failed", messageOf(error));
        timer = setTimer(choose, retryMs);
      };

      const tail = (choice: LogSourceLinkChoice): void => {
        const mine = attempt;
        if (said === null) say("connecting");
        choice.link.query("logs.tail", { limit: LOG_PAGE }).then(
          (value) => {
            if (mine !== attempt) return;
            const page = batchOf(value);
            if (page === null) return failed(new Error("The host answered with no log"));
            show(page);
            follow(choice);
          },
          (error: unknown) => {
            if (mine === attempt) failed(error);
          },
        );
      };

      const limited = (choice: LogSourceLinkChoice): void => {
        full.add(choice.key);
        choose();
      };

      const follow = (choice: LogSourceLinkChoice): void => {
        const mine = attempt;
        say("live");
        const current = (): boolean => mine === attempt;
        const subscription = choice.link.subscribe("logs.follow", after(), {
          onStarted: () => {
            if (current()) say("live");
          },
          onData: (value) => {
            if (!current()) return;
            const batch = batchOf(value);
            if (batch !== null) show(batch);
          },
          // The relay says it inside its own callback: leave it after that returns.
          onLimited: () => {
            queueMicrotask(() => {
              if (current()) limited(choice);
            });
          },
          onResnapshot: (error) => {
            if (current()) failed(error);
          },
          onError: (error) => {
            if (!current()) return;
            if (reasonOf(error) === "subscription-limit") limited(choice);
            else failed(error);
          },
          onComplete: () => {
            if (current()) failed(new Error("The host stopped sending its log"));
          },
        });
        if (current()) stream = subscription;
        else subscription.unsubscribe();
      };

      /** Every link is full: read the newest lines now and then, and ask for a stream again later. */
      const poll = (left: number): void => {
        const mine = attempt;
        polling = true;
        say("live", LOG_SOURCE_POLLING);
        const next = (): void => {
          if (left <= 1) {
            full.clear();
            timer = setTimer(choose, pollMs);
            return;
          }
          // Cleared by whatever leaves this attempt, so it runs only while it is current.
          timer = setTimer(() => {
            timer = undefined;
            leave();
            poll(left - 1);
          }, pollMs);
        };
        using!.link.query("logs.tail", { ...after(), limit: LOG_PAGE }).then(
          (value) => {
            if (mine !== attempt) return;
            const page = batchOf(value);
            if (page !== null) show(page);
            say("live", LOG_SOURCE_POLLING);
            next();
          },
          (error: unknown) => {
            if (mine !== attempt) return;
            say("failed", messageOf(error));
            next();
          },
        );
      };

      const stopWatching = links.subscribe(() => {
        const ready = links.ready();
        if (using === null) {
          if (ready.length > 0) choose();
          else {
            const waiting = links.waiting();
            say(waiting.status, waiting.detail);
          }
          return;
        }
        const held = using;
        // The link in use closed, or its project went: move to another.
        if (!ready.some((choice) => choice.key === held.key)) {
          choose();
          return;
        }
        // Polling, and a link the budget has not refused came up: stream over it.
        if (polling && ready.some((choice) => !full.has(choice.key))) choose();
      });

      choose();
      return () => {
        leave();
        stopWatching();
      };
    },
  };
}

/* -------------------------------------------------------------- registry */

let remotes: readonly LogSource[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/**
 * Shows a remote host's log in the viewer until the returned function is
 * called. A second source with the same id replaces the first.
 */
export function registerRemoteLogSource(source: LogSource): () => void {
  remotes = [...remotes.filter((held) => held.id !== source.id), source];
  changed();
  return () => {
    if (!remotes.includes(source)) return;
    remotes = remotes.filter((held) => held !== source);
    changed();
  };
}

/** The remote sources registered now. */
export function remoteLogSources(): readonly LogSource[] {
  return remotes;
}

function subscribeRemotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** This Mac first, then every registered remote host. */
export function useLogSources(local: LogSource): readonly LogSource[] {
  const registered = React.useSyncExternalStore(subscribeRemotes, remoteLogSources);
  return React.useMemo(() => [local, ...registered], [local, registered]);
}
