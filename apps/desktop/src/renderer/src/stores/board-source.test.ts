import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";

import { startBoardProtocol, stopBoardProtocol } from "@renderer/lib/board-protocol";

import { boardSourceFor, cloudBoardSource, installCloudBoardSource } from "./board-source";
import { ConvexBoardSource } from "./cloud-board/source";
import { adoptLaunch } from "./launch";
import { remoteProject } from "./remote-project.test-support";

afterEach(() => {
  stopBoardProtocol();
  adoptLaunch(LOCAL_LAUNCH);
  installCloudBoardSource(null);
});

function silentView() {
  return {
    paint: vi.fn(),
    adoptProject: vi.fn(),
    notePlanningChange: vi.fn(),
    checkoutMoved: vi.fn(),
    failed: vi.fn(),
  };
}

describe("where a project's board goes (VC-889)", () => {
  it("is the legacy write-through for every project of a local launch with the flag off", () => {
    expect(boardSourceFor("p1")).toBeNull();
    expect(boardSourceFor(null)).toBeNull();
  });

  it("is the protocol engine for a remote host's project, or one it still follows", () => {
    const { sync } = startBoardProtocol({ view: silentView(), client: {} as never });
    expect(boardSourceFor("mine")).toBeNull();
    expect(boardSourceFor(undefined)).toBeNull();
    const undo = remoteProject("remote");
    expect(boardSourceFor("remote")).toBe(sync);
    undo();
    vi.spyOn(sync, "follows").mockImplementation((id) => id === "left");
    expect(boardSourceFor("left")).toBe(sync);
    expect(boardSourceFor("remote")).toBeNull();
  });

  it("is Volli Cloud's source for every project of a cloud launch", () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "http://127.0.0.1:1" });
    expect(boardSourceFor("any")).toBeNull();
    const source = new ConvexBoardSource(
      {
        paint: vi.fn(),
        notePlanningChange: vi.fn(),
        failed: vi.fn(),
        refused: vi.fn(),
        unconfirmed: vi.fn(),
        readOnly: () => null,
        dropped: vi.fn(),
      },
      "user-1",
    );
    installCloudBoardSource(source);
    expect(cloudBoardSource()).toBe(source);
    expect(boardSourceFor("any")).toBe(source);
    expect(boardSourceFor(null)).toBe(source);
  });
});
