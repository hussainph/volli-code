import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers";
import { createSessionEngine } from "@volli/session-engine";
import type { SessionEngine } from "@volli/session-engine";
import type { SessionLedger } from "@volli/shared";
import { createCheckpointFailureReporter } from "../session-control/checkpoint-diagnostics";

/** Private Sessions construction: callers must use the composed host engine. */
export function createHostSessionEngine(
  ledger: SessionLedger,
  ports: {
    now?: () => number;
    nextId?: () => string;
    /** Reporter override for isolated checkpoint-diagnostics tests. */
    onProjectionCheckpointFailure?: (error: unknown) => void;
  } = {},
): SessionEngine {
  const now = ports.now ?? Date.now;
  const nextId = ports.nextId ?? randomUUID;
  return createSessionEngine({
    ledger,
    clock: { now },
    ids: { next: () => nextId() },
    onProjectionCheckpointFailure:
      ports.onProjectionCheckpointFailure ?? createCheckpointFailureReporter(),
    yieldToHost: yieldToMainProcess,
  });
}

/**
 * The main process's turn of its event loop, for a roster fold that spans
 * many Sessions (VC-388).
 *
 * `setImmediate` lands in the check phase with no floor; the engine's own
 * default is `setTimeout(0)`, which Node clamps to a millisecond, and that
 * clamp is paid once per chunk. The engine owns no Node API, so the faster
 * spelling is this host's to supply.
 */
function yieldToMainProcess(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
