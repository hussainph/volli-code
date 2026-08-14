import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

/**
 * Direct Ticket-session creation controls. Chat is the structured path; a
 * terminal is its explicit companion, never a peer hidden behind a create menu.
 */
export function TicketSessionActions({
  disabled,
  className,
  onNewChat,
  onNewTerminal,
}: {
  /** A Session of either kind is already booting. */
  disabled: boolean;
  className?: string;
  onNewChat(): void;
  onNewTerminal(): void;
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={disabled}
        aria-label="New chat"
        title="New chat"
        onClick={onNewChat}
      >
        <ChatCircleIcon weight="fill" className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={disabled}
        aria-label="New terminal"
        title="New terminal"
        onClick={onNewTerminal}
      >
        <TerminalWindowIcon weight="fill" className="size-3.5" />
      </Button>
    </div>
  );
}
