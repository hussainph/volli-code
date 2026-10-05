import { appendFileSync } from "node:fs";

/** Smoke-only, synchronous breadcrumbs survive a blocked native app.exit. */
export function traceShutdown(stage: string): void {
  const path = process.env["VOLLI_SHUTDOWN_TRACE_FILE"];
  if (!path) return;
  try {
    appendFileSync(
      path,
      `${JSON.stringify({ at: Date.now(), pid: process.pid, stage, resources: process.getActiveResourcesInfo() })}\n`,
    );
  } catch (error) {
    console.error("[volli] failed to write shutdown trace:", error);
  }
}

export function registerShutdownTrace(lifecycle: {
  on(event: "before-quit" | "will-quit" | "quit", listener: () => void): void;
  quit(): void;
}): void {
  if (!process.env["VOLLI_SHUTDOWN_TRACE_FILE"]) return;
  const quit = lifecycle.quit;
  lifecycle.quit = () => {
    traceShutdown("app-quit-invoked");
    quit.call(lifecycle);
    traceShutdown("app-quit-returned");
  };
  for (const event of ["before-quit", "will-quit", "quit"] as const) {
    lifecycle.on(event, () => traceShutdown(event));
  }
  process.on("exit", () => traceShutdown("process-exit"));
}
