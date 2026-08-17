import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  SESSION_RPC_IPC_PROCEDURES,
} from "./session-rpc-wire";

describe("Session RPC wire protocol", () => {
  it("names the three channels both ends open", () => {
    expect(SESSION_RPC_IPC_CHANNEL).toBe("volli:session-rpc");
    expect(SESSION_RPC_EVENT_CHANNEL).toBe("volli:session-rpc-event");
    expect(SESSION_RPC_CANCEL_CHANNEL).toBe("volli:session-rpc-cancel");
  });

  // The array IS the request guard's allow-list, and a renderer holds a live
  // reference to it — a procedure pushed onto it from anywhere would widen what
  // main accepts without a single line changing in main.
  it("publishes a frozen allow-list of the routed procedures", () => {
    expect(Object.isFrozen(SESSION_RPC_IPC_PROCEDURES)).toBe(true);
    expect(SESSION_RPC_IPC_PROCEDURES).toEqual([
      "modelAccess.inspect",
      "modelAccess.defaults",
      "modelAccess.setDefault",
      "modelAccess.hiddenModels",
      "modelAccess.setHiddenModels",
      "sessions.create",
      "sessions.attach",
      "session.snapshot",
      "session.projection",
      "session.subscribe",
      "session.command",
      "session.cancelInteraction",
      "session.reconcile",
    ]);
  });

  // Lab diagnostics are the development-only HTTP surface's business: a
  // production client has no debug pane to feed and no business reading a
  // diagnostic log over the channel it runs Sessions on.
  it("withholds the lab diagnostics namespace", () => {
    expect(
      SESSION_RPC_IPC_PROCEDURES.some((procedure) => procedure.startsWith("labDiagnostics.")),
    ).toBe(false);
  });
});
