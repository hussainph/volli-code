import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";

import {
  ModelAccessFirstRun,
  useModelAccessReady,
} from "@renderer/components/sessions/model-access-first-run";
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
 *
 * ── EXCEPT WHEN THE APP CANNOT KEEP THAT PROMISE (VC-54 scope 6) ──────────
 * "Create & start puts an agent on it" is a lie on a profile with no default
 * model: the create is refused in main before anything durable exists. While
 * Model Access has no default, VC-53's own first-run block stands in the line's
 * place — the provider sign-in menu, deep-linking into each flow — and the
 * ticket line returns the moment a default exists.
 *
 * This is where that block LIVES now, and the move was not cosmetic. Removing
 * the Sessions nav removed the app's only PROACTIVE auth surface: VC-52 ships
 * the background install deliberately silent, so nothing else tells a fresh
 * profile that Model Access exists until something refuses. Home's Board tab is
 * the first thing a fresh profile sees, and its empty state is the one surface
 * guaranteed to be on screen there. The reactive paths — the chat plane's
 * blocker, `createChatSession`'s `isDefaultModelRequired` jump — remain as
 * backstops for a project that already has tickets.
 *
 * It stays inside the "let controls talk" guardrail because it is a STATE of an
 * existing empty state rather than a new panel, and it is a button plus a menu
 * rather than prose.
 */
export function BoardEmpty({ className }: { className?: string }) {
  // Asked only while this state is on screen, and re-asked on every Model
  // Access revision — finishing sign-in flips the block back to the ticket line
  // without a reload. `null` means unanswered: neither branch draws yet, which
  // is what keeps a one-frame sign-in prompt off a perfectly configured profile.
  const modelReady = useModelAccessReady(true);

  return (
    <div className={cn(EMPTY_PAGE, "gap-4", className)}>
      {modelReady === false ? (
        <ModelAccessFirstRun />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
