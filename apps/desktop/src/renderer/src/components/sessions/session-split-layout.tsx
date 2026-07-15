import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ColumnsPlusRightIcon } from "@phosphor-icons/react/dist/csr/ColumnsPlusRight";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { PlusCircleIcon } from "@phosphor-icons/react/dist/csr/PlusCircle";
import { RowsPlusBottomIcon } from "@phosphor-icons/react/dist/csr/RowsPlusBottom";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";

import { TerminalView } from "@renderer/components/sessions/terminal-view";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { cn } from "@renderer/lib/utils";
import type { SessionLayout, SessionTab, TerminalSplitDirection } from "@renderer/stores/sessions";
import { sessionPanes } from "@renderer/stores/sessions";
import { getEngine } from "@renderer/terminal/registry";

interface SessionSplitLayoutProps {
  /** The unified store owner key (projectId for scratch, ticketId for ticket). */
  ownerId: string;
  tab: SessionTab;
  visible: boolean;
  onActivate(sessionId: string): void;
  onSplit(sessionId: string, direction: TerminalSplitDirection): void;
  onClose(sessionId: string): void;
  onResize(splitId: string, ratio: number): void;
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
}: SessionSplitLayoutProps) {
  const isSplit = sessionPanes(tab.layout).length > 1;
  return (
    <div className={cn("absolute inset-0 min-h-0 min-w-0", !visible && "hidden")}>
      <SplitNode
        ownerId={ownerId}
        tabId={tab.sessionId}
        layout={tab.layout}
        visible={visible}
        activePaneId={tab.activePaneId}
        isSplit={isSplit}
        onActivate={onActivate}
        onSplit={onSplit}
        onClose={onClose}
        onResize={onResize}
      />
    </div>
  );
}

interface SplitNodeProps {
  ownerId: string;
  tabId: string;
  layout: SessionLayout;
  visible: boolean;
  activePaneId: string;
  isSplit: boolean;
  onActivate(sessionId: string): void;
  onSplit(sessionId: string, direction: TerminalSplitDirection): void;
  onClose(sessionId: string): void;
  onResize(splitId: string, ratio: number): void;
}

function SplitNode(props: SplitNodeProps) {
  const { layout } = props;
  if (layout.kind === "pane") {
    const active = layout.sessionId === props.activePaneId;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-terminal-pane-id={layout.sessionId}
            data-terminal-tab-id={props.tabId}
            data-terminal-owner-id={props.ownerId}
            className={cn(
              "relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background",
              props.isSplit &&
                (active ? "ring-1 ring-primary/60 ring-inset" : "ring-1 ring-border/50 ring-inset"),
            )}
            onPointerDown={() => props.onActivate(layout.sessionId)}
            onContextMenu={() => props.onActivate(layout.sessionId)}
          >
            <TerminalView
              ownerId={props.ownerId}
              tabId={props.tabId}
              sessionId={layout.sessionId}
              visible={props.visible}
              active={active}
              onActivate={() => props.onActivate(layout.sessionId)}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            icon={ColumnsPlusRightIcon}
            onSelect={() => props.onSplit(layout.sessionId, "vertical")}
          >
            Split Right
            <ContextMenuShortcut>⌘D</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            icon={RowsPlusBottomIcon}
            onSelect={() => props.onSplit(layout.sessionId, "horizontal")}
          >
            Split Down
            <ContextMenuShortcut>⇧⌘D</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={PlusCircleIcon}
            onSelect={() => getEngine(layout.sessionId)?.adjustFontSize(1)}
          >
            Increase Font Size
            <ContextMenuShortcut>⌘+</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            icon={MinusCircleIcon}
            onSelect={() => getEngine(layout.sessionId)?.adjustFontSize(-1)}
          >
            Decrease Font Size
            <ContextMenuShortcut>⌘−</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            icon={ArrowCounterClockwiseIcon}
            onSelect={() => getEngine(layout.sessionId)?.resetFontSize()}
          >
            Reset Font Size
            <ContextMenuShortcut>⌘0</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={XCircleIcon}
            variant="destructive"
            onSelect={() => props.onClose(layout.sessionId)}
          >
            Close Pane
          </ContextMenuItem>
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
        // Split the 6px divider cost evenly so a 0.5 ratio is visually equal.
        style={{ flex: `0 0 calc(${layout.ratio * 100}% - 3px)` }}
      >
        <SplitNode {...props} layout={layout.first} />
      </div>
      <SplitDivider
        direction={layout.direction}
        ratio={layout.ratio}
        onChange={(ratio) => props.onResize(layout.id, ratio)}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SplitNode {...props} layout={layout.second} />
      </div>
    </div>
  );
}

interface SplitDividerProps {
  direction: TerminalSplitDirection;
  ratio: number;
  onChange(ratio: number): void;
}

function SplitDivider({ direction, ratio, onChange }: SplitDividerProps) {
  const vertical = direction === "vertical";
  const dragging = React.useRef(false);

  const ratioFromPointer = (event: React.PointerEvent<HTMLDivElement>): number => {
    const parent = event.currentTarget.parentElement;
    if (parent === null) return ratio;
    const rect = parent.getBoundingClientRect();
    const total = vertical ? rect.width : rect.height;
    const position = vertical ? event.clientX - rect.left : event.clientY - rect.top;
    const minRatio = Math.min(0.45, 96 / Math.max(total, 1));
    return Math.min(1 - minRatio, Math.max(minRatio, position / Math.max(total, 1)));
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={
        vertical ? "Resize left and right terminal panes" : "Resize top and bottom terminal panes"
      }
      tabIndex={0}
      className={cn(
        "group relative z-10 shrink-0 bg-transparent outline-none focus-visible:ring-1 focus-visible:ring-primary",
        vertical ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize",
      )}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onChange(ratioFromPointer(event));
      }}
      onPointerMove={(event) => {
        if (dragging.current) onChange(ratioFromPointer(event));
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(event) => {
        const decrement = vertical ? event.key === "ArrowLeft" : event.key === "ArrowUp";
        const increment = vertical ? event.key === "ArrowRight" : event.key === "ArrowDown";
        if (!decrement && !increment) return;
        event.preventDefault();
        onChange(ratio + (increment ? 0.03 : -0.03));
      }}
    >
      <span
        className={cn(
          "absolute bg-border transition-colors duration-150 group-hover:bg-primary/70 group-focus-visible:bg-primary",
          vertical
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
    </div>
  );
}
