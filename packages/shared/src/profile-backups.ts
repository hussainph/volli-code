/** Machine-local backup projection. Bundle contents never cross this boundary. */
export interface ProfileBackupStatus {
  running: boolean;
  lastBackup: { createdAt: number; sizeBytes: number } | null;
  /** The latest skipped/failed attempt, or a pause during the current attempt. */
  notice: string | null;
}
