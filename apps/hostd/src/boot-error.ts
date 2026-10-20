/**
 * A reason hostd will not start that an operator has to fix: a bad argument,
 * a data directory or socket another process holds. A secret key or store it
 * cannot use is never one (VC-641): hostd boots with credentials locked
 * (`secrets.ts`). It exits with {@link EXIT_CONFIG} (sysexits' `EX_CONFIG`), which the
 * systemd unit lists in `RestartPreventExitStatus=` so a misconfiguration is
 * reported once instead of restarted in a loop.
 */
export const EXIT_CONFIG = 78;

export type HostdBootFailure =
  | "usage"
  | "data-dir"
  | "socket"
  | "already-running"
  | "operators"
  | "devices"
  | "host-protocol";

export class HostdBootError extends Error {
  readonly reason: HostdBootFailure;
  readonly fields: Readonly<Record<string, unknown>>;

  constructor(
    reason: HostdBootFailure,
    message: string,
    fields: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HostdBootError";
    this.reason = reason;
    this.fields = fields;
  }
}
