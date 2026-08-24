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
 *  - success navigates to the fresh Session — the adopt + open pair every
 *    other externally-minted Session already uses.
 */
import type { AutomationRunStartResult } from "../../../../ipc/contract";

export type RunAutomationAction =
  | { kind: "open-model-access" }
  | { kind: "toast"; message: string }
  | { kind: "open-session"; sessionId: string; projectId: string };

export function runAutomationAction(result: AutomationRunStartResult): RunAutomationAction {
  if (result.ok) {
    return { kind: "open-session", sessionId: result.run.sessionId, projectId: result.projectId };
  }
  if (result.code === "MODEL_REQUIRED") return { kind: "open-model-access" };
  return { kind: "toast", message: `Couldn't run automation: ${result.error}` };
}
