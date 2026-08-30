/**
 * The one mark that says a Session is a Run's (VC-112 "Observability", VC-131).
 *
 * One component, used by every surface that lists Sessions, because the rule it
 * serves is about ALL of them at once: a Session a Run created must be
 * distinguishable from one a person started *everywhere a Session appears*. A
 * per-surface bolt is how two lists come to disagree about the same Session.
 *
 * ── WHAT IT DRAWS, AND WHAT IT REFUSES TO ─────────────────────────────────
 * A lightning bolt and the Automation's name, and nothing at all for the other
 * two parties. That asymmetry is the whole design:
 *
 * - **`user` draws nothing.** It is the resting case, and a rail is mostly this
 *   — so anything drawn here would be persistent weight paid on every row to
 *   say what the absence of a mark already says.
 * - **`session` draws nothing either, and mints no glyph.** VC-112 rules that
 *   out on a fact: a glyph would say "an agent started this" and stop, while
 *   the reader's question is *which* agent. Its whole mark is the row's hover
 *   line ({@link sessionProvenanceHoverLine}), which the calling row composes
 *   into the `title` it already has — no new node, no new ink.
 * - **`automation` draws the bolt**, which is the same glyph the nav item, the
 *   column header and the palette already use for an Automation. A fourth
 *   spelling of one concept would have been a fourth thing to learn.
 *
 * The name beside the bolt is conditional and {@link automationMarkName} owns
 * why: a Run names its Session after its Automation, so the word is usually the
 * row's title already.
 *
 * ── WEIGHT ────────────────────────────────────────────────────────────────
 * `bold` at `size-3`, which is the sidebar band's small-glyph tier and a
 * statement about the pen rather than the size: Phosphor draws regular at
 * 16/256 em against bold's 24/256, and at 12px that is 0.75px of ink beside a
 * ~1.1px text stem. A mark drawn lighter than the label it qualifies reads as a
 * smudge. Emphatically not `fill` — a filled bolt at this size is a solid wedge
 * that would out-shout the title it sits beside, and this mark is a
 * qualification rather than an alarm.
 *
 * It is drawn in `text-primary`, the app's one "Volli did this" ink, and never
 * in a status colour: the bolt says WHO started the work, and a status hue here
 * would compete with the dot beside it that says what the work is doing.
 */
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { automationMarkLabel, automationMarkName, type SessionProvenance } from "@volli/shared";

import { cn } from "@renderer/lib/utils";

export function SessionProvenanceMark({
  provenance,
  rowTitle,
  className,
}: {
  provenance: SessionProvenance;
  /**
   * The title this row already shows. The mark reads it so it can decline to
   * print a name the row is already saying — see {@link automationMarkName}.
   */
  rowTitle: string;
  className?: string;
}) {
  // The accessible sentence decides whether anything is drawn at all: it is
  // non-null for exactly the arm that draws a bolt, so a mark can never reach
  // the DOM without a name for a screen reader to read.
  const label = automationMarkLabel(provenance);
  if (label === null) return null;
  const name = automationMarkName(provenance, rowTitle);
  return (
    <span
      className={cn("inline-flex min-w-0 shrink items-center gap-1 text-primary", className)}
      // One accessible sentence for the pair, rather than a labelled glyph
      // beside a text node a screen reader would read as two things. It names
      // the Automation even when the visible half declines to repeat it, so the
      // fact never depends on a sighted comparison with the title — and when
      // there is no name to be had it still says an Automation was here.
      aria-label={label}
    >
      <LightningIcon weight="bold" aria-hidden className="size-3 shrink-0" />
      {name === null ? null : <span className="truncate">{name}</span>}
    </span>
  );
}
