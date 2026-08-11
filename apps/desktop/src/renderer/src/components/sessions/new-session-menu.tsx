/**
 * The "+" that starts a Session, wherever one is offered.
 *
 * One control and two mounts — the project's scratch strip and that surface's
 * empty state — because two identically-drawn buttons 300px apart must not mean
 * two different things. A surface rarely gains a second Session, so the press
 * the menu costs is almost never paid; what it buys is that neither kind is the
 * hidden one. The Ticket surfaces choose instead: they draw Chat and Terminal
 * as direct controls, since a ticket's working set is the one place both kinds
 * are reached often enough to earn the width.
 *
 * `label` is the one draw that differs: a strip's "+" is one control among tabs
 * that already name what exists, while an empty surface's is the only thing on
 * screen and has to say what it does.
 */
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";

export function NewSessionMenu({
  disabled,
  align = "start",
  className,
  label,
  onNewSession,
  onNewChat,
}: {
  /** A Session of either kind is already booting. */
  disabled: boolean;
  align?: "start" | "end";
  className?: string;
  /** Draws a labeled button instead of the bare "+", for a mount that is the only affordance on screen. */
  label?: string;
  onNewSession(): void;
  onNewChat(): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {label === undefined ? (
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label="New session"
            className={className}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm" disabled={disabled} className={className}>
            <PlusIcon />
            {label}
          </Button>
        )}
      </DropdownMenuTrigger>
      {/* Chat first: it is the structured default, and the first item is what
          the keyboard opens onto. Listing the manual companion above it made the
          deliberate act the one a press lands on. */}
      <DropdownMenuContent align={align}>
        <DropdownMenuItem onSelect={onNewChat}>
          <ChatCircleIcon weight="fill" />
          Chat
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewSession}>
          <TerminalWindowIcon weight="fill" />
          Terminal
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
