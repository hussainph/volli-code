import * as React from "react";
import type { TicketStatus } from "@volli/shared";

import { useBoardStore } from "@renderer/stores/board";

interface TicketComposerOptions {
  projectId: string;
  ticketPrefix: string;
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
 */
export function useTicketComposer({
  projectId,
  ticketPrefix,
  status,
  initiallyOpen = false,
  onClose,
}: TicketComposerOptions) {
  const [open, setOpen] = React.useState(initiallyOpen);
  const [title, setTitle] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) inputRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  /** Adds the ticket when the trimmed title is non-empty; reports whether it did. */
  function submit(): boolean {
    const trimmed = title.trim();
    if (trimmed === "") return false;
    useBoardStore.getState().addTicket(projectId, ticketPrefix, status, trimmed);
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
    submit();
    close();
  }

  return {
    open,
    openComposer: () => setOpen(true),
    title,
    setTitle,
    inputRef,
    handleKeyDown,
    handleBlur,
  };
}
