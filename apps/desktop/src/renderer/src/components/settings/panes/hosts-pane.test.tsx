// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  click,
  HETZNER_ID,
  hostWorld,
  type HostWorld,
} from "@renderer/components/hosts/hosts.test-support";
import { useHostSignInSheet } from "@renderer/components/hosts/sign-ins/remote-host-sign-in-source";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useHostConnectionStore, type HostLinkView } from "@renderer/stores/host-connection";
import { remoteHost } from "@renderer/stores/host-sources";
import { useProjectsStore } from "@renderer/stores/projects";
import { setRemoteHostsApi, useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import {
  createFakeRemoteHostsApi,
  registryHost,
  type FakeRemoteHostsApi,
} from "@renderer/stores/remote-hosts.test-support";

import { HostsPane } from "./hosts-pane";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

let world: HostWorld | null = null;
let api: FakeRemoteHostsApi;

const HETZNER = registryHost({ id: HETZNER_ID, name: "hetzner-1", target: "deploy@hetzner-1" });
const IDLE = registryHost({
  id: "host-idle",
  name: "studio",
  target: "me@studio",
  os: "macos",
  mode: "user",
  agentsShareAccount: true,
  deviceId: "dev-me",
});

beforeEach(() => {
  api = createFakeRemoteHostsApi();
  setRemoteHostsApi(api);
});

afterEach(async () => {
  await world?.cleanup();
  world = null;
  setRemoteHostsApi(null);
  useRemoteHostsStore.setState({ hosts: [], addHost: { open: false, target: "" } });
  document.body.innerHTML = "";
  toast.mockClear();
  toast.error.mockClear();
});

async function renderPane(hosts = [HETZNER, IDLE]): Promise<HTMLElement> {
  world = hostWorld();
  const snapshot = world.remote.getSnapshot();
  world.remote.set({
    ...snapshot,
    hosts: [...snapshot.hosts, remoteHost(IDLE.id, IDLE.name, { os: "macos" })],
  });
  useRemoteHostsStore.getState().setHosts(hosts);
  return world.render(
    <TooltipProvider>
      <HostsPane />
    </TooltipProvider>,
  );
}

function rowNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll("[data-host-row]")].map((row) => row.textContent ?? "");
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openHost(root: HTMLElement, name: string): Promise<void> {
  const row = [...root.querySelectorAll<HTMLElement>("[data-host-row]")].find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (row === undefined) throw new Error(`No row ${name}`);
  await act(async () => row.click());
  await settle();
}

