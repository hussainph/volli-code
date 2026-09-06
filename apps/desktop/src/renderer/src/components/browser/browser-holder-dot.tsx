/**
 * The holder's mark on a Browser tab in a strip (VC-239): the Session's
 * identity colour, or the foreground for the person, in the badge slot
 * between the browser glyph and the label — the same slot a Session tab's
 * provenance bolt takes, so a held tab keeps its mark where every other tab
 * keeps its own.
 *
 * Drawn on every held tab, on screen or not: the strip is where a person
 * learns a Session is driving a tab they are not looking at. Nothing for a
 * free tab — the dot is the state.
 *
 * One component for both strips (Home's and the ticket's), so they cannot
 * disagree on what a held tab looks like.
 */
import type { BrowserTabHolder } from "../../../../ipc/contract";

export function browserHolderLabel(holder: BrowserTabHolder): string {
  return holder.kind === "session" ? `Held by ${holder.name}` : "Yours";
}

export function BrowserHolderDot({ holder }: { holder: BrowserTabHolder | null }) {
  if (holder === null) return null;
  const label = browserHolderLabel(holder);
  return (
    <span
      data-slot="browser-holder-dot"
      data-holder={holder.kind}
      aria-label={label}
      title={label}
      className="size-2 shrink-0 rounded-full"
      style={{
        backgroundColor: holder.kind === "session" ? holder.color : "var(--foreground)",
      }}
    />
  );
}
