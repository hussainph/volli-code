/**
 * A scripted flow: an async function that narrates a backend that does not
 * exist. It waits, reports, and — when the flow needs a person — asks, then
 * resumes with the answer. That shape keeps a whole multi-step install
 * readable as one top-to-bottom story instead of a reducer of timers, and makes
 * every failure state reachable by running the same script with a different
 * outcome.
 *
 * Lab-only. This is not a model of how hostd install works; it is a stage
 * manager for the UI that will one day watch it.
 */
import * as React from "react";

export class ScriptAborted extends Error {
  constructor() {
    super("script aborted");
  }
}

export interface ScriptIo<State, Ask, Answer> {
  /** Pause for `ms` (scaled by the lab speed). Throws when the run is replaced. */
  wait(ms: number): Promise<void>;
  update(patch: (state: State) => State): void;
  /** Park the flow on a question and resume with the person's answer. */
  ask(question: Ask): Promise<Answer>;
  /** Animate a 0→1 fraction over `ms`, reporting each frame-ish tick. */
  tween(ms: number, onTick: (fraction: number) => void): Promise<void>;
}

export interface Script<State, Ask, Answer> {
  state: State;
  question: Ask | null;
  answer(value: Answer): void;
  restart(): void;
}

export function useScript<State, Ask, Answer>(
  initial: () => State,
  run: (io: ScriptIo<State, Ask, Answer>) => Promise<void>,
  options: { speed: number; key: string; autostart?: boolean },
): Script<State, Ask, Answer> {
  const [state, setState] = React.useState(initial);
  const [question, setQuestion] = React.useState<Ask | null>(null);
  const [generation, setGeneration] = React.useState(0);
  const speed = React.useRef(options.speed);
  speed.current = options.speed;
  const resolver = React.useRef<((value: Answer) => void) | null>(null);
  const runRef = React.useRef(run);
  runRef.current = run;
  const initialRef = React.useRef(initial);
  initialRef.current = initial;

  React.useEffect(() => {
    if (options.autostart === false && generation === 0) return;
    let aborted = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    setState(initialRef.current());
    setQuestion(null);

    const guard = () => {
      if (aborted) throw new ScriptAborted();
    };
    const io: ScriptIo<State, Ask, Answer> = {
      wait: (ms) =>
        new Promise<void>((resolve, reject) => {
          const id = setTimeout(
            () => {
              timers.delete(id);
              if (aborted) reject(new ScriptAborted());
              else resolve();
            },
            Math.max(0, ms / speed.current),
          );
          timers.add(id);
        }),
      update: (patch) => {
        guard();
        setState(patch);
      },
      ask: (value) =>
        new Promise<Answer>((resolve, reject) => {
          if (aborted) {
            reject(new ScriptAborted());
            return;
          }
          resolver.current = (answer) => {
            resolver.current = null;
            setQuestion(null);
            if (aborted) reject(new ScriptAborted());
            else resolve(answer);
          };
          setQuestion(() => value);
        }),
      tween: async (ms, onTick) => {
        const steps = Math.max(1, Math.round(ms / 80));
        for (let index = 1; index <= steps; index += 1) {
          await io.wait(ms / steps);
          guard();
          onTick(index / steps);
        }
      },
    };

    runRef.current(io).catch((error: unknown) => {
      if (!(error instanceof ScriptAborted)) console.error(error);
    });
    return () => {
      aborted = true;
      for (const id of timers) clearTimeout(id);
      resolver.current = null;
    };
    // The key restarts the story (a new outcome, a new host); generation
    // restarts it in place (Replay).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.key, generation]);

  return {
    state,
    question,
    answer: (value) => resolver.current?.(value),
    restart: () => setGeneration((value) => value + 1),
  };
}
