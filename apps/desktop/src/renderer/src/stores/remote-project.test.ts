import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const sync = vi.hoisted(() => ({
  workspaceOf: vi.fn((_id: string): string | undefined => undefined),
}));
vi.mock("@renderer/lib/board-protocol", () => ({
  boardProtocol: () => ({ sync }),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));

import { remoteProject } from "./remote-project.test-support";
import {
  notAvailableOn,
  refuseRemote,
  refuseRemoteTicket,
  remoteHostNow,
  remoteHostOfTicketNow,
} from "./remote-project";

let undo: (() => void) | null = null;
afterEach(() => {
  undo?.();
  undo = null;
  toast.mockClear();
  sync.workspaceOf.mockReset();
});

describe("a remote project, read outside React (VC-711)", () => {
  it("names the host serving a remote project, and none for This Mac's or nothing", () => {
    undo = remoteProject("r1");
    expect(remoteHostNow("r1")?.name).toBe("box");
    expect(remoteHostNow("p1")).toBeNull();
    expect(remoteHostNow(null)).toBeNull();
    expect(remoteHostNow(undefined)).toBeNull();
  });

  it("is never remote with the cloud flag off", () => {
    undo = remoteProject("r1", { cloud: false });
    expect(remoteHostNow("r1")).toBeNull();
    expect(refuseRemote("r1")).toBe(false);
  });

  it("finds a ticket's project by the board that holds it", () => {
    undo = remoteProject("r1");
    sync.workspaceOf.mockImplementation((id) => (id === "rt" ? "r1" : undefined));
    expect(remoteHostOfTicketNow("rt")?.name).toBe("box");
    expect(remoteHostOfTicketNow("local-ticket")).toBeNull();
    expect(remoteHostOfTicketNow(null)).toBeNull();
    expect(remoteHostOfTicketNow(undefined)).toBeNull();
  });

  it("refuses a person's local-only action on one, once, in the host's name", () => {
    undo = remoteProject("r1");
    sync.workspaceOf.mockImplementation((id) => (id === "rt" ? "r1" : undefined));
    expect(refuseRemote("r1")).toBe(true);
    expect(refuseRemoteTicket("rt")).toBe(true);
    expect(refuseRemote("p1")).toBe(false);
    expect(refuseRemoteTicket("pt")).toBe(false);
    expect(toast.mock.calls).toEqual([
      ["Not available on box yet", { id: "host-local-only" }],
      ["Not available on box yet", { id: "host-local-only" }],
    ]);
    expect(notAvailableOn({ name: "hetzner-1" })).toBe("Not available on hetzner-1 yet");
  });
});
