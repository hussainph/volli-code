// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import { RunningOnLabel } from "./running-on-label";
import { hostWorld, type HostWorld } from "./hosts.test-support";

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
});

function label(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="running-on"]');
}

describe("Running on label", () => {
  it("renders nothing with the flag off, even for a remote host", async () => {
    world = hostWorld({ cloud: false });
    const container = await world.render(<RunningOnLabel projectId="remote" />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden for This Mac, so a person without hosts sees nothing new", async () => {
    world = hostWorld();
    const container = await world.render(<RunningOnLabel projectId="local" />);
    expect(container.innerHTML).toBe("");
    await world.rerender(<RunningOnLabel projectId={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("names a remote host, its dot the host's state", async () => {
    world = hostWorld();
    await world.render(<RunningOnLabel projectId="remote" className="mt-2" />);
    // Read whole ("Running on hetzner-1"); the words on screen are the name.
    expect(label()?.textContent).toBe("Running on hetzner-1");
    expect(label()?.querySelector(".sr-only")?.textContent).toBe("Running on ");
    expect(label()?.getAttribute("title")).toBe("Running on hetzner-1");
    expect(label()?.className).toContain("mt-2");
    const dot = () =>
      label()?.querySelector('[data-slot="status-dot"]')?.getAttribute("data-state");
    expect(dot()).toBe("ready");

    world.setHetzner({ link: { status: "offline", since: 0, retryAt: null } });
    expect(dot()).toBe("exited");
  });
});
