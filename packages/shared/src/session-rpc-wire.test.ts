import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
} from "./session-rpc-wire";

describe("Session RPC wire protocol", () => {
  it("names the three channels both ends open", () => {
    expect(SESSION_RPC_IPC_CHANNEL).toBe("volli:session-rpc");
    expect(SESSION_RPC_EVENT_CHANNEL).toBe("volli:session-rpc-event");
    expect(SESSION_RPC_CANCEL_CHANNEL).toBe("volli:session-rpc-cancel");
  });
});
