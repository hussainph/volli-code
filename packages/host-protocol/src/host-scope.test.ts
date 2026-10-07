import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { nMinusOneReadsHello } from "../fixtures/n-1-hello";
import {
  assembleDeviceCredential,
  bytesToBase64Url,
  deviceCredentialSigningInput,
  buildHostHello,
  encodeHostHello,
  readHostHello,
  HOST_SCOPE_FEATURES,
  HOST_SCOPE_PROOF_LIMITS,
  HOST_PROTOCOL_VERSIONS,
  hostError,
  isHostActor,
  isHostConnectionActor,
  isHostScopeActor,
  isHostHello,
  isHostScopeHello,
  isHostConnectionHello,
  isHostWelcome,
  isHostScopeWelcome,
  isHostConnectionWelcome,
  isDeviceCredentialClaims,
  isHostScopeDeviceCredentialClaims,
  parseDeviceCredential,
  negotiateWelcome,
  validateWelcome,
  operationsGrantedBy,
  REFUSING_CREDENTIAL_VERIFIER,
  type HostHello,
  type HostWelcome,
  type HostScopeHello,
  type HostScopeWelcome,
  type HostScopeOffer,
  type HostScopeActor,
  type HostActor,
  type HostOffer,
  type HostScopeDeviceCredentialClaims,
} from "./index";

const hostId = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const deviceId = "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const workspaceId = "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const hello: HostScopeHello = {
  scope: "host",
  protocol: HOST_PROTOCOL_VERSIONS,
  client: { kind: "desktop", version: "1" },
  features: [...HOST_SCOPE_FEATURES, "sessions", "unknown"],
  credential: "test-credential",
  nonce: "AAAAAAAAAAAAAAAAAAAAAA",
};
const actor: HostScopeActor = { scope: "host", kind: "device", deviceId };
const offer: HostScopeOffer = {
  scope: "host",
  host: { id: hostId, version: "1" },
  protocol: HOST_PROTOCOL_VERSIONS,
  features: [...HOST_SCOPE_FEATURES, "sessions", "unknown"],
};
const welcome: HostScopeWelcome = {
  scope: "host",
  protocolVersion: 1,
  host: offer.host,
  actor,
  features: [...HOST_SCOPE_FEATURES],
  proof: null,
};
const workspaceHello: HostHello = {
  protocol: hello.protocol,
  client: hello.client,
  features: ["sessions"],
  credential: hello.credential,
  nonce: hello.nonce,
  workspaceId,
  lastSeen: null,
};
const workspaceActor: HostActor = { kind: "device", deviceId, workspaceId };
const workspaceOffer: HostOffer = {
  host: offer.host,
  protocol: offer.protocol,
  workspace: { id: workspaceId, epoch: 0 },
  features: ["sessions"],
};
const workspaceWelcome: HostWelcome = {
  host: offer.host,
  protocolVersion: 1,
  workspace: workspaceOffer.workspace,
  actor: workspaceActor,
  features: ["sessions"],
  proof: null,
};
const claims: HostScopeDeviceCredentialClaims = {
  scope: "host",
  hostId,
  deviceId,
  iat: 1_800_000_000,
  exp: 1_800_000_060,
  jti: hello.nonce,
};
const frame = (value: unknown) =>
  assembleDeviceCredential(
    `vdc1.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))}`,
    new Uint8Array(64),
  );

