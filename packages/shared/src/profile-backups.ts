/** Machine-local backup projection. Bundle contents never cross this boundary. */
export interface ProfileBackupStatus {
  /** Durable revision of the latest accepted backup attempt. */
  revision: string;
  running: boolean;
  lastBackup: { createdAt: number; sizeBytes: number } | null;
  /** The latest skipped/failed attempt, or a pause during the current attempt. */
  notice: string | null;
}
