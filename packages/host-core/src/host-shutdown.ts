import type { Logger } from "./log/logger";
import { closeAllMcpSessionHosts } from "./mcp/session-host";

/** Host drain only. Quit gates, window teardown and app.exit stay in desktop. */
export async function shutdownNativeSessions(options: {
  sessionWatchdog: { stop(): void } | null;
  scheduledResumeHost: { stop(): void } | null;
  shellHostNotices: { close(): void } | null;
  sessionRpc: { close(): Promise<void> } | null;
  sessionRuntime: { close(): Promise<void> } | null;
  agentObservability: { shutdown(): Promise<void> } | null;
  log: Pick<Logger, "error">;
}): Promise<void> {
  options.sessionWatchdog?.stop();
  options.scheduledResumeHost?.stop();
  options.shellHostNotices?.close();
  const results = await Promise.allSettled([
    options.sessionRpc?.close(),
    options.sessionRuntime?.close(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      options.log.error("failed to close native session rpc", { error: result.reason });
    }
  }
  // Every Session has closed, and with it every MCP host it owned. This is
  // the backstop for one whose own close never ran: a stdio server's whole
  // process group goes with it, so a quit leaves no `npx`/`uvx` child.
  await closeAllMcpSessionHosts();
  // The one flush, and it is here rather than anywhere else because this is
  // the only point at which every Session has stopped producing events.
  // Bounded inside the owner, so a collector that has stopped answering
  // delays the quit by a couple of seconds instead of holding it.
  await options.agentObservability?.shutdown();
}
