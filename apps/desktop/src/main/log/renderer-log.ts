/**
 * The renderer's lines in main's log (VC-699): `volli:renderer-log`.
 *
 * A window's warnings and errors (and, once a host link lives in it, the
 * link's state changes) arrive here and are written by main's logger as
 * component `renderer:<area>`, with the window's trace when it sent one. The
 * channel is client-local: nothing on it ever reaches a host.
 *
 * A window cannot flood the log: each may send {@link RENDERER_LOG_BUDGET}
 * lines a window of time; past that, lines are counted, and the next line
 * after the window turns says how many were dropped.
 */
import { hostLogger, withLogContext } from "@volli/host-core/log";
import { readRendererLogEntry } from "@volli/shared";

/** Lines one renderer may send per `windowMs`. */
export const RENDERER_LOG_BUDGET = Object.freeze({ lines: 200, windowMs: 10_000 });

interface Budget {
  windowStart: number;
  used: number;
  dropped: number;
}

/** What a sender is: its id, to keep one window's budget from another's. */
interface Sender {
  readonly id: number;
}

/** Writes one renderer entry, or counts it against the sender's budget. Exported for its tests. */
export function createRendererLogWriter(
  now: () => number = Date.now,
): (sender: Sender, value: unknown) => void {
  const budgets = new Map<number, Budget>();
  const log = hostLogger("renderer");
  return (sender, value) => {
    const entry = readRendererLogEntry(value);
    if (entry === null) return;
    const at = now();
    let budget = budgets.get(sender.id);
    if (budget === undefined || at - budget.windowStart >= RENDERER_LOG_BUDGET.windowMs) {
      const dropped = budget?.dropped ?? 0;
      budget = { windowStart: at, used: 0, dropped: 0 };
      budgets.set(sender.id, budget);
      if (dropped > 0) log.warn("renderer log lines dropped", { window: sender.id, dropped });
    }
    if (budget.used >= RENDERER_LOG_BUDGET.lines) {
      budget.dropped += 1;
      return;
    }
    budget.used += 1;
    const area = log.child({ component: `renderer:${entry.area}`, window: sender.id });
    const write = () => area[entry.level](entry.msg, entry.fields);
    if (entry.traceId === undefined) write();
    else withLogContext({ traceId: entry.traceId }, write);
  };
}

/** Listens on `volli:renderer-log`. */
export function registerRendererLogForwarding(ipc: {
  on(
    channel: "volli:renderer-log",
    listener: (event: { sender: Sender }, entry: unknown) => void,
  ): unknown;
}): void {
  const write = createRendererLogWriter();
  ipc.on("volli:renderer-log", (event, entry) => write(event.sender, entry));
}
