/**
 * WHOSE agent is running here and WHAT it is doing, as one drawing (VC-402).
 *
 * The sidebar's Active band used to spend two marks on that pair: a 6px status
 * dot on the title's cap height, and a Phosphor mnemonic on the meta line
 * standing for the harness. Two marks for two halves of one sentence, in two
 * places, and the mnemonic was the weaker half — a glyph chosen for being a
 * silhouette nothing else in the band shared, which a reader had to be taught.
 * The vendor's own mark needs no teaching, and it is the same size as the slot
 * the dot was already holding. So it takes the slot and carries the colour.
 *
 * **The colour is `ui/status-dot.tsx`'s, reached through {@link statusToneInk}
 * rather than transposed.** A second `text-*` copy of that map is exactly the
 * drift the dot was created to end, one colour apart instead of one surface
 * apart. The breath is the dot's own `status-dot-live` class, at the dot's own
 * 2.4s: the tab strip and the ticket rail still draw discs for Sessions this
 * band draws marks for, and two periods for one fact on one screen is the same
 * disagreement in the time axis.
 *
 * **14px, not 12.** The band's other glyphs are 12px Phosphor at `bold`, which
 * is a pen weight rather than a size; these are vendor artwork with interiors —
 * Anthropic's counter, OpenCode's hole, Z.ai's slab — and at 12px the interiors
 * close up and five distinct marks become five smudges. It costs the title 8px
 * of truncation against the dot it replaces, which is the trade.
 *
 * **It is IN the accessibility tree**, unlike the dot. The dot is always beside
 * words that say its state, so announcing it would read the status twice; this
 * mark says something the row prints nowhere — which vendor — so its name is
 * the vendor plus the state, and nothing visible is added.
 */
import {
  STATUS_DOT_LIVE,
  STATUS_LIVE_HALO_COLOR,
  statusToneInk,
  type StatusDotState,
} from "@renderer/components/ui/status-dot";
import type { VendorMark } from "@renderer/components/ui/vendor-marks";
import { cn } from "@renderer/lib/utils";

export function SessionMark({
  mark,
  /**
   * The whole accessible name. Composed by the row rather than here, because
   * the state's words are `SESSION_ACTIVITY_LABEL`'s and a copy of them in a
   * drawing component would be the fourth.
   */
  name,
  /**
   * The state the mark carries, or `null` for a band that draws no status —
   * Previous, where the mark is identity alone in the band's muted ink and
   * nothing animates but the caret.
   */
  state,
}: {
  mark: VendorMark;
  name: string;
  state: StatusDotState | null;
}) {
  const live = state === "working";
  return (
    <span
      data-slot="session-mark"
      data-state={state ?? "none"}
      // The breath rides the WRAPPER so the halo dims WITH the glyph and the
      // two read as one object — `globals.css` makes that call explicitly for
      // the dot, whose fill and halo are one element.
      // Its own 14px box rather than one borrowed from the caller: the band
      // gives it a slot of exactly that size, and a mark that only measured
      // right inside one particular parent is a mark the next surface draws
      // wrong.
      className={cn(
        "relative flex size-3.5 shrink-0 items-center justify-center",
        live && STATUS_DOT_LIVE,
      )}
    >
      {live ? (
        <span
          aria-hidden
          className="absolute size-5 rounded-full"
          style={{ background: STATUS_LIVE_HALO_COLOR }}
        />
      ) : null}
      {/* No tone class at all when there is no state: the mark then inherits
          the band's own muted ink, which is what "the same mark, quieter"
          means in a row that has already decided its colour. */}
      <svg
        role="img"
        aria-label={name}
        viewBox="0 0 24 24"
        className={cn("relative size-3.5", state !== null && statusToneInk(state))}
      >
        <path d={mark.path} fill="currentColor" />
      </svg>
    </span>
  );
}
