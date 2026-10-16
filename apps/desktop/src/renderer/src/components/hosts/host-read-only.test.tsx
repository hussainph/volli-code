// @vitest-environment jsdom
/**
 * Read-only is real (VC-615 flow 5) and keyed off the CURRENT PROJECT's own
 * link: while it cannot serve, `useCanWrite` stands every write down and
 * `guardWrite` refuses a submission with the reason. With the flag off nothing
 * reads the host store at all — no subscription, no re-render, no commit.
 */
import { act, Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useNewTicketShortcut } from "@renderer/hooks/use-new-ticket-shortcut";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useUiStore } from "@renderer/stores/ui";

import { HETZNER_ID, hostWorld, type HostWorld } from "./hosts.test-support";
import { ReadOnlyNote } from "./read-only-note";
import { RunningOnLabel } from "./running-on-label";
import {
  canWriteNow,
  guardWrite,
  readOnlyControl,
  readOnlyMark,
  readOnlyReason,
  useCanWrite,
} from "./use-hosts";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const OFFLINE = { status: "offline", since: 0, retryAt: null } as const;
const FENCED = { status: "incompatible", reason: "fenced" } as const;

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
  useUiStore.setState({ newTicketOpen: false });
  toast.mockClear();
});

function Probe({ projectId }: { projectId: string | null }) {
  useNewTicketShortcut();
  const canWrite = useCanWrite(projectId);
  return <button type="button" {...readOnlyControl(canWrite)} data-testid="write" />;
}

function write(): HTMLButtonElement {
  return document.querySelector('[data-testid="write"]') as HTMLButtonElement;
}

function pressC(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
  });
}

describe("useCanWrite", () => {
  it("stands writes and the c shortcut down while the project cannot serve, and says why", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    await world.render(<Probe projectId="remote" />);
    expect(write().disabled).toBe(true);
    expect(write().hasAttribute("data-host-read-only")).toBe(true);
    expect(canWriteNow("remote")).toBe(false);
    expect(readOnlyReason("remote")).toBe("Can’t reach hetzner-1 · Read-only");
    pressC();
    expect(useUiStore.getState().newTicketOpen).toBe(false);
    expect(toast).toHaveBeenCalledWith("Can’t reach hetzner-1 · Read-only", {
      id: "host-read-only",
    });

    world.setHetzner({ link: { status: "incompatible", reason: "host-too-old" } });
    expect(write().disabled).toBe(true);
    expect(readOnlyReason("remote")).toBe("hetzner-1 needs a newer Volli host · Read-only");
  });

  it("brings them back once the host serves, and never stands down for a blip", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    await world.render(<Probe projectId="remote" />);
    world.setHetzner({ link: { status: "reconnecting" } });
    expect(write().disabled).toBe(false);
    expect(write().hasAttribute("data-host-read-only")).toBe(false);
    world.setHetzner({ link: { status: "open" } });
    expect(readOnlyReason("remote")).toBeNull();
    expect(guardWrite("remote")).toBe(true);
    pressC();
    expect(useUiStore.getState().newTicketOpen).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it("follows the project's own link: a fenced neighbour on the same box blocks only itself", async () => {
    world = hostWorld();
    // `spare` moves to hetzner-1 beside `remote`, then only `spare` is fenced.
    act(() => {
      const snapshot = world!.remote.getSnapshot();
      world!.remote.set({
        ...snapshot,
        projects: { ...snapshot.projects, spare: { hostId: HETZNER_ID, link: FENCED } },
      });
    });
    await world.render(<Probe projectId="remote" />);
    expect(write().disabled).toBe(false);
    expect(canWriteNow("spare")).toBe(false);
    expect(readOnlyReason("spare")).toBe("hetzner-1 no longer serves this project · Read-only");
    expect(guardWrite("remote")).toBe(true);
    expect(guardWrite("spare")).toBe(false);
  });

  it("never stands This Mac's projects down", async () => {
    world = hostWorld({ selected: "local", hetzner: { link: OFFLINE } });
    await world.render(<Probe projectId="local" />);
    expect(write().disabled).toBe(false);
    expect(canWriteNow(null)).toBe(true);
  });

  it("marks nothing at all while a control can write", () => {
    expect(readOnlyControl(true)).toEqual({});
    expect(readOnlyMark(true)).toEqual({});
    expect(readOnlyControl(false)).toEqual({ disabled: true, "data-host-read-only": "" });
    expect(readOnlyMark(false)).toEqual({ "data-host-read-only": "" });
  });
});

