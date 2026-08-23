/**
 * What Settings → Agent telemetry draws, from the one view main answers with.
 *
 * A pure fold, extracted for the reason `web-access-model.ts` was: the pane
 * itself is I/O and drawing, and the decision worth checking is which of three
 * states a person is in — off, exporting, or enabled and not landing. None of
 * that needs a DOM.
 *
 * The notice is the exception to "let controls talk" that `AGENTS.md` names: a
 * blocked state with one recovery action. There is no notice at all for the
 * working case and none for the off case, because a switch that is off is not a
 * problem to explain.
 */
import type { AgentObservabilityView } from "../../../../ipc/contract";

export interface AgentObservabilityPanel {
  enabled: boolean;
  /** Beside the dot: three words, not a sentence. */
  stateLabel: string;
  /** `ready` while telemetry is landing, `idle` when off, `error` when not. */
  dotState: "ready" | "idle" | "error";
  /** The latched sentence, or nothing. Never a dependency's message. */
  problem: string | null;
}

export function agentObservabilityPanel(view: AgentObservabilityView): AgentObservabilityPanel {
  if (!view.enabled) {
    return { enabled: false, stateLabel: "Off", dotState: "idle", problem: null };
  }
  if (view.status === "failed") {
    return {
      enabled: true,
      stateLabel: "Not delivering",
      dotState: "error",
      problem: view.problem,
    };
  }
  return { enabled: true, stateLabel: "Exporting", dotState: "ready", problem: null };
}
