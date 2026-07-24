// This directory is the terminal/PTY subsystem, being split out of the
// former monolithic `pty.ts` per issue #99. This barrel is the module's
// public surface — import from "./pty" (or "../pty"), not from "./pty/manager" directly.

export { PtyManager } from "./manager";
export type { AgentRuntimeEnvironment } from "./manager";
export { confirmDestructiveClose, registerTerminalIpcHandlers } from "./ipc";
