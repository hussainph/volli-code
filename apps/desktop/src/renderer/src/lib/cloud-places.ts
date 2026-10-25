/**
 * Where each cloud Session runs, for "Waiting for <Mac>" (VC-895). Installed
 * only in a cloud launch, beside the cloud Session listing
 * (`cloud-sessions.ts`), which feeds it each listed Session's Place
 * (`placeRunnerId`) and `turnActive`.
 *
 * The runners come from `runners.places`, which answers by Session id and
 * only for Sessions the viewer can see: this follower names one listed
 * Session per distinct Place as that runner's witness, in reads of at most
 * {@link RUNNER_PLACES_MAX_SESSIONS}. It never lists anyone's runners.
 *
 * This Mac's own runner id comes from main's `runners.subscribeThisMac`
 * stream (the same one Settings → Runners reads), so a Session placed here
 * reads "Running on this Mac" whatever the backend last heard.
 *
 * A Session's queued commands come from the backend's own list
 * (`sessionMessages.pending`, the jobs its runner has not answered yet),
 * watched only while that Session's composer is drawn, so "Sent — waiting
 * for hp-mac" survives a reload and clears when the runner takes the work,
 * never on a guess. Nothing the backend has not accepted is held here.
 *
 * The words are `sessionPlaceState` / `pendingCommandLabel` in
 * `@volli/shared/cloud`; this module only gathers their facts.
 */
import * as React from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ThisMacRunnerSnapshot } from "@volli/shared";
import {
  pendingCommandLabel,
  RUNNER_PLACES_MAX_SESSIONS,
  sessionPlaceState,
  type RunnerPlace,
  type SessionPlaceState,
} from "@volli/shared/cloud";

import { launchStore } from "@renderer/stores/launch";

import { followCloudSession, type CloudSession } from "./cloud-client";

/** What a listing row says about a Session's Place. */
export interface SessionPlaceFacts {
  readonly placeRunnerId: string;
  readonly turnActive: boolean;
}

export interface CloudPlacesState {
  /** Per followed project: its listed Sessions' Places. */
  readonly byProject: Readonly<Record<string, Readonly<Record<string, SessionPlaceFacts>>>>;
  /** Every listed Session's Place, flattened from {@link byProject}. */
  readonly sessions: Readonly<Record<string, SessionPlaceFacts>>;
  /** The runners `runners.places` answered, by id. */
  readonly runners: Readonly<Record<string, RunnerPlace>>;
  /** This Mac's runner id, when it is one. */
  readonly thisRunnerId: string | null;
}

const EMPTY: CloudPlacesState = {
  byProject: {},
  sessions: {},
  runners: {},
  thisRunnerId: null,
};

export const useCloudPlacesStore = create<CloudPlacesState>(() => EMPTY);

function flatten(
  byProject: CloudPlacesState["byProject"],
): Readonly<Record<string, SessionPlaceFacts>> {
  return Object.assign({}, ...Object.values(byProject)) as Record<string, SessionPlaceFacts>;
}

/** A project's listing painted: its Sessions' Places replace what it said before. */
export function noteProjectPlaces(
  projectId: string,
  rows: readonly { id: string; placeRunnerId: string; turnActive: boolean }[],
): void {
  useCloudPlacesStore.setState((state) => {
    const byProject = {
      ...state.byProject,
      [projectId]: Object.fromEntries(
        rows.map((row) => [
          row.id,
          { placeRunnerId: row.placeRunnerId, turnActive: row.turnActive },
        ]),
      ),
    };
    return { byProject, sessions: flatten(byProject) };
  });
}

/** A project no longer followed: its Places are forgotten. */
export function forgetProjectPlaces(projectId: string): void {
  useCloudPlacesStore.setState((state) => {
    if (!(projectId in state.byProject)) return state;
    const { [projectId]: _gone, ...byProject } = state.byProject;
    return { byProject, sessions: flatten(byProject) };
  });
}

