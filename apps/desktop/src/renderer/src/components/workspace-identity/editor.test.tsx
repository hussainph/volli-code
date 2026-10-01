// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vite-plus/test";
import { DEFAULT_CANVAS, GLYPH_CATALOG, suggestGlyphs } from "@volli/shared";

import { useThemeStore } from "@renderer/stores/theme";
import { WorkspaceIdentityEditor } from "./editor";

const motionPreference = vi.hoisted(() => ({ reduce: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motionPreference.reduce,
}));

const SOURCE = "data:image/png;base64,c291cmNl";
const THUMBNAIL = "data:image/webp;base64,bWFyaw==";
const readers: MockReader[] = [];
const images: MockImage[] = [];
class MockReader extends EventTarget {
  result: string | null = null;
  readAsDataURL(_file: File) {
    readers.push(this);
  }
}
class MockImage extends EventTarget {
  naturalWidth = 1024;
  naturalHeight = 512;
  set src(_value: string) {
    images.push(this);
  }
}

let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
const initialTheme = useThemeStore.getState();
const onCommit = vi.fn().mockResolvedValue(true);
const onCancel = vi.fn();
const createProject = vi.fn();
const fetch = vi.fn();
const drawImage = vi.fn();
let encode: MockInstance<HTMLCanvasElement["toDataURL"]>;
const baseProps = {
  defaultName: "Moonshot",
  seed: "picked-folder-seed",
  folderPath: "/Users/example/work/moonshot",
  usedGlyphs: ["rocket", "code"] as const,
  busy: false,
  onCommit,
  onCancel,
};

