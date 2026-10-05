import type { ShutdownAgentSocket } from "@volli/host-core/agent-socket";
import { settleShutdownBeforeDeadline } from "@volli/host-core/shutdown-deadline";
import { traceShutdown } from "./shutdown-trace";

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
}): void {
  let shutdownStarted = false;
  options.lifecycle.on("will-quit", (event) => {
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    traceShutdown("socket-drain-started");
    // Early startup's socket-only fallback needs the same native-exit entry
    // boundary as the accepted-quit coordinator (VC-536), not a Promise
    // checkpoint. Keep the Immediate referenced; native exit remains unbounded.
    const exitAfterCheckpoint = () => {
      traceShutdown("socket-drain-settled");
      setImmediate(() => {
        traceShutdown("native-exit-started");
        options.lifecycle.exit(0);
        traceShutdown("native-exit-returned");
      });
    };
    void settleShutdownBeforeDeadline({
      shutdowns: [options.shutdownAgentSocket],
      deadlineMs: options.shutdownDeadlineMs,
      reportFailure: options.reportFailure,
    }).then(exitAfterCheckpoint, exitAfterCheckpoint);
  });
}
