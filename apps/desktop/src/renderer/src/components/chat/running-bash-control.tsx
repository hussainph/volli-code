import * as React from "react";
import { SHELL_MAX_PER_SESSION } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import { toast } from "sonner";

import { activityDescriptor } from "@volli/session-presentation";
import { Button } from "@renderer/components/ui/button";
import { remoteHostOfSession } from "@renderer/lib/session-project";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";

type RunningBashContextValue = {
  sessionId: string;
  active: boolean;
  register(callId: string, move: () => void): () => void;
};
const RunningBashContext = React.createContext<RunningBashContextValue | null>(null);

/** Focus scopes the shortcut to this Session, including its composer, never a hidden pane. */
export function RunningBashProvider({
  sessionId,
  active,
  children,
}: React.PropsWithChildren<{ sessionId: string; active: boolean }>) {
  const calls = React.useRef(new Map<string, () => void>());
  const register = React.useCallback((callId: string, move: () => void) => {
    calls.current.set(callId, move);
    return () => {
      if (calls.current.get(callId) === move) calls.current.delete(callId);
    };
  }, []);
  const context = React.useMemo(
    () => ({ sessionId, active, register }),
    [sessionId, active, register],
  );
  React.useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !active ||
        event.defaultPrevented ||
        event.repeat ||
        !event.ctrlKey ||
        !event.shiftKey ||
        event.metaKey ||
        event.altKey ||
        event.key.toLowerCase() !== "b"
      )
        return;
      if (
        !(event.target instanceof Element) ||
        event.target
          .closest("[data-running-bash-session]")
          ?.getAttribute("data-running-bash-session") !== sessionId
      )
        return;
      // Pi normally has one foreground call. With several, the newest running row wins.
      const move = [...calls.current.values()].at(-1);
      if (move === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      move();
    };
    document.addEventListener("keydown", shortcut, true);
    return () => document.removeEventListener("keydown", shortcut, true);
  }, [active, sessionId]);
  return (
    <RunningBashContext value={context}>
      <div className="contents" data-running-bash-session={sessionId}>
        {children}
      </div>
    </RunningBashContext>
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The host stamps this only on supported top-level bash progress, never nested calls. */
function backgroundable(part: DynamicToolUIPart): boolean {
  if (part.state !== "output-available" || part.preliminary !== true) return false;
  if (activityDescriptor(part).nativeToolName !== "bash") return false;
  return (
    record(part.output) &&
    record(part.output.details) &&
    part.output.details.backgroundable === true
  );
}

type RunningBashCallValue = {
  toolCallId: string;
  visible: boolean;
  pending: boolean;
  reason: string | null;
  move(): Promise<void>;
};
const RunningBashCallContext = React.createContext<RunningBashCallValue | null>(null);

/** Keep call state and shortcut registration alive outside the bundle's disclosure. */
export function RunningBashCall({
  part,
  children,
}: React.PropsWithChildren<{ part: DynamicToolUIPart }>) {
  const call = React.useContext(RunningBashCallContext);
  if (call?.toolCallId === part.toolCallId || activityDescriptor(part).nativeToolName !== "bash")
    return children;
  return (
    <RunningBashCallOwner key={part.toolCallId} part={part}>
      {children}
    </RunningBashCallOwner>
  );
}

function RunningBashCallOwner({
  part,
  children,
}: React.PropsWithChildren<{ part: DynamicToolUIPart }>) {
  const context = React.useContext(RunningBashContext);
  const live =
    part.state === "output-available" &&
    part.preliminary === true &&
    activityDescriptor(part).nativeToolName === "bash";
  const running = useBackgroundShellsStore((state) =>
    live
      ? Object.values(state.byId).filter(
          (shell) => shell.sessionId === context?.sessionId && shell.state === "running",
        ).length
      : 0,
  );
  const [pending, setPending] = React.useState(false);
  const [moved, setMoved] = React.useState(false);
  const inFlight = React.useRef(false);
  const sessionId = context?.sessionId;
  const remote = sessionId === undefined ? null : remoteHostOfSession(sessionId);
  const reason = !backgroundable(part)
    ? "This command can’t move to the background. Nested commands and Sessions without background-shell support aren’t supported."
    : context === null
      ? "This command isn’t attached to a Session."
      : !context.active
        ? "Activate this Session to move its command to the background."
        : remote !== null
          ? "Moving commands to the background isn’t available on remote hosts yet."
          : running >= SHELL_MAX_PER_SESSION
            ? `This Session already has ${SHELL_MAX_PER_SESSION} running background shells. Stop one first.`
            : null;
  const supported = live && !moved && reason === null;
  const move = React.useCallback(async () => {
    if (!supported || sessionId === undefined || reason !== null || inFlight.current) return;
    // A remote claim must never become a call to This Mac's shell registry.
    if (remoteHostOfSession(sessionId) !== null) {
      toast.error("Moving commands to the background isn’t available on remote hosts yet.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      await sessionRpcClient().shells.moveToBackground.mutate({
        sessionId,
        toolCallId: part.toolCallId,
      });
      setMoved(true);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn’t move command to the background.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [supported, sessionId, reason, part.toolCallId]);
  React.useEffect(() => {
    if (!supported || context === null) return;
    return context.register(part.toolCallId, () => {
      void move();
    });
  }, [context, supported, reason, part.toolCallId, move]);
  const value = React.useMemo(
    () => ({ toolCallId: part.toolCallId, visible: live && !moved, pending, reason, move }),
    [part.toolCallId, live, moved, pending, reason, move],
  );
  return <RunningBashCallContext value={value}>{children}</RunningBashCallContext>;
}

export function RunningBashControl({ part }: { part: DynamicToolUIPart }) {
  return (
    <RunningBashCall part={part}>
      <RunningBashButton />
    </RunningBashCall>
  );
}

/** A blocked state stays readable without hovering a disabled control. */
export function RunningBashReason() {
  const call = React.useContext(RunningBashCallContext);
  if (call === null || !call.visible || call.reason === null) return null;
  return (
    <p className="py-1 text-label text-muted-foreground whitespace-pre-wrap break-words">
      {call.reason}
    </p>
  );
}

function RunningBashButton() {
  const call = React.useContext(RunningBashCallContext);
  if (call === null || !call.visible) return null;
  const { pending, reason, move } = call;
  return (
    <span
      className="shrink-0"
      title={reason ?? "Move to background (Ctrl+Shift+B)"}
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={pending || reason !== null}
        aria-description={reason ?? undefined}
        aria-keyshortcuts="Control+Shift+B"
        onClick={() => void move()}
      >
        {pending ? "Moving…" : "Move to background"}
      </Button>
    </span>
  );
}