/** One witness Session per distinct Place, in reads of at most {@link RUNNER_PLACES_MAX_SESSIONS}. */
export function witnessBatches(sessions: Readonly<Record<string, SessionPlaceFacts>>): string[][] {
  const witnesses = new Map<string, string>();
  for (const sessionId of Object.keys(sessions).toSorted()) {
    const runnerId = sessions[sessionId]!.placeRunnerId;
    if (!witnesses.has(runnerId)) witnesses.set(runnerId, sessionId);
  }
  const ids = [...witnesses.values()].toSorted();
  const batches: string[][] = [];
  for (let at = 0; at < ids.length; at += RUNNER_PLACES_MAX_SESSIONS) {
    batches.push(ids.slice(at, at + RUNNER_PLACES_MAX_SESSIONS));
  }
  return batches;
}

/** Reads one `runners.places` answer; anything not shaped like one is ignored. */
export function readPlaces(value: unknown): RunnerPlace[] {
  if (!Array.isArray(value)) return [];
  const places: RunnerPlace[] = [];
  for (const row of value as unknown[]) {
    const place = (row as { place?: unknown } | null)?.place as Record<string, unknown> | null;
    if (
      place === null ||
      typeof place !== "object" ||
      typeof place.id !== "string" ||
      typeof place.name !== "string" ||
      typeof place.kind !== "string" ||
      typeof place.status !== "string" ||
      typeof place.statusChangedAt !== "number" ||
      (place.statusReason !== null && typeof place.statusReason !== "string") ||
      typeof place.owned !== "boolean"
    )
      continue;
    places.push({
      id: place.id,
      name: place.name,
      kind: place.kind,
      status: place.status,
      statusChangedAt: place.statusChangedAt,
      statusReason: place.statusReason as string | null,
      owned: place.owned,
    });
  }
  return places;
}

/** Main's stream of this Mac's runner, as `runners.subscribeThisMac` types it. */
export interface ThisMacStream {
  subscribe(
    input: undefined,
    handlers: { onData(data: ThisMacRunnerSnapshot): void; onError(error: unknown): void },
  ): { unsubscribe(): void };
}

export interface CloudPlacesDeps {
  /** Follows the launch's one client (`followCloudSession`). */
  follow(listener: (session: CloudSession | null) => void): () => void;
  thisMac: ThisMacStream | null;
  warn(message: string, error?: unknown): void;
}

interface Watched {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): unknown;
}

/**
 * Follows the Places of every listed Session until the returned function is
 * called, which forgets everything it learned.
 */
export function bindCloudPlaces(deps: CloudPlacesDeps): () => void {
  let session: CloudSession | null = null;
  let key = "";
  let stops: (() => void)[] = [];

  const stopWatches = () => {
    for (const stop of stops) stop();
    stops = [];
  };
  const watch = () => {
    const batches = session === null ? [] : witnessBatches(useCloudPlacesStore.getState().sessions);
    const next = JSON.stringify(batches);
    if (next === key) return;
    key = next;
    stopWatches();
    if (session === null) return;
    const current = session;
    for (const sessionIds of batches) {
      const watched = current.client.watchQuery(current.api.runners.places, {
        sessionIds,
      }) as Watched;
      // The runners this batch last answered: its next answer replaces them,
      // so a Place the backend stops answering (its witness went private, was
      // deleted, or the viewer left the Workspace) leaves no label behind.
      let answeredIds: string[] = [];
      const replace = (answered: readonly RunnerPlace[]) =>
        useCloudPlacesStore.setState((state) => {
          const runners = { ...state.runners };
          const witnessed = sessionIds.flatMap((id) => {
            const facts = state.sessions[id];
            return facts === undefined ? [] : [facts.placeRunnerId];
          });
          for (const id of [...answeredIds, ...witnessed]) delete runners[id];
          for (const place of answered) runners[place.id] = place;
          answeredIds = answered.map((place) => place.id);
          return { runners };
        });
      const read = () => {
        let value: unknown;
        try {
          value = watched.localQueryResult();
        } catch (error) {
          deps.warn("[volli] cloud Session places:", error);
          replace([]);
          return;
        }
        if (value === undefined) return;
        replace(readPlaces(value));
      };
      stops.push(watched.onUpdate(read));
      queueMicrotask(read);
    }
  };

  /** Runners no listed Session lives on any more are forgotten. */
  const prune = (state: CloudPlacesState) => {
    const referenced = new Set(Object.values(state.sessions).map((facts) => facts.placeRunnerId));
    const kept = Object.entries(state.runners).filter(([id]) => referenced.has(id));
    if (kept.length !== Object.keys(state.runners).length)
      useCloudPlacesStore.setState({ runners: Object.fromEntries(kept) });
  };

  const stopSessions = useCloudPlacesStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return;
    prune(state);
    watch();
  });
  const stopFollowing = deps.follow((next) => {
    session = next;
    key = "";
    stopWatches();
    useCloudPlacesStore.setState({ runners: {} });
    watch();
  });
  const thisMac =
    deps.thisMac?.subscribe(undefined, {
      onData: (snapshot) => useCloudPlacesStore.setState({ thisRunnerId: snapshot.runnerId }),
      onError: (error) => deps.warn("[volli] this Mac's runner:", error),
    }) ?? null;

  return () => {
    stopSessions();
    stopFollowing();
    stopWatches();
    thisMac?.unsubscribe();
    useCloudPlacesStore.setState(EMPTY);
  };
}

