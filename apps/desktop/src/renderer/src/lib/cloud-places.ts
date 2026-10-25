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
 * A Session drawn on screen (its header, its composer) is opened
 * ({@link useOpenSessionPlace}) and is its own witness when no listing holds
 * it, so its Place shows even before or outside a listing; it is answered by
 * the same query, by Session, and loses its Place with the backend's vouching.
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
  type SessionPlaceReason,
  type SessionPlaceState,
} from "@volli/shared/cloud";

import type { StatusDotState } from "@renderer/components/ui/status-dot";
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
  /** Sessions drawn now (a header, a composer), by how many surfaces draw each. */
  readonly opened: Readonly<Record<string, number>>;
  /**
   * The Places of drawn Sessions no listing holds (not loaded yet, or in no
   * followed project), as `runners.places` answered them. Their turn is not
   * known here, so they read as idle.
   */
  readonly openedPlaces: Readonly<Record<string, SessionPlaceFacts>>;
}

const EMPTY: CloudPlacesState = {
  byProject: {},
  sessions: {},
  runners: {},
  thisRunnerId: null,
  opened: {},
  openedPlaces: {},
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

/**
 * A drawn Session is opened while the returned function is not yet called
 * (each surface that draws it opens it once): its Place is followed even when
 * no listing holds it. The last release forgets it.
 */
export function openSessionPlace(sessionId: string): () => void {
  useCloudPlacesStore.setState((state) => ({
    opened: { ...state.opened, [sessionId]: (state.opened[sessionId] ?? 0) + 1 },
  }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useCloudPlacesStore.setState((state) => {
      const count = (state.opened[sessionId] ?? 1) - 1;
      if (count > 0) return { opened: { ...state.opened, [sessionId]: count } };
      const { [sessionId]: _closed, ...opened } = state.opened;
      const { [sessionId]: _forgotten, ...openedPlaces } = state.openedPlaces;
      return { opened, openedPlaces };
    });
  };
}

/** A Session's Place facts: its listing row's, else what `runners.places` said of it while drawn. */
function factsOf(state: CloudPlacesState, sessionId: string): SessionPlaceFacts | undefined {
  return state.sessions[sessionId] ?? state.openedPlaces[sessionId];
}

/** Drawn Sessions no listing holds: each is its own witness. */
function unlistedOpened(state: Pick<CloudPlacesState, "sessions" | "opened">): string[] {
  return Object.keys(state.opened).filter((sessionId) => !(sessionId in state.sessions));
}

/**
 * One witness Session per distinct listed Place, plus every drawn Session no
 * listing holds, in reads of at most {@link RUNNER_PLACES_MAX_SESSIONS}.
 */
export function witnessBatches(
  sessions: Readonly<Record<string, SessionPlaceFacts>>,
  unlisted: readonly string[] = [],
): string[][] {
  const witnesses = new Map<string, string>();
  for (const sessionId of Object.keys(sessions).toSorted()) {
    const runnerId = sessions[sessionId]!.placeRunnerId;
    if (!witnesses.has(runnerId)) witnesses.set(runnerId, sessionId);
  }
  const ids = [...new Set([...witnesses.values(), ...unlisted])].toSorted();
  const batches: string[][] = [];
  for (let at = 0; at < ids.length; at += RUNNER_PLACES_MAX_SESSIONS) {
    batches.push(ids.slice(at, at + RUNNER_PLACES_MAX_SESSIONS));
  }
  return batches;
}

/** One `runners.places` row: a Session and its Place, `null` when the backend vouches for none. */
export interface PlaceAnswer {
  readonly sessionId: string;
  readonly place: RunnerPlace | null;
}

function placeOfRow(value: unknown): RunnerPlace | null {
  const place = value as Record<string, unknown> | null;
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
    return null;
  return {
    id: place.id,
    name: place.name,
    kind: place.kind,
    status: place.status,
    statusChangedAt: place.statusChangedAt,
    statusReason: place.statusReason as string | null,
    owned: place.owned,
  };
}

/**
 * Reads one `runners.places` answer. A row whose place is malformed reads as
 * no place; a row with no Session id, or an answer that is not a list, as
 * nothing at all.
 */
export function readPlaces(value: unknown): PlaceAnswer[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((row) => {
    const { sessionId, place } = (row ?? {}) as { sessionId?: unknown; place?: unknown };
    return typeof sessionId === "string" ? [{ sessionId, place: placeOfRow(place ?? null) }] : [];
  });
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
  /** Per live batch, the runners its latest answer vouched for. */
  let vouched: string[][] = [];

  const stopWatches = () => {
    for (const stop of stops) stop();
    stops = [];
    vouched = [];
  };
  const watch = () => {
    const state = useCloudPlacesStore.getState();
    const batches = session === null ? [] : witnessBatches(state.sessions, unlistedOpened(state));
    const next = JSON.stringify(batches);
    if (next === key) return;
    key = next;
    stopWatches();
    if (session === null) return;
    const current = session;
    const answeredBy = batches.map((): string[] => []);
    vouched = answeredBy;
    batches.forEach((sessionIds, index) => {
      const watched = current.client.watchQuery(current.api.runners.places, {
        sessionIds,
      }) as Watched;
      // Live until this batch is replaced or the binding ends: a read queued
      // for a batch that is gone (a rebind, another account, the end) paints
      // nothing.
      let live = true;
      // The runners this batch last answered: its next answer replaces them,
      // so a Place the backend stops answering (its witness went private, was
      // deleted, or the viewer left the Workspace) leaves no label behind.
      const replace = (answers: readonly PlaceAnswer[]) =>
        useCloudPlacesStore.setState((known) => {
          const runners = { ...known.runners };
          const witnessed = sessionIds.flatMap((id) => {
            const facts = factsOf(known, id);
            return facts === undefined ? [] : [facts.placeRunnerId];
          });
          for (const id of [...answeredBy[index]!, ...witnessed]) delete runners[id];
          // A drawn Session no listing holds takes its Place from this answer,
          // and loses it with the backend's vouching.
          const unlisted = sessionIds.filter((id) => id in known.opened && !(id in known.sessions));
          const placed = new Map<string, string>();
          const answered: string[] = [];
          for (const { sessionId, place } of answers) {
            if (place === null) continue;
            answered.push(place.id);
            runners[place.id] = place;
            placed.set(sessionId, place.id);
          }
          answeredBy[index] = answered;
          let openedPlaces = known.openedPlaces;
          for (const id of unlisted) {
            const runnerId = placed.get(id);
            if (openedPlaces[id]?.placeRunnerId === runnerId) continue;
            const { [id]: _was, ...rest } = openedPlaces;
            openedPlaces =
              runnerId === undefined
                ? rest
                : { ...rest, [id]: { placeRunnerId: runnerId, turnActive: false } };
          }
          return { runners, openedPlaces };
        });
      const read = () => {
        if (!live) return;
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
      const unsubscribe = watched.onUpdate(read);
      stops.push(() => {
        live = false;
        unsubscribe();
      });
      queueMicrotask(read);
    });
  };

  /**
   * Runners neither a listed or drawn Session lives on, nor a live batch's
   * latest answer vouched for, are forgotten. A listing a step behind the
   * backend (a witness that just moved runner) does not erase the answer.
   */
  const prune = () => {
    const state = useCloudPlacesStore.getState();
    const kept = new Set([
      ...[...Object.values(state.sessions), ...Object.values(state.openedPlaces)].map(
        (facts) => facts.placeRunnerId,
      ),
      ...vouched.flat(),
    ]);
    const runners = Object.entries(state.runners).filter(([id]) => kept.has(id));
    if (runners.length !== Object.keys(state.runners).length)
      useCloudPlacesStore.setState({ runners: Object.fromEntries(runners) });
  };

  const stopSessions = useCloudPlacesStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions && state.opened === previous.opened) return;
    // Rebuild first, so a batch that is gone no longer vouches for anything.
    watch();
    prune();
  });
  const stopFollowing = deps.follow((next) => {
    session = next;
    key = "";
    stopWatches();
    useCloudPlacesStore.setState({ runners: {}, openedPlaces: {} });
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
    // Surfaces still drawn keep their opening; everything learned goes.
    useCloudPlacesStore.setState((state) => ({ ...EMPTY, opened: state.opened }));
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
  turnActive?: boolean,
): SessionPlaceState | null {
  if (sessionId === null) return null;
  const facts = factsOf(state, sessionId);
  if (facts === undefined) return null;
  const runner = state.runners[facts.placeRunnerId];
  if (runner === undefined) return null;
  return sessionPlaceState({
    // A drawn Session already has its authoritative snapshot, even when no
    // listing holds it. Prefer that turn state over the listing's fallback.
    session: turnActive === undefined ? facts : { ...facts, turnActive },
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
export function useSessionPlace(
  sessionId: string | null,
  turnActive?: boolean,
): SessionPlaceState | null {
  return useCloudPlacesStore(
    useShallow((state) => placeOf(state, sessionId, Date.now(), turnActive)),
  );
}

/**
 * {@link useSessionPlace} for the surface that draws one Session (its header,
 * its composer): the Session is opened while mounted, so its Place is
 * followed even when no listing holds it. Opens nothing in a local launch.
 */
export function useOpenSessionPlace(
  sessionId: string | null,
  turnActive?: boolean,
): SessionPlaceState | null {
  const cloud = launchStore() === "cloud";
  React.useEffect(
    () => (cloud && sessionId !== null ? openSessionPlace(sessionId) : undefined),
    [cloud, sessionId],
  );
  return useSessionPlace(sessionId, turnActive);
}

/**
 * The dot a runner's availability wears, wherever it is drawn: the Session
 * header's Place and Settings → Runners. Serving is ready, removed an error,
 * and waiting by its reason.
 */
export function availabilityDotState(availability: {
  readonly kind: string;
  readonly reason: SessionPlaceReason | null;
}): StatusDotState {
  if (availability.kind === "removed") return "error";
  if (availability.kind !== "waiting") return "ready";
  switch (availability.reason) {
    case "asleep":
      return "parked";
    case "closed":
      return "exited";
    case "updating":
      return "starting";
    case "needs_update":
      return "error";
    default:
      return "idle";
  }
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