describe("host-scoped v1 handshake", () => {
  it("builds and reads a fresh host hello without Workspace fields", () => {
    const first = buildHostHello({
      scope: "host",
      client: hello.client,
      features: hello.features,
      credential: hello.credential,
    });
    const second = buildHostHello({ ...hello });
    expectTypeOf(first).toEqualTypeOf<HostScopeHello>();
    expect(first.protocol).toBe(HOST_PROTOCOL_VERSIONS);
    expect(second.protocol).toBe(hello.protocol);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first).not.toHaveProperty("workspaceId");
    expect(first).not.toHaveProperty("lastSeen");
    expect(isHostHello(first)).toBe(false);
    expect(isHostScopeHello(first)).toBe(true);
    expect(readHostHello(encodeHostHello(first))).toEqual(first);
    expect(isHostConnectionHello(workspaceHello)).toBe(true);
  });

  it("refuses mixed scopes, including null and undefined Workspace fields", () => {
    for (const value of [
      null,
      [],
      { ...hello, scope: "workspace" },
      { ...hello, workspaceId },
      { ...hello, workspaceId: null },
      { ...hello, workspaceId: undefined },
      { ...hello, lastSeen: null },
      { ...hello, lastSeen: undefined },
      { ...hello, nonce: "bad" },
      { ...workspaceHello, scope: "host" },
      { ...workspaceHello, scope: null },
      { ...workspaceHello, scope: "workspace" },
    ])
      expect(isHostConnectionHello(value)).toBe(false);
    expect(
      readHostHello({ "volli-hello": JSON.stringify({ ...hello, lastSeen: null }) }),
    ).toBeNull();
  });

  it("permits only remote device host actors, never Sessions or workers", () => {
    expect(isHostScopeActor(actor)).toBe(true);
    expect(isHostConnectionActor(actor)).toBe(true);
    expect(isHostConnectionActor(workspaceActor)).toBe(true);
    expect(isHostActor(actor)).toBe(false);
    for (const value of [
      null,
      [],
      { ...actor, scope: null },
      { ...actor, kind: "session" },
      { ...actor, kind: "worker" },
      { ...actor, deviceId: "local" },
      { ...actor, deviceId: "bad" },
      { ...actor, workspaceId: null },
      { ...actor, sessionId: "s" },
      { ...actor, workerId: deviceId },
      { ...workspaceActor, scope: "host" },
    ])
      expect(isHostConnectionActor(value)).toBe(false);
  });

  it("negotiates only host features, and keeps old typed callers narrow", () => {
    const negotiated = negotiateWelcome(hello, offer, actor);
    if (!negotiated.ok) throw new Error("refused");
    expectTypeOf(negotiated.welcome).toEqualTypeOf<HostScopeWelcome>();
    expect(negotiated.welcome).toEqual(welcome);
    const legacy = negotiateWelcome(workspaceHello, workspaceOffer, workspaceActor);
    if (!legacy.ok) throw new Error("refused");
    expectTypeOf(legacy.welcome).toEqualTypeOf<HostWelcome>();
    expect(legacy.welcome).toEqual(workspaceWelcome);
    expect([...operationsGrantedBy(["host.workspaces"])]).toEqual([
      "protocol.welcome",
      "workspaces.list",
      "workspaces.create",
    ]);
    expect([...operationsGrantedBy(["host.workspaces"], "host")]).toEqual([
      "protocol.hostWelcome",
      "workspaces.list",
      "workspaces.create",
    ]);
    expect(hostError("workspace-scope-required", "Choose a Workspace").code).toBe("FORBIDDEN");
    for (const answer of [
      negotiateWelcome(hello, offer, workspaceActor),
      negotiateWelcome(hello, workspaceOffer, actor),
      negotiateWelcome({ ...hello, lastSeen: null } as HostScopeHello, offer, actor),
      negotiateWelcome(hello, { ...offer, workspace: null } as HostScopeOffer, actor),
      negotiateWelcome(hello, { ...offer, scope: null } as unknown as HostScopeOffer, actor),
    ])
      expect(answer).toMatchObject({ ok: false, error: { reason: "credential-invalid" } });
    for (const answer of [
      negotiateWelcome(workspaceHello, offer, workspaceActor),
      negotiateWelcome(workspaceHello, workspaceOffer, actor),
    ])
      expect(answer).toMatchObject({ ok: false, error: { reason: "workspace-scope-required" } });
    expect(
      negotiateWelcome({ ...hello, protocol: { min: 2, max: 2 } }, offer, actor),
    ).toMatchObject({ ok: false, error: { reason: "protocol-version-unsupported" } });
  });

  it("validates the host welcome and its proof without an authority fence", () => {
    expect(isHostScopeWelcome(welcome)).toBe(true);
    expect(isHostWelcome(welcome)).toBe(false);
    expect(isHostConnectionWelcome(workspaceWelcome)).toBe(true);
    const verdict = validateWelcome(welcome, hello);
    if (!verdict.ok) throw new Error("refused");
    expectTypeOf(verdict.welcome).toEqualTypeOf<HostScopeWelcome>();
    expect(verdict.welcome).toBe(welcome);
    expect(
      validateWelcome(welcome, hello, {
        verifyProof: (w, h) => {
          expectTypeOf(w).toEqualTypeOf<HostScopeWelcome>();
          expectTypeOf(h).toEqualTypeOf<HostScopeHello>();
          expect(w).toBe(welcome);
          expect(h).toBe(hello);
          return null;
        },
      }).ok,
    ).toBe(true);
    const error = hostError("welcome-invalid", "Bad proof");
    expect(validateWelcome(welcome, hello, { verifyProof: () => error })).toEqual({
      ok: false,
      error,
    });
    for (const value of [
      null,
      [],
      { ...welcome, scope: "workspace" },
      { ...welcome, workspace: null },
      { ...welcome, workspaceId: null },
      { ...welcome, lastSeen: null },
      { ...welcome, actor: workspaceActor },
      { ...welcome, features: ["sessions"] },
      { ...workspaceWelcome, scope: "host" },
    ]) {
      expect(isHostConnectionWelcome(value)).toBe(false);
      expect(validateWelcome(value, hello).ok).toBe(false);
    }
    expect(validateWelcome(workspaceWelcome, hello)).toMatchObject({
      ok: false,
      error: { reason: "welcome-invalid" },
    });
    expect(validateWelcome(welcome, workspaceHello)).toMatchObject({
      ok: false,
      error: { reason: "welcome-invalid" },
    });
    expect(validateWelcome({ ...welcome, features: ["sign-ins", "sign-ins"] }, hello).ok).toBe(
      false,
    );
    expect(validateWelcome(welcome, { ...hello, features: [] }).ok).toBe(false);
    expect(validateWelcome({ ...welcome, protocolVersion: 2 }, hello)).toMatchObject({
      ok: false,
      error: { reason: "protocol-version-unsupported" },
    });
  });

  it("bounds only host-scope proof strings in UTF-16 code units", () => {
    expect(HOST_SCOPE_PROOF_LIMITS).toEqual({ scheme: 128, value: 8192 });
    for (const field of ["scheme", "value"] as const) {
      const max = HOST_SCOPE_PROOF_LIMITS[field];
      for (const unit of ["x", "界", "😀"]) {
        const exact = unit.repeat(max / unit.length);
        const proof = { scheme: "reserved.future-proof", value: "", [field]: exact };
        expect(isHostScopeWelcome({ ...welcome, proof })).toBe(true);
        expect(isHostScopeWelcome({ ...welcome, proof: { ...proof, [field]: exact + "x" } })).toBe(
          false,
        );
        // The legacy Workspace grammar deliberately keeps its unbounded proof.
        expect(
          isHostWelcome({ ...workspaceWelcome, proof: { ...proof, [field]: exact + unit } }),
        ).toBe(true);
      }
    }
    expect(isHostScopeWelcome({ ...welcome, proof: { scheme: "", value: "" } })).toBe(true);
    expect(isHostScopeWelcome({ ...welcome, proof: { scheme: "x" } })).toBe(false);
  });

  it("an N-1 peer refuses a host hello rather than silently selecting a Workspace", async () => {
    expect(nMinusOneReadsHello(JSON.parse(JSON.stringify(workspaceHello)))).toBe(true);
    expect(nMinusOneReadsHello(JSON.parse(JSON.stringify(hello)))).toBe(false);
    expect(
      await REFUSING_CREDENTIAL_VERIFIER.verify({
        scope: "host",
        credential: hello.credential,
        client: hello.client,
        nonce: hello.nonce,
      }),
    ).toBeNull();
  });
});

