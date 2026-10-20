import { afterEach, describe, expect, it } from "vite-plus/test";
import { REMOTE_HOST_HEALTH_LIMITS } from "@volli/shared";
import { remoteHostsSnapshotSchema } from "../../session-rpc/src/remote-hosts-schema";
import { harness, hostEntry, registry } from "./testing/remote-hosts-harness";

const h = harness({ registry: registry(hostEntry()) });
afterEach(async () => {
  await h.engine.close();
});
const base = h.engine.snapshot();
const accepts = (hostScope: unknown) =>
  remoteHostsSnapshotSchema.safeParse({
    ...base,
    hosts: [{ ...base.hosts[0], hostScope }],
  }).success;

describe("actual hostScope output validator", () => {
  it("is additive, bounded, and has an explicitly closed status enum", () => {
    expect(accepts(undefined)).toBe(true);
    for (const status of ["connecting", "ready", "older", "unavailable"])
      expect(accepts({ status, granted: [] })).toBe(true);
    expect(accepts({ status: "unknown", granted: [] })).toBe(false);
    expect(
      accepts({ status: "ready", granted: ["x".repeat(REMOTE_HOST_HEALTH_LIMITS.feature)] }),
    ).toBe(true);
    expect(
      accepts({ status: "ready", granted: ["x".repeat(REMOTE_HOST_HEALTH_LIMITS.feature + 1)] }),
    ).toBe(false);
    expect(
      accepts({
        status: "ready",
        granted: Array(REMOTE_HOST_HEALTH_LIMITS.features).fill("feature"),
      }),
    ).toBe(true);
    expect(
      accepts({
        status: "ready",
        granted: Array(REMOTE_HOST_HEALTH_LIMITS.features + 1).fill("feature"),
      }),
    ).toBe(false);
    const json = remoteHostsSnapshotSchema.toJSONSchema();
    expect(JSON.stringify(json)).toContain('"enum":["connecting","ready","older","unavailable"]');
  });
});
