/**
 * The schema-upgrade window (VC-1105) against a recording BrowserWindow: what
 * it is built with, which page and mode it loads, when it shows, and that it
 * can be closed any number of times.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { windows, theme } = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  theme: { shouldUseDarkColors: true },
}));

interface FakeWindow {
  options: Record<string, unknown>;
  url: string | null;
  shown: number;
  destroyed: boolean;
  buttonsVisible: boolean | null;
  handlers: Map<string, () => void>;
  openHandler: (() => { action: string }) | null;
  navigation: ((event: { preventDefault(): void }) => void) | null;
}

vi.mock("electron", () => {
  class BrowserWindow {
    readonly record: FakeWindow;
    readonly webContents: {
      setWindowOpenHandler(handler: () => { action: string }): void;
      on(event: string, handler: (event: { preventDefault(): void }) => void): void;
    };
    constructor(options: Record<string, unknown>) {
      const record: FakeWindow = {
        options,
        url: null,
        shown: 0,
        destroyed: false,
        buttonsVisible: null,
        handlers: new Map(),
        openHandler: null,
        navigation: null,
      };
      this.record = record;
      windows.push(record);
      this.webContents = {
        setWindowOpenHandler: (handler) => {
          record.openHandler = handler;
        },
        on: (event, handler) => {
          if (event === "will-navigate") record.navigation = handler;
        },
      };
    }
    setWindowButtonVisibility(visible: boolean): void {
      this.record.buttonsVisible = visible;
    }
    once(event: string, handler: () => void): void {
      this.record.handlers.set(event, handler);
    }
    loadURL(url: string): Promise<void> {
      this.record.url = url;
      return Promise.resolve();
    }
    isDestroyed(): boolean {
      return this.record.destroyed;
    }
    destroy(): void {
      this.record.destroyed = true;
    }
    show(): void {
      this.record.shown += 1;
    }
    showInactive(): void {
      this.record.shown += 1;
    }
  }
  return { BrowserWindow, nativeTheme: theme };
});

const { openUpdatingWindow, updatingPageUrl } = await import("./updating-window");
const { quietWindowPolicy } = await import("@volli/host-core/maintenance");

const policy = quietWindowPolicy({}, process.platform);

beforeEach(() => {
  windows.length = 0;
  theme.shouldUseDarkColors = true;
});

describe("updatingPageUrl", () => {
  it("names the mode on the bundle's page, or the dev server's", () => {
    const dark = { appearance: "dark", background: "#45291e" } as const;
    const light = { appearance: "light", background: "#f6d4c6" } as const;
    expect(updatingPageUrl(dark, undefined)).toBe(
      "volli-app://bundle/updating.html?appearance=dark&background=%2345291e",
    );
    expect(updatingPageUrl(light, "http://localhost:5173/")).toBe(
      "http://localhost:5173/updating.html?appearance=light&background=%23f6d4c6",
    );
    expect(updatingPageUrl(light, undefined, "check")).toBe(
      "volli-app://bundle/updating.html?appearance=light&background=%23f6d4c6&work=check",
    );
  });
});

describe("openUpdatingWindow", () => {
  it("loads the page in the system's mode, with no bridge and nothing to press", () => {
    theme.shouldUseDarkColors = false;
    openUpdatingWindow({ devRendererUrl: undefined, policy });
    const [window] = windows;
    // The page paints the window's own edge: the default canvas, as a first-ever launch does.
    const url = new URL(window?.url ?? "");
    expect(window?.url?.split("?")[0]).toBe("volli-app://bundle/updating.html");
    expect(url.searchParams.get("appearance")).toBe("light");
    expect(url.searchParams.get("background")).toBe(window?.options["backgroundColor"]);
    expect(url.searchParams.has("work")).toBe(false);
    expect(window?.options).toMatchObject({
      show: false,
      resizable: false,
      titleBarStyle: "hidden",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    expect(window?.options["webPreferences"]).not.toHaveProperty("preload");
    // The default canvas's edge, as a first-ever launch paints it.
    expect(window?.options["backgroundColor"]).toEqual(expect.stringMatching(/^#/));
    if (process.platform === "darwin") expect(window?.buttonsVisible).toBe(false);
    expect(window?.openHandler?.()).toEqual({ action: "deny" });
    const preventDefault = vi.fn();
    window?.navigation?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });

  it("shows once painted, and closes any number of times", () => {
    const updating = openUpdatingWindow({ devRendererUrl: undefined, policy });
    const [window] = windows;
    expect(window?.shown).toBe(0);
    window?.handlers.get("ready-to-show")?.();
    expect(window?.shown).toBe(1);
    updating.close();
    updating.close();
    expect(window?.destroyed).toBe(true);
    // A window already gone is not shown.
    window?.handlers.get("ready-to-show")?.();
    expect(window?.shown).toBe(1);
  });
});
