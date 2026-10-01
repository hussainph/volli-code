// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CANVAS } from "@volli/shared";

import { useThemeStore } from "@renderer/stores/theme";
import { isScratchModule } from "../scratch";
import * as scratch from "./workspace-identity-studio";

const motionPreference = vi.hoisted(() => ({ reduce: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motionPreference.reduce,
}));

let host: HTMLDivElement;
let root: Root;
const initialTheme = useThemeStore.getState();
const readers: MockReader[] = [];
const images: MockImage[] = [];
class MockReader extends EventTarget {
  result: string | null = null;
  readAsDataURL() {
    readers.push(this);
  }
}
class MockImage extends EventTarget {
  set src(_value: string) {
    images.push(this);
  }
}

beforeEach(async () => {
  motionPreference.reduce = false;
  MotionGlobalConfig.skipAnimations = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("hover"),
      media: query,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  vi.stubGlobal("FileReader", MockReader);
  vi.stubGlobal("Image", MockImage);
  readers.length = 0;
  images.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<scratch.default />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useThemeStore.setState(initialTheme);
  MotionGlobalConfig.skipAnimations = false;
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
function hero(): HTMLElement {
  return host.querySelector<HTMLElement>('.studio-mark[data-size="hero"]')!;
}
function tile(id: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[data-studio-workspace="${id}"]`)!;
}
async function click(label: string, pointer = false) {
  await act(async () =>
    button(label).dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: pointer ? 1 : 0 }),
    ),
  );
}
async function name(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="Project name"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function upload(file: File) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="Upload your mark"]')!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("workspace atelier", () => {
  it("is a discoverable window scratch with four materials and an explicitly simulated suggestion flow", () => {
    expect(isScratchModule(scratch)).toBe(true);
    expect(scratch.viewport).toBe("window");
    expect(host.textContent).toContain("Jev study · local fixture");
    expect(host.querySelectorAll(".studio-material-button")).toHaveLength(4);
    expect(host.querySelectorAll(".studio-candidate")).toHaveLength(3);
    expect(host.querySelectorAll("[data-studio-workspace]")).toHaveLength(6);
    expect(hero().dataset.glyph).toBe("rocket");
  });

  it("does not silently reselect the identity on rename or new suggestions", async () => {
    await name("Paper Trail");
    await click("Suggest marks");
    expect(hero().dataset.glyph).toBe("rocket");
    expect(host.querySelectorAll(".studio-candidate")).toHaveLength(3);
    expect(host.querySelector('[aria-label="Suggested glyphs"]')?.textContent).toContain("Scroll");
    const suggested = host.querySelector<HTMLButtonElement>(".studio-candidate")!;
    await act(async () => suggested.click());
    const chosen = hero().dataset.glyph;
    await name("Completely different");
    expect(hero().dataset.glyph).toBe(chosen);
    expect(host.querySelector('[data-studio-workspace="studio-draft"]')).toBeNull();
  });

  it("supports monogram signatures, deterministic stamp variants, and material changes", async () => {
    await click("Initials");
    expect(hero().dataset.identityKind).toBe("initials");
    await click("Choose Woven initials");
    expect(hero().dataset.monogram).toBe("woven");
    await click("Stamp");
    const first = hero().querySelector("svg")?.innerHTML;
    await name("Renamed stamp");
    expect(hero().querySelector("svg")?.innerHTML).toBe(first);
    await click("Another stamp");
    expect(hero().querySelector("svg")?.innerHTML).not.toBe(first);
    await click("Another stamp");
    await click("Another stamp");
    expect(hero().dataset.stampVariant).toBe("3");
    expect(button("Choose stamp 4").getAttribute("aria-pressed")).toBe("true");
    await click("Use Orbit material");
    expect(hero().dataset.surface).toBe("orbit");
    await click("Make it mine");
    expect(tile("studio-draft").querySelector("svg rect")).not.toBeNull();
    expect(
      tile("studio-draft").querySelector(".studio-mark")?.getAttribute("data-stamp-variant"),
    ).toBe("3");
  });

  it("mints only on explicit commit and keeps the saved mark stable while the draft changes", async () => {
    await click("Make it mine");
    expect(tile("studio-draft").getAttribute("aria-current")).toBe("true");
    expect(tile("studio-draft").querySelector(".studio-mark")?.getAttribute("data-glyph")).toBe(
      "rocket",
    );
    await click("Choose suggested Moon");
    await name("Another name");
    expect(tile("studio-draft").getAttribute("aria-label")).toContain("Moonshot");
    expect(tile("studio-draft").querySelector(".studio-mark")?.getAttribute("data-glyph")).toBe(
      "rocket",
    );
    await click("Make it mine");
    expect(host.querySelectorAll('[data-studio-workspace="studio-draft"]')).toHaveLength(1);
    expect(tile("studio-draft").getAttribute("aria-label")).toContain("Another name");
    expect(tile("studio-draft").querySelector(".studio-mark")?.getAttribute("data-glyph")).toBe(
      "moon",
    );
    await name(" ");
    expect(button("Make it mine").disabled).toBe(true);
  });

  it("keeps the original notification semantics and excludes helpers", async () => {
    expect(tile("canopy").getAttribute("aria-label")).toBe("Canopy · 2 active · 1 unread");
    expect(host.querySelector('[data-studio-session="c3"]')).toBeNull();
    await act(async () => tile("volli").click());
    expect(tile("volli").getAttribute("aria-label")).toContain("2 unread");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-studio-session="v2"]')!.click(),
    );
    expect(tile("volli").getAttribute("aria-label")).toContain("1 unread");
    expect(tile("volli").querySelector('[data-studio-signal="waiting"]')).not.toBeNull();
    await click("Reset unread fixtures");
    expect(tile("volli").getAttribute("aria-label")).toContain("2 unread");
  });

  it("opens the curated picker and chooses an explicit glyph", async () => {
    await click("Browse marks");
    await click("Choose Coffee");
    expect(hero().dataset.glyph).toBe("coffee");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("remembers choices across mode visits and feeds saved glyphs into suggestions", async () => {
    await click("Browse marks");
    await click("Choose Coffee");
    await click("Stamp");
    await click("Another stamp");
    await click("Icon");
    expect(hero().dataset.glyph).toBe("coffee");
    await click("Stamp");
    expect(hero().dataset.stampVariant).toBe("1");
    await click("Icon");
    await name("Moon Lab");
    await click("Choose suggested Moon");
    await click("Make it mine");
    await click("Suggest marks");
    expect(host.querySelector(".studio-candidate")?.getAttribute("aria-label")).toBe(
      "Choose suggested Atom",
    );
    expect(hero().dataset.glyph).toBe("moon");
  });

  it("gates reveal motion for keyboard, reduced motion, and the motion switch", async () => {
    expect(host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate")).toBe("false");
    await click("Use Orbit material", true);
    expect(host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate")).toBe("true");
    await click("Use Porcelain material");
    expect(host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate")).toBe("false");
    motionPreference.reduce = true;
    await click("Use Etched material", true);
    expect(host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate")).toBe("false");
    motionPreference.reduce = false;
    await click("Motion on");
    expect(host.querySelector(".identity-studio")?.getAttribute("data-motion")).toBe("false");
    await click("Use Orbit material", true);
    expect(host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate")).toBe("false");
  });

  it("follows inherited canvas and appearance while keeping state tokens outside each identity", async () => {
    await click("Inherited");
    const initial = hero().getAttribute("style");
    await act(async () =>
      useThemeStore.setState({
        preview: { ...DEFAULT_CANVAS, stops: [{ hex: "#448899", x: 0.5, y: 0.5 }] },
      }),
    );
    expect(hero().getAttribute("style")).not.toBe(initial);
    const paper = tile("paper").querySelector(".studio-mark")?.getAttribute("style");
    await act(async () => useThemeStore.setState({ previewAppearance: "light" }));
    const light = hero().getAttribute("style");
    await act(async () => useThemeStore.setState({ previewAppearance: "dark" }));
    expect(hero().getAttribute("style")).not.toBe(light);
    expect(tile("paper").querySelector(".studio-mark")?.getAttribute("style")).toBe(paper);
    expect(hero().getAttribute("style")).not.toContain("--positive:");
    expect(
      tile("volli")
        .querySelector(".studio-mark")
        ?.contains(tile("volli").querySelector("[data-studio-signal]")),
    ).toBe(false);
  });

  it("rejects unsupported/oversized files and shows read failures", async () => {
    await click("Your mark");
    expect(button("Make it mine").disabled).toBe(true);
    await upload(new File(["<svg/>"], "mark.svg", { type: "image/svg+xml" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("PNG, JPEG, or WebP");
    expect(readers).toHaveLength(0);
    await upload(
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }),
    );
    expect(readers).toHaveLength(0);
    await upload(new File(["image"], "mark.png", { type: "image/png" }));
    await act(async () => readers[0]!.dispatchEvent(new Event("error")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not read");
  });

  it("shows invalid image data and decode failures without adopting a broken mark", async () => {
    await click("Your mark");
    const file = new File(["image"], "mark.png", { type: "image/png" });
    await upload(file);
    readers[0]!.result = "data:image/svg+xml;base64,YQ==";
    await act(async () => readers[0]!.dispatchEvent(new Event("load")));
    expect(images).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not read");
    await upload(file);
    readers[1]!.result = "data:image/png;base64,YQ==";
    await act(async () => readers[1]!.dispatchEvent(new Event("load")));
    await act(async () => images[0]!.dispatchEvent(new Event("error")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be displayed");
    expect(hero().dataset.identityKind).toBe("initials");
    expect(button("Make it mine").disabled).toBe(true);
  });

  it("ignores a stale decode after a new upload and falls back if the rendered image fails", async () => {
    await click("Your mark");
    const file = new File(["image"], "mark.png", { type: "image/png" });
    await upload(file);
    readers[0]!.result = "data:image/png;base64,YQ==";
    await act(async () => readers[0]!.dispatchEvent(new Event("load")));
    await upload(file);
    readers[1]!.result = "data:image/png;base64,Yg==";
    await act(async () => readers[1]!.dispatchEvent(new Event("load")));
    await act(async () => images[0]!.dispatchEvent(new Event("load")));
    expect(hero().dataset.identityKind).toBe("initials");
    await act(async () => images[1]!.dispatchEvent(new Event("load")));
    expect(hero().querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,Yg==");
    await act(async () => hero().querySelector("img")!.dispatchEvent(new Event("error")));
    expect(hero().dataset.identityKind).toBe("initials");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be displayed");
    expect(button("Make it mine").disabled).toBe(true);
  });

  it("decodes a local image before choosing it and ignores stale file reads", async () => {
    await click("Your mark");
    await upload(new File(["image"], "mark.png", { type: "image/png" }));
    readers[0]!.result = "data:image/png;base64,aGVsbG8=";
    await act(async () => readers[0]!.dispatchEvent(new Event("load")));
    expect(hero().dataset.identityKind).toBe("initials");
    await act(async () => images[0]!.dispatchEvent(new Event("load")));
    expect(hero().dataset.identityKind).toBe("custom");
    expect(host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate")).toBe("false");
    expect(button("Make it mine").disabled).toBe(false);
    await click("Make it mine");
    expect(tile("studio-draft").querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
    await click("Initials");
    await click("Your mark");
    expect(hero().dataset.identityKind).toBe("custom");
    await upload(new File(["new image"], "second.png", { type: "image/png" }));
    await click("Initials");
    readers[1]!.result = "data:image/png;base64,bGF0ZQ==";
    await act(async () => readers[1]!.dispatchEvent(new Event("load")));
    expect(images).toHaveLength(1);
    expect(hero().dataset.identityKind).toBe("initials");
  });
});
