// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { questionPrompt } from "@renderer/components/hosts/add-host-model";
import { click, hostWorld, type HostWorld } from "@renderer/components/hosts/hosts.test-support";
import { useRemoteHostsStore } from "@renderer/stores/remote-hosts";

import { installFakeApi } from "../fake-api";
import { isScratchModule } from "../scratch";
import * as scratch from "./host-add-live";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("@renderer/lib/app-state-storage", () => ({
  appStateStorage: { getItem: () => null, setItem() {}, removeItem() {} },
}));

let world: HostWorld;
let root: HTMLElement;

beforeEach(async () => {
  vi.useFakeTimers();
  installFakeApi();
  useRemoteHostsStore.setState({
    hosts: [],
    readOnly: null,
    addHost: { open: false, target: "" },
    addHostActivity: null,
  });
  world = hostWorld();
  root = await world.render(<scratch.default />);
});

afterEach(async () => {
  await world.cleanup();
  vi.useRealTimers();
  useRemoteHostsStore.setState({
    addHost: { open: false, target: "" },
    addHostActivity: null,
  });
});

async function scenario(value: string) {
  const select = root.querySelector("select")!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function sheet() {
  const found = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  if (found === null) throw new Error("sheet closed");
  return found;
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

async function start(value: string) {
  await scenario(value);
  await click(root, "Add a host…");
  await click(sheet(), "Connect");
  // Replay arrives at 120 ms; connect finishes 650 ms later, then probe asks.
  await advance(800);
}

describe("host-add-live scratch", () => {
  it("satisfies the lab discovery contract", () => {
    expect(isScratchModule(scratch)).toBe(true);
  });

  it("reaches the production self-add warning and Add anyway continues to a user-mode Mac", async () => {
    await start("self-add");
    const prompt = questionPrompt({ id: "q1", kind: "self-add", step: "probe" }, "you@localhost");
    expect(sheet().textContent).toContain(prompt.line);
    expect(
      [...sheet().querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(expect.arrayContaining(["Add anyway", "Cancel"]));
    await click(sheet(), "Add anyway");
    await advance(4_200);
    expect(sheet().textContent).toContain("Starts when you log in to you@localhost");
    expect(sheet().textContent).toContain("Agents on you@localhost share your account");
    expect(
      useRemoteHostsStore.getState().hosts.find((host) => host.target === "you@localhost"),
    ).toMatchObject({ os: "macos", mode: "user", agentsShareAccount: true });
  });

  it("the production Cancel closes self-add without adding a host, and it can start again", async () => {
    await start("self-add");
    await click(sheet(), "Cancel");
    expect(useRemoteHostsStore.getState().addHost.open).toBe(false);
    await advance(4_200);
    expect(useRemoteHostsStore.getState().hosts).toHaveLength(1);
    expect(
      useRemoteHostsStore.getState().hosts.some((host) => host.target === "you@localhost"),
    ).toBe(false);
    await click(root, "Add a host…");
    await click(sheet(), "Connect");
    await advance(800);
    expect(sheet().textContent).toContain("Add it anyway (for testing)?");
  });

  it("previews production restart copy with and without a count, without a listing backend", async () => {
    await start("existing");
    const question = {
      id: "q1",
      kind: "existing-hostd",
      step: "probe" as const,
      version: "0.2.4",
      mode: "system",
      adoptable: true,
    };
    const figures = root.querySelectorAll("figure");
    expect(figures).toHaveLength(2);
    for (const [index, count] of [null, 3].entries()) {
      const prompt = questionPrompt(question, "deploy@box", count);
      if (prompt.kind !== "existing-hostd") throw new Error("wrong preview question");
      expect(figures[index].textContent).toContain(prompt.line);
      expect(figures[index].textContent).toContain(prompt.note);
    }
    expect(figures[0].textContent).not.toContain("running Sessions in connected projects");
    expect(figures[1].textContent).toContain("3 running Sessions in connected projects");
    expect(root.textContent).toContain("these previews do not simulate a Session listing");
    expect(sheet().textContent).toContain(
      "Its projects stay. Running Sessions on deploy@box will stop.",
    );
    expect(sheet().textContent).not.toContain("running Sessions in connected projects");
    await click(sheet(), "Update and pair");
    await advance(4_200);
    expect(useRemoteHostsStore.getState().hosts.some((host) => host.target === "deploy@box")).toBe(
      true,
    );
  });
});
