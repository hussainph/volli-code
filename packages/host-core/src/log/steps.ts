/**
 * A person-started flow of named steps, logged as one trace (VC-699).
 *
 * The "Add a host over SSH" flow (VC-700) is the first: probe → upload →
 * unit → start → pair → connect. The desktop mints the flow's trace when the
 * person presses Add; every step logs `step started` and `step done` (with
 * its duration) or `step failed` (with the error), under the flow's
 * component, and every line written inside a step (an ssh child's, the
 * pairing's, the host link's first connect) carries the same trace. The
 * checklist's Details is the log viewer filtered to that trace
 * (`LogStream` with `{ traceId }`), so the checklist and the log are one
 * record.
 *
 * ```ts
 * const install = startStepLog({ component: "ssh-install", flow: "install", traceId, fields: { host: label } });
 * await install.step("probe", () => probe(target));
 * await install.step("upload", () => upload(target, artifact), { bytes: artifact.size });
 * install.done();
 * ```
 */
import { isTraceId } from "@volli/shared";

import { mintSpanId, mintTraceId, withTrace } from "./context";
import type { LogFields } from "./logger";
import { hostLogger } from "./root";

/** The "Add a host over SSH" steps, in order (HP § Decided 1). */
export const SSH_INSTALL_STEPS = ["probe", "upload", "unit", "start", "pair", "connect"] as const;
export type SshInstallStep = (typeof SSH_INSTALL_STEPS)[number];

export interface StepLog {
  /** The flow's trace: give it to the viewer, the host link and every request the flow makes. */
  readonly traceId: string;
  /** Runs one step inside the flow's trace, logging its start and its outcome; rethrows a failure. */
  step<Result>(
    name: string,
    run: () => Result | Promise<Result>,
    fields?: LogFields,
  ): Promise<Result>;
  /** A line of the flow's own, between steps. */
  info(msg: string, fields?: LogFields): void;
  /** The flow finished; logs its whole duration. */
  done(fields?: LogFields): void;
  /** The flow stopped on `error`; logs it with the step it was in, if any. */
  failed(error: unknown, fields?: LogFields): void;
}

export interface StepLogOptions {
  /** The log component every line names: `ssh-install`. */
  readonly component: string;
  /** What the flow is, in its lines: `install`. */
  readonly flow: string;
  /** The trace the Client minted for the flow; a fresh one when absent or malformed. */
  readonly traceId?: string;
  /** Identifiers on every line: the host's label, never a credential. */
  readonly fields?: LogFields;
  readonly now?: () => number;
}

export function startStepLog(options: StepLogOptions): StepLog {
  const now = options.now ?? Date.now;
  const started = now();
  const log = hostLogger(options.component, { flow: options.flow, ...options.fields });
  // The flow's trace: the Client's when it is one, otherwise minted once here.
  const traceId = isTraceId(options.traceId) ? options.traceId : mintTraceId();
  const inFlow = <Result>(fields: Record<string, string | undefined>, run: () => Result): Result =>
    withTrace({ traceId, spanId: mintSpanId() }, fields, run);
  let current: string | undefined;

  inFlow({}, () => log.info(`${options.flow} started`));
  return {
    traceId,
    async step(name, run, fields = {}) {
      return inFlow({ step: name }, async () => {
        const at = now();
        current = name;
        log.info("step started", fields);
        try {
          const result = await run();
          log.info("step done", { ...fields, durationMs: now() - at });
          return result;
        } catch (error) {
          log.error("step failed", { ...fields, durationMs: now() - at, error });
          throw error;
        } finally {
          current = undefined;
        }
      });
    },
    info: (msg, fields) => inFlow({}, () => log.info(msg, fields)),
    done: (fields = {}) =>
      inFlow({}, () =>
        log.info(`${options.flow} done`, { ...fields, durationMs: now() - started }),
      ),
    failed: (error, fields = {}) =>
      inFlow({ step: current }, () =>
        log.error(`${options.flow} failed`, { ...fields, durationMs: now() - started, error }),
      ),
  };
}
