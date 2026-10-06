// @vitest-environment jsdom
/**
 * Read-only is real (VC-615 flow 5): while the project's host cannot serve,
 * the board's create and write controls stand down — and with the flag off,
 * or for a host that serves, nothing changes.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useNewTicketShortcut } from "@renderer/hooks/use-new-ticket-shortcut";
import { useUiStore } from "@renderer/stores/ui";

import { hostWorld, type HostWorld } from "./hosts.test-support";
import { isHostReadOnly, useHostReadOnly } from "./use-hosts";

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
  useUiStore.setState({ newTicketOpen: false });
});

function Probe({ projectId }: { projectId: string | null }) {
  useNewTicketShortcut();
  const readOnly = useHostReadOnly(projectId);
  return <button type="button" disabled={readOnly} data-testid="write" />;
}

function write(): HTMLButtonElement {
  return document.querySelector('[data-testid="write"]') as HTMLButtonElement;
}

function pressC(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
  });
}

describe("read-only stand-down", () => {
  it("stands the write controls and the c shortcut down while the host cannot serve", async () => {
    world = hostWorld({ hetzner: { link: { status: "offline", since: 0, retryAt: null } } });
    await world.render(<Probe projectId="remote" />);
    expect(write().disabled).toBe(true);
    expect(isHostReadOnly("remote")).toBe(true);
    pressC();
    expect(useUiStore.getState().newTicketOpen).toBe(false);

    world.setHetzner({ link: { status: "incompatible", reason: "host-too-old" } });
    expect(write().disabled).toBe(true);
  });

  it("brings them back once the host serves, and never stands down for a blip", async () => {
    world = hostWorld({ hetzner: { link: { status: "offline", since: 0, retryAt: null } } });
    await world.render(<Probe projectId="remote" />);
    world.setHetzner({ link: { status: "reconnecting" } });
    expect(write().disabled).toBe(false);
    world.setHetzner({ link: { status: "open" } });
    expect(write().disabled).toBe(false);
    pressC();
    expect(useUiStore.getState().newTicketOpen).toBe(true);
  });

  it("changes nothing with the flag off, even for an unreachable host", async () => {
    world = hostWorld({
      cloud: false,
      hetzner: { link: { status: "offline", since: 0, retryAt: null } },
    });
    await world.render(<Probe projectId="remote" />);
    expect(write().disabled).toBe(false);
    expect(isHostReadOnly("remote")).toBe(false);
    pressC();
    expect(useUiStore.getState().newTicketOpen).toBe(true);
  });

  it("never stands This Mac's projects down", async () => {
    world = hostWorld({
      selected: "local",
      hetzner: { link: { status: "offline", since: 0, retryAt: null } },
    });
    await world.render(<Probe projectId="local" />);
    expect(write().disabled).toBe(false);
  });
});
