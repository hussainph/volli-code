/**
 * What the renderer does with a Run door's answer — the decision, kept pure
 * so the gate can reach it; the store/navigation glue lives in
 * `run-automation.ts` beside it.
 *
 * Three arms and no fourth:
 *  - a missing default model is a predictable configuration state whose
 *    recovery is Model Access, so it opens Settings instead of toasting
 *    (VC-53's classification, matched by CODE here rather than by string —
 *    the door carries one);
 *  - every other refusal toasts, because a person asked for a Run and did not
 *    get one (surface-every-failure, CLAUDE.md);
 *  - success exposes the fresh Session and the launch-time Automation name so
 *    every Run door can announce it without navigating (VC-234). The toast's
 *    "Open session" action is the only route into the fresh Session.
 */
import type { AutomationRunStartResult } from "../../../../ipc/contract";

export type RunAutomationAction =
  | { kind: "open-model-access" }
  | { kind: "toast"; message: string }
  | {
      kind: "session-started";
      sessionId: string;
      projectId: string;
      /** The name main resolved into both the Run record and Session title. */
      automationName: string | null;
    };

export function runAutomationAction(result: AutomationRunStartResult): RunAutomationAction {
  if (result.ok) {
    return {
      kind: "session-started",
      sessionId: result.run.sessionId,
      projectId: result.projectId,
      automationName: result.run.automationName,
    };
  }
  if (result.code === "MODEL_REQUIRED") return { kind: "open-model-access" };
  return { kind: "toast", message: `Couldn't run automation: ${result.error}` };
}
