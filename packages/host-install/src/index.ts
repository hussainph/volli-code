/**
 * `@volli/host-install`: add a host over SSH (VC-700). Electron-free, so the
 * desktop's main process, a future CLI and a control plane share it.
 * The box-side contract is also exported alone, at `/contract`.
 */
export * from "./artifact";
export * from "./contract";
export * from "./failures";
export * from "./logger";
export * from "./probe";
export * from "./provision";
export * from "./remote-hosts";
export * from "./remote-hosts-device-key";
export * from "./remote-hosts-link";
export * from "./remote-hosts-registry";
export * from "./ssh-provider";
export * from "./ssh";
export * from "./target";
export * from "./tunnel";

// The hostd clone path uses the same pure URL admission rules as SSH creation.
export { gitUrlProblem, repositoryName } from "./remote-hosts-projects";
