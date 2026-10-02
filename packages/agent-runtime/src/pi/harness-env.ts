/** Product-owned Pi 0.99.2 execution compatibility; Pi 1.0 no longer ships this harness. */
export { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "./vendor/pi-harness/context";
export { NodeExecutionEnv } from "./vendor/pi-harness/env/nodejs";
export {
  err,
  ExecutionError,
  FileError,
  type AgentHarnessTool,
  type AgentHarnessToolInvocation,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputCaptureOptions,
  type ShellOutputMetadata,
  type ShellOutputUpdate,
  type ShellOutputView,
} from "./vendor/pi-harness/types";
export {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditToolDetails,
  type ExecutionToolContext,
  type ReadImageProcessor,
} from "./vendor/pi-harness/tools/index";
export type { JsonValue } from "./vendor/pi-harness/session/types";
export { applyShellOutputUpdate } from "./vendor/pi-harness/execution/output-capture";
export {
  executeShellWithCapture,
  sanitizeBinaryOutput,
  type ShellCaptureOptions,
  type ShellCaptureResult,
} from "./vendor/pi-harness/execution/shell-output";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
  utf8ByteLength,
} from "./vendor/pi-harness/utils/truncate";
