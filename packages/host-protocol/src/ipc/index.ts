/**
 * `@volli/host-protocol/ipc`: the router-generic IPC bridge's wire and its
 * client link (VC-608). Renderer-safe: `@trpc/client` only; no Node, no
 * Electron. The server half is `@volli/host-protocol/ipc-server`.
 */
export * from "./link";
export * from "./wire";