/** `14:02` today, a date before that, in the person's locale. */
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

/** A Session's Place from the store's facts, or `null` while any is unknown. */
export function placeOf(
  state: CloudPlacesState,
  sessionId: string | null,
  now: number,
): SessionPlaceState | null {
  if (sessionId === null) return null;
  const facts = state.sessions[sessionId];
  if (facts === undefined) return null;
  const runner = state.runners[facts.placeRunnerId];
  if (runner === undefined) return null;
  return sessionPlaceState({
    session: facts,
    runner,
    viewerRunnerId: state.thisRunnerId,
    now,
    formatSince: sinceLabel,
  });
}

/**
 * A Session's Place while it is drawn, or `null` (no cloud launch, not
 * listed, or its runner not answered yet). The store's snapshot is read with
 * the clock at that moment, and compared field by field, so it re-renders
 * only when the words change.
 */
export function useSessionPlace(sessionId: string | null): SessionPlaceState | null {
  return useCloudPlacesStore(useShallow((state) => placeOf(state, sessionId, Date.now())));
}

/** A message the backend holds for a Session's runner, as the composer shows it while it waits. */
export interface PendingMessage {
  readonly commandId: string;
  readonly text: string;
}

/** A command the runner never carried out, in the backend's words (path-free). */
export interface FailedCommand {
  readonly commandId: string;
  /** The message's words, when it was one and its body came back. */
  readonly text: string | null;
  readonly reason: string;
}

/** A Session's commands its runner has not answered yet, from `sessionMessages.pending`. */
export interface SessionPending {
  /** Commands still waiting: queued, leased, or run with no engine receipt yet. */
  readonly count: number;
  /** The waiting messages whose bodies came back, oldest first. */
  readonly messages: readonly PendingMessage[];
  /** Commands that ended without being carried out, oldest first. */
  readonly failures: readonly FailedCommand[];
  /** Whether this is the backend's answer, rather than nothing heard yet. */
  readonly answered: boolean;
}

export const NO_PENDING: SessionPending = Object.freeze({
  count: 0,
  messages: [],
  failures: [],
  answered: false,
});

/** The statuses in which a command ended without being carried out. */
const ENDED = new Set(["failed", "cancelled", "expired"]);

/** Why a command ended undone: the backend's (path-free) detail, else its code, else its status. */
function failureReason(status: string, failure: unknown): string {
  const { detail, code } = (failure ?? {}) as { detail?: unknown; code?: unknown };
  if (typeof detail === "string" && detail !== "") return detail;
  if (typeof code === "string" && code !== "") return code;
  return status;
}

/** A staged body's words: the artifact's message's text parts. `null` when unreadable. */
function bodyText(body: unknown): string | null {
  if (typeof body !== "string") return null;
  try {
    const parts = (JSON.parse(body) as { message?: { parts?: unknown } }).message?.parts;
    if (!Array.isArray(parts)) return null;
    const words = parts
      .flatMap((part: unknown) => {
        const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown };
        return type === "text" && typeof text === "string" ? [text] : [];
      })
      .join("\n")
      .trim();
    return words === "" ? null : words;
  } catch {
    return null;
  }
}

