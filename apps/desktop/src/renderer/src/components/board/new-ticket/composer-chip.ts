/**
 * The composer's chip: one class string, so every control in the metadata row
 * — Status, Priority, Labels, the harness, the branch relationship — is the
 * same object at the same weight, and adding a chip cannot quietly introduce a
 * sixth size.
 *
 * It rides `Button size="sm"` (h-6, the pill scale's 24px step from
 * docs/DESIGN.md) and overrides only what makes a chip a chip: an outline
 * instead of a fill, tighter padding, and the meta type step. The row reads as
 * a strip of quiet outlines under the description rather than five buttons.
 */
export function composerChipClass(): string {
  return "border border-border px-2 text-ui font-medium text-muted-foreground";
}
