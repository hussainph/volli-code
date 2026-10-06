/**
 * `@volli/host-install`: add a host over SSH (VC-700). Electron-free, so the
 * desktop's main process, a future CLI and a control plane share it.
 * The box-side contract is also exported alone, at `/contract`.
 */
export * from "./contract";
