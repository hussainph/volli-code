// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import { hostWorld, type HostWorld } from "./hosts.test-support";
import { notAvailableOn, remoteHostNameNow, useRemoteHostName } from "./use-remote-project";

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
});

function HostName({ projectId }: { projectId: string | null }) {
  return <span data-slot="name">{useRemoteHostName(projectId) ?? "this-mac"}</span>;
}

const shown = () => document.querySelector('[data-slot="name"]')?.textContent;

describe("which host a project's Sessions run on (VC-713)", () => {
  it("names a remote project's host, and This Mac for a local one or none", async () => {
    world = hostWorld();
    await world.render(<HostName projectId="remote" />);
    expect(shown()).toBe("hetzner-1");
    expect(remoteHostNameNow("remote")).toBe("hetzner-1");
    await world.rerender(<HostName projectId="local" />);
    expect(shown()).toBe("this-mac");
    expect(remoteHostNameNow("local")).toBeNull();
    await world.rerender(<HostName projectId={null} />);
    expect(shown()).toBe("this-mac");
    expect(remoteHostNameNow(null)).toBeNull();
  });

  it("is This Mac everywhere with the flag off", async () => {
    world = hostWorld({ cloud: false });
    await world.render(<HostName projectId="remote" />);
    expect(shown()).toBe("this-mac");
    expect(remoteHostNameNow("remote")).toBeNull();
  });

  it("says what a local-only surface cannot do there", () => {
    expect(notAvailableOn("hetzner-1")).toBe("Not available on hetzner-1 yet");
  });
});
