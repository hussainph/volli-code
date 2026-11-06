import type { CloudMovePreflight, CloudMoveSnapshot } from "@volli/shared";
export const MOVE_SNAPSHOT: CloudMoveSnapshot = {
  revision: 1,
  account: null,
  workspaces: [],
  moves: [],
  unavailable: null,
  preflight: null,
};
export const MOVE_REARM_SNAPSHOT: CloudMoveSnapshot = {
  ...MOVE_SNAPSHOT,
  moves: [
    {
      moveId: "move",
      queueId: "queue",
      projectId: "project",
      projectName: "Atlas",
      workspaceName: "Workspace",
      state: "finished",
      step: "check",
      completedSteps: [],
      message: "Moved to Volli Cloud.",
      progress: null,
      estimateSeconds: null,
      actions: ["open-cloud", "re-arm"],
      localReadOnly: true,
      confirmedAt: 1,
      backupPath: null,
      returnExportPath: "/export",
      rollback: null,
      checks: [],
      counts: null,
      pausedAutomations: [],
      localCredentials: [],
      automationRearm: {
        columns: [{ automationId: "column", name: "Review", status: "doing" }],
        schedules: [{ automationId: "schedule", name: "Nightly" }],
        inertGlobals: [{ id: "global", name: "Personal helper" }],
        canRearmOnThisMac: true,
        unavailable: null,
        retryable: false,
      },
    },
  ],
};
export const MOVE_PREFLIGHT: CloudMovePreflight = {
  id: "dry-run",
  projects: [],
  backupDirectory: "/profile/backups",
  disk: { requiredBytes: 1024, freeBytes: 2048 },
  stopAtFirstProblem: true,
  exclusions: [],
};
