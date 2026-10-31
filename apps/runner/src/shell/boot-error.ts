/**
 * A reason a headless daemon will not start that an operator has to fix: a
 * bad argument, a data directory or socket another process holds. A secret
 * key or store it cannot use is never one (VC-641): it boots with
 * credentials locked (`secrets.ts`). It exits with {@link EXIT_CONFIG}
 * (sysexits' `EX_CONFIG`), which a systemd unit lists in
 * `RestartPreventExitStatus=` so a misconfiguration is reported once instead
 * of restarted in a loop.
 */
export const EXIT_CONFIG = 78;

/** The refusals the shell itself raises; a daemon adds its own. */
export type BootFailure = "usage" | "data-dir" | "socket" | "already-running";

export class BootError<Reason extends string = BootFailure> extends Error {
  readonly reason: Reason;
  readonly fields: Readonly<Record<string, unknown>>;

  constructor(reason: Reason, message: string, fields: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "BootError";
    this.reason = reason;
    this.fields = fields;
  }
}