describe("ReadOnlyNote", () => {
  it("says the reason while the project cannot serve, and nothing otherwise", async () => {
    world = hostWorld();
    const container = await world.render(<ReadOnlyNote projectId="remote" className="px-4" />);
    expect(container.innerHTML).toBe("");
    world.setHetzner({ link: OFFLINE });
    const note = container.querySelector('[data-slot="host-read-only-note"]');
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.textContent).toBe("Can’t reach hetzner-1 · Read-only");
    expect(note?.className).toContain("px-4");
    world.setHetzner({ link: { status: "open" } });
    expect(container.innerHTML).toBe("");
  });
});

describe("flag off: zero cost", () => {
  it("changes nothing, even for an unreachable host", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    const container = await world.render(
      <>
        <Probe projectId="remote" />
        <ReadOnlyNote projectId="remote" />
      </>,
    );
    expect(write().disabled).toBe(false);
    expect(write().outerHTML).toBe('<button type="button" data-testid="write"></button>');
    expect(container.querySelector('[data-slot="host-read-only-note"]')).toBeNull();
    expect(canWriteNow("remote")).toBe(true);
    expect(readOnlyReason("remote")).toBeNull();
    expect(guardWrite("remote")).toBe(true);
    pressC();
    expect(useUiStore.getState().newTicketOpen).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it("the board hook and the label hold no host-store subscription, and never re-render or commit", async () => {
    world = hostWorld({ cloud: false });
    const subscribe = vi.spyOn(useHostConnectionStore, "subscribe");
    let renders = 0;
    function Board() {
      renders += 1;
      return <>{String(useCanWrite("remote"))}</>;
    }
    const commits = vi.fn();
    await world.render(
      <>
        <Board />
        <Profiler id="label" onRender={commits}>
          <RunningOnLabel projectId="remote" />
        </Profiler>
      </>,
    );
    expect(subscribe).not.toHaveBeenCalled();
    const before = renders;
    commits.mockClear();

    world.setHetzner({ link: OFFLINE });
    world.setHetzner({ version: "0.4.0" });
    world.setHetzner({ link: FENCED });
    expect(renders).toBe(before);
    expect(commits).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    subscribe.mockRestore();
  });

  it("with the flag on, the same hook does follow the host (the probe above is live)", async () => {
    world = hostWorld();
    let renders = 0;
    function Board() {
      renders += 1;
      return <>{String(useCanWrite("remote"))}</>;
    }
    const container = await world.render(<Board />);
    const before = renders;
    world.setHetzner({ link: OFFLINE });
    expect(renders).toBe(before + 1);
    expect(container.textContent).toBe("false");
    // A change that does not touch the answer does not re-render.
    world.setHetzner({ version: "0.4.0" });
    expect(renders).toBe(before + 1);
  });

  it("turning the flag on mid-life subscribes, and turning it off lets go", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    const container = await world.render(<Probe projectId="remote" />);
    expect(write().disabled).toBe(false);
    const { useExperimentsStore } = await import("@renderer/stores/experiments");
    act(() =>
      useExperimentsStore.getState().receive({ cloud: { enabled: true, source: "storage" } }),
    );
    expect(write().disabled).toBe(true);
    act(() =>
      useExperimentsStore.getState().receive({ cloud: { enabled: false, source: "storage" } }),
    );
    expect(write().disabled).toBe(false);
    expect(container.innerHTML).toContain("write");
  });
});
