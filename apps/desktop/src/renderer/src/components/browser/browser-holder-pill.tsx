/**
 * Who holds this Browser Tab (VC-239), said in the chrome beside the address
 * bar — and the person's two ways to answer.
 *
 * Present only while someone holds the tab. A free tab says nothing: the
 * pill is the state, and an "unheld" pill would be a control that is mostly
 * decoration. While a Session holds it, the pill wears that Session's colour
 * dot and name — identity, the same hue its cursor and its tab-strip dot
 * wear — and offers **Take over** (the hold passes to the person now) and
 * **Ask to leave** (one line into the Session asking it to release when it
 * is safe). While the person holds it, the pill says so and offers **Hand
 * back**.
 *
 * Takeover is a control, not an inference. Main cannot tell a person's click
 * in the native view from the Session's own synthetic one, so nothing here
 * watches input; using the address bar, back, forward or reload is not a
 * takeover either. The person is never locked out — their clicks and typing
 * into the page are always delivered — so this pill is about whose TURN it
 * is, not about who is allowed.
 *
 * Hook-free like `BrowserChrome`, so a test can call it as a plain function.
 */
import { HandPalmIcon } from "@phosphor-icons/react/dist/csr/HandPalm";
import { HandWavingIcon } from "@phosphor-icons/react/dist/csr/HandWaving";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import type { BrowserTabHolder } from "@volli/shared";

export interface BrowserHolderPillProps {
  /** Exactly what main pushes as the tab's `heldBy`. */
  holder: BrowserTabHolder;
  onTakeOver(): void;
  onAskToLeave(): void;
  onHandBack(): void;
  className?: string;
}

export function BrowserHolderPill({
  holder,
  onTakeOver,
  onAskToLeave,
  onHandBack,
  className,
}: BrowserHolderPillProps) {
  return (
    <div
      data-slot="browser-holder-pill"
      data-holder={holder.kind}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 rounded-full border border-border bg-background pl-2.5 pr-1 text-ui shadow-raised",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={
          holder.kind === "session"
            ? { backgroundColor: holder.color }
            : // The person has no identity colour: their mark is the foreground,
              // the ink every other control is drawn in.
              { backgroundColor: "var(--foreground)" }
        }
      />
      {/* The labels are the whole explanation (AGENTS.md: let controls talk).
          No tooltip sentences: "Take over" and "Hand back" say what they do.
          In a narrow pane the words give way and the glyph stays, keyed on the
          CHROME's width (`@container/chrome` on `BrowserChrome`) rather than
          the window's: a split pane is narrow in a wide window. The accessible
          name is the word either way. */}
      <span className="max-w-40 truncate pr-1 text-foreground">
        {holder.kind === "session" ? holder.name : "Yours"}
      </span>
      {holder.kind === "session" ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Take over"
            onClick={onTakeOver}
          >
            <HandPalmIcon weight="bold" />
            <span className="hidden @min-[680px]/chrome:inline">Take over</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Ask to leave"
            onClick={onAskToLeave}
          >
            <HandWavingIcon weight="bold" />
            <span className="hidden @min-[680px]/chrome:inline">Ask to leave</span>
          </Button>
        </>
      ) : (
        <Button type="button" variant="ghost" size="xs" aria-label="Hand back" onClick={onHandBack}>
          <ArrowUUpLeftIcon weight="bold" />
          <span className="hidden @min-[680px]/chrome:inline">Hand back</span>
        </Button>
      )}
    </div>
  );
}
