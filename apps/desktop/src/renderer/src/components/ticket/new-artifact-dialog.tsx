import * as React from "react";
import { toast } from "sonner";

import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";

interface NewArtifactDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Calls `api.artifacts.create`; the tab owns the IPC round-trip so this stays a pure name→result contract. */
  onCreate(name: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  /** The just-created artifact's forced-`.md` name — the caller selects it and opens it in edit mode. */
  onCreated(name: string): void;
}

/**
 * Name-prompt dialog for "New artifact" (ticket-detail-mvp decision #17): a
 * new, minimally-templated `.md` artifact in the ticket tier. Same
 * open/reset-on-close idiom as `new-ticket-dialog.tsx`'s `NewTicketDialog` —
 * Radix unmounts `DialogContent`'s children when closed, so the form's field
 * state resets for free on every open, no manual reset needed.
 */
export function NewArtifactDialog({
  open,
  onOpenChange,
  onCreate,
  onCreated,
}: NewArtifactDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <NewArtifactForm onCreate={onCreate} onCreated={onCreated} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function NewArtifactForm({
  onCreate,
  onCreated,
  onOpenChange,
}: Omit<NewArtifactDialogProps, "open">) {
  const [name, setName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const trimmedName = name.trim();

  async function submit() {
    if (trimmedName === "" || submitting) return;
    setSubmitting(true);
    const result = await onCreate(trimmedName);
    if (!result.ok) {
      toast.error(result.error);
      setSubmitting(false);
      return;
    }
    onCreated(result.name);
    onOpenChange(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New artifact</DialogTitle>
      </DialogHeader>
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Artifact name…"
      />
      <DialogFooter>
        <Button onClick={() => void submit()} disabled={trimmedName === "" || submitting}>
          Create
        </Button>
      </DialogFooter>
    </>
  );
}
