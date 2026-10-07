/**
 * The Add-a-host sheet's state (VC-700 PR 3): the address field, then one
 * flow in desktop main followed over `hostAdd.subscribe`.
 *
 * Main owns the flow — its steps, its questions, its log — and streams it;
 * this only holds the latest view and the log lines, and turns the person's
 * clicks into the tier's calls. A sudo password goes from the field to
 * `hostAdd.sudoPassword` and is never kept here. Leaving a flow that has not
 * finished (Back, Close) cancels it in main, which discards whatever step was
 * in flight.
 */
import * as React from "react";
import type { AddHostAnswer, AddHostLogLine, AddHostStepId, AddHostView } from "@volli/shared";

import type { RemoteHostsApi } from "@renderer/stores/remote-hosts";

/** How many log lines Details keeps (main keeps the same, `ADD_HOST_LOG_LIMIT`). */
export const ADD_HOST_LOG_LINES = 500;

/** A log line with the sequence number it arrived as: its stable key. */
export interface NumberedLogLine {
  readonly seq: number;
  readonly line: AddHostLogLine;
}

export type AddHostPhase =
  | {
      readonly kind: "entry";
      readonly target: string;
      /** Why the last Connect did not start a flow. */
      readonly error: string | null;
      readonly starting: boolean;
    }
  | {
      readonly kind: "flow";
      readonly flowId: string;
      readonly target: string;
      /** `null` until main's first view arrives. */
      readonly view: AddHostView | null;
      readonly log: readonly NumberedLogLine[];
      /** Earlier lines main left out of its replay, or this dropped past {@link ADD_HOST_LOG_LINES}. */
      readonly omitted: number;
      /** The stream ended without the flow finishing. */
      readonly lost: boolean;
      /** A call is in flight: its buttons wait. */
      readonly busy: boolean;
    };

export interface AddHostFlow {
  readonly phase: AddHostPhase;
  setTarget(target: string): void;
  connect(): void;
  answer(answer: AddHostAnswer): void;
  sudoPassword(password: string): void;
  retry(from?: AddHostStepId): void;
  /** Leaves the flow (cancelling it) for the address field, keeping what was typed. */
  back(): void;
  /** Cancels an unfinished flow; the caller closes the sheet. */
  leave(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "That didn’t work.";

/** The id of the question on screen, or `""` (main refuses an answer to none). */
const questionOf = (phase: AddHostPhase): string =>
  phase.kind === "flow" ? (phase.view?.question?.id ?? "") : "";

const finished = (view: AddHostView | null): boolean =>
  view !== null && (view.status === "done" || view.status === "cancelled");

export function useAddHostFlow(
  api: RemoteHostsApi,
  initialTarget: string,
  onError: (message: string) => void,
): AddHostFlow {
  const [phase, setPhase] = React.useState<AddHostPhase>({
    kind: "entry",
    target: initialTarget,
    error: null,
    starting: false,
  });
  const flowId = phase.kind === "flow" ? phase.flowId : null;
  // The latest phase, for the callbacks below without re-binding them.
  const current = React.useRef(phase);
  current.current = phase;

  React.useEffect(() => {
    if (flowId === null) return;
    return api.subscribeAdd(flowId, {
      onEvent(event) {
        setPhase((before) => {
          if (before.kind !== "flow" || before.flowId !== flowId) return before;
          if (event.kind === "view") return { ...before, view: event.view, lost: false };
          if (event.kind === "replay") {
            // A (re)subscription: main's view and the newest of its log, whole.
            const seq = before.log.at(-1)?.seq ?? 0;
            return {
              ...before,
              view: event.view,
              lost: false,
              log: event.log.map((line, index) => ({ seq: seq + index + 1, line })),
              omitted: event.omitted,
            };
          }
          const log = [...before.log, { seq: (before.log.at(-1)?.seq ?? 0) + 1, line: event.line }];
          const over = Math.max(0, log.length - ADD_HOST_LOG_LINES);
          return {
            ...before,
            log: over > 0 ? log.slice(over) : log,
            omitted: before.omitted + over,
          };
        });
      },
      onError() {
        setPhase((before) =>
          before.kind === "flow" && before.flowId === flowId ? { ...before, lost: true } : before,
        );
      },
    });
  }, [api, flowId]);

  /** Runs one call on the flow; its buttons wait for it, and a refusal is said. */
  const call = React.useCallback(
    (run: (id: string) => Promise<unknown>) => {
      const now = current.current;
      if (now.kind !== "flow" || now.busy) return;
      const id = now.flowId;
      const settle = () =>
        setPhase((before) =>
          before.kind === "flow" && before.flowId === id ? { ...before, busy: false } : before,
        );
      setPhase({ ...now, busy: true });
      run(id).then(settle, (error: unknown) => {
        settle();
        onError(messageOf(error));
      });
    },
    [onError],
  );

  /**
   * The start in flight, if any: left (Close, unmount) before main answered,
   * its flow is cancelled the moment the answer lands, never followed.
   */
  const starting = React.useRef<{ abandoned: boolean } | null>(null);

  const cancel = React.useCallback(() => {
    if (starting.current !== null) starting.current.abandoned = true;
    const now = current.current;
    if (now.kind !== "flow" || finished(now.view)) return;
    // Fire and forget: the flow is left either way, and main discards it.
    api.cancelAdd(now.flowId).catch(() => {});
  }, [api]);

  // Leaving by any road, the sheet's body unmounting included (Close, or
  // `cloud` turning off), cancels an unfinished flow and a start in flight.
  React.useEffect(() => cancel, [cancel]);

  return {
    phase,
    setTarget(target) {
      setPhase((before) => (before.kind === "entry" ? { ...before, target, error: null } : before));
    },
    connect() {
      const now = current.current;
      if (now.kind !== "entry" || now.starting) return;
      const target = now.target.trim();
      setPhase({ ...now, starting: true, error: null });
      const attempt = { abandoned: false };
      starting.current = attempt;
      const settled = (): boolean => {
        if (starting.current === attempt) starting.current = null;
        return attempt.abandoned;
      };
      api.startAdd({ target }).then(
        ({ flowId: id }) => {
          if (settled()) {
            // Left while main was starting it: it never reaches the screen.
            api.cancelAdd(id).catch(() => {});
            return;
          }
          setPhase({
            kind: "flow",
            flowId: id,
            target,
            view: null,
            log: [],
            omitted: 0,
            lost: false,
            busy: false,
          });
        },
        (error: unknown) => {
          if (settled()) return;
          setPhase({ kind: "entry", target: now.target, error: messageOf(error), starting: false });
        },
      );
    },
    // Each names the question on screen: one main no longer asks is refused there.
    answer: (reply) => call((id) => api.answerAdd(id, questionOf(current.current), reply)),
    sudoPassword: (password) =>
      call((id) => api.sudoPassword(id, questionOf(current.current), password)),
    retry: (from) => call((id) => api.retryAdd(id, from)),
    back() {
      const now = current.current;
      if (now.kind !== "flow") return;
      cancel();
      setPhase({ kind: "entry", target: now.target, error: null, starting: false });
    },
    leave: cancel,
  };
}
