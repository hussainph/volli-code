/**
 * The composer's chip: one class string, so every control in the metadata row
 * — Status, Priority, Labels, the harness, the branch relationship — is the
 * same object at the same weight, and adding a chip cannot quietly introduce a
 * sixth size.
 *
 * It rides the default 28px metadata rung. The borderless inspector face matches
 * the ticket property controls; the Button owns geometry.
 */
export function composerChipClass(): string {
  return "gap-1.5 px-2 font-medium text-foreground";
}
