import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { isHostActor, isLocalDeviceActor, LOCAL_DEVICE_ACTOR, LOCAL_DEVICE_ID } from "./actor";
import {
  HOST_ERROR_CODES,
  HOST_ERROR_REASON_CODES,
  hostError,
  isHostError,
  readHostError,
  type HostErrorCode,
} from "./errors";
import { isEpoch, isIdentifier, isUuidV4 } from "./identity";

const WORKSPACE = "6f1cbc6b-0b8e-4d4e-9a39-2a0c5f4f2d11";
const ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("the error envelope", () => {
  it("speaks tRPC's code vocabulary exactly", () => {
    expectTypeOf<HostErrorCode>().toEqualTypeOf<TRPC_ERROR_CODE_KEY>();
    expect(new Set(HOST_ERROR_CODES).size).toBe(HOST_ERROR_CODES.length);
  });

  it("pins every reason to the code it travels under", () => {
    for (const [reason, code] of Object.entries(HOST_ERROR_REASON_CODES)) {
      expect(HOST_ERROR_CODES).toContain(code);
      expect(hostError(reason as keyof typeof HOST_ERROR_REASON_CODES, "m")).toStrictEqual({
        code,
        message: "m",
        reason,
      });
    }
  });

  it("pins resnapshot-required failures to PRECONDITION_FAILED on the wire", () => {
    const envelope = hostError("subscription-resnapshot-required", "Read a fresh snapshot");
    expect(envelope).toStrictEqual({
      code: "PRECONDITION_FAILED",
      message: "Read a fresh snapshot",
      reason: "subscription-resnapshot-required",
    });
    expect(isHostError(envelope)).toBe(true);
    expect(readHostError({ data: { hostError: envelope } })).toStrictEqual(envelope);
  });

  it("refuses an envelope whose reason travels under the wrong code, or is not one", () => {
    expect(isHostError({ code: "NOT_FOUND", message: "gone" })).toBe(true);
    expect(isHostError(hostError("verb-refused", "no"))).toBe(true);
    expect(isHostError({ code: "BAD_REQUEST", message: "no", reason: "verb-refused" })).toBe(false);
    expect(isHostError({ code: "BAD_REQUEST", message: "no", reason: "toString" })).toBe(false);
    expect(isHostError({ code: "TEAPOT", message: "no" })).toBe(false);
    expect(isHostError({ code: "BAD_REQUEST" })).toBe(false);
    expect(isHostError([])).toBe(false);
  });

  it("reads the envelope back out of whatever a client was handed", () => {
    const envelope = hostError("workspace-unknown", "No such workspace");
    expect(readHostError(envelope)).toStrictEqual(envelope);
    expect(readHostError({ message: "wrapped", data: { hostError: envelope } })).toStrictEqual(
      envelope,
    );
    const future = { code: "NOT_FOUND", message: "gone", reason: "future-reason" };
    expect(readHostError(future)).toStrictEqual({ code: "NOT_FOUND", message: "gone" });
    expect(readHostError({ data: { hostError: future } })).toStrictEqual({
      code: "NOT_FOUND",
      message: "gone",
    });
    expect(readHostError({ data: { hostError: { code: "NOT_FOUND", message: 7 } } })).toMatchObject(
      { code: "INTERNAL_SERVER_ERROR" },
    );
    // Both of today's links: a tRPC client error carrying only the code key.
    expect(readHostError({ message: "slow down", data: { code: "TOO_MANY_REQUESTS" } })).toEqual({
      code: "TOO_MANY_REQUESTS",
      message: "slow down",
    });
    expect(readHostError({ message: "odd", data: { code: -32600 } })).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "odd",
    });
    expect(readHostError(new TRPCError({ code: "FORBIDDEN", message: "server-side" }))).toEqual({
      code: "FORBIDDEN",
      message: "server-side",
    });
    expect(readHostError("boom")).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Host request failed",
    });
  });
});

describe("identity and actor guards", () => {
  it("accepts v4 UUIDs only, never a v1, the nil id or a machine-local name", () => {
    expect(isUuidV4(ID)).toBe(true);
    expect(isUuidV4("6f1cbc6b-0b8e-1d4e-9a39-2a0c5f4f2d11")).toBe(false);
    expect(isUuidV4("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isUuidV4("macbook-pro.local")).toBe(false);
    expect(isUuidV4(7)).toBe(false);
  });

  it("accepts an epoch as a non-negative safe integer", () => {
    expect(isEpoch(0)).toBe(true);
    expect(isEpoch(-1)).toBe(false);
    expect(isEpoch(2 ** 53)).toBe(false);
    expect(isEpoch("1")).toBe(false);
  });

  it("accepts a bounded identifier without surrounding whitespace", () => {
    expect(isIdentifier("session-1")).toBe(true);
    expect(isIdentifier(" session-1")).toBe(false);
    expect(isIdentifier("")).toBe(false);
    expect(isIdentifier("x".repeat(513))).toBe(false);
  });

  it("knows the three actors, each bound to one workspace", () => {
    expect(isHostActor({ kind: "device", deviceId: ID, workspaceId: WORKSPACE })).toBe(true);
    expect(isHostActor({ kind: "session", sessionId: "session-1", workspaceId: WORKSPACE })).toBe(
      true,
    );
    expect(isHostActor({ kind: "worker", workerId: ID, workspaceId: WORKSPACE })).toBe(true);
    expect(isHostActor({ kind: "user", deviceId: ID, workspaceId: WORKSPACE })).toBe(false);
    expect(isHostActor({ kind: "device", deviceId: ID })).toBe(false);
    expect(isHostActor({ kind: "worker", workerId: "hostname", workspaceId: WORKSPACE })).toBe(
      false,
    );
    expect(isHostActor(null)).toBe(false);
    expect(isHostActor([])).toBe(false);
  });

  // VC-564 D7: the desktop's own window is the person, over no handshake. A
  // network verifier must never be able to hand that identity to a socket.
  it("reserves the local device id for the in-process desktop", () => {
    expect(isHostActor({ kind: "device", deviceId: LOCAL_DEVICE_ID, workspaceId: WORKSPACE })).toBe(
      false,
    );
    expect(isHostActor({ ...LOCAL_DEVICE_ACTOR, workspaceId: WORKSPACE })).toBe(false);
    expect(isLocalDeviceActor(LOCAL_DEVICE_ACTOR)).toBe(true);
    expect(isLocalDeviceActor({ kind: "device", deviceId: ID, workspaceId: WORKSPACE })).toBe(
      false,
    );
    expect(Object.isFrozen(LOCAL_DEVICE_ACTOR)).toBe(true);
  });

  it("never mistakes a malformed actor with no Workspace for the desktop", () => {
    const malformed = [
      { kind: "session", sessionId: "agent" },
      { kind: "worker", workerId: ID },
      { kind: "device", deviceId: ID },
    ];
    for (const actor of malformed) {
      expect(isLocalDeviceActor(actor as never)).toBe(false);
    }
  });
});
