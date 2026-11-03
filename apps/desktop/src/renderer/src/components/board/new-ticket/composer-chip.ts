/**
 * The composer's chip: one class string, so every control in the metadata row
 * — Status, Priority, Labels, the harness, the branch relationship — is the
 * same object at the same weight, and adding a chip cannot quietly introduce a
 * sixth size.
 *
 * It rides the default 28px metadata rung. The raised card face is the same
 * semantic material as the runtime controls below; the Button owns geometry.
 */
export function composerChipClass(): string {
  return "border border-border bg-card font-medium text-muted-foreground shadow-raised";
}
