/**
 * `@volli/host-core/log`: the host's structured, correlated log (VC-699).
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export {
  currentTrace,
  type LogContextFields,
  logContext,
  mintSpanId,
  mintTraceId,
  withLogContext,
  withRootLogContext,
  withTrace,
} from "../log/context";
export {
  commandTrace,
  MAX_REMEMBERED,
  rememberCommandTrace,
  rememberTurnTrace,
  resetLogCorrelation,
  turnTrace,
} from "../log/correlation";
export {
  createRotatingFileSink,
  LOG_FILE_POLICY,
  type LogFileFailure,
  type LogFileHandle,
  type LogFilePolicy,
  type LogFileSystem,
  NODE_LOG_FILE_SYSTEM,
  reportToStderr,
  type RotatingFileSink,
  type RotatingFileSinkOptions,
} from "../log/file-sink";
export {
  buildLogRecord,
  createLogger,
  type LogFields,
  type Logger,
  type LogRoot,
  type LogSink,
  MAX_LOG_LINE_BYTES,
} from "../log/logger";
export {
  createLogRing,
  LOG_PAGE_LIMIT,
  LOG_RING_BOUNDS,
  type LogRing,
  type LogRingBounds,
} from "../log/ring";
export { hostLogger, hostLogLevel, installHostLog } from "../log/root";
export { consoleSink, jsonLineSink, teeSinks } from "../log/sinks";
export {
  SSH_INSTALL_STEPS,
  type SshInstallStep,
  startStepLog,
  type StepLog,
  type StepLogOptions,
} from "../log/steps";
