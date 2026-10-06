import { describe, expect, it, vi } from "vite-plus/test";

const query = vi.hoisted(() => vi.fn());
vi.mock("./session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({ ticket: { body: { query } } }),
}));

import { readTicketBody } from "./ticket-body-read";

describe("readTicketBody", () => {
  it("reads the body over ticket.body, and a gone ticket as nothing to read", async () => {
    query.mockResolvedValueOnce("# Scope").mockResolvedValueOnce(null);
    await expect(readTicketBody({ ticketId: "t1" })).resolves.toEqual({
      ok: true,
      body: "# Scope",
    });
    await expect(readTicketBody({ ticketId: "gone" })).resolves.toEqual({ ok: false });
    expect(query.mock.calls).toEqual([[{ ticketId: "t1" }], [{ ticketId: "gone" }]]);
  });

  it("rejects when the bridge does", async () => {
    query.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(readTicketBody({ ticketId: "t1" })).rejects.toThrow("IPC unavailable");
  });
});
