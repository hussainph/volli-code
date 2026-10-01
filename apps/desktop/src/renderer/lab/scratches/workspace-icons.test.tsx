// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CANVAS } from "@volli/shared";

import { useThemeStore } from "@renderer/stores/theme";

import { isScratchModule } from "../scratch";
import * as scratch from "./workspace-icons";

let host: HTMLDivElement;
let root: Root;
const initialTheme = useThemeStore.getState();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<scratch.default />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useThemeStore.setState(initialTheme);
  vi.unstubAllGlobals();
});

function tile(id: string, material = "canvas"): HTMLButtonElement {
  const node = host.querySelector<HTMLButtonElement>(
    `nav[aria-label="${material} workspaces"] [data-workspace="${id}"]`,
  );
  if (!node) throw new Error(`Missing ${id} tile`);
  return node;
}

function select(label: string): HTMLSelectElement {
  const node = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!node) throw new Error(`Missing ${label}`);
  return node;
}

async function choose(label: string, value: string) {
  await act(async () => {
    const node = select(label);
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function thumbnail(id: string): string | null {
  return tile(id).querySelector("[data-material]")!.getAttribute("style");
}

describe("workspace icons scratch", () => {
  it("is discoverable and draws both materials with independent unread and input marks", () => {
    expect(isScratchModule(scratch)).toBe(true);
    expect(host.querySelectorAll("[data-workspace]")).toHaveLength(12);
    expect(tile("volli").querySelector("[data-workspace-unread]")).not.toBeNull();
    expect(
      tile("volli").querySelector("[data-workspace-signal]")?.getAttribute("data-workspace-signal"),
    ).toBe("waiting");
    expect(tile("paper").querySelector("[data-workspace-signal]")).toBeNull();
    expect(tile("archive").querySelector("[data-workspace-unread]")).toBeNull();
    expect(tile("volli").getAttribute("aria-current")).toBe("page");
    expect(host.querySelector('[data-session="v2"]')?.getAttribute("aria-label")).toBe(
      "Open Permission policy · Needs input · VC-472 · unread",
    );
    expect(tile("long").querySelector('[data-workspace-signal="interrupted"]')).not.toBeNull();
  });

  it("hides fixture helpers without promoting their waits or unread into workspace notifications", async () => {
    await act(async () => tile("canopy").click());
    expect(tile("canopy").getAttribute("aria-label")).toBe("Canopy · 2 active · 1 unread");
    expect(host.querySelector('[data-session="c3"]')).toBeNull();
    expect(host.querySelectorAll("[data-session]")).toHaveLength(4);
    expect(host.querySelector('[data-session="c1"]')?.getAttribute("aria-label")).toBe(
      "Open Index the repository · Working · CN-18 · unread",
    );
  });

  it("selects workspaces without marking anything read, and reads only an opened Session", async () => {
    await act(async () => tile("paper").click());
    expect(tile("paper").getAttribute("aria-current")).toBe("page");
    expect(tile("paper", "stamp").getAttribute("aria-current")).toBe("page");
    expect(tile("paper").getAttribute("aria-label")).toContain("1 unread");
    expect(tile("volli").getAttribute("aria-label")).toContain("2 unread");
    await act(async () => tile("volli").click());
    const session = host.querySelector<HTMLButtonElement>('[data-session="v2"]')!;
    await act(async () => session.click());
    for (const material of ["canvas", "stamp"]) {
      expect(tile("volli", material).getAttribute("aria-label")).toContain("1 unread");
      expect(tile("volli", material).querySelector("[data-workspace-signal]")).not.toBeNull();
    }
    expect(host.querySelectorAll('[data-session="v2"][aria-label*="unread"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-session="v3"][aria-label*="unread"]')).toHaveLength(2);
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("resets receipts and switches state scenarios without changing identity or selection", async () => {
    await choose("Scenario", "quiet");
    expect(host.querySelectorAll("[data-workspace-unread], [data-workspace-signal]")).toHaveLength(
      0,
    );
    await choose("Scenario", "busy");
    expect(host.querySelectorAll('[data-workspace-signal="working"]')).toHaveLength(10);
    await choose("Scenario", "collision");
    expect(host.querySelectorAll('[data-workspace-signal="waiting"]')).toHaveLength(10);
    expect(host.querySelectorAll("[data-workspace-unread]")).toHaveLength(10);
    await choose("Identity", "glyph");
    expect(tile("volli").querySelector("svg")).not.toBeNull();
    expect(tile("volli").getAttribute("aria-current")).toBe("page");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-session="v1"]')!.click());
    expect(tile("volli").getAttribute("aria-label")).toContain("2 unread");
    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Reset receipts",
    )!;
    await act(async () => reset.click());
    expect(tile("volli").getAttribute("aria-label")).toContain("3 unread");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("updates inherited canvases and modes live but honors destination overrides", async () => {
    const inherited = thumbnail("archive");
    const pinned = thumbnail("paper");
    await act(async () =>
      useThemeStore.setState({
        preview: { ...DEFAULT_CANVAS, stops: [{ hex: "#5588bb", x: 0.5, y: 0.5 }] },
      }),
    );
    expect(thumbnail("archive")).not.toBe(inherited);
    expect(thumbnail("paper")).toBe(pinned);
    await act(async () => useThemeStore.setState({ previewAppearance: "light" }));
    const light = thumbnail("archive");
    await act(async () => useThemeStore.setState({ previewAppearance: "dark" }));
    expect(thumbnail("archive")).not.toBe(light);
    expect(thumbnail("paper")).toBe(pinned);
    await act(async () =>
      useThemeStore.setState({ previewAppearance: "auto", systemPrefersDark: true }),
    );
    const systemDark = thumbnail("archive");
    await act(async () => useThemeStore.setState({ systemPrefersDark: false }));
    expect(thumbnail("archive")).not.toBe(systemDark);
    expect(thumbnail("paper")).toBe(pinned);
    // The identity's local variables never override Session-state or unread tokens.
    expect(thumbnail("volli")).not.toContain("--positive:");
    expect(thumbnail("volli")).not.toContain("--info:");
  });
});
