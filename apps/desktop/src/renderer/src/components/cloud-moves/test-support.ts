import { vi } from "vite-plus/test";
import type {
  CloudMovePreflight,
  CloudMoveSnapshot,
  CloudMoveStatus,
  CloudMovesApi,
} from "@volli/shared";

export const counts = {
  tickets: 12,
  sessions: 30,
  events: 400,
  attachments: 2,
  attachmentBytes: 2048,
  transcriptBytes: 4096,
  piLogBytes: 8192,
};
export const preflight: CloudMovePreflight = {
  id: "dry-run",
  backupDirectory: "/profile/backups",
  disk: { requiredBytes: 1024, freeBytes: 8192 },
  stopAtFirstProblem: true,
  exclusions: [{ label: "Automations", count: 2, reason: "Kept paused until you re-arm them" }],
  projects: [
    {
      id: "project",
      name: "Atlas",
      removed: false,
      counts,
      estimateSeconds: 150,
      blockers: [],
      exclusions: [{ label: "Machine settings", reason: "Only used on this Mac" }],
      warnings: [],
    },
  ],
};
export const move: CloudMoveStatus = {
  moveId: "move",
  queueId: "queue",
  projectId: "project",
  projectName: "Atlas",
  workspaceName: "My team",
  state: "moving",
  step: "upload",
  completedSteps: ["backup", "freeze", "export"],
  message: "Uploading files.",
  progress: { completed: 10, total: 20, unit: "bytes" },
  estimateSeconds: 120,
  actions: ["pause", "cancel"],
  localReadOnly: true,
  confirmedAt: null,
  backupPath: "/profile/backups/safety.tar.gz",
  returnExportPath: "/profile/cloud-moves/move/cloud-changes",
  checks: [],
  counts,
  pausedAutomations: [],
  localCredentials: [],
};
export const snapshot: CloudMoveSnapshot = {
  revision: 1,
  account: { userId: "person", displayName: "Alex" },
  workspaces: [{ id: "workspace", name: "My team", canMove: true }],
  moves: [],
  unavailable: null,
};
export function fakeApi() {
  return {
    snapshot: vi.fn<CloudMovesApi["snapshot"]>().mockResolvedValue(structuredClone(snapshot)),
    preflight: vi.fn<CloudMovesApi["preflight"]>().mockResolvedValue(structuredClone(preflight)),
    start: vi.fn<CloudMovesApi["start"]>().mockResolvedValue(undefined),
    command: vi.fn<CloudMovesApi["command"]>().mockResolvedValue(undefined),
    report: vi.fn<CloudMovesApi["report"]>().mockResolvedValue('{"ok":true}'),
    onChanged: vi.fn<CloudMovesApi["onChanged"]>().mockReturnValue(() => {}),
  } satisfies CloudMovesApi;
}
