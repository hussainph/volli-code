/**
 * The composer's chip: one class string, so every control in the metadata row
 * — Status, Priority, Labels, the harness, the branch relationship — is the
 * same object at the same weight, and adding a chip cannot quietly introduce a
 * sixth size.
 *
 * It rides the default 28px metadata rung, in the same flat glass as the
 * runtime controls below. The Button owns height and inset; the corner is the
 * chip role's (`--radius-chip`, globals.css).
 */
export function composerChipClass(): string {
  return "rounded-chip border border-glass-edge bg-glass-1 font-medium text-muted-foreground";
}
