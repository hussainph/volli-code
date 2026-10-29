/** Machine-local restore commands. No bundle contents or credentials cross the bridge. */
export interface ProfileRestoreProject {
  id: string;
  name: string;
  directory: string | null;
}
export interface ProfileRestoreBundle {
  fileName: string;
  createdAt: number;
  sizeBytes: number;
  verification: "verified" | "failed" | "unknown";
  keptForMove: boolean;
}
export interface ProfileRestoreStatus {
  revision: string;
  phase: "idle" | "checking" | "mapping" | "staging" | "ready" | "failed" | "cancelled";
  bundles: ProfileRestoreBundle[];
  selectedFile: string | null;
  projects: ProfileRestoreProject[];
  /** Bounded-work checkpoints completed, not an invented percentage. */
  checkpoints: number;
  paused: boolean;
  problems: { kind: string; message: string }[];
  credentialsMessage: string | null;
  previousProfile: string | null;
}
export interface ProfileRestorePort {
  status(): Promise<ProfileRestoreStatus>;
  choose(fileName?: string): Promise<ProfileRestoreStatus>;
  directory(): Promise<string | null>;
  start(
    expectedRevision: string,
    projectPaths: Record<string, string>,
  ): Promise<ProfileRestoreStatus>;
  cancel(expectedRevision: string): Promise<ProfileRestoreStatus>;
  restart(expectedRevision: string): Promise<void>;
}
