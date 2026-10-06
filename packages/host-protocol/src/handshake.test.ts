import { describe, expect, it } from "vite-plus/test";

import {
  buildHostHello,
  checkWorkspaceFence,
  createHostNonce,
  encodeHostHello,
  HOST_HELLO_PARAM,
  HOST_PROTOCOL_CLOSE_CODES,
  HOST_PROTOCOL_VERSIONS,
  isHostFeature,
  isHostHello,
  isHostNonce,
  isProtocolVersionRange,
  negotiateFeatures,
  negotiateProtocolVersion,
  negotiateWelcome,
  readHostHello,
  type HostHello,
  type HostOffer,
} from "./handshake";
import type { HostActor } from "./actor";

const WORKSPACE = "6f1cbc6b-0b8e-4d4e-9a39-2a0c5f4f2d11";
const OTHER_WORKSPACE = "0d4f6a7e-3c1b-4f62-8e0a-9b5c2d7e1f30";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_HOST = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
const DEVICE = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const hello: HostHello = {
  protocol: { min: 1, max: 1 },
  client: { kind: "desktop", version: "0.3.0" },
  workspaceId: WORKSPACE,
  lastSeen: { epoch: 2, hostId: HOST },
  features: ["sessions", "terminals.stream", "from-the-future"],
  credential: "device-token",
  nonce: "q2Vh7wJcJ0rX3m3d4cQ9tA",
};
const offer: HostOffer = {
  host: { id: HOST, version: "0.3.0" },
  protocol: HOST_PROTOCOL_VERSIONS,
  workspace: { id: WORKSPACE, epoch: 2 },
  features: ["board", "sessions", "terminals.stream"],
};
const device: HostActor = { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE };

describe("negotiateProtocolVersion", () => {
  it("picks the highest version both ranges share", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 3 }, { min: 2, max: 5 })).toBe(3);
    expect(negotiateProtocolVersion({ min: 2, max: 2 }, { min: 1, max: 4 })).toBe(2);
  });

  it("answers null when the ranges do not meet, in either direction", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 1 }, { min: 2, max: 3 })).toBeNull();
    expect(negotiateProtocolVersion({ min: 4, max: 5 }, { min: 2, max: 3 })).toBeNull();
  });
});

describe("negotiateFeatures", () => {
  it("grants what was asked and is served, in the host's order, once each, ignoring unknown names", () => {
    expect(negotiateFeatures(["c", "a", "zzz", "a"], ["a", "b", "c", "a"])).toEqual(["a", "c"]);
    expect(negotiateFeatures([], ["a"])).toEqual([]);
  });
});

describe("negotiateWelcome", () => {
  it("welcomes a hello with the host's identity, the epoch, the actor and the shared features", () => {
    expect(negotiateWelcome(hello, offer, device)).toStrictEqual({
      ok: true,
      welcome: {
        protocolVersion: 1,
        host: { id: HOST, version: "0.3.0" },
        workspace: { id: WORKSPACE, epoch: 2 },
        actor: device,
        features: ["sessions", "terminals.stream"],
        proof: null,
      },
    });
  });

  it("welcomes first contact, which has seen no epoch", () => {
    expect(negotiateWelcome({ ...hello, lastSeen: null }, offer, device).ok).toBe(true);
  });

  it("refuses a version range the host does not speak, naming both", () => {
    const answer = negotiateWelcome({ ...hello, protocol: { min: 2, max: 3 } }, offer, device);
    expect(answer).toStrictEqual({
      ok: false,
      error: {
        code: "PRECONDITION_FAILED",
        reason: "protocol-version-unsupported",
        message: "This host speaks protocol 1; the client speaks 2–3",
      },
    });
  });

  it("answers workspace-unknown when the actor or the hello is for another workspace", () => {
    const elsewhere: HostActor = { ...device, workspaceId: OTHER_WORKSPACE };
    for (const answer of [
      negotiateWelcome(hello, offer, elsewhere),
      negotiateWelcome({ ...hello, workspaceId: OTHER_WORKSPACE }, offer, device),
    ]) {
      expect(answer).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND", reason: "workspace-unknown" },
      });
    }
  });

  it("refuses a host whose epoch is older than one the client has seen: it was fenced", () => {
    const lastSeen = { epoch: 3, hostId: OTHER_HOST };
    expect(negotiateWelcome({ ...hello, lastSeen }, offer, device)).toMatchObject({
      ok: false,
      error: { code: "PRECONDITION_FAILED", reason: "workspace-epoch-fenced" },
    });
  });
});

describe("checkWorkspaceFence", () => {
  it("passes first contact, a later epoch, and the same epoch from the same host", () => {
    expect(checkWorkspaceFence(null, { epoch: 1, hostId: HOST })).toBeNull();
    expect(checkWorkspaceFence({ epoch: 1, hostId: OTHER_HOST }, { epoch: 2, hostId: HOST })).toBe(
      null,
    );
    expect(checkWorkspaceFence({ epoch: 2, hostId: HOST }, { epoch: 2, hostId: HOST })).toBeNull();
  });

  it("refuses the same epoch from a different host: two authorities is split brain", () => {
    expect(
      checkWorkspaceFence({ epoch: 2, hostId: OTHER_HOST }, { epoch: 2, hostId: HOST }),
    ).toMatchObject({ code: "CONFLICT", reason: "workspace-split-brain" });
  });
});

