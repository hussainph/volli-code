import { describe, expect, it } from "vite-plus/test";

import { LOCAL_DEVICE_ID, type HostActor } from "./actor";
import { hostError } from "./errors";
import { negotiateWelcome, type HostHello, type HostWelcome } from "./handshake";
import { isHostWelcome, validateWelcome } from "./welcome";

const WORKSPACE = "6f1cbc6b-0b8e-4d4e-9a39-2a0c5f4f2d11";
const OTHER_WORKSPACE = "0d4f6a7e-3c1b-4f62-8e0a-9b5c2d7e1f30";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_HOST = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
const DEVICE = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const hello: HostHello = {
  protocol: { min: 1, max: 2 },
  client: { kind: "mobile", version: "1.0.0" },
  workspaceId: WORKSPACE,
  lastSeen: { epoch: 2, hostId: HOST },
  features: ["sessions", "sessions.subscribe"],
  credential: "device-token",
  nonce: "q2Vh7wJcJ0rX3m3d4cQ9tA",
};
const device: HostActor = { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE };
const welcome: HostWelcome = {
  protocolVersion: 1,
  host: { id: HOST, version: "0.3.0" },
  workspace: { id: WORKSPACE, epoch: 2 },
  actor: device,
  features: ["sessions"],
  proof: null,
};

describe("validateWelcome", () => {
  it("accepts the welcome a host negotiated for this hello, unchanged", () => {
    const negotiated = negotiateWelcome(
      hello,
      {
        host: { id: HOST, version: "0.3.0" },
        protocol: { min: 1, max: 1 },
        workspace: { id: WORKSPACE, epoch: 3 },
        features: ["sessions", "board"],
      },
      device,
    );
    expect(negotiated.ok).toBe(true);
    const answer = negotiated.ok ? negotiated.welcome : null;
    expect(validateWelcome(JSON.parse(JSON.stringify(answer)), hello)).toStrictEqual({
      ok: true,
      welcome: answer,
    });
  });

  it("refuses a malformed welcome, and one that names the reserved local device", () => {
    for (const value of [
      null,
      [],
      { ...welcome, host: null },
      { ...welcome, workspace: [] },
      { ...welcome, protocolVersion: 0 },
      { ...welcome, protocolVersion: "1" },
      { ...welcome, host: { id: "host", version: "1" } },
      { ...welcome, host: { id: HOST, version: 1 } },
      { ...welcome, host: { id: HOST, version: "v".repeat(129) } },
      { ...welcome, workspace: { id: "w", epoch: 1 } },
      { ...welcome, workspace: { id: WORKSPACE, epoch: -1 } },
      { ...welcome, actor: { kind: "device", deviceId: LOCAL_DEVICE_ID, workspaceId: WORKSPACE } },
      { ...welcome, features: "sessions" },
      { ...welcome, features: ["host.workspaces"] },
      { ...welcome, features: ["Sessions"] },
      { ...welcome, features: Array.from({ length: 257 }, (_, index) => `f${index}`) },
      { ...welcome, proof: "signature" },
      { ...welcome, proof: { scheme: "ed25519" } },
      { ...welcome, proof: undefined },
    ]) {
      expect(isHostWelcome(value)).toBe(false);
      expect(validateWelcome(value, hello)).toStrictEqual({
        ok: false,
        error: {
          code: "BAD_GATEWAY",
          reason: "welcome-invalid",
          message: "The host's welcome is malformed",
        },
      });
    }
  });

  it("refuses a selected version outside the range this client asked for", () => {
    for (const protocolVersion of [3, 1]) {
      expect(
        validateWelcome(
          { ...welcome, protocolVersion },
          { ...hello, protocol: { min: 2, max: 2 } },
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "PRECONDITION_FAILED", reason: "protocol-version-unsupported" },
      });
    }
  });

  it("refuses a welcome to another Workspace, or an actor bound to another one", () => {
    for (const value of [
      { ...welcome, workspace: { id: OTHER_WORKSPACE, epoch: 2 } },
      { ...welcome, actor: { ...device, workspaceId: OTHER_WORKSPACE } },
    ]) {
      expect(validateWelcome(value, hello)).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND", reason: "workspace-unknown" },
      });
    }
  });

  it("refuses a grant wider than the request, or one that repeats a feature", () => {
    for (const features of [
      ["sessions", "board"],
      ["sessions", "sessions"],
    ]) {
      expect(validateWelcome({ ...welcome, features }, hello)).toStrictEqual({
        ok: false,
        error: {
          code: "BAD_GATEWAY",
          reason: "welcome-invalid",
          message: "The host granted a feature this client did not ask for",
        },
      });
    }
  });

  it("refuses a host fenced by an epoch this client has seen, and two hosts at one epoch", () => {
    expect(
      validateWelcome({ ...welcome, workspace: { id: WORKSPACE, epoch: 1 } }, hello),
    ).toMatchObject({
      ok: false,
      error: { code: "PRECONDITION_FAILED", reason: "workspace-epoch-fenced" },
    });
    expect(
      validateWelcome({ ...welcome, host: { id: OTHER_HOST, version: "0.3.0" } }, hello),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", reason: "workspace-split-brain" },
    });
    // A higher epoch from another host is a move, not a fence.
    expect(
      validateWelcome(
        {
          ...welcome,
          host: { id: OTHER_HOST, version: "0.3.0" },
          workspace: { id: WORKSPACE, epoch: 3 },
        },
        hello,
      ).ok,
    ).toBe(true);
  });

  it("asks the proof hook after the grant and before the fence, with the welcome and the hello", () => {
    const asked: unknown[] = [];
    const refused = hostError("welcome-invalid", "The welcome's proof does not verify");
    const fenced = {
      ...welcome,
      workspace: { id: WORKSPACE, epoch: 1 },
      proof: { scheme: "s", value: "v" },
    };
    expect(
      validateWelcome(fenced, hello, {
        verifyProof: (...args) => {
          asked.push(args);
          return refused;
        },
      }),
    ).toStrictEqual({ ok: false, error: refused });
    expect(asked).toStrictEqual([[fenced, hello]]);
    // Not reached for a grant the client never asked for.
    expect(
      validateWelcome({ ...welcome, features: ["board"] }, hello, {
        verifyProof: () => {
          throw new Error("asked too early");
        },
      }).ok,
    ).toBe(false);
    expect(validateWelcome(welcome, hello, { verifyProof: () => null }).ok).toBe(true);
  });
});
