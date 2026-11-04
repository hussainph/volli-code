import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ColumnsPlusRightIcon } from "@phosphor-icons/react/dist/csr/ColumnsPlusRight";
import { CornersOutIcon } from "@phosphor-icons/react/dist/csr/CornersOut";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { PlusCircleIcon } from "@phosphor-icons/react/dist/csr/PlusCircle";
import { RowsPlusBottomIcon } from "@phosphor-icons/react/dist/csr/RowsPlusBottom";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import type { SessionListingRow, SessionRecord } from "@volli/shared";

import { TerminalView } from "@renderer/components/sessions/terminal-view";
import { SplitViewDivider } from "@renderer/components/split/split-view-divider";
import { PaneHeader } from "@renderer/components/ui/pane-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { canResumeSession } from "@renderer/components/ticket/session-history";
import { useTerminalFocusTarget } from "@renderer/hooks/use-terminal-focus-target";
import { cn } from "@renderer/lib/utils";
import type { SessionLayout, SessionTab, TerminalSplitDirection } from "@renderer/stores/sessions";
import { launchAdapter, sessionPanes, TERMINAL_SPLIT_RATIO_RANGE } from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { getEngine } from "@renderer/terminal/registry";

/** No terminal pane is squeezed below this — a prompt and a few columns. */
const TERMINAL_MIN_PANE_PX = 96;

interface SessionSplitLayoutProps {
  /** The unified store owner key (projectId for scratch, ticketId for ticket). */
  ownerId: string;
  tab: SessionTab;
  visible: boolean;
  onActivate(sessionId: string): void;
  onSplit(sessionId: string, direction: TerminalSplitDirection): void;
  onClose(sessionId: string): void;
  onResize(splitId: string, ratio: number): void;
  /**
   * Boots a resumed session for an exited, resumable ticket pane
   * (interrupt/resume, issue #78). Absent for the scratch surface — resume is
   * ticket-only, so scratch panes never show the affordance.
   */
  onResume?(sessionId: string): void;
}

/** Recursive app-owned split tree. Each leaf is one TerminalView/engine/PTY. */
export function SessionSplitLayout({
  ownerId,
  tab,
  visible,
  onActivate,
  onSplit,
  onClose,
  onResize,
  onResume,
}: SessionSplitLayoutProps) {
  const isSplit = sessionPanes(tab.layout).length > 1;
  // The ticket's Session listing rows (stores/ticket-session-records.ts) — the
  // ONE shared cache also fed by the rail and SessionsLayer's exit handler, so
  // an exited pane's resumability shows up here without a second
  // `listForTicket` fetch. `byTicket` is keyed by ticketId only, so this is a
  // no-op lookup (undefined) for the scratch surface. Every pane here is a PTY,
  // so only terminal rows can ever answer a lookup by pane id.
  const rows = useTicketSessionRecordsStore((state) => state.byTicket[ownerId]);
  const recordsById = React.useMemo(() => {
    if (rows === undefined) return null;
    return new Map<string, SessionRecord>(
      rows
        .filter(
          (row): row is Extract<SessionListingRow, { kind: "terminal" }> => row.kind === "terminal",
        )
        .map((row) => [row.record.id, row.record]),
    );
  }, [rows]);

  return (
    <div className={cn("group/focus absolute inset-0 min-h-0 min-w-0", !visible && "hidden")}>
      <SplitNode
        ownerId={ownerId}
        tabId={tab.sessionId}
        title={tab.title}
        layout={tab.layout}
        visible={visible}
        activePaneId={tab.activePaneId}
        isSplit={isSplit}
        onActivate={onActivate}
        onSplit={onSplit}
        onClose={onClose}
        onResize={onResize}
        onResume={onResume}
        recordsById={recordsById}
      />
    </div>
  );
}

/** Terminal focus stays on the active pane's header, never over scrollback.
 * Hidden tabs pay no focus-target subscriptions. The existing shortcut and
 * persistent zen exit remain unchanged.
 */
function PaneFocusControl({ sessionId }: { sessionId: string }) {
  const target = useTerminalFocusTarget();
  const focused = useUiStore((state) => state.terminalFocusTarget !== null);
  if (focused || target === null || target.sessionId !== sessionId) return null;

  return (
    <Button
      type="button"
      variant="toolbar"
      size="icon-xs"
      onClick={() => useUiStore.getState().setTerminalFocusTarget(target)}
      aria-label="Enter terminal focus"
      title="Enter terminal focus (⌥⌘⏎)"
      aria-keyshortcuts="Alt+Meta+Enter"
    >
      <CornersOutIcon />
    </Button>
  );
}

interface SplitNodeProps {
  ownerId: string;
  tabId: string;
  title: string;
  layout: SessionLayout;
  visible: boolean;
  activePaneId: string;
  isSplit: boolean;
  onActivate(sessionId: string): void;
  onSplit(sessionId: string, direction: TerminalSplitDirection): void;
  onClose(sessionId: string): void;
  onResize(splitId: string, ratio: number): void;
  onResume?(sessionId: string): void;
  recordsById: Map<string, SessionRecord> | null;
}

