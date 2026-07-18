import * as React from "react";

import { ComposerForm } from "@renderer/components/board/new-ticket/composer-form";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

/**
 * The globally reachable Linear-style New-ticket composer: opened by the board
 * header's "New ticket" button or the plain "c" hotkey (see
 * hooks/use-new-ticket-shortcut.ts), from anywhere a project is selected — not
 * just the board page. Controlled by the ui store's `newTicketOpen` flag; `open`
 * also requires a selected project (the composer seeds its target from it).
 * Escape and overlay-click close come free from Radix via `onOpenChange`.
 *
 * The chrome (breadcrumb project chip, title/description, chips, footer) lives
 * in {@link ComposerForm}, which Radix mounts fresh on each open — so every open
 * starts blank. The dialog owns only the Expand state (a wider centered sheet).
 */
function closeComposer() {
  useUiStore.getState().setNewTicketOpen(false);
}

export function NewTicketDialog() {
  const project = useSelectedProject();
  const newTicketOpen = useUiStore((state) => state.newTicketOpen);
  const open = newTicketOpen && project !== null;
  const [expanded, setExpanded] = React.useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeComposer();
          setExpanded(false);
        }
      }}
    >
      <DialogContent
        data-testid="new-ticket-composer"
        showCloseButton={false}
        className={cn("gap-0 overflow-hidden p-0", expanded ? "sm:max-w-3xl" : "sm:max-w-xl")}
      >
        {/* Radix requires a title for the dialog's accessible name; the visible
            "New ticket" crumb lives in the breadcrumb, so this is screen-reader-only. */}
        <DialogTitle className="sr-only">New ticket</DialogTitle>
        {project !== null ? (
          <ComposerForm
            initialProject={project}
            expanded={expanded}
            onToggleExpand={() => setExpanded((value) => !value)}
            onClose={closeComposer}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
