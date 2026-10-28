import type { CloudMoveStep, CloudMoveStatus } from "@volli/shared";

export const MOVE_STATE_LABELS: Record<CloudMoveStatus["state"], string> = {
  queued: "Waiting",
  moving: "Moving",
  waiting: "Paused",
  problem: "Needs you",
  check: "Check it",
  finished: "Moved",
  "rolled-back": "Rolled back",
  returned: "Back on this Mac",
};

export function movePercent(progress: CloudMoveStatus["progress"]): string {
  if (progress === null || progress.total <= 0) return "";
  return ` ${Math.min(100, Math.max(0, Math.floor((progress.completed / progress.total) * 100)))} %`;
}

export const MOVE_STEP_LABELS: Record<CloudMoveStep, string> = {
  backup: "Backup",
  freeze: "Read-only copy",
  export: "Prepare files",
  upload: "Upload files",
  copy: "Copy records",
  history: "Session history",
  verify: "Check every record",
  handover: "Keep folders and worktrees",
  check: "Check in Volli Cloud",
};

export function moveTime(seconds: number | null): string {
  if (seconds === null) return "Time estimate not yet available";
  if (seconds < 60) return "About a minute";
  return `About ${Math.ceil(seconds / 60).toLocaleString()} min`;
}
