// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DialStore } from "dialkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isScratchModule } from "../scratch";
import { useThemeStore } from "@renderer/stores/theme";
import * as scratch from "./surface-materials";
import { COMPONENT_COVERAGE } from "../surface/component-gallery";

// Use the actual package CSS: upgrades must not silently restore remote fonts.
// Optical/compositing behaviour itself is verified in the live browser check.

const PANEL = "volli-lab-surface-v1";
let root: Root | null = null;
let host: HTMLElement | null = null;
let systemDark = false;
let systemListener: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  systemDark = false;
  vi.stubGlobal("matchMedia", () => ({
    matches: systemDark,
    addEventListener: (_: string, callback: () => void) => {
      systemListener = callback;
    },
    removeEventListener: () => {
      systemListener = null;
    },
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.removeItem(`dialkit:${PANEL}`);
});

afterEach(async () => {
  await act(async () => {
    if (DialStore.getPanel(PANEL)) DialStore.resetValues(PANEL);
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  localStorage.removeItem(`dialkit:${PANEL}`);
  vi.unstubAllGlobals();
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<scratch.default />));
  await act(async () => DialStore.resetValues(PANEL));
}

function button(name: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === name || node.getAttribute("aria-label") === name,
  );
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}

async function update(path: string, value: string | number | boolean) {
  await act(async () => DialStore.updateValue(PANEL, path, value));
}

describe("Surface materials scratch", () => {
  it("is a discoverable window scratch, with no module-level setup", () => {
    expect(isScratchModule(scratch)).toBe(true);
    expect(scratch.viewport).toBe("window");
    expect("seed" in scratch).toBe(false);
    expect("api" in scratch).toBe(false);
  });

  it("scopes neutral theme tokens onto the real portal and never paints the root/theme store", async () => {
    const rootStyle = document.documentElement.getAttribute("style");
    const rootClass = document.documentElement.className;
    const themeState = useThemeStore.getState();
    await mount();
    const study = document.querySelector<HTMLElement>('[data-testid="surface-study"]')!;
    const lens = document.querySelector<HTMLElement>('[aria-label="Surface model inspector"]')!;
    expect(lens.closest('[data-testid="surface-study"]')).toBeNull();
    expect(lens.style.getPropertyValue("--card")).toBe(study.style.getPropertyValue("--card"));
    expect(lens.className).toContain("text-ui");
    expect(document.documentElement.getAttribute("style")).toBe(rootStyle);
    expect(document.documentElement.className).toBe(rootClass);
    expect(useThemeStore.getState()).toBe(themeState);
    expect(host?.querySelector("style")?.textContent).not.toMatch(
      /@import|@font-face|https?:\/\//i,
    );
  });

  it("updates real materials without remounting fields, and presets leave the canvas choice alone", async () => {
    await mount();
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Local preview note"]')!;
    await update("canvas.environment", "colour");
    await update("lens.opacity", 0.5);
    const lens = document.querySelector<HTMLElement>('[aria-label="Surface model inspector"]')!;
    expect(lens.style.getPropertyValue("--surface-opacity")).toBe("50%");
    expect(document.querySelector('[aria-label="Local preview note"]')).toBe(field);
    await act(async () => button("Flat").click());
    expect(DialStore.getValue(PANEL, "canvas.environment")).toBe("colour");
    expect(lens.style.getPropertyValue("--surface-shadow")).toBe("none");
    await act(async () => button("Reset study").click());
    expect(lens.style.getPropertyValue("--surface-opacity")).toBe("76%");
  });

  it("tunes transparent work and inspector materials independently without remounting content", async () => {
    await mount();
    const field = document.querySelector('[aria-label="Local preview note"]');
    const work = document.querySelector<HTMLElement>('[aria-label="Work pane"]')!;
    const lens = document.querySelector<HTMLElement>('[aria-label="Surface model inspector"]')!;
    const study = document.querySelector<HTMLElement>('[data-testid="surface-study"]')!;
    await act(async () => button("Clear").click());
    expect(study.style.getPropertyValue("--work-opacity")).toBe("50%");
    expect(work.dataset.material).toBe("glass");
    expect(work.querySelector(".surface-spatial-layers")).not.toBeNull();
    expect(study.style.getPropertyValue("--surface-opacity")).toBe("76%");
    await act(async () => button("Satin").click());
    expect(lens.dataset.material).toBe("satin");
    expect(lens.style.getPropertyValue("--surface-bevel")).toBe("8px");
    expect(study.style.getPropertyValue("--work-opacity")).toBe("50%");
    expect(document.querySelector('[aria-label="Local preview note"]')).toBe(field);
    await update("canvas.backdropDetail", true);
    expect(document.querySelector(".surface-backdrop-detail")).not.toBeNull();
    await act(async () => button("All glass").click());
    expect(work.dataset.material).toBe("glass");
    expect(lens.dataset.material).toBe("glass");
    expect(study.style.getPropertyValue("--work-backdrop")).toBe("blur(8px)");
  });

  it("represents the real component tree and keeps gallery state/portal theme while tuning", async () => {
    await mount();
    const gallery = document.querySelector('[data-testid="surface-component-gallery"]')!;
    expect(COMPONENT_COVERAGE.length).toBeGreaterThanOrEqual(19);
    for (const family of COMPONENT_COVERAGE) expect(gallery.textContent).toContain(family);
    const toggle = gallery.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => button("Sample details").click());
    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    expect(dialog.closest('[data-testid="surface-study"]')).toBeNull();
    expect(dialog.querySelector(".surface-material-face")).not.toBeNull();
    await act(async () => button("Porcelain").click());
    expect(dialog.dataset.material).toBe("porcelain");
    expect(dialog.style.getPropertyValue("--surface-opacity")).toBe("100%");
    expect(gallery.querySelector('[role="switch"]')).toBe(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('[data-slot="dialog-content"]')).toBe(dialog);
  });

  it("switches into the macOS 27 continuum without losing authored Surface recipes or live fields", async () => {
    await mount();
    await update("lens.bevel", 9);
    const draft = document.querySelector<HTMLTextAreaElement>('[aria-label="Local preview note"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        draft,
        "Keep my draft",
      );
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rootStyle = document.documentElement.getAttribute("style");
    await act(async () => button("macOS 27").click());
    await act(async () => button("Clear").click());
    const lens = document.querySelector<HTMLElement>('[aria-label="Surface model inspector"]')!;
    expect(lens.classList.contains("surface-reference")).toBe(true);
    expect(lens.style.getPropertyValue("--surface-opacity")).toBe("24%");
    expect(lens.style.getPropertyValue("--surface-backdrop")).toBe("blur(6px)");
    await act(async () => button("Tinted").click());
    expect(lens.style.getPropertyValue("--surface-opacity")).toBe("90%");
    await update("reference.balance", 0.37);
    expect(lens.style.getPropertyValue("--surface-backdrop")).toBe("blur(11.92px)");
    await act(async () => button("Inactive").click());
    expect(
      document
        .querySelector('[data-testid="surface-study"]')
        ?.getAttribute("data-reference-active"),
    ).toBe("false");
    expect(document.querySelector('[aria-label="Local preview note"]')).toBe(draft);
    expect(draft.value).toBe("Keep my draft");
    await act(async () => button("Surface").click());
    expect(lens.style.getPropertyValue("--surface-bevel")).toBe("9px");
    expect(lens.classList.contains("surface-reference")).toBe(false);
    expect(document.documentElement.getAttribute("style")).toBe(rootStyle);
  });

  it("follows System changes and applies the resolved mode to the lens as well", async () => {
    await mount();
    await act(async () => button("System").click());
    await act(async () => {
      systemDark = true;
      systemListener?.();
    });
    expect(
      document.querySelector('[data-testid="surface-study"]')?.getAttribute("data-appearance"),
    ).toBe("dark");
    expect(
      document.querySelector<HTMLElement>('[aria-label="Surface model inspector"]')?.style
        .colorScheme,
    ).toBe("dark");
  });

  it("commits keyboard light placement to the dials/versions, and reset restores it", async () => {
    await mount();
    await act(async () =>
      button("Move key light").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })),
    );
    expect(DialStore.getValue(PANEL, "placement.keyX")).toBeCloseTo(0.26);
    await update("lighting.angle", 90);
    expect(DialStore.getValue(PANEL, "placement.keyX")).toBeCloseTo(0.1);
    expect(DialStore.getValue(PANEL, "placement.keyY")).toBeCloseTo(0.5);
    await act(async () => button("Reset study").click());
    expect(DialStore.getValue(PANEL, "placement.keyX")).toBe(0.22);
  });

  it("surfaces clipboard failure rather than silently reporting success", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await mount();
    await act(async () => button("Copy study").click());
    expect(
      document.querySelector('[data-testid="surface-dial-scroll"] [role="status"]')?.textContent,
    ).toContain("Copy failed");
  });
});
