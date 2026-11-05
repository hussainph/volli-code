/** A vacant pane keeps every command, with one primary action and a compact inventory. */
import {
  BrowserIcon,
  ChatIcon,
  FindFileIcon,
  TerminalIcon,
  CloseIcon,
  MoreIcon,
} from "@renderer/components/ui/icon";
import { EmptyState } from "@renderer/components/ui/empty-state";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@renderer/components/ui/dropdown-menu";

export interface PaneEmptyStateProps {
  onNewChat(): void;
  onNewTerminal(): void;
  onNewBrowser(): void;
  onOpenFile(): void;
  onClosePane(): void;
}
export function PaneEmptyState({
  onNewChat,
  onNewTerminal,
  onNewBrowser,
  onOpenFile,
  onClosePane,
}: PaneEmptyStateProps) {
  return (
    <div
      data-slot="pane-empty-state"
      className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-4"
    >
      <EmptyState
        tier="panel"
        illustration="chat"
        title="No open tabs"
        action={{
          label: "New chat",
          icon: <ChatIcon />,
          onAction: onNewChat,
          shortcut: "⌘T",
          keyshortcuts: "Meta+T",
          slot: "pane-empty-row",
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Pane actions">
            <MoreIcon />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" aria-label="Pane actions">
          <DropdownMenuItem
            aria-label="New terminal"
            aria-keyshortcuts="Alt+Meta+T"
            onSelect={onNewTerminal}
          >
            <TerminalIcon />
            New terminal<DropdownMenuShortcut>⌥⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem aria-label="New browser" onSelect={onNewBrowser}>
            <BrowserIcon />
            New browser
          </DropdownMenuItem>
          <DropdownMenuItem
            aria-label="Open file…"
            aria-keyshortcuts="Meta+P"
            onSelect={onOpenFile}
          >
            <FindFileIcon />
            Open file…<DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem aria-label="Close pane" onSelect={onClosePane}>
            <CloseIcon />
            Close pane
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
