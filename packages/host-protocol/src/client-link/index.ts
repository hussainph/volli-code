/**
 * `@volli/host-protocol/client-link`: the client host link (VC-670), one per
 * Workspace. Renderer-safe: `@trpc/client` and the platform WebSocket only;
 * no Node, no Electron, no `ws`.
 */
export * from "./link";
export * from "./host-scope-link";
export * from "./handshake-failure";
export * from "./policy";
export * from "./registry";
export * from "./trpc-link";
