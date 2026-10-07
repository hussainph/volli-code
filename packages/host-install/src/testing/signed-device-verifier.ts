/** Actual enrolled P-256 credentials for loopback protocol tests. No permissive grants. */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  parseDeviceCredential,
  type HostCredentialVerifier,
  type ParsedDeviceCredential,
} from "@volli/host-protocol";

export function signedDeviceVerifier(hostId: string, now: () => number) {
  const enrolled = new Map<string, KeyObject>();
  const seen = new Set<string>();
  const accepted: ParsedDeviceCredential[] = [];
  const verifier: HostCredentialVerifier = {
    verify(presentation) {
      const parsed = parseDeviceCredential(presentation.credential);
      if (parsed === null) return null;
      const { claims } = parsed;
      const key = enrolled.get(claims.deviceId);
      const seconds = Math.floor(now() / 1000);
      if (
        key === undefined ||
        claims.hostId !== hostId ||
        claims.iat > seconds ||
        claims.exp <= seconds ||
        seen.has(claims.jti)
      )
        return null;
      const hostScope = "scope" in claims;
      if (hostScope !== "scope" in presentation) return null;
      if (
        !hostScope &&
        !("scope" in presentation) &&
        claims.workspaceId !== presentation.workspaceId
      )
        return null;
      if (
        !verify(
          "sha256",
          Buffer.from(parsed.signingInput, "ascii"),
          { key, dsaEncoding: "ieee-p1363" },
          parsed.signature,
        )
      )
        return null;
      seen.add(claims.jti);
      accepted.push(parsed);
      return {
        actor: hostScope
          ? { scope: "host", kind: "device", deviceId: claims.deviceId }
          : { kind: "device", deviceId: claims.deviceId, workspaceId: claims.workspaceId },
        current: () =>
          enrolled.get(claims.deviceId) === key && Math.floor(now() / 1000) < claims.exp,
      };
    },
  };
  return {
    verifier,
    accepted,
    enrolled,
    enroll(deviceId: string, publicKey: KeyObject | string) {
      enrolled.set(
        deviceId,
        typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey,
      );
    },
  };
}
