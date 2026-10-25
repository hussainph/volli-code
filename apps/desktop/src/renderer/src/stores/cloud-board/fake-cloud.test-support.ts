/**
 * A stand-in for the window's Volli Cloud client (VC-889): `watchQuery` and
 * `query` keyed by the function's name and arguments, with results a test
 * sets and errors it throws, through the backend's real function references.
 */
import { getFunctionName } from "convex/server";
import { api } from "@volli/convex/api";

import type { CloudSession } from "@renderer/lib/cloud-client";

interface Entry {
  result: unknown;
  error: unknown;
  listeners: Set<() => void>;
}

export interface FakeCloud {
  readonly session: CloudSession;
  /** Sets a watched query's answer and tells its watchers. */
  answer(name: string, args: Record<string, unknown>, result: unknown): void;
  /** Makes a watched query fail and tells its watchers. */
  fail(name: string, args: Record<string, unknown>, error: unknown): void;
  /** How many live watchers a query has. */
  watchers(name: string, args: Record<string, unknown>): number;
  /** One-shot query answers by name. */
  readonly queries: Map<string, (args: unknown) => unknown>;
  /** Every mutation issued, oldest first, each settled by the test. */
  readonly mutations: FakeMutation[];
  /** Whether the client's socket reads connected. */
  connected: boolean;
}

export interface FakeMutation {
  readonly name: string;
  readonly args: Record<string, unknown>;
  resolve(reply: unknown): void;
  reject(error: unknown): void;
}

const key = (name: string, args: Record<string, unknown>) => `${name} ${JSON.stringify(args)}`;

function notify(watched: Entry): void {
  for (const listener of Array.from(watched.listeners)) listener();
}

export function fakeCloud(): FakeCloud {
  const entries = new Map<string, Entry>();
  const queries = new Map<string, (args: unknown) => unknown>();
  const mutations: FakeMutation[] = [];
  const entry = (name: string, args: Record<string, unknown>): Entry => {
    const id = key(name, args);
    let found = entries.get(id);
    if (found === undefined) {
      found = { result: undefined, error: undefined, listeners: new Set() };
      entries.set(id, found);
    }
    return found;
  };
  const client = {
    watchQuery(reference: unknown, args: Record<string, unknown>) {
      const watched = entry(getFunctionName(reference as never), args);
      return {
        onUpdate(callback: () => void) {
          watched.listeners.add(callback);
          return () => {
            watched.listeners.delete(callback);
          };
        },
        localQueryResult() {
          if (watched.error !== undefined) throw watched.error;
          return watched.result;
        },
      };
    },
    async query(reference: unknown, args: unknown) {
      return queries.get(getFunctionName(reference as never))!(args);
    },
    connectionState: () => ({ isWebSocketConnected: fake.connected }),
    mutation(
      reference: unknown,
      args: Record<string, unknown>,
      options: { optimisticUpdate(store: unknown): void },
    ) {
      // The optimistic update runs over the watched results, as Convex runs it.
      options.optimisticUpdate({
        getQuery: (query: unknown, queryArgs: Record<string, unknown>) =>
          entry(getFunctionName(query as never), queryArgs).result,
        setQuery: (query: unknown, queryArgs: Record<string, unknown>, value: unknown) => {
          const watched = entry(getFunctionName(query as never), queryArgs);
          watched.result = value;
          notify(watched);
        },
      });
      return new Promise((resolve, reject) => {
        mutations.push({ name: getFunctionName(reference as never), args, resolve, reject });
      });
    },
  };
  const fake: FakeCloud = {
    session: { client: client as never, api },
    answer(name, args, result) {
      const watched = entry(name, args);
      watched.result = result;
      watched.error = undefined;
      notify(watched);
    },
    fail(name, args, error) {
      const watched = entry(name, args);
      watched.error = error;
      notify(watched);
    },
    watchers: (name, args) => entry(name, args).listeners.size,
    queries,
    mutations,
    connected: true,
  };
  return fake;
}

/** A refusal as the client throws it: a ConvexError's `data`. */
export function refusal(code: string, message: string): Error {
  return Object.assign(new Error(`[CONVEX] ${message}`), { data: { code, message } });
}
