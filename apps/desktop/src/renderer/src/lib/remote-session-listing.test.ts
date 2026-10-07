/**
 * A remote project's Session listing over its Workspace link (VC-711 with
 * VC-713): the rows the host answers, its failures in the listing's own
 * shape, and This Mac's projects and tickets left to the local reader.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { relaySessionListing } from "./remote-session-listing";

const ROW = { kind: "chat", record: { id: "s1" } };

describe("relaySessionListing", () => {
  it("reads a remote project's and a remote ticket's rows over that project's link", async () => {
    const query = vi.fn(async (path: string, _input?: unknown) => {
      if (path === "session.listingForTicket") throw { data: { hostError: { message: "gone" } } };
      return { sessions: [ROW], omitted: 0 };
    });
    const link = vi.fn((_projectId: string) => ({ query }));
    const listing = relaySessionListing({
      isRemote: (projectId) => projectId === "r1",
      projectOfTicket: (ticketId) =>
        ticketId === "rt" ? "r1" : ticketId === "lt" ? "p1" : undefined,
      link,
    });
    expect(await listing.forProject("r1")!.list({ projectId: "r1" })).toEqual({
      ok: true,
      sessions: [ROW],
    });
    expect(await listing.forTicket("rt")!.listForTicket({ ticketId: "rt" })).toEqual({
      ok: false,
      error: "gone",
    });
    expect(query.mock.calls).toEqual([
      ["session.listing", { projectId: "r1" }],
      ["session.listingForTicket", { ticketId: "rt" }],
    ]);
    expect(link.mock.calls).toEqual([["r1"], ["r1"]]);
    // This Mac's project and ticket, and a ticket no board holds: the local reader's.
    expect(listing.forProject("p1")).toBeNull();
    expect(listing.forTicket("lt")).toBeNull();
    expect(listing.forTicket("unknown")).toBeNull();
  });
});
