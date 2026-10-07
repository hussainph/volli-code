import { describe, expect, it } from "vite-plus/test";

import { REFUSING_CREDENTIAL_VERIFIER } from "./credentials";
import {
  HOST_BASE_OPERATIONS,
  HOST_FEATURE_OPERATIONS,
  HOST_V1_FEATURES,
  hostOffersSignIns,
  operationsGrantedBy,
} from "./features";
import { isHostFeature } from "./handshake";
import { HOST_PROTOCOL_MAX_FRAME_BYTES, SUBSCRIPTION_REPLAY_BOUNDS } from "./subscriptions";

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
      "sessions.queue": ["session.cancelQueued", "session.editQueued", "session.subscribeQueue"],
      "host.logs": ["logs.tail", "logs.follow"],
      "sessions.subscribe": ["session.subscribe"],
      "sessions.history": ["session.history"],
      "session.read": ["session.list", "session.show", "session.peek", "session.answer"],
      "board.read": [
        "board.snapshot",
        "board.roster",
        "board.changes",
        "board.projectFolder",
        "board.ticketBody",
        "board.archivedTickets",
        "board.ticketEvents",
        "board.latestSignals",
        "board.statusEntries",
        "board.comments",
      ],
      "board.write": [
        "ticket.move",
        "board.updateProject",
        "board.setSkillModes",
        "board.setSessionDefaults",
        "board.createTicket",
        "board.moveTickets",
        "board.setPriority",
        "board.updateTicket",
        "board.setLabels",
        "board.archiveTicket",
        "board.unarchiveTicket",
        "board.deleteTicket",
        "board.createComment",
        "board.updateComment",
        "board.removeComment",
        "board.setLabelColor",
      ],
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
      "sign-ins": [
        "signIns.status",
        "signIns.setApiKey",
        "signIns.signOut",
        "signIns.start",
        "signIns.subscribe",
        "signIns.answer",
        "signIns.cancel",
        "signIns.setGitCredential",
        "signIns.clearGitCredential",
      ],
      "auth.callback": ["auth.callback.deliver"],
    });
    expect(HOST_V1_FEATURES).toStrictEqual([
      "sessions",
      "sessions.queue",
      "host.logs",
      "sessions.subscribe",
      "sessions.history",
      "session.read",
      "board.read",
      "board.write",
      "model-access",
      "sign-ins",
      "auth.callback",
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

  it("bound one frame at the replay byte bound, so a frame never outweighs a resume", () => {
    expect(HOST_PROTOCOL_MAX_FRAME_BYTES).toBe(SUBSCRIPTION_REPLAY_BOUNDS.bytes);
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

describe("hostOffersSignIns", () => {
  it("reads sign-ins off the welcome: an older host never granted them (N−1)", () => {
    expect(hostOffersSignIns({ features: ["sessions", "sign-ins"] })).toBe(true);
    expect(hostOffersSignIns({ features: ["sessions", "session.read"] })).toBe(false);
  });
});
