/**
 * One background shell as the renderer sees it: the host's whole snapshot of a
 * live or finished shell. Produced by host-core's background-shell host
 * (`shell/background-shell-host.ts`); a client's IPC contract carries it, so
 * it lives here, where a client can name it without depending on host-core.
 */
export interface BackgroundShellState {
  /** Host-minted opaque id, never a pid. */
  shellId: string;
  sessionId: string;
  projectId: string;
  ticketId: string | null;
  /** The command as the model gave it; the island shows its first line. */
  command: string;
  title: string | null;
  state: "running" | "exited";
  /** Exit code once exited; `null` while running and when a signal ended it. */
  code: number | null;
  signal: string | null;
  startedAt: number;
  exitedAt: number | null;
  pid: number;
}
