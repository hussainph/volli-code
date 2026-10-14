/**
 * Divergence between the app-wide value and this project's, marked once.
 *
 * SCOPE IS THE SURFACE, not a mode. Settings is app-wide, always; Configure is
 * this project, always. There is no scope switch anywhere, because the pane a
 * person is standing in already answers the question one would ask.
 *
 * What remains is saying, on the Configure side, that a row has diverged — and
 * that is one control, not a vocabulary.
 */
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";

import { Button } from "@renderer/components/ui/button";

/**
 * The one inheritance idiom, and it costs **zero pills**.
 *
 * A scopeable row shows its effective value without a separate mode switch:
 *
 *  - Inheriting? The control simply shows the inherited value. Touching it
 *    overrides. There is no mode to enter first, which was always the
 *    redundant step: choosing a value *is* the act of overriding.
 *  - Overridden? A revert button appears. That is the whole signal.
 *
 * There was briefly a second signal — a 2px accent bar in the row's gutter —
 * and it lasted exactly as long as it took someone to point at it and ask what
 * it was. Which is the answer: a coloured tick means "overridden" only to
 * whoever wrote it. It was redundant besides. The revert button appears on
 * precisely the same rows, sits in the same scannable right-hand column, and
 * unlike a mark it says what it is ("Reset Model to the app-wide value,
 * claude-opus-4.6") and does something about it.
 */
export function OverrideControl({
  label,
  inheritedValue,
  overridden,
  disabled = false,
  onRevert,
  children,
}: {
  /** Names the revert button: "Reset Harness to the app-wide value, …". */
  label: string;
  /** What Settings says. Named in the button's accessible label. */
  inheritedValue: string;
  overridden: boolean;
  /** Keeps revert from remaining as an active mutation when its control is inactive. */
  disabled?: boolean;
  onRevert: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      {overridden ? (
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={disabled}
          aria-label={`Reset ${label} to the app-wide value, ${inheritedValue}`}
          onClick={onRevert}
        >
          <ArrowCounterClockwiseIcon />
        </Button>
      ) : (
        // Holds the column so the control does not shift right when a row
        // reverts. The same trick the model catalogue uses for a model with
        // no reserve to set.
        <span aria-hidden className="size-5" />
      )}
    </>
  );
}

// Precedence is published once, in a section's `(i)`. Divergence and its
// revert live on the project's Configure page, not beside the global value.