describe("Settings → Hosts", () => {
  it("lists This Mac, then each added host with its connection and its facts", async () => {
    const root = await renderPane();
    const rows = rowNames(root);
    expect(rows[0]).toContain("This Mac");
    expect(rows[1]).toContain("hetzner-1");
    expect(rows[1]).toContain("SSH · deploy@hetzner-1 · 1.1.0");
    expect(rows[1]).toContain("Online");
    // studio serves no project here, but still has engine-owned host health.
    expect(rows[2]).toContain("No projects yet");
    expect(rows[2]).toContain("Online");
    expect(root.textContent).toContain("Add a host…");
  });

  it.each<{ link: HostLinkView; label: string }>([
    { link: { status: "connecting" }, label: "Connecting" },
    { link: { status: "open" }, label: "Online" },
    { link: { status: "offline", since: 0, retryAt: null }, label: "Offline" },
  ])("shows $label in the list and detail for a zero-project host", async ({ link, label }) => {
    const root = await renderPane();
    act(() => world!.remote.setHost(IDLE.id, { link }));
    expect(
      Object.values(useHostConnectionStore.getState().projects).filter(
        (claim) => claim.hostId === IDLE.id,
      ),
    ).toHaveLength(0);
    expect(rowNames(root)[2]).toContain("No projects yet");
    expect(rowNames(root)[2]).toContain(label);
    if (link.status !== "offline") {
      expect(root.querySelector('[aria-label="Retry studio"]')).toBeNull();
    }

    await openHost(root, "studio");
    await vi.waitFor(() => expect(root.querySelector("[data-host-row]")).toBeNull());
    const header = root.querySelector("h2")!.parentElement!.parentElement!;
    expect(header.textContent).toContain("No projects yet");
    expect(header.textContent).toContain(label);
    if (link.status !== "offline") {
      expect(header.querySelector('[aria-label="Retry studio"]')).toBeNull();
    }
  });

  it("retries a zero-project offline host from both list and detail through its owning source", async () => {
    const root = await renderPane();
    act(() =>
      world!.remote.setHost(IDLE.id, {
        link: { status: "offline", since: 0, retryAt: null },
      }),
    );
    await click(root, "Retry studio");
    expect(world!.remote.calls).toEqual([{ kind: "retry", hostId: IDLE.id }]);
    expect(world!.local.calls).toEqual([]);
    expect(root.querySelector('[aria-label="All hosts"]')).toBeNull();
    expect(rowNames(root)[2]).toContain("Offline");

    await openHost(root, "studio");
    await vi.waitFor(() => expect(root.querySelector("[data-host-row]")).toBeNull());
    await click(root, "Retry studio");
    expect(world!.remote.calls).toEqual([
      { kind: "retry", hostId: IDLE.id },
      { kind: "retry", hostId: IDLE.id },
    ]);
    // Intent alone does not claim recovery; only a new engine projection does.
    const header = root.querySelector("h2")!.parentElement!.parentElement!;
    expect(header.textContent).toContain("Offline");
    act(() => world!.remote.setHost(IDLE.id, { link: { status: "connecting" } }));
    expect(header.textContent).toContain("Connecting");
    expect(header.querySelector('[aria-label="Retry studio"]')).toBeNull();
    act(() => world!.remote.setHost(IDLE.id, { link: { status: "open" } }));
    expect(header.textContent).toContain("Online");
    await click(root, "All hosts");
    await vi.waitFor(() => expect(rowNames(root)[2]).toContain("Online"));
    expect(root.querySelector('[aria-label="Retry studio"]')).toBeNull();
  });

  it("offers Add a host… as the one row when only This Mac is here", async () => {
    const root = await renderPane([]);
    const rows = rowNames(root);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("Add a host…");
    const add = root.querySelectorAll<HTMLElement>("[data-host-row]")[1]!;
    await act(async () => add.click());
    expect(useRemoteHostsStore.getState().addHost.open).toBe(true);
  });

  it("opens a host's page: its facts, its projects, and the devices it has paired", async () => {
    api.devicesOf.set(IDLE.id, [
      {
        deviceId: "dev-old",
        name: "Old laptop",
        fingerprint: "f",
        enrolledAt: "2026-01-01T00:00:00Z",
        via: "ssh",
        revokedAt: "2026-02-01T00:00:00Z",
        thisMac: false,
      },
      {
        deviceId: "dev-me",
        name: "Hussain’s MacBook Pro",
        fingerprint: "f",
        enrolledAt: "2026-10-03T00:00:00Z",
        via: "ssh",
        revokedAt: null,
        thisMac: true,
      },
    ]);
    const root = await renderPane();
    await openHost(root, "studio");
    expect(api.calls).toContainEqual(["devices", IDLE.id]);
    const text = root.textContent ?? "";
    expect(text).toContain("macOS");
    expect(text).toContain("Your account");
    expect(text).toContain("When you log in to studio");
    expect(text).toContain("No projects open on this Mac yet");
    // One row per device: this Mac first, a revoked one last.
    const devices = [...root.querySelectorAll<HTMLElement>('[data-testid^="host-device-"]')].map(
      (node) => [node.dataset["testid"], node.textContent ?? ""],
    );
    expect(devices.map(([id]) => id)).toEqual(["host-device-dev-me", "host-device-dev-old"]);
    expect(devices[0]![1]).toContain("This Mac");
    expect(devices[1]![1]).not.toContain("This Mac");
    await click(root, "All hosts");
    await settle();
    expect(rowNames(root)[2]).toContain("studio");
  });

  it("says a hosts file it cannot change, and offers no way to add", async () => {
    const root = await renderPane([]);
    await act(async () =>
      useRemoteHostsStore.getState().setHosts([], "This Mac’s hosts file is from a newer Volli."),
    );
    expect(root.querySelector('[role="status"]')?.textContent).toBe(
      "This Mac’s hosts file is from a newer Volli. Its hosts can’t be added or changed here.",
    );
    // The empty row closes up (its exit animation), and the section offers no action.
    await vi.waitFor(() => expect(root.textContent).not.toContain("Add a host…"));
  });

  it("offers no Rename or Forget on a read-only hosts file: no menu, a plain name, Forget disabled", async () => {
    const line = "This Mac’s hosts file is from a newer Volli.";
    const root = await renderPane();
    await act(async () =>
      useRemoteHostsStore.getState().setHosts(useRemoteHostsStore.getState().hosts, line),
    );
    expect(root.querySelector('[aria-label^="More for"]')).toBeNull();
    await openHost(root, "studio");
    expect(root.querySelector('[aria-label="Host name"]')).toBeNull();
    expect(
      [...root.querySelectorAll("button")].some((b) => b.textContent?.includes("Rename")),
    ).toBe(false);
    const forget = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Forget…",
    );
    expect(forget?.disabled).toBe(true);
    expect(root.textContent).toContain(line);
    expect(api.calls.filter(([method]) => method === "rename" || method === "forget")).toEqual([]);
  });

  it("opens the host's sign-ins from its page (VC-702)", async () => {
    const root = await renderPane();
    await openHost(root, "studio");
    expect(root.textContent).toContain("Models and git");
    await click(root, "Sign-ins…");
    expect(useHostSignInSheet.getState().target).toEqual({
      hostId: IDLE.id,
      hostName: "studio",
      providerId: null,
    });
    act(() => useHostSignInSheet.getState().close());
  });

  it("lists a host's projects", async () => {
    const root = await renderPane();
    await openHost(root, "hetzner-1");
    expect(root.textContent).toContain("Remote");
  });

  it("opens and makes a project on the host from its page (VC-710)", async () => {
    const root = await renderPane();
    await openHost(root, "hetzner-1");
    await click(root, "Open…");
    expect(useRemoteHostsStore.getState().openProject).toMatchObject({
      open: true,
      hostId: HETZNER_ID,
      start: "list",
    });
    await click(root, "New project…");
    expect(useRemoteHostsStore.getState().openProject.start).toBe("new");
    act(() => useRemoteHostsStore.getState().closeProjectSheet());
  });

  it("counts the projects open here that the rail does not name yet", async () => {
    const root = await renderPane();
    act(() =>
      useProjectsStore.setState({
        projects: useProjectsStore.getState().projects.filter((one) => one.id !== "remote"),
      }),
    );
    await openHost(root, "hetzner-1");
    expect(root.textContent).toContain("1 project open on this Mac");
  });

  it("says why it could not list the devices, and tries again", async () => {
    api.devicesOf.set(IDLE.id, new Error("Couldn’t reach studio"));
    const root = await renderPane();
    await openHost(root, "studio");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t reach studio");
    api.devicesOf.set(IDLE.id, []);
    await click(root, "Try again");
    await settle();
    expect(api.calls.filter(([method]) => method === "devices")).toHaveLength(2);
    expect(root.textContent).toContain("No devices");
    await click(root, "Refresh");
    await settle();
    expect(api.calls.filter(([method]) => method === "devices")).toHaveLength(3);
  });

  it("renames a host as this Mac's label", async () => {
    const root = await renderPane();
    await openHost(root, "studio");
    await click(root, "studioRename");
    const field = root.querySelector<HTMLInputElement>('input[aria-label="Host name"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field, "Studio Mac");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(api.calls).toContainEqual(["rename", IDLE.id, "Studio Mac"]);
  });

  it("says when a rename is refused", async () => {
    api.refuseNext("rename", "Too long");
    const root = await renderPane();
    await openHost(root, "studio");
    await click(root, "studioRename");
    const field = root.querySelector<HTMLInputElement>('input[aria-label="Host name"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field, "x");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await settle();
    expect(toast.error).toHaveBeenCalled();
  });

  it("forgets a host only after the confirm, and goes back to the list", async () => {
    const root = await renderPane();
    await openHost(root, "studio");
    await click(root, "Forget…");
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Forget studio?");
    expect(api.calls.some(([method]) => method === "forget")).toBe(false);
    await click(dialog, "Forget");
    await settle();
    expect(api.calls).toContainEqual(["forget", IDLE.id]);
    expect(toast).toHaveBeenCalledWith("Forgot studio");
  });

  it("says when forgetting fails", async () => {
    api.refuseNext("forget", "Busy");
    const root = await renderPane();
    await openHost(root, "studio");
    await click(root, "Forget…");
    await click(document.querySelector<HTMLElement>('[role="alertdialog"]')!, "Forget");
    await settle();
    expect(toast.error).toHaveBeenCalled();
  });
});
