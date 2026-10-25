// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";

import { adoptLaunch, cloudLaunchNow, launchStore } from "./launch";
import { projectPlaceNow, useProjectPlace, type ProjectPlace } from "./project-place";
import { remoteProject } from "./remote-project.test-support";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD = { store: "cloud", userId: "u", backendUrl: "http://127.0.0.1:1" } as const;

afterEach(() => adoptLaunch(LOCAL_LAUNCH));

function placeIn(projectId: string | null): ProjectPlace {
  let place: ProjectPlace | null = null;
  function Probe() {
    place = useProjectPlace(projectId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return place!;
}

describe("the launch's store and each project's place (VC-889)", () => {
  it("is a local launch until boot adopts another", () => {
    expect(launchStore()).toBe("local");
    expect(cloudLaunchNow()).toBeNull();
    adoptLaunch(CLOUD);
    expect(launchStore()).toBe("cloud");
    expect(cloudLaunchNow()).toBe(CLOUD);
  });

  it("puts every project of a cloud launch on Volli Cloud", () => {
    adoptLaunch(CLOUD);
    expect(projectPlaceNow("p1")).toBe("cloud");
    expect(placeIn("p1")).toBe("cloud");
  });

  it("puts a local launch's projects on this Mac, and a remote host's on that host", () => {
    expect(projectPlaceNow("p1")).toBe("local");
    expect(placeIn("p1")).toBe("local");
    const undo = remoteProject("remote");
    try {
      expect(projectPlaceNow("remote")).toBe("remote-host");
      expect(placeIn("remote")).toBe("remote-host");
    } finally {
      undo();
    }
  });
});
