/** Host protocol types and guards (host-protocol.md). No transport/Node/Electron;
 * the test-only contract harness is exported separately at /testing. */
export * from "./actor";
export * from "./commands";
export * from "./errors";
export * from "./handshake";
export * from "./identity";
export type { IsJsonSafe, JsonUnsafeProcedures } from "./json-safe";
