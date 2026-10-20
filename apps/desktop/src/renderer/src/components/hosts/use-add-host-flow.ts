/**
 * The Add-a-host sheet's state (VC-700 PR 3): the address field, then one
 * flow in desktop main followed over `hostAdd.subscribe`.
 *
 * Main owns the flow — its steps, its questions, its log — and streams it;
 * this only holds the latest view, what the flow has found (read with
 * `hostAdd.facts` on each view) and the log lines, and turns the person's
 * clicks into the tier's calls. A sudo password goes from the field to
 * `hostAdd.sudoPassword` and is never kept here. Closing the sheet only
 * detaches its UI. The hook lives in the sheet owner, not its visible body;
 * only explicit Cancel or Back cancels in main.
 */
import * as React from "react";
import type {
  ActiveAddHost,
  AddHostAnswer,
  AddHostFacts,
  AddHostLogLine,
  AddHostStepId,
  AddHostView,
} from "@volli/shared";

import type { RemoteHostsApi } from "@renderer/stores/remote-hosts";

import { NO_FACTS } from "./add-host-model";

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
      /** What the flow has found, as main last answered: {@link NO_FACTS} until then. */
      readonly facts: AddHostFacts;
      readonly log: readonly NumberedLogLine[];
      /** Earlier lines main left out of its replay, or this dropped past {@link ADD_HOST_LOG_LINES}. */
      readonly omitted: number;
      /** The stream ended without the flow finishing. */
      readonly lost: boolean;
      /** A step-driving call is in flight: repeated answers/retries wait, Cancel does not. */
      readonly busy: boolean;
      /** Cancellation preempts a pending step-driving RPC. */
      readonly cancelling: boolean;
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
  /** Only a still-current successful cancellation may invoke the close callback. */
  leave(onCancelled?: () => void): Promise<void>;
  /** Clears only a terminal flow when the sheet closes. */
  resetFinished(): void;
  /** Reopen: resubscribe a lost observer or discover main's active reference, never start an install. */
  reattach(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "That didn’t work.";

/** The id of the question on screen, or `""` (main refuses an answer to none). */
const questionOf = (phase: AddHostPhase): string =>
  phase.kind === "flow" ? (phase.view?.question?.id ?? "") : "";

const finished = (view: AddHostView | null): boolean =>
  view !== null && (view.status === "done" || view.status === "cancelled");

function followingFlow(flowId: string, target: string): AddHostPhase {
  return {
    kind: "flow",
    flowId,
    target,
    view: null,
    facts: NO_FACTS,
    log: [],
    omitted: 0,
    lost: false,
    busy: false,
    cancelling: false,
  };
}

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
  const [subscriptionGeneration, resubscribe] = React.useState(0);
  const flowId = phase.kind === "flow" ? phase.flowId : null;
  // The latest phase, for the callbacks below without re-binding them.
  const current = React.useRef(phase);
  current.current = phase;

  React.useEffect(() => {
    if (flowId === null) return;
    // The newest read of the flow's facts wins; one left behind, or refused
    // (a finished flow let go), changes nothing.
    let asked = 0;
    let following = true;
    const readFacts = () => {
      const ask = ++asked;
      api.addFacts(flowId).then(
        (facts) => {
          if (!following || ask !== asked) return;
          setPhase((before) =>
            before.kind === "flow" && before.flowId === flowId ? { ...before, facts } : before,
          );
        },
        () => {},
      );
    };
    const unsubscribe = api.subscribeAdd(flowId, {
      onEvent(event) {
        if (!following) return;
        // A view (or a replay) may follow a step that found something.
        if (event.kind !== "log") readFacts();
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
        if (!following) return;
        setPhase((before) =>
          before.kind === "flow" && before.flowId === flowId ? { ...before, lost: true } : before,
        );
      },
    });
    return () => {
      following = false;
      unsubscribe();
    };
  }, [api, flowId, subscriptionGeneration]);

  // Unmount releases local observation, never the install owned by main.
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // One intent generation: cancellation supersedes a step RPC; replacing or
  // clearing a flow supersedes both. Even same-id late replies cannot settle
  // a newer operation. The ref also guards double clicks before React renders.
  const operation = React.useRef(0);
  const pending = React.useRef<"step" | "cancel" | "start" | null>(null);
  const owns = React.useCallback(
    (id: string, generation: number): boolean =>
      mounted.current &&
      operation.current === generation &&
      current.current.kind === "flow" &&
      current.current.flowId === id,
    [],
  );

  const call = React.useCallback(
    (run: (id: string) => Promise<unknown>) => {
      const now = current.current;
      if (now.kind !== "flow" || pending.current !== null) return;
      const id = now.flowId;
      const generation = ++operation.current;
      pending.current = "step";
      setPhase((before) =>
        before.kind === "flow" && before.flowId === id ? { ...before, busy: true } : before,
      );
      const settle = (error?: unknown) => {
        if (!owns(id, generation)) return;
        pending.current = null;
        setPhase((before) =>
          before.kind === "flow" && before.flowId === id ? { ...before, busy: false } : before,
        );
        if (error !== undefined) onError(messageOf(error));
      };
      run(id).then(
        () => settle(),
        (error: unknown) => settle(error),
      );
    },
    [onError, owns],
  );

  const cancel = async (onCancelled?: () => void): Promise<void> => {
    const now = current.current;
    if (now.kind !== "flow" || pending.current === "cancel") return;
    const id = now.flowId;
    const generation = ++operation.current;
    pending.current = "cancel";
    setPhase((before) =>
      before.kind === "flow" && before.flowId === id
        ? { ...before, busy: false, cancelling: true }
        : before,
    );
    try {
      if (!finished(now.view)) await api.cancelAdd(id);
      if (!owns(id, generation)) return;
      pending.current = null;
      // Close synchronously inside the identity guard, not in an old Actions
      // promise callback which could close a replacement flow's sheet.
      onCancelled?.();
      setPhase({ kind: "entry", target: now.target, error: null, starting: false });
    } catch (error) {
      if (!owns(id, generation)) return;
      pending.current = null;
      setPhase((before) =>
        before.kind === "flow" && before.flowId === id ? { ...before, cancelling: false } : before,
      );
      onError(messageOf(error));
    }
  };

  const discovery = React.useRef(0);
  const discover = React.useCallback(() => {
    const now = current.current;
    if (now.kind !== "entry" || pending.current !== null) return;
    const read = ++discovery.current;
    const generation = operation.current;
    const valid = () =>
      mounted.current &&
      read === discovery.current &&
      operation.current === generation &&
      current.current.kind === "entry";
    api.activeAdds().then(
      (flows) => {
        if (!valid()) return;
        const active: ActiveAddHost | undefined = flows[0];
        if (active === undefined) return;
        ++operation.current;
        setPhase(followingFlow(active.flowId, active.target));
      },
      (error: unknown) => {
        if (!valid()) return;
        setPhase((before) =>
          before.kind === "entry" ? { ...before, error: messageOf(error) } : before,
        );
      },
    );
  }, [api]);
  // Main, not this React owner, is the recoverable index after window close,
  // navigation/reload or cloud off/on. One bounded read; no polling or starts.
  React.useEffect(() => {
    discover();
  }, [discover]);

  return {
    phase,
    setTarget: React.useCallback((target: string) => {
      setPhase((before) =>
        before.kind === "entry" && before.target !== target
          ? { ...before, target, error: null }
          : before,
      );
    }, []),
    connect() {
      const now = current.current;
      if (now.kind !== "entry" || now.starting || pending.current !== null) return;
      const target = now.target.trim();
      const generation = ++operation.current;
      pending.current = "start";
      setPhase({ ...now, starting: true, error: null });
      api.startAdd({ target }).then(
        ({ flowId: id }) => {
          if (!mounted.current || operation.current !== generation) return;
          pending.current = null;
          setPhase(followingFlow(id, target));
        },
        (error: unknown) => {
          if (!mounted.current || operation.current !== generation) return;
          pending.current = null;
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
      void cancel();
    },
    leave: cancel,
    reattach: React.useCallback(() => {
      const now = current.current;
      if (now.kind === "flow" && now.lost) resubscribe((generation) => generation + 1);
      else if (now.kind === "entry") discover();
    }, [discover]),
    resetFinished: React.useCallback(() => {
      const now = current.current;
      if (now.kind === "flow" && finished(now.view)) {
        ++operation.current;
        pending.current = null;
        setPhase({ kind: "entry", target: "", error: null, starting: false });
      }
    }, []),
  };
}
