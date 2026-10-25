import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const sync = vi.hoisted(() => ({
  projectOf: vi.fn((_id: string): string | undefined => undefined),
}));
vi.mock("@renderer/lib/board-protocol", () => ({
  boardProtocol: () => ({ sync }),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));

import { LOCAL_LAUNCH } from "@volli/shared";

import { adoptLaunch } from "./launch";
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
  sync.projectOf.mockReset();
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
    sync.projectOf.mockImplementation((id) => (id === "rt" ? "r1" : undefined));
    expect(remoteHostOfTicketNow("rt")?.name).toBe("box");
    expect(remoteHostOfTicketNow("local-ticket")).toBeNull();
    expect(remoteHostOfTicketNow(null)).toBeNull();
    expect(remoteHostOfTicketNow(undefined)).toBeNull();
  });

  it("refuses a person's local-only action on one, once, in the host's name", () => {
    undo = remoteProject("r1");
    sync.projectOf.mockImplementation((id) => (id === "rt" ? "r1" : undefined));
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

describe("a cloud launch's projects (VC-889)", () => {
  afterEach(() => adoptLaunch(LOCAL_LAUNCH));

  it("stands every local-only surface down for every project and ticket, in Volli Cloud's name", () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "http://127.0.0.1:1" });
    expect(remoteHostNow("any")?.name).toBe("Volli Cloud");
    expect(remoteHostNow(null)).toBeNull();
    expect(remoteHostOfTicketNow("t")?.name).toBe("Volli Cloud");
    expect(refuseRemote("any")).toBe(true);
    expect(refuseRemoteTicket("t")).toBe(true);
    expect(toast).toHaveBeenCalledWith("Not available on Volli Cloud yet", {
      id: "host-local-only",
    });
  });
});
