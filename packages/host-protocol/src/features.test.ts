import { describe, expect, it } from "vite-plus/test";

import { REFUSING_CREDENTIAL_VERIFIER } from "./credentials";
import {
  HOST_BASE_OPERATIONS,
  HOST_FEATURE_OPERATIONS,
  HOST_V1_FEATURES,
  operationsGrantedBy,
} from "./features";
import { isHostFeature } from "./handshake";
import { SUBSCRIPTION_REPLAY_BOUNDS } from "./subscriptions";

describe("the v1 feature table", () => {
  // A feature's operation set is fixed once it ships: this snapshot changing
  // is a wire change, and the fix is a new feature name, not an edit here.
  it("names each v1 feature and exactly the operations it grants", () => {
    expect(HOST_BASE_OPERATIONS).toStrictEqual(["protocol.welcome"]);
    expect(HOST_FEATURE_OPERATIONS).toStrictEqual({
      sessions: [
        "sessions.create",
        "sessions.attach",
        "session.snapshot",
        "session.projection",
        "session.command",
        "session.cancelInteraction",
        "session.reconcile",
      ],
      "sessions.subscribe": ["session.subscribe"],
      "session.read": ["session.list", "session.show", "session.peek", "session.answer"],
      "model-access": [
        "modelAccess.inspect",
        "modelAccess.defaults",
        "modelAccess.setDefault",
        "modelAccess.hiddenModels",
        "modelAccess.setHiddenModels",
        "modelAccess.compactionPolicy",
        "modelAccess.setCompactionPolicy",
        "modelAccess.codeModePolicy",
        "modelAccess.setCodeModePolicy",
        "modelAccess.pickerView",
        "modelAccess.setPickerView",
      ],
    });
    expect(HOST_V1_FEATURES).toStrictEqual([
      "sessions",
      "sessions.subscribe",
      "session.read",
      "model-access",
    ]);
    expect(HOST_V1_FEATURES.every(isHostFeature)).toBe(true);
  });

  it("puts no operation in two features, nor beside the base set", () => {
    const all = [...HOST_BASE_OPERATIONS, ...Object.values(HOST_FEATURE_OPERATIONS).flat()];
    expect(new Set(all).size).toBe(all.length);
  });

  it("grants the base set plus the granted features' operations, and nothing for unknown names", () => {
    expect([...operationsGrantedBy([])]).toStrictEqual(["protocol.welcome"]);
    expect([
      ...operationsGrantedBy(["sessions.subscribe", "toString", "from-the-future"]),
    ]).toStrictEqual(["protocol.welcome", "session.subscribe"]);
    expect(operationsGrantedBy(["session.read"]).has("session.peek")).toBe(true);
    expect(operationsGrantedBy(["session.read"]).has("session.command")).toBe(false);
  });
});

describe("the WebSocket replay bounds", () => {
  it("are VC-315's 4,096 events and 16 MiB, frozen", () => {
    expect(SUBSCRIPTION_REPLAY_BOUNDS).toStrictEqual({ events: 4096, bytes: 16_777_216 });
    expect(Object.isFrozen(SUBSCRIPTION_REPLAY_BOUNDS)).toBe(true);
  });
});

describe("the refusing verifier", () => {
  it("accepts no credential at all", async () => {
    expect(
      await REFUSING_CREDENTIAL_VERIFIER.verify({
        credential: "anything",
        workspaceId: "6f1cbc6b-0b8e-4d4e-9a39-2a0c5f4f2d11",
        nonce: "q2Vh7wJcJ0rX3m3d4cQ9tA",
        client: { kind: "cli", version: "1" },
      }),
    ).toBeNull();
  });
});