/**
 * One `sessionMessages.pending` answer (`{ commands }`, newest first) as the
 * composer reads it: what still waits (`queued`, `leased`, or `done` with no
 * engine receipt yet), and what ended undone (`failed`, `cancelled` or
 * `expired`, with the backend's `failure` words). Anything not shaped like
 * one is nothing pending.
 */
export function readPending(value: unknown): SessionPending {
  const commands = (value as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(commands)) return { ...NO_PENDING, answered: true };
  let count = 0;
  const messages: PendingMessage[] = [];
  const failures: FailedCommand[] = [];
  for (const row of commands as unknown[]) {
    const { commandId, kind, body, status, failure } = (row ?? {}) as Record<string, unknown>;
    const text = kind === "message.submit" ? bodyText(body) : null;
    if (typeof status === "string" && ENDED.has(status)) {
      if (typeof commandId === "string")
        failures.push({ commandId, text, reason: failureReason(status, failure) });
      continue;
    }
    count += 1;
    if (typeof commandId === "string" && text !== null) messages.push({ commandId, text });
  }
  return {
    count,
    messages: messages.toReversed(),
    failures: failures.toReversed(),
    answered: true,
  };
}

/**
 * `sessionMessages.pending` for one Session while mounted, over the launch's
 * client: the backend's own list of what waits for its runner, so it
 * survives a reload and clears when the runner answers, never on a guess.
 * Nothing with no Session or no client; a failed read is logged and reads as
 * nothing (the composer still sends).
 */
export function useSessionPending(
  sessionId: string | null,
  follow: CloudPlacesDeps["follow"] = followCloudSession,
): SessionPending {
  // Keyed by the Session it answers, so a render between two Sessions never
  // shows the previous one's commands under the next one's name.
  const [state, setState] = React.useState<{ sessionId: string | null; pending: SessionPending }>({
    sessionId: null,
    pending: NO_PENDING,
  });
  React.useEffect(() => {
    const setPending = (pending: SessionPending) => setState({ sessionId, pending });
    setPending(NO_PENDING);
    if (sessionId === null) return;
    let stopWatch: (() => void) | null = null;
    const stopFollowing = follow((session) => {
      stopWatch?.();
      stopWatch = null;
      setPending(NO_PENDING);
      if (session === null) return;
      const watched = session.client.watchQuery(session.api.sessionMessages.pending, {
        sessionId,
      }) as Watched;
      const read = () => {
        try {
          const value = watched.localQueryResult();
          if (value !== undefined) setPending(readPending(value));
        } catch (error) {
          console.warn("[volli] cloud Session pending commands:", error);
          setPending(NO_PENDING);
        }
      };
      stopWatch = watched.onUpdate(read);
      read();
    });
    return () => {
      stopWatch?.();
      stopFollowing();
    };
  }, [follow, sessionId]);
  return state.sessionId === sessionId ? state.pending : NO_PENDING;
}

/**
 * What the line above a cloud Session's composer says about its queued
 * commands: "Sent — waiting for hp-mac" while any waits on a runner that is
 * not running the Session (`null` once it is), the messages among them, and
 * every command that ended undone, wherever the runner is.
 * Watches nothing in a local launch.
 */
export function useSessionPendingLine(
  sessionId: string | null,
  follow?: CloudPlacesDeps["follow"],
): {
  label: string | null;
  messages: readonly PendingMessage[];
  failures: readonly FailedCommand[];
  answered: boolean;
} {
  const pending = useSessionPending(launchStore() === "cloud" ? sessionId : null, follow);
  const waiting = pending.count > 0;
  const label = useCloudPlacesStore((state) =>
    waiting ? pendingCommandLabel(placeOf(state, sessionId, Date.now())) : null,
  );
  return {
    label,
    messages: label === null ? [] : pending.messages,
    failures: pending.failures,
    answered: pending.answered,
  };
}
