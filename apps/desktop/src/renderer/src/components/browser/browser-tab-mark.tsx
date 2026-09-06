import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { RobotIcon } from "@phosphor-icons/react/dist/csr/Robot";

/**
 * The glyph a Browser Tab wears wherever it is drawn: a browser for a
 * person's tab, a robot for one a Session owns (VC-238). The strip and the
 * preview both use it, so a promoted agent tab is marked the same way in both
 * places and a person can always tell which tabs an agent may still be
 * driving. `bold`, because these sit at 12px where regular draws lighter than
 * the label beside it.
 */
export function BrowserTabMark({ driven, className }: { driven: boolean; className?: string }) {
  const Icon = driven ? RobotIcon : BrowserIcon;
  return (
    <Icon
      aria-hidden={driven ? undefined : true}
      aria-label={driven ? "Driven by a Session" : undefined}
      role={driven ? "img" : undefined}
      weight="bold"
      data-browser-tab-mark={driven ? "session" : "user"}
      className={className ?? "size-3 shrink-0 text-muted-foreground"}
    />
  );
}
