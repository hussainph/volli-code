import * as React from "react";
import type { TicketStatus } from "@volli/shared";

import { guardWrite, useCanWrite } from "@renderer/components/hosts/use-hosts";
import { useBoardStore } from "@renderer/stores/board";

interface TicketComposerOptions {
  projectId: string;
  status: TicketStatus;
  initiallyOpen?: boolean;
  /** Fired whenever the composer closes (Escape or blur). */
  onClose?(): void;
}

/**
 * The add-card composer contract, shared by the board column's inline card
 * composer and the list view's section composer so the two views can never
 * drift: Enter submits and keeps composing, Escape closes, a non-empty blur
 * submits then closes. The consumers own only their wrapper markup.
 *
 * Read-only (VC-576): while the project's host cannot serve, the composer does
 * not open, and one already open refuses to submit — Enter says why, and a
 * blur closes it KEEPING the draft for when the host is back. `canWrite` is
 * the consumer's gate for its "New" button.
 */
export function useTicketComposer({
  projectId,
  status,
  initiallyOpen = false,
  onClose,
}: TicketComposerOptions) {
  const canWrite = useCanWrite(projectId);
  // A collapsed column's expand opens this composer; a read-only one stays shut.
  const [open, setOpen] = React.useState(initiallyOpen && canWrite);
  const [title, setTitle] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) inputRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  /** Adds the ticket when the trimmed title is non-empty; reports whether it did. */
  function submit(): boolean {
    const trimmed = title.trim();
    if (trimmed === "") return false;
    if (!guardWrite(projectId)) return false;
    // Fire-and-forget: the store surfaces creation failures via toast; this
    // composer only needs to know locally whether it had a title to submit.
    void useBoardStore.getState().addTicket(projectId, status, trimmed);
    return true;
  }

  function close() {
    setTitle("");
    setOpen(false);
    onClose?.();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (submit()) setTitle("");
    } else if (event.key === "Escape") {
      close();
    }
  }

  function handleBlur() {
    if (title.trim() !== "" && !guardWrite(projectId)) {
      // Not sent, so not lost: the draft waits for the host.
      setOpen(false);
      onClose?.();
      return;
    }
    submit();
    close();
  }

  return {
    open,
    canWrite,
    openComposer: () => {
      if (guardWrite(projectId)) setOpen(true);
    },
    title,
    setTitle,
    inputRef,
    handleKeyDown,
    handleBlur,
  };
}
