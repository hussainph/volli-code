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

import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

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
export function localLogSource(
  client: () => LocalLogClient = () => sessionRpcClient() as unknown as LocalLogClient,
): LogSource {
  return {
    id: LOCAL_SOURCE_ID,
    label: "This Mac",
    start: (handlers) =>
      tailThenFollow(
        handlers,
        () => client().logs.tail.query({ limit: 500 }),
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
    },
  ): { unsubscribe(): void };
}

/** A remote host's log over its link: `host.logs`, resumed by the link across reconnects. */
export function hostLinkLogSource(input: {
  id: string;
  label: string;
  link: LogSourceLink;
}): LogSource {
  return {
    id: input.id,
    label: input.label,
    start: (handlers) =>
      tailThenFollow(
        handlers,
        () => input.link.query("logs.tail", { limit: 500 }),
        (after, onBatch, onError) => {
          const subscription = input.link.subscribe(
            "logs.follow",
            { after },
            {
              onData: (value) => {
                const batch = batchOf(value);
                if (batch !== null) onBatch(batch);
              },
              onResnapshot: onError,
              onError,
            },
          );
          return () => subscription.unsubscribe();
        },
      ),
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
