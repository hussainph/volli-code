/** Error identity crosses the worker codec; prose never selects recovery policy. */
export type ProfileBackupFailureCode = "disk-space" | "verification" | "cancelled" | "io";

export class ProfileBackupError extends Error {
  constructor(
    readonly code: ProfileBackupFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProfileBackupError";
  }
}
