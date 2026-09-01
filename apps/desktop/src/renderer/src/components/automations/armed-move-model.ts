/**
 * Renderer-facing import seam for the armed-column window model.
 *
 * The decision now lives in `@volli/shared` because Electron main owns the
 * durable pending arrival and its timer. Keeping this re-export lets the view
 * stay beside its rendering arithmetic without giving the renderer a second
 * copy of the automatic-Run policy.
 */
export {
  armedMoveDecision,
  armedRunProgress,
  armedRunSecondsLeft,
  armedRunVerdict,
  openArmedRun,
  type ArmedMoveDecision,
  type ArmedRunAbandonReason,
  type ArmedRunVerdict,
  type DeliberateMoveChoice,
  type PendingArmedRun,
  type PendingArmedRunOrigin,
} from "@volli/shared";
