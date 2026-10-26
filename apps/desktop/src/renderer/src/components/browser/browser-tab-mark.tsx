import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";

/**
 * The glyph a Browser Tab wears wherever it is drawn: the browser, whoever
 * owns the tab. A Session's tab used to wear a robot (VC-238); the owner asked
 * for the browser back (VC-614) — a strip of agent tabs read as a row of
 * robots and said nothing about what they were. Ownership is still said to
 * assistive tech ("Driven by a Session") and to probes (`data-browser-tab-mark`),
 * and on screen by the holder dot while a Session drives. `bold`, because these
 * sit at 12px where regular draws lighter than the label beside it.
 */
export function BrowserTabMark({ driven, className }: { driven: boolean; className?: string }) {
  return (
    <BrowserIcon
      aria-hidden={driven ? undefined : true}
      aria-label={driven ? "Driven by a Session" : undefined}
      role={driven ? "img" : undefined}
      weight="bold"
      data-browser-tab-mark={driven ? "session" : "user"}
      className={className ?? "size-3 shrink-0 text-muted-foreground"}
    />
  );
}
