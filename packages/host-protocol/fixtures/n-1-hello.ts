/** Frozen pre-VC-722 v1 hello grammar. Do not import the current parser here:
 * this is refusal evidence for an old peer, not an old host process smoke. */
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function nMinusOneReadsHello(value: unknown): boolean {
  if (!record(value) || !record(value.client) || !record(value.protocol)) return false;
  return (
    positive(value.protocol.min) &&
    positive(value.protocol.max) &&
    (value.protocol.min as number) <= (value.protocol.max as number) &&
    ["desktop", "web", "mobile", "cli", "worker"].includes(value.client.kind as string) &&
    typeof value.client.version === "string" &&
    value.client.version.length <= 128 &&
    uuid(value.workspaceId) &&
    (value.lastSeen === null ||
      (record(value.lastSeen) &&
        typeof value.lastSeen.epoch === "number" &&
        Number.isSafeInteger(value.lastSeen.epoch) &&
        value.lastSeen.epoch >= 0 &&
        uuid(value.lastSeen.hostId))) &&
    Array.isArray(value.features) &&
    value.features.length <= 256 &&
    value.features.every(
      (f) =>
        typeof f === "string" &&
        f.length <= 128 &&
        /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(f),
    ) &&
    typeof value.credential === "string" &&
    value.credential.length > 0 &&
    value.credential.length <= 8192 &&
    typeof value.nonce === "string" &&
    /^[A-Za-z0-9_-]{22,128}$/u.test(value.nonce)
  );
}