function SplitNode(props: SplitNodeProps) {
  const { layout } = props;
  if (layout.kind === "pane") {
    const active = layout.sessionId === props.activePaneId;
    // Exited-pane resume affordance (interrupt/resume, issue #78): only for a
    // ticket pane whose PTY has actually exited AND whose own durable record
    // is resumable (agent launch, ended, harness knows how to resume). The
    // dead terminal's scrollback is left exactly as-is underneath — resuming
    // always boots a NEW tab, never touches this pane.
    const record = props.recordsById?.get(layout.sessionId);
    const resumable =
      layout.exitCode !== null &&
      record !== undefined &&
      canResumeSession({ kind: "terminal", record }, launchAdapter) &&
      props.onResume !== undefined;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-terminal-pane-id={layout.sessionId}
            data-terminal-tab-id={props.tabId}
            data-terminal-owner-id={props.ownerId}
            className={cn(
              "group/pane relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
              props.isSplit &&
                (active
                  ? "ring-2 ring-(--accent-selected) ring-inset"
                  : "ring-1 ring-border ring-inset"),
            )}
            onPointerDown={() => props.onActivate(layout.sessionId)}
            onContextMenu={() => props.onActivate(layout.sessionId)}
          >
            <PaneHeader
              identity={<TerminalWindowIcon className="size-3.5" />}
              title={record?.title || props.title}
              actions={
                <div
                  className="flex items-center gap-0.5"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {active && props.visible ? <PaneFocusControl sessionId={props.tabId} /> : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="toolbar"
                        size="icon-xs"
                        aria-label="Terminal actions"
                        title="Terminal actions"
                      >
                        <DotsThreeIcon weight="bold" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <TerminalPaneCommands {...props} sessionId={layout.sessionId} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="toolbar"
                    size="icon-xs"
                    aria-label="Close pane"
                    title="Close pane"
                    onClick={() => props.onClose(layout.sessionId)}
                  >
                    <XIcon weight="bold" />
                  </Button>
                </div>
              }
            />
            <div className="relative min-h-0 flex-1">
              <TerminalView
                ownerId={props.ownerId}
                tabId={props.tabId}
                sessionId={layout.sessionId}
                visible={props.visible}
                active={active}
                onActivate={() => props.onActivate(layout.sessionId)}
              />
              {resumable ? (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-4"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="pointer-events-auto shadow-raised"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onResume?.(layout.sessionId);
                    }}
                  >
                    <ArrowClockwiseIcon />
                    Resume session
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <TerminalPaneCommands {...props} sessionId={layout.sessionId} context />
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  const vertical = layout.direction === "vertical";
  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 overflow-hidden",
        vertical ? "flex-row" : "flex-col",
      )}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        // Split the 5px divider cost evenly so a 0.5 ratio is visually equal.
        style={{ flex: `0 0 calc(${layout.ratio * 100}% - 2.5px)` }}
      >
        <SplitNode {...props} layout={layout.first} />
      </div>
      {/* The shared split grip, with the terminal's floor: a terminal pane
          stays usable far narrower than a surface pane, and the range it
          reports and steps within is the sessions store's own clamp. */}
      <SplitViewDivider
        direction={vertical ? "row" : "column"}
        ratio={layout.ratio}
        minPanePx={TERMINAL_MIN_PANE_PX}
        valueRange={TERMINAL_SPLIT_RATIO_RANGE}
        label={
          vertical ? "Resize left and right terminal panes" : "Resize top and bottom terminal panes"
        }
        onChange={(ratio) => props.onResize(layout.id, ratio)}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SplitNode {...props} layout={layout.second} />
      </div>
    </div>
  );
}

/** The header menu and the existing context menu offer the same commands. */
function TerminalPaneCommands({
  sessionId,
  context = false,
  onSplit,
  onClose,
}: Pick<SplitNodeProps, "onSplit" | "onClose"> & { sessionId: string; context?: boolean }) {
  const commands = [
    {
      label: "Split Right",
      icon: ColumnsPlusRightIcon,
      shortcut: "⌘D",
      run: () => onSplit(sessionId, "vertical"),
    },
    {
      label: "Split Down",
      icon: RowsPlusBottomIcon,
      shortcut: "⇧⌘D",
      run: () => onSplit(sessionId, "horizontal"),
    },
    { separator: "font-size" },
    {
      label: "Increase Font Size",
      icon: PlusCircleIcon,
      shortcut: "⌘+",
      run: () => getEngine(sessionId)?.adjustFontSize(1),
    },
    {
      label: "Decrease Font Size",
      icon: MinusCircleIcon,
      shortcut: "⌘−",
      run: () => getEngine(sessionId)?.adjustFontSize(-1),
    },
    {
      label: "Reset Font Size",
      icon: ArrowCounterClockwiseIcon,
      shortcut: "⌘0",
      run: () => getEngine(sessionId)?.resetFontSize(),
    },
    { separator: "close" },
    {
      label: "Close pane",
      icon: XCircleIcon,
      shortcut: undefined,
      run: () => onClose(sessionId),
      destructive: true,
    },
  ];
  return commands.map((command) => {
    if (command.separator !== undefined)
      return context ? (
        <ContextMenuSeparator key={command.separator} />
      ) : (
        <DropdownMenuSeparator key={command.separator} />
      );
    const variant = command.destructive ? "destructive" : "default";
    return context ? (
      <ContextMenuItem
        key={command.label}
        icon={command.icon}
        variant={variant}
        onSelect={command.run}
      >
        {command.label}
        {command.shortcut === undefined ? null : (
          <ContextMenuShortcut>{command.shortcut}</ContextMenuShortcut>
        )}
      </ContextMenuItem>
    ) : (
      <DropdownMenuItem key={command.label} variant={variant} onSelect={command.run}>
        {command.label}
        {command.shortcut === undefined ? null : (
          <DropdownMenuShortcut>{command.shortcut}</DropdownMenuShortcut>
        )}
      </DropdownMenuItem>
    );
  });
}
