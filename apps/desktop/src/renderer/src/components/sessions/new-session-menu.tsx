/**
 * The "+" that starts a Session, wherever a ticket offers one.
 *
 * One control and two mounts — the tab strip and the rail's Sessions header —
 * because two identically-drawn buttons 300px apart must not mean two different
 * things. A ticket rarely gains a second Session, so the press the menu costs is
 * almost never paid; what it buys is that neither kind is the hidden one.
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
  onNewSession,
  onNewChat,
}: {
  /** A Session of either kind is already booting. */
  disabled: boolean;
  align?: "start" | "end";
  className?: string;
  onNewSession(): void;
  onNewChat(): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={disabled}
          aria-label="New session"
          className={className}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuItem onSelect={onNewSession}>
          <TerminalWindowIcon weight="fill" />
          Terminal
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewChat}>
          <ChatCircleIcon weight="fill" />
          Chat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
