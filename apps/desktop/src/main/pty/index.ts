// The desktop half of the terminal subsystem: the Electron IPC adapter over
// host-core's terminal supervisor (`@volli/host-core/pty`, VC-560).
// This barrel is the adapter's public surface — import from "./pty" (or
// "../pty"), not from "./pty/ipc" directly.

export {
  confirmDestructiveClose,
  desktopPtyHost,
  prepareTerminalQuit,
  registerTerminalIpcHandlers,
} from "./ipc";
