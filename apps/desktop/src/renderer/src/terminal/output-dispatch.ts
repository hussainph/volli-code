/**
 * PTY output into an engine, and the flow-control ack back out (VC-821).
 *
 * The host pauses a PTY once too many delivered characters are unacked and
 * resumes it when acks bring the count back down (`packages/host-core/src/pty/
 * output.ts`). That only works if an ack means "consumed". xterm's `write` is
 * asynchronous — it queues the chunk and parses it in time slices — so acking
 * on IPC receipt kept the host's count near zero while xterm's queue grew
 * without bound, and xterm eventually threw past its 50M-char discard mark. The
 * throw landed before the ack, so that chunk's credit was never returned and
 * the PTY stayed paused for good.
 *
 * Two rules, then: ack when the engine releases the chunk (`onParsed`), and
 * ack exactly once per delivered batch no matter how the write ends — a lost
 * ack is a frozen terminal.
 *
 * Pure (the engine and the ack door are passed in) so main's flow-control
 * tests can drive the real IPC adapter through it.
 */
import type { TerminalDataEvent } from "@volli/shared";

import type { TerminalEngine } from "./engine";

export function deliverTerminalOutput(
  event: TerminalDataEvent,
  engine: TerminalEngine | undefined,
  ack: (sessionId: string, chars: number) => void,
): void {
  let acked = false;
  const release = (): void => {
    if (acked) return;
    acked = true;
    ack(event.sessionId, event.data.length);
  };
  // No engine: the session is closing (or never had a view) — nothing will
  // ever parse this chunk, so its credit goes straight back.
  if (engine === undefined) {
    release();
    return;
  }
  try {
    engine.write(event.data, release);
  } catch (error) {
    release();
    console.error("terminal output dropped:", error);
  }
}
