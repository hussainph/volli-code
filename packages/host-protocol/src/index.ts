/**
 * `@volli/host-protocol`: the versioned, capability-negotiated contract every
 * client and worker speaks to a host. The spec is `docs/plans/host-protocol.md`.
 *
 * Types and small runtime guards only. There is no transport here and no
 * `electron` import, directly or transitively. The contract-test harness lives
 * at `@volli/host-protocol/testing`, for tests alone.
 */
export * from "./actor";
export * from "./commands";
export * from "./errors";
export * from "./handshake";
export * from "./identity";
export type { IsJsonSafe, JsonUnsafeProcedures } from "./json-safe";
