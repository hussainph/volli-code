import type {
  CloudMovePreflightPhase,
  CloudMovePreflightProgress,
  CloudMoveStep,
  CloudMoveStatus,
} from "@volli/shared";

export const MOVE_STATE_LABELS: Record<CloudMoveStatus["state"], string> = {
  queued: "Waiting",
  moving: "Moving",
  waiting: "Waiting",
  problem: "Needs you",
  check: "Check it",
  finished: "Moved",
  "rolled-back": "Rolled back",
  returned: "Back on this Mac",
};

export function movePercentLabel(progress: CloudMoveStatus["progress"]): string {
  if (progress === null || progress.total <= 0) return "";
  return `${Math.min(100, Math.max(0, Math.floor((progress.completed / progress.total) * 100)))} %`;
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

export const PREFLIGHT_PHASE_LABELS: Record<CloudMovePreflightPhase, string> = {
  starting: "Starting",
  checking: "Checking for unfinished work",
  snapshot: "Taking a snapshot",
  reading: "Reading the project",
  exporting: "Exporting records",
  history: "Checking transcripts and Pi logs",
  verifying: "Verifying the export",
  planning: "Planning the move",
  sizing: "Measuring backup space",
};

/** One line for a running dry run: where it is, and how far along when it can count. */
export function preflightProgressLabel(progress: CloudMovePreflightProgress): string {
  const parts: string[] = [];
  if (progress.projectIndex > 0)
    parts.push(
      `Project ${progress.projectIndex.toLocaleString()} of ${progress.projectCount.toLocaleString()}`,
    );
  if (progress.projectName !== null) parts.push(progress.projectName);
  let phase = PREFLIGHT_PHASE_LABELS[progress.phase];
  if (progress.done !== null && progress.unit !== null)
    phase +=
      progress.total === null
        ? ` · ${progress.done.toLocaleString()} ${progress.unit}`
        : ` · ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} ${progress.unit}`;
  parts.push(phase);
  return parts.join(" · ");
}
