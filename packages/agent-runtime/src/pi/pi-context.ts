/**
 * The one place this runtime turns an `AbortSignal` into a Pi `Context`.
 *
 * Pi 0.85.0 moved cancellation off the argument lists. Where 0.84.3 took an
 * optional trailing `abortSignal`, every session read, every session write,
 * every filesystem call and `compact` itself now take a required trailing
 * `context` — the structured context from `@earendil-works/chord`, which
 * carries cancellation, telemetry parentage and arbitrary keyed values down a
 * call tree the way Go's does.
 *
 * Volli does not adopt that shape. What this runtime holds and passes around is
 * an `AbortSignal`, because that is what the executor port hands it
 * (`SessionRuntimeSpec.signal`), what the DOM and Node both speak, and what
 * every other package here already understands. So the context exists at the
 * boundary and nowhere else: built from the signal we hold at the moment of the
 * call, handed to Pi, and forgotten.
 *
 * The two values are deliberately distinct rather than one nullable one:
 *
 * - {@link piContext} with a signal is a call a caller can still cancel, and
 *   cancelling it must reach Pi. Deriving from `BACKGROUND_CONTEXT` is what
 *   makes the signal Pi's cancellation rather than a parameter it ignores.
 * - {@link piContext} with nothing is `BACKGROUND_CONTEXT` itself: work no
 *   caller is waiting on and nobody can cancel. Cleanup is the honest case —
 *   it must run to completion precisely when the turn around it was abandoned,
 *   which is why Pi's own `withoutAbortSignal` exists for the same purpose.
 *
 * Pi also exports `TODO_CONTEXT`, a migration marker for call sites nobody has
 * thought about yet. Nothing here uses it: a call site that cannot say which of
 * the two cases above it is has not been ported, only silenced.
 */

import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/pi-agent-core";

export type { Context };

/**
 * The Pi context for one call, cancelled by `signal` when there is one.
 *
 * An already-aborted signal is passed through rather than short-circuited here:
 * Pi's own entry points check `context.abortSignal.aborted` and answer with
 * their typed aborted error, and inventing that error at this boundary would
 * put a second spelling of "was cancelled" in front of the one Pi already has.
 */
export function piContext(signal?: AbortSignal): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);
}
