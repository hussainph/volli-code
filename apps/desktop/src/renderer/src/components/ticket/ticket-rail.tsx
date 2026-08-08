/**
 * Ticket detail right rail — icon-mode navigator shell (decision #46).
 *
 * A thin vertical mode strip switches which index the rail shows. Changing
 * mode never opens or steals a main-view tab; only deliberate list selection
 * (Sessions row / Files row / Changes row) does, via the callbacks the host
 * wires into each mode's content.
 *
 * Mode-content seam for follow-on navigators:
 *   - Pass `filesContent` / `changesContent` to replace the empty placeholders.
 *   - On row select, call the host's open/focus helpers — typically
 *     `useWorkspaceStore.getState().previewTicketFile(projectId, ticketId, relPath)`
 *     (click) / `pinTicketFile` (dblclick) for Files and `openTicketDiff` for
 *     Changes. Sessions already call `onActivateSession(sessionId)` →
 *     `setTicketActiveTab`.
 *   - Do NOT call those openers from agent/filesystem event handlers.
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import type { Ticket } from "@volli/shared";

import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import {
  TICKET_RAIL_MODE_LABELS,
  availableRailModes,
  resolveRailMode,
  selectRailMode,
  type TicketRailMode,
} from "@renderer/components/ticket/ticket-rail-model";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

const MODE_ICONS: Record<TicketRailMode, PhosphorIcon> = {
  sessions: TerminalWindowIcon,
  files: FoldersIcon,
  changes: GitDiffIcon,
  properties: SlidersHorizontalIcon,
};

/** Compact vertical icon strip — presentational; mode state lives in the UI store. */
export function TicketRailModeStrip({
  mode,
  modes,
  onSelectMode,
}: {
  mode: TicketRailMode;
  /** Which modes this surface offers — see `availableRailModes`. */
  modes: readonly TicketRailMode[];
  onSelectMode(mode: TicketRailMode): void;
}) {
  return (
    <nav
      aria-label="Ticket rail modes"
      className="flex shrink-0 flex-col items-center gap-0.5 border-l border-sidebar-border py-2"
    >
      {modes.map((key) => {
        const Icon = MODE_ICONS[key];
        const label = TICKET_RAIL_MODE_LABELS[key];
        const active = mode === key;
        return (
          <Button
            key={key}
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-pressed={active}
            title={label}
            data-testid={`ticket-rail-mode-${key}`}
            onClick={() => onSelectMode(key)}
            className={cn(
              "rounded-md text-muted-foreground",
              active &&
                "bg-primary/15 text-primary ring-1 ring-inset ring-primary/40 hover:bg-primary/20 hover:text-primary",
            )}
          >
            <Icon weight="fill" className="size-3.5" />
          </Button>
        );
      })}
    </nav>
  );
}

function RailModePlaceholder({ label }: { label: string }) {
  return (
    <div
      data-testid={`ticket-rail-placeholder-${label.toLowerCase()}`}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center"
    >
      <p className="text-ui font-medium text-muted-foreground">{label}</p>
      <p className="text-xs text-muted-foreground/80">Nothing here yet</p>
    </div>
  );
}

export function TicketRail({
  projectId,
  ticket,
  creating,
  onNewSession,
  onNewChat,
  onActivateSession,
  onActivateChat,
  activeTabId,
  filesContent,
  changesContent,
}: {
  projectId: string;
  ticket: Ticket;
  creating: boolean;
  onNewSession(): void;
  onNewChat(): void;
  /** Focus (or open) a session tab in the main strip — deliberate selection only. */
  onActivateSession(sessionId: string): void;
  /** Open (adopting first, if nothing is attached) a chat Session's tab. */
  onActivateChat(sessionId: string): void;
  /**
   * The main strip's active tab. The rail never changes it — it is threaded in
   * so mode switches run through {@link selectRailMode} on the live path (see
   * `onSelectMode`), not only in tests.
   */
  activeTabId: string;
  /**
   * Optional Files navigator. When omitted, a quiet placeholder renders so the
   * shell stays usable until the Files agent lands.
   */
  filesContent?: React.ReactNode;
  /** Optional Changes navigator — same seam as `filesContent`. */
  changesContent?: React.ReactNode;
}) {
  const storedMode = useUiStore((state) => state.railMode);
  const setRailMode = useUiStore((state) => state.setRailMode);
  const chrome = { mode: storedMode, activeTabId };
  const mode = resolveRailMode(chrome);
  const modes = availableRailModes();

  // Decision #46: switching navigator must not open, close, or retarget a
  // main-view tab. The chrome transition is computed by the pure contract and
  // only its `mode` is committed, so the store has no path by which a mode
  // click could reach the tab strip — and the rule the tests assert is the same
  // code the app runs, rather than a parallel description of it.
  const onSelectMode = React.useCallback(
    (next: TicketRailMode) => {
      setRailMode(selectRailMode({ mode, activeTabId }, next).mode);
    },
    [mode, activeTabId, setRailMode],
  );

  return (
    <div className="flex min-h-0 flex-1" data-testid="ticket-rail">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {mode === "sessions" ? (
          <TicketSessionsPanel
            ticketId={ticket.id}
            creating={creating}
            onNewSession={onNewSession}
            onNewChat={onNewChat}
            onActivateSession={onActivateSession}
            onActivateChat={onActivateChat}
          />
        ) : null}
        {mode === "files" ? (filesContent ?? <RailModePlaceholder label="Files" />) : null}
        {mode === "changes" ? (changesContent ?? <RailModePlaceholder label="Changes" />) : null}
        {mode === "properties" ? (
          <div
            data-testid="ticket-rail-properties"
            className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
          >
            <TicketProperties projectId={projectId} ticket={ticket} />
          </div>
        ) : null}
      </div>
      <TicketRailModeStrip mode={mode} modes={modes} onSelectMode={onSelectMode} />
    </div>
  );
}
