import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";

import { Button } from "@renderer/components/ui/button";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

/**
 * A board with no tickets on it at all.
 *
 * Not the same state as a filter matching nothing, and it is shown in place of
 * the collapsed-column rail rather than beside it: five empty pills whose only
 * offer is "expand me and type here" are a worse first move than one line and
 * one button, and they were the whole of what a new board said (VC-42 audit,
 * finding F6).
 *
 * ONE LINE, AND IT NAMES THE KICKOFF. The thing a first-timer cannot discover
 * is not that a board takes tickets — it is that the second button in the
 * composer turns one into a running agent in the same gesture. So the line
 * carries that clause and nothing else; the button carries the way in, and the
 * chord it announces is the same `c` that works from anywhere in the app
 * (`hooks/use-new-ticket-shortcut.ts`). Everything past those two sentences
 * belongs in the composer, where the controls are.
 */
export function BoardEmpty({ className }: { className?: string }) {
  return (
    <div className={cn(EMPTY_PAGE, "gap-4", className)}>
      <p className="text-sm text-muted-foreground">
        Write the first ticket — Create &amp; start puts an agent on it.
      </p>
      <Button
        className="gap-1 px-2 text-ui"
        onClick={() => useUiStore.getState().setNewTicketOpen(true)}
      >
        <PlusIcon className="size-3.5" />
        New ticket
        {/* The shortcut-chip treatment the primary buttons already use
            (ticket-activity-feed.tsx, project-tile.tsx). */}
        <kbd className="rounded-sm bg-primary-foreground/10 px-1 py-px font-sans text-label font-normal text-primary-foreground/70">
          C
        </kbd>
      </Button>
    </div>
  );
}
