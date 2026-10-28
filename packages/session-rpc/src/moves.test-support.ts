import type { CloudMovePreflight, CloudMoveSnapshot } from "@volli/shared";
export const MOVE_SNAPSHOT: CloudMoveSnapshot = {
  revision: 1,
  account: null,
  workspaces: [],
  moves: [],
  unavailable: null,
};
export const MOVE_PREFLIGHT: CloudMovePreflight = {
  id: "dry-run",
  projects: [],
  backupDirectory: "/profile/backups",
  disk: { requiredBytes: 1024, freeBytes: 2048 },
  stopAtFirstProblem: true,
  exclusions: [],
};