describe("host-scoped vdc1 claims", () => {
  it("round-trips host claims and the exact signing bytes, dropping unrelated extras", () => {
    const input = deviceCredentialSigningInput(claims);
    expect(input).toBe(
      `vdc1.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}`,
    );
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signature = sign("sha256", Buffer.from(input), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    const parsed = parseDeviceCredential(assembleDeviceCredential(input, signature))!;
    expect(
      verify(
        "sha256",
        Buffer.from(parsed.signingInput),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        parsed.signature,
      ),
    ).toBe(true);
    expect(parsed.claims).toEqual(claims);
    expect(parsed.signingInput).toBe(input);
    expect(parseDeviceCredential(frame({ ...claims, extra: true }))?.claims).toEqual(claims);
    expect(isHostScopeDeviceCredentialClaims(claims)).toBe(true);
    expect(isDeviceCredentialClaims(claims)).toBe(false);
  });

  it("preserves Workspace signing serialization byte for byte", () => {
    const oldClaims = {
      hostId,
      deviceId,
      workspaceId,
      iat: claims.iat,
      exp: claims.exp,
      jti: claims.jti,
    };
    expect(deviceCredentialSigningInput(oldClaims)).toBe(
      `vdc1.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(oldClaims)))}`,
    );
    expect(parseDeviceCredential(frame(oldClaims))?.claims).toEqual(oldClaims);
    expect(readHostHello(encodeHostHello(workspaceHello))).toEqual(workspaceHello);
    expect(encodeHostHello(workspaceHello)["volli-hello"]).toBe(JSON.stringify(workspaceHello));
  });

  it("refuses mixed or unknown claim scopes and malformed host claims", () => {
    for (const value of [
      null,
      [],
      { ...claims, scope: "workspace" },
      { ...claims, scope: null },
      { ...claims, workspaceId },
      { ...claims, workspaceId: null },
      { ...claims, workspaceId: undefined },
      { ...claims, deviceId: "local" },
      { ...claims, hostId: "bad" },
      { ...claims, exp: claims.iat },
      { ...claims, jti: "bad" },
      { ...claims, scope: undefined },
    ]) {
      expect(isHostScopeDeviceCredentialClaims(value)).toBe(false);
      expect(isDeviceCredentialClaims(value)).toBe(false);
      // undefined is absent on the wire; direct guards above still reject its presence.
      if (
        !(
          value &&
          typeof value === "object" &&
          "workspaceId" in value &&
          value.workspaceId === undefined
        )
      )
        expect(parseDeviceCredential(frame(value))).toBeNull();
    }
  });
});
