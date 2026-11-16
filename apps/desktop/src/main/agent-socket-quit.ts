import type { ShutdownAgentSocket } from "@volli/host-core/agents";
import { settleShutdownBeforeDeadline } from "@volli/host-core/maintenance";

interface AgentSocketAppLifecycle {
  on(event: "will-quit", listener: (event: { preventDefault(): void }) => void): void;
  exit(code: number): void;
}

/** Lets a normal Electron will-quit wait for the same bounded socket shutdown. */
export function registerAgentSocketWillQuit(options: {
  lifecycle: AgentSocketAppLifecycle;
  shutdownAgentSocket: ShutdownAgentSocket;
  shutdownDeadlineMs?: number;
  reportFailure(error: unknown): void;
  /** The quit's timeline in the log (VC-1208): this is early startup's accepted quit. */
  timeline?: {
    accepted(): void;
    drained(deadlineExpired: boolean): void;
  };
}): void {
  let shutdownStarted = false;
  options.lifecycle.on("will-quit", (event) => {
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    options.timeline?.accepted();
    let deadlineExpired = false;
    // Early startup's socket-only fallback needs the same native-exit entry
    // boundary as the accepted-quit coordinator (VC-536), not a Promise
    // checkpoint. Keep the Immediate referenced; native exit remains unbounded.
    const exitAfterCheckpoint = () => {
      options.timeline?.drained(deadlineExpired);
      setImmediate(() => options.lifecycle.exit(0));
    };
    void settleShutdownBeforeDeadline({
      shutdowns: [options.shutdownAgentSocket],
      deadlineMs: options.shutdownDeadlineMs,
      reportFailure: options.reportFailure,
      onDeadline: () => {
        deadlineExpired = true;
      },
    }).then(exitAfterCheckpoint, exitAfterCheckpoint);
  });
}