describe("the hello on the wire", () => {
  it("round-trips through tRPC connectionParams as one string value", () => {
    const params = encodeHostHello(hello);
    expect(Object.values(params).every((value) => typeof value === "string")).toBe(true);
    expect(readHostHello(params)).toStrictEqual(hello);
  });

  it("reads null for a connection that sent no hello, or one it cannot parse or trust", () => {
    expect(readHostHello(null)).toBeNull();
    expect(readHostHello({})).toBeNull();
    expect(readHostHello({ [HOST_HELLO_PARAM]: "{not json" })).toBeNull();
    expect(
      readHostHello({ [HOST_HELLO_PARAM]: JSON.stringify({ ...hello, credential: "" }) }),
    ).toBe(null);
  });

  it("refuses a hello that claims more than the grammar allows", () => {
    expect(isHostHello(hello)).toBe(true);
    const broken: unknown[] = [
      null,
      [],
      { ...hello, client: null },
      { ...hello, client: { kind: "toaster", version: "1" } },
      { ...hello, client: { kind: "desktop", version: 1 } },
      { ...hello, protocol: { min: 2, max: 1 } },
      { ...hello, protocol: { min: 0, max: 1 } },
      { ...hello, protocol: [] },
      { ...hello, workspaceId: "project-1" },
      { ...hello, lastSeen: { epoch: -1, hostId: HOST } },
      { ...hello, lastSeen: { epoch: 1, hostId: "host-1" } },
      { ...hello, lastSeen: 2 },
      { ...hello, features: "sessions" },
      { ...hello, features: ["Sessions"] },
      { ...hello, features: Array.from({ length: 257 }, (_, index) => `f${index}`) },
      { ...hello, credential: 7 },
      { ...hello, credential: "c".repeat(8193) },
      { ...hello, client: { kind: "desktop", version: "v".repeat(129) } },
    ];
    for (const value of broken) expect(isHostHello(value)).toBe(false);
  });

  it("states the version range and feature grammar it checks", () => {
    expect(isProtocolVersionRange({ min: 1, max: 1 })).toBe(true);
    expect(isProtocolVersionRange({ min: 1, max: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(isHostFeature("terminals.stream")).toBe(true);
    expect(isHostFeature("terminals..stream")).toBe(false);
    expect(isHostFeature(`a${"b".repeat(128)}`)).toBe(false);
    expect(isHostFeature(7)).toBe(false);
  });
});

describe("the hello's nonce (VC-663, D6)", () => {
  it("is required v1 wire: a hello without one, or with a short or non-base64url one, is refused", () => {
    const { nonce: _nonce, ...withoutNonce } = hello;
    for (const value of [
      withoutNonce,
      { ...hello, nonce: null },
      { ...hello, nonce: "too-short" },
      { ...hello, nonce: "q2Vh7wJcJ0rX3m3d4cQ9tA==" },
      { ...hello, nonce: "a".repeat(129) },
    ]) {
      expect(isHostHello(value)).toBe(false);
    }
    expect(readHostHello(encodeHostHello({ ...hello, nonce: "" }))).toBeNull();
  });

  it("is minted fresh with 256 bits per handshake, base64url without padding", () => {
    const nonces = new Set(Array.from({ length: 64 }, () => createHostNonce()));
    expect(nonces.size).toBe(64);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(isHostNonce(nonce)).toBe(true);
    }
  });
});

describe("buildHostHello", () => {
  it("builds a hello the host can read, with every version this build speaks and a fresh nonce", () => {
    const input = {
      client: { kind: "mobile" as const, version: "1.0.0" },
      workspaceId: WORKSPACE,
      credential: "device-token",
      features: ["sessions"],
      lastSeen: null,
    };
    const first = buildHostHello(input);
    expect(first).toStrictEqual({
      protocol: HOST_PROTOCOL_VERSIONS,
      client: { kind: "mobile", version: "1.0.0" },
      workspaceId: WORKSPACE,
      lastSeen: null,
      features: ["sessions"],
      credential: "device-token",
      nonce: first.nonce,
    });
    expect(isHostHello(first)).toBe(true);
    expect(readHostHello(encodeHostHello(first))).toStrictEqual(first);
    expect(buildHostHello(input).nonce).not.toBe(first.nonce);
  });

  it("keeps a narrower version range the client chose", () => {
    const range = { min: 1, max: 1 };
    expect(
      buildHostHello({
        client: { kind: "cli", version: "1" },
        workspaceId: WORKSPACE,
        credential: "c",
        features: [],
        lastSeen: { epoch: 2, hostId: HOST },
        protocol: range,
      }).protocol,
    ).toBe(range);
  });
});

describe("HOST_PROTOCOL_CLOSE_CODES", () => {
  it("are fixed application codes, distinct, and frozen", () => {
    expect(HOST_PROTOCOL_CLOSE_CODES).toStrictEqual({
      handshakeRefused: 4400,
      credentialInvalid: 4401,
      helloTimeout: 4408,
      responseTooLarge: 4413,
    });
    const codes = Object.values(HOST_PROTOCOL_CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code >= 4000 && code <= 4999).toBe(true);
    expect(Object.isFrozen(HOST_PROTOCOL_CLOSE_CODES)).toBe(true);
  });
});