beforeEach(async () => {
  vi.clearAllMocks();
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
  vi.stubGlobal("api", { projects: { create: createProject } });
  vi.stubGlobal("fetch", fetch);
  readers.length = 0;
  images.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(THUMBNAIL);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
  await act(async () => root.render(<WorkspaceIdentityEditor {...baseProps} />));
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove();
  useThemeStore.setState(initialTheme);
  MotionGlobalConfig.skipAnimations = false;
  vi.restoreAllMocks();
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
function alert(): string | null {
  return host.querySelector('[role="alert"]')?.textContent ?? null;
}
async function click(label: string, pointer = false) {
  await act(async () => {
    if (pointer) button(label).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    else button(label).click();
  });
}
async function input(label: string, value: string) {
  await act(async () => {
    const node = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function upload(file = new File(["image"], "mark.png", { type: "image/png" })) {
  await act(async () => {
    const node = host.querySelector<HTMLInputElement>('[aria-label="Upload your mark"]')!;
    Object.defineProperty(node, "files", { value: [file], configurable: true });
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function read(index = readers.length - 1, result = SOURCE) {
  readers[index]!.result = result;
  await act(async () => readers[index]!.dispatchEvent(new Event("load")));
}
async function decode(index = images.length - 1) {
  await act(async () => images[index]!.dispatchEvent(new Event("load")));
}
function suggestions() {
  return [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label="Suggested glyphs"] button'),
  ].map((node) => node.getAttribute("aria-label"));
}
function expectedSuggestions(name: string) {
  return suggestGlyphs(name, baseProps.usedGlyphs).map(
    (glyph) => `Choose suggested ${GLYPH_CATALOG.find((entry) => entry.name === glyph)!.label}`,
  );
}

describe("WorkspaceIdentityEditor", () => {
  it("starts with the picked name/path and collision-aware local suggestions, not a durable create", () => {
    expect(host.querySelector<HTMLInputElement>('[aria-label="Project name"]')!.value).toBe(
      "Moonshot",
    );
    expect(host.querySelector(".studio-folder-path")?.textContent).toBe(baseProps.folderPath);
    expect(suggestions()).toEqual(expectedSuggestions("Moonshot"));
    expect(hero().dataset.glyph).toBe(suggestGlyphs("Moonshot", baseProps.usedGlyphs)[0]);
    // Used semantic matches remain valid; equally relevant unused filler wins ties.
    expect(suggestions()).not.toContain("Choose suggested Code");
    expect(host.textContent).toContain("no AI request");
    expect(onCommit).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes suggestions from the edited name without replacing an explicit choice", async () => {
    await click("Browse marks");
    await click("Choose Coffee");
    await input("Project name", "Paper Trail");
    await click("Suggest marks");
    expect(suggestions()).toEqual(expectedSuggestions("Paper Trail"));
    expect(hero().dataset.glyph).toBe("coffee");
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "current mark stays yours",
    );
    await click("Initials");
    await click("Stamp");
    await click("Icon");
    expect(hero().dataset.glyph).toBe("coffee");
    expect(onCommit).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses subsequence search in the shared glyph library and commits only via onCommit", async () => {
    await click("Browse marks");
    await input("Find a glyph", "pprpln");
    expect(document.querySelectorAll('[aria-label="Phosphor glyph library"] button')).toHaveLength(
      1,
    );
    await click("Choose Paper Plane");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(hero().dataset.glyph).toBe("paper-plane");
    await input("Project name", "  Paper Trail  ");
    await click("Make it mine");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({
      name: "Paper Trail",
      workspaceIdentity: {
        choice: { kind: "glyph", name: "paper-plane" },
        surface: "etched",
        monogramStyle: "editorial",
      },
      themeCanvas: null,
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("commits explicit initials, material and canvas, remembering the signature across modes", async () => {
    await click("Initials");
    await click("Choose Woven initials");
    await click("Use Orbit material");
    await click("Tidal");
    await click("Stamp");
    await click("Initials");
    await input("Project name", "Paper Trail");
    expect(hero().dataset.identityKind).toBe("initials");
    expect(hero().dataset.monogram).toBe("woven");
    expect(hero().querySelector(".studio-monogram")?.textContent).toBe("PT");
    await click("Make it mine");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({
      name: "Paper Trail",
      workspaceIdentity: { choice: { kind: "initials" }, surface: "orbit", monogramStyle: "woven" },
      themeCanvas: {
        ...DEFAULT_CANVAS,
        stops: [
          { hex: "#427d98", x: 0.2, y: 0.2 },
          { hex: "#7d7ab5", x: 0.85, y: 0.8 },
        ],
      },
    });
  });

  it("keeps the stamp seed and variant stable through renames and mode round trips", async () => {
    await click("Stamp");
    await click("Another stamp");
    const stamp = hero().querySelector("svg")!.innerHTML;
    await input("Project name", "Renamed workspace");
    expect(hero().querySelector("svg")!.innerHTML).toBe(stamp);
    await click("Icon");
    await click("Stamp");
    expect(hero().querySelector("svg")!.innerHTML).toBe(stamp);
    expect(button("Choose stamp 2").getAttribute("aria-pressed")).toBe("true");
    await click("Use Letterpress material");
    await click("Make it mine");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({
      name: "Renamed workspace",
      workspaceIdentity: {
        choice: { kind: "stamp", seed: baseProps.seed, variant: 1 },
        surface: "letterpress",
        monogramStyle: "editorial",
      },
      themeCanvas: null,
    });
  });

  it("refuses blank names and delegates cancellation without creating", async () => {
    await input("Project name", "  ");
    expect(button("Make it mine").disabled).toBe(true);
    await click("Make it mine");
    await click("Cancel");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("disables every edit, commit, cancel and reveal while creation is busy", async () => {
    await click("Use Orbit material", true);
    await act(async () => root.render(<WorkspaceIdentityEditor {...baseProps} busy />));
    expect(host.querySelector("fieldset")!.disabled).toBe(true);
    for (const node of host.querySelectorAll("fieldset input, fieldset button")) {
      expect(node.matches(":disabled")).toBe(true);
    }
    expect(button("Cancel").disabled).toBe(true);
    expect(button("Creating workspace…").disabled).toBe(true);
    await click("Stamp");
    await click("Cancel");
    await click("Creating workspace…");
    expect(hero().dataset.identityKind).toBe("glyph");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate")).toBe("false");
  });

  it("gates reveal for keyboard activation, reduced motion and the motion switch", async () => {
    const reveal = () => host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate");
    expect(reveal()).toBe("false");
    await click("Use Orbit material", true);
    expect(reveal()).toBe("true");
    await click("Use Porcelain material");
    expect(reveal()).toBe("false");
    motionPreference.reduce = true;
    await click("Use Etched material", true);
    expect(reveal()).toBe("false");
    motionPreference.reduce = false;
    await click("Motion on");
    await click("Use Orbit material", true);
    expect(host.querySelector(".identity-studio")?.getAttribute("data-motion")).toBe("false");
    expect(reveal()).toBe("false");
  });
});

describe("local mark uploads", () => {
  it("rejects unsupported MIME types and files over 2 MB before starting a reader", async () => {
    await click("Your mark");
    expect(button("Make it mine").disabled).toBe(true);
    await upload(new File(["<svg/>"], "mark.svg", { type: "image/svg+xml" }));
    expect(alert()).toContain("PNG, JPEG, or WebP under 2 MB");
    await upload(
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }),
    );
    expect(readers).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["image/png", "image/jpeg", "image/webp"])(
    "decodes %s locally, downsizes to 128px and commits only the bounded WebP thumbnail",
    async (type) => {
      await click("Your mark");
      await upload(new File([new Uint8Array(2 * 1024 * 1024)], "mark", { type }));
      expect(readers).toHaveLength(1);
      expect(button("Reading image…").disabled).toBe(true);
      await click("Reading image…");
      await read(0, `data:${type};base64,c291cmNl`);
      expect(hero().dataset.identityKind).toBe("initials");
      expect(button("Reading image…").disabled).toBe(true);
      expect(encode).not.toHaveBeenCalled();
      await decode();
      expect(drawImage).toHaveBeenCalledExactlyOnceWith(images[0], 0, 0, 128, 64);
      expect(encode).toHaveBeenCalledExactlyOnceWith("image/webp", 0.9);
      expect((encode.mock.contexts[0] as HTMLCanvasElement).width).toBe(128);
      expect((encode.mock.contexts[0] as HTMLCanvasElement).height).toBe(64);
      expect(hero().querySelector("img")?.getAttribute("src")).toBe(THUMBNAIL);
      expect(THUMBNAIL.length).toBeLessThanOrEqual(128 * 1024);
      expect(host.querySelector(".studio-hero-reveal")?.getAttribute("data-animate")).toBe("false");
      expect(onCommit).not.toHaveBeenCalled();
      await click("Make it mine");
      expect(onCommit).toHaveBeenCalledExactlyOnceWith({
        name: baseProps.defaultName,
        workspaceIdentity: {
          choice: { kind: "custom", dataUrl: THUMBNAIL },
          surface: "etched",
          monogramStyle: "editorial",
        },
        themeCanvas: null,
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(createProject).not.toHaveBeenCalled();
    },
  );

  it("refuses drag-and-drop edits while creation is busy, not just disabled file-input clicks", async () => {
    await click("Your mark");
    await upload();
    await read();
    await decode();
    await act(async () => root.render(<WorkspaceIdentityEditor {...baseProps} busy />));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [new File(["replacement"], "replacement.png", { type: "image/png" })] },
    });
    await act(async () => host.querySelector(".studio-upload")!.dispatchEvent(drop));
    expect(readers).toHaveLength(1);
    expect(hero().querySelector("img")?.getAttribute("src")).toBe(THUMBNAIL);
    expect(button("Creating workspace…").disabled).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not upscale small marks and preserves a decoded custom mark across modes", async () => {
    await click("Your mark");
    await upload();
    await read();
    images[0]!.naturalWidth = 32;
    images[0]!.naturalHeight = 64;
    await decode();
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(images[0], 0, 0, 32, 64);
    await click("Initials");
    await click("Your mark");
    expect(hero().querySelector("img")?.getAttribute("src")).toBe(THUMBNAIL);
    expect(button("Make it mine").disabled).toBe(false);
  });

  it("reports file read, invalid data and image decode errors without adopting a broken mark", async () => {
    await click("Your mark");
    await upload();
    await act(async () => readers[0]!.dispatchEvent(new Event("error")));
    expect(alert()).toContain("Could not read this image");
    await upload();
    await read(1, "data:image/svg+xml;base64,YQ==");
    expect(images).toHaveLength(0);
    expect(alert()).toContain("Could not read this image");
    await upload();
    await read();
    await act(async () => images[0]!.dispatchEvent(new Event("error")));
    expect(alert()).toContain("could not be displayed");
    expect(hero().dataset.identityKind).toBe("initials");
    expect(button("Make it mine").disabled).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["throw", "too large", "not an image", "no context", "invalid dimensions"])(
    "reports %s conversion failure and keeps commit blocked",
    async (failure) => {
      await click("Your mark");
      await upload();
      await read();
      if (failure === "throw")
        encode.mockImplementation(() => {
          throw new Error("encoding failed");
        });
      if (failure === "too large")
        encode.mockReturnValue(`data:image/webp;base64,${"a".repeat(128 * 1024)}`);
      if (failure === "not an image") encode.mockReturnValue("data:,");
      if (failure === "no context")
        vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
      if (failure === "invalid dimensions") images[0]!.naturalWidth = 0;
      await decode();
      expect(alert()).toContain("Could not prepare this image");
      expect(hero().dataset.identityKind).toBe("initials");
      expect(button("Make it mine").disabled).toBe(true);
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("blocks commit while a replacement image is pending and ignores stale reader/decode callbacks", async () => {
    await click("Your mark");
    await upload();
    await read();
    await decode();
    await upload();
    expect(button("Reading image…").disabled).toBe(true);
    await upload();
    await read(1);
    expect(images).toHaveLength(1);
    await read(2);
    await upload();
    await decode(1);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(button("Reading image…").disabled).toBe(true);
    await read(3);
    encode.mockReturnValue("data:image/webp;base64,bmV3");
    await decode(2);
    expect(hero().querySelector("img")?.getAttribute("src")).toBe("data:image/webp;base64,bmV3");
    expect(button("Make it mine").disabled).toBe(false);
  });

  it("invalidates both file and image callbacks on a mode change", async () => {
    await click("Your mark");
    await upload();
    await click("Stamp");
    await read(0);
    expect(images).toHaveLength(0);
    await click("Your mark");
    await upload();
    await read(1);
    await click("Icon");
    await act(async () => images[0]!.dispatchEvent(new Event("error")));
    await decode(0);
    expect(encode).not.toHaveBeenCalled();
    expect(alert()).toBeNull();
    expect(hero().dataset.identityKind).toBe("glyph");
  });

  it("invalidates callbacks on unmount without decoding, encoding or committing", async () => {
    await click("Your mark");
    await upload();
    await read(0);
    await upload();
    await act(async () => root.unmount());
    mounted = false;
    await read(1);
    await decode(0);
    await act(async () => images[0]!.dispatchEvent(new Event("error")));
    expect(images).toHaveLength(1);
    expect(encode).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("falls back and forgets a custom mark if its rendered image fails", async () => {
    await click("Your mark");
    await upload();
    await read();
    await decode();
    await act(async () => hero().querySelector("img")!.dispatchEvent(new Event("error")));
    expect(alert()).toContain("could not be displayed");
    expect(hero().dataset.identityKind).toBe("initials");
    expect(button("Make it mine").disabled).toBe(true);
    await click("Icon");
    await click("Your mark");
    expect(hero().dataset.identityKind).toBe("initials");
    expect(button("Make it mine").disabled).toBe(true);
  });
});
