/**
 * A background shell's tail, read-only (VC-270): what `openShell` opens.
 *
 * A plain `<pre>`, deliberately not a `TerminalEngine`. `terminal/registry.ts`
 * keys engines by Session id and each one is a restty canvas counted against
 * a GPU-pressure budget, so an engine per shell would both collide with the
 * Session's real terminal and eat that budget — and VC-107 is replacing the
 * backend anyway. A read-only tail needs no terminal emulator: monospace,
 * the host's retained bytes, and a scroll that follows the bottom until the
 * person scrolls up.
 *
 * The output is READ, not pushed. Main's push carries a shell's chrome only;
 * this view asks for the tail on mount and, while the shell runs, on a
 * short interval — then once more after the exit, so the last lines land.
 * Only an open view pays for output, which is the whole reason the store
 * holds none.
 */

import * as React from "react";

import { errorMessage, shellCommandLine, shellStanding } from "@volli/shared";

import type { BackgroundShellState } from "../../../../ipc/contract";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useBackgroundShellsStore, type ShellsApi } from "@renderer/stores/background-shells";

/** How often a running shell's tail is re-read while its view is open. */
export const SHELL_OUTPUT_POLL_MS = 500;

/** Within this many pixels of the bottom counts as "following". */
const FOLLOW_SLACK_PX = 8;

export interface ShellOutputViewProps {
  shellId: string;
  /** Injected for tests; production passes `window.api.shells`. */
  api: Pick<ShellsApi, "tail">;
  className?: string;
}

export function ShellOutputView({ shellId, api, className }: ShellOutputViewProps) {
  const live = useBackgroundShellsStore((state) => state.byId[shellId]);
  const [tail, setTail] = React.useState<{ output: string; shell: BackgroundShellState } | null>(
    null,
  );
  const [gone, setGone] = React.useState(false);
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const following = React.useRef(true);

  // The chrome the store knows is fresher than the chrome a tail read
  // carried; prefer it, and fall back to the read's for a forgotten shell.
  const shell = live ?? tail?.shell ?? null;
  const running = shell?.state === "running";

  const read = React.useCallback(async () => {
    try {
      const result = await api.tail({ shellId });
      if (!result.ok) {
        setGone(true);
        return;
      }
      setTail({ output: result.output, shell: result.shell });
    } catch (error) {
      toastError(`Could not read the shell's output: ${errorMessage(error)}`);
    }
  }, [api, shellId]);

  // Mount, then every interval while running; a state change re-runs this
  // effect, so the exit's final read happens on the transition itself.
  React.useEffect(() => {
    void read();
    if (!running) return;
    const timer = window.setInterval(() => void read(), SHELL_OUTPUT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [read, running]);

  // Follow the bottom unless the person scrolled away from it.
  React.useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null || !following.current) return;
    node.scrollTop = node.scrollHeight;
  }, [tail?.output]);

  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-shell-output={shellId}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-ui">
        <span className="min-w-0 truncate font-mono text-foreground">
          {shell === null ? shellId : (shell.title ?? shellCommandLine(shell.command))}
        </span>
        <span className="shrink-0 text-muted-foreground" data-shell-standing>
          {gone ? "gone" : shell === null ? "…" : shellStanding(shell)}
        </span>
      </div>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
        <pre
          className="m-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-ui text-foreground"
          aria-live="off"
          aria-readonly="true"
        >
          {gone
            ? "This background shell is gone: its Session's attachment ended."
            : (tail?.output ?? "")}
        </pre>
      </div>
    </div>
  );
}
