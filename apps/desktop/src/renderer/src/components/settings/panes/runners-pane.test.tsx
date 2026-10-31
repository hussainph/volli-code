// @vitest-environment jsdom
/**
 * Settings → Runners (VC-895) over a stand-in for main's `runners.*` tier and
 * the window's Volli Cloud client: what the list and this Mac's states draw,
 * and where each control's command goes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { THIS_MAC_RUNNER_OFF, type ThisMacRunnerSnapshot } from "@volli/shared";

import type { CloudSession } from "@renderer/lib/cloud-client";
import { fakeCloud, refusal } from "@renderer/stores/cloud-board/fake-cloud.test-support";

import { RunnersPane } from "./runners-pane";
import type { RunnerRow, RunnersRpc } from "./use-runners";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIST = "runners:list";

const ONLINE: ThisMacRunnerSnapshot = {
  ...THIS_MAC_RUNNER_OFF,
  state: "online",
  runnerId: "runner-mac",
  runnerName: "studio",
  since: 1,
};

const row = (patch: Partial<RunnerRow> & Pick<RunnerRow, "id" | "name">): RunnerRow => ({
  kind: "linux",
  status: "online",
  statusReason: null,
  statusChangedAt: Date.now(),
  ...patch,
});

const ROWS: RunnerRow[] = [
  row({ id: "runner-box", name: "box", version: "0.3.0" }),
  row({ id: "runner-mac", name: "studio", kind: "mac" }),
  row({ id: "runner-old", name: "old", status: "revoked", statusReason: "credential_reuse" }),
  row({ id: "runner-new", name: "zeta", kind: "cloud", status: "hibernating" }),
];

function standIn() {
  let handlers: {
    onData(data: ThisMacRunnerSnapshot): void;
    onError(error: unknown): void;
  } | null = null;
  const unsubscribe = vi.fn();
  const rpc = {
    runners: {
      subscribeThisMac: {
        subscribe: vi.fn((_input: undefined, next: NonNullable<typeof handlers>) => {
          handlers = next;
          return { unsubscribe };
        }),
      },
      addThisMac: { mutate: vi.fn(async () => null) },
      removeThisMac: { mutate: vi.fn(async () => null) },
    },
  } satisfies RunnersRpc;
  const cloud = fakeCloud();
  let session: CloudSession | null = cloud.session;
  const followers = new Set<(session: CloudSession | null) => void>();
  const follow = vi.fn((listener: (next: CloudSession | null) => void) => {
    followers.add(listener);
    if (session !== null) listener(session);
    return () => followers.delete(listener);
  });
  return {
    rpc,
    cloud,
    unsubscribe,
    props: { rpc, follow, current: () => session },
    push: (snapshot: ThisMacRunnerSnapshot) => act(() => handlers!.onData(snapshot)),
    fail: (error: unknown) => act(() => handlers!.onError(error)),
    list: (rows: readonly RunnerRow[]) => act(() => cloud.answer(LIST, {}, rows)),
    listFails: (error: unknown) => act(() => cloud.fail(LIST, {}, error)),
    close: () =>
      act(() => {
        session = null;
        for (const listener of followers) listener(null);
      }),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const button = (label: string, scope: ParentNode = document): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}" in ${document.body.textContent}`);
  return found;
};

const runnerRow = (id: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-testid="runner-${id}"]`)!;

async function openMenu(name: string): Promise<void> {
  const trigger = container.querySelector<HTMLElement>(`[aria-label="More for ${name}"]`)!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
}

async function menu(name: string, item: string): Promise<void> {
  await openMenu(name);
  const found = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (node) => node.textContent?.trim() === item,
  );
  if (found === undefined) throw new Error(`no menu item "${item}"`);
  await act(async () => found.click());
}

async function type(input: HTMLInputElement, value: string, key: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const dialog = (): HTMLElement => document.querySelector<HTMLElement>("[role=alertdialog]")!;

describe("Settings → Runners", () => {
  it("lists the person's runners, this Mac first and marked, each status in a short phrase", () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    expect(container.textContent).toContain("Loading runners…");
    tier.push(ONLINE);
    tier.list(ROWS);

    const names = [...container.querySelectorAll('[data-testid^="runner-"]')].map((node) =>
      node.getAttribute("data-testid")!,
    );
    expect(names).toEqual([
      "runner-runner-mac",
      "runner-runner-box",
      "runner-runner-old",
      "runner-runner-new",
    ]);
    expect(runnerRow("runner-mac").textContent).toContain("This Mac");
    expect(runnerRow("runner-mac").textContent).toContain("Online");
    expect(runnerRow("runner-box").textContent).not.toContain("This Mac");
    expect(runnerRow("runner-box").textContent).toContain("Version 0.3.0");
    expect(runnerRow("runner-old").textContent).toContain("Used from two places");
    expect(runnerRow("runner-new").textContent).toContain("hibernating");
    expect(container.querySelector('[data-testid="this-mac-blocked"]')).toBeNull();
  });

  it("shows the backend’s update floor and version without offering unavailable update controls", async () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.push(ONLINE);
    tier.list([
      row({ id: "old-linux", name: "old-linux", version: "0.2.9", status: "upgrade_required" }),
    ]);
    expect(runnerRow("old-linux").textContent).toContain("Needs an update");
    expect(runnerRow("old-linux").textContent).toContain("Version 0.2.9");
    await openMenu("old-linux");
    expect(document.body.textContent).not.toContain("Update now");
    expect(document.body.textContent).not.toContain("Automatic updates");
  });

  it("requests a one-shot update without enabling automatic updates, and shows the backend's pin", async () => {
    const tier = standIn();
    const linux = row({
      id: "box",
      name: "box",
      version: "0.3.0",
      status: "upgrade_required",
      autoUpdate: { enabled: false, channel: "stable", pinnedVersion: null },
    });
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list([linux]);
    await menu("box", "Update now");
    expect(tier.cloud.mutations.map(({ name, args }) => [name, args])).toEqual([
      ["runners:updateNow", { runnerId: "box" }],
    ]);
    await openMenu("box");
    expect(document.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-disabled")).toBe(
      "true",
    );
    const policy = { enabled: false, channel: "stable", pinnedVersion: "0.3.1" };
    await act(async () => tier.cloud.mutations[0]!.resolve({ autoUpdate: policy }));
    tier.list([{ ...linux, autoUpdate: policy }]);
    expect(runnerRow("box").textContent).toContain("Update to 0.3.1 requested");
    expect(document.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked")).toBe(
      "false",
    );
    tier.list([{ ...linux, version: "0.3.1", status: "online" }]);
    expect(runnerRow("box").textContent).not.toContain("requested");
  });

  it("toggles automatic updates through the owner API without changing channel", async () => {
    const tier = standIn();
    const linux = row({
      id: "box",
      name: "box",
      autoUpdate: { enabled: true, channel: "canary", pinnedVersion: null },
    });
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list([linux]);
    await menu("box", "Automatic updates");
    expect(tier.cloud.mutations[0]).toMatchObject({
      name: "runners:setAutoUpdate",
      args: { runnerId: "box", enabled: false },
    });
    const policy = { ...linux.autoUpdate!, enabled: false };
    await act(async () => tier.cloud.mutations[0]!.resolve({ autoUpdate: policy }));
    tier.list([{ ...linux, autoUpdate: policy }]);
    await menu("box", "Automatic updates");
    expect(tier.cloud.mutations[1]).toMatchObject({
      name: "runners:setAutoUpdate",
      args: { runnerId: "box", enabled: true },
    });
    await act(async () => tier.cloud.mutations[1]!.resolve({ autoUpdate: linux.autoUpdate }));
  });

  it("surfaces refused updates and policy writes, and refuses disconnected writes", async () => {
    const tier = standIn();
    const { toast } = await import("sonner");
    const error = vi.spyOn(toast, "error");
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list([
      row({
        id: "box",
        name: "box",
        autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
      }),
    ]);
    await menu("box", "Update now");
    await act(async () =>
      tier.cloud.mutations[0]!.reject(
        refusal("release_unavailable", "No runner update is available yet."),
      ),
    );
    expect(error).toHaveBeenCalledWith(
      "Couldn’t update box: No runner update is available yet.",
      expect.anything(),
    );
    await menu("box", "Automatic updates");
    await act(async () =>
      tier.cloud.mutations[1]!.reject(refusal("not_found", "Runner not found.")),
    );
    expect(error).toHaveBeenCalledWith(
      "Couldn’t change automatic updates for box: Runner not found.",
      expect.anything(),
    );
    tier.cloud.connected = false;
    await menu("box", "Update now");
    expect(tier.cloud.mutations).toHaveLength(2);
    expect(error).toHaveBeenCalledWith(
      "Couldn’t update box: Volli Cloud isn’t connected yet.",
      expect.anything(),
    );
  });

  it("keeps a revoked runner's update controls disabled", async () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list([
      row({
        id: "box",
        name: "box",
        status: "revoked",
        statusReason: "credential_reuse",
        autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
      }),
    ]);
    await menu("box", "Update now");
    const controls = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter(
      (node) => ["Update now", "Automatic updates"].includes(node.textContent?.trim() ?? ""),
    );
    expect(controls).toHaveLength(2);
    expect(controls.every((node) => node.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(tier.cloud.mutations).toHaveLength(0);
  });

  it.each(["mac", "cloud", "future-kind"])(
    "does not offer Linux update controls for %s runners",
    async (kind) => {
      const tier = standIn();
      act(() => root.render(<RunnersPane {...tier.props} />));
      tier.list([
        row({
          id: "box",
          name: "box",
          kind,
          autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
        }),
      ]);
      await openMenu("box");
      expect(document.body.textContent).not.toContain("Update now");
      expect(document.body.textContent).not.toContain("Automatic updates");
    },
  );

  it("says quietly while this Mac is being added, and lets its own state speak when it can't reach Volli Cloud", () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list([]);
    expect(container.textContent).toContain("No runners yet.");
    tier.push({ ...THIS_MAC_RUNNER_OFF, state: "registering" });
    const pending = container.querySelector('[data-testid="runner-this-mac-pending"]')!;
    expect(pending.textContent).toContain("This Mac");
    expect(pending.textContent).toContain("Adding…");

    tier.push({ ...ONLINE, state: "connecting" });
    expect(container.textContent).toContain("Connecting…");
    tier.list(ROWS);
    expect(container.querySelector('[data-testid="runner-this-mac-pending"]')).toBeNull();
    expect(runnerRow("runner-mac").textContent).toContain("Connecting…");

    tier.push({ ...ONLINE, state: "offline", since: null });
    expect(runnerRow("runner-mac").textContent).toContain("Offline");
    expect(runnerRow("runner-mac").textContent).not.toContain("Online");
  });

  it("shows a removed Mac's sentence and adds it again", async () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list(ROWS.filter(({ id }) => id !== "runner-mac"));
    tier.push({
      ...ONLINE,
      state: "removed",
      problem: "removed",
      message: "This Mac was removed from your runners.",
    });
    const blocked = container.querySelector<HTMLElement>('[data-testid="this-mac-blocked"]')!;
    expect(blocked.querySelector("[role=status]")?.textContent).toBe(
      "This Mac was removed from your runners.",
    );
    await act(async () => button("Add this Mac again", blocked).click());
    expect(tier.rpc.runners.addThisMac.mutate).toHaveBeenCalledOnce();
  });

  it("shows a failed registration as an alert and tries again, surfacing a retry that fails", async () => {
    const tier = standIn();
    const { toast } = await import("sonner");
    const error = vi.spyOn(toast, "error");
    tier.rpc.runners.addThisMac.mutate.mockRejectedValueOnce(new Error("Keychain locked."));
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list([]);
    tier.push({
      ...THIS_MAC_RUNNER_OFF,
      state: "failed",
      problem: "credentials_locked",
      message: "This Mac's runner credential couldn't be read.",
    });
    const blocked = container.querySelector<HTMLElement>('[data-testid="this-mac-blocked"]')!;
    expect(blocked.querySelector("[role=alert]")?.textContent).toBe(
      "This Mac's runner credential couldn't be read.",
    );
    await act(async () => button("Try again", blocked).click());
    expect(tier.rpc.runners.addThisMac.mutate).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Couldn’t add this Mac: Keychain locked.",
      expect.anything(),
    );
  });

  it("renames a runner in place through the window's client, and surfaces a refusal", async () => {
    const tier = standIn();
    const { toast } = await import("sonner");
    const error = vi.spyOn(toast, "error");
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.push(ONLINE);
    tier.list(ROWS);

    await menu("box", "Rename");
    let input = runnerRow("runner-box").querySelector("input")!;
    await type(input, "Big Box", "Enter");
    expect(tier.cloud.mutations.map(({ name, args }) => [name, args])).toEqual([
      ["runners:rename", { runnerId: "runner-box", name: "Big Box" }],
    ]);
    await act(async () => tier.cloud.mutations[0]!.resolve({ name: "big-box" }));
    expect(error).not.toHaveBeenCalled();

    await menu("box", "Rename");
    input = runnerRow("runner-box").querySelector("input")!;
    await type(input, "studio", "Enter");
    await act(async () =>
      tier.cloud.mutations[1]!.reject(
        refusal("forbidden", "You already have a runner named studio."),
      ),
    );
    expect(error).toHaveBeenCalledWith(
      "Couldn’t rename box: You already have a runner named studio.",
      expect.anything(),
    );
  });

  it("refuses a write while Volli Cloud isn't connected", async () => {
    const tier = standIn();
    const { toast } = await import("sonner");
    const error = vi.spyOn(toast, "error");
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list(ROWS);
    tier.cloud.connected = false;
    await menu("box", "Rename");
    await type(runnerRow("runner-box").querySelector("input")!, "crate", "Enter");
    expect(tier.cloud.mutations).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      "Couldn’t rename box: Volli Cloud isn’t connected yet.",
      expect.anything(),
    );
  });

  it("removes another runner through the window's client, only after the confirm", async () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.push(ONLINE);
    tier.list(ROWS);
    await menu("box", "Remove…");
    expect(tier.cloud.mutations).toHaveLength(0);
    expect(dialog().textContent).toContain("Remove box?");
    await act(async () => button("Cancel", dialog()).click());
    expect(tier.cloud.mutations).toHaveLength(0);

    await menu("box", "Remove…");
    await act(async () => button("Remove", dialog()).click());
    expect(tier.cloud.mutations.map(({ name, args }) => [name, args])).toEqual([
      ["runners:remove", { runnerId: "runner-box" }],
    ]);
    expect(tier.rpc.runners.removeThisMac.mutate).not.toHaveBeenCalled();
  });

  it("removes this Mac through main, never the window's client", async () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.push(ONLINE);
    tier.list(ROWS);
    await menu("studio", "Remove…");
    expect(dialog().textContent).toContain("Remove this Mac?");
    await act(async () => button("Remove", dialog()).click());
    expect(tier.rpc.runners.removeThisMac.mutate).toHaveBeenCalledOnce();
    expect(tier.cloud.mutations).toHaveLength(0);
  });

  it("says when either read failed, and reads both again on Retry", () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.listFails(refusal("unauthenticated", "Sign in to Volli Cloud."));
    expect(container.textContent).toContain("Sign in to Volli Cloud.");
    act(() => button("Retry").click());
    expect(tier.props.follow).toHaveBeenCalledTimes(2);
    expect(tier.rpc.runners.subscribeThisMac.subscribe).toHaveBeenCalledTimes(2);
    expect(tier.unsubscribe).toHaveBeenCalledOnce();

    tier.list(ROWS);
    tier.fail(new Error("The subscription's source failed"));
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "The subscription's source failed",
    );
    expect(runnerRow("runner-box")).not.toBeNull();
  });

  it("waits again when the client closes, and stops watching on unmount", () => {
    const tier = standIn();
    act(() => root.render(<RunnersPane {...tier.props} />));
    tier.list(ROWS);
    expect(tier.cloud.watchers(LIST, {})).toBe(1);
    tier.close();
    expect(container.textContent).toContain("Volli Cloud isn’t connected yet.");
    expect(tier.cloud.watchers(LIST, {})).toBe(0);
    act(() => root.unmount());
    expect(tier.unsubscribe).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});
