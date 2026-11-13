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

const { launchWindowPage, openUpdatingWindow, updatingPageUrl } = await import("./updating-window");
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
    expect(updatingPageUrl(light, undefined, "upgrade", "quit")).toBe(
      "volli-app://bundle/updating.html?appearance=light&background=%23f6d4c6&then=quit",
    );
  });
});

describe("launchWindowPage", () => {
  it("names the upgrade's page, the check's, and anything else as the app's", () => {
    expect(launchWindowPage("volli-app://bundle/updating.html?appearance=dark")).toBe("upgrade");
    expect(launchWindowPage("http://localhost:5173/updating.html?work=check")).toBe("check");
    expect(launchWindowPage("volli-app://bundle/index.html")).toBe("app");
    expect(launchWindowPage("")).toBe("app");
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

  it("says a quit waits for the upgrade, and comes forward when asked (VC-1208)", () => {
    const updating = openUpdatingWindow({ devRendererUrl: undefined, policy });
    const [window] = windows;
    expect(new URL(window?.url ?? "").searchParams.has("then")).toBe(false);
    updating.reveal();
    expect(window?.shown).toBe(1);
    updating.quitting();
    expect(new URL(window?.url ?? "").searchParams.get("then")).toBe("quit");
    expect(window?.shown).toBe(2);
    // Closed by the person, not by the launch: a waiting quit opens it again.
    window!.destroyed = true;
    updating.reveal();
    expect(window?.shown).toBe(2);
    updating.quitting();
    expect(windows).toHaveLength(2);
    expect(new URL(windows[1]?.url ?? "").searchParams.get("then")).toBe("quit");
    // Closed by the launch: nothing reopens it.
    updating.close();
    updating.quitting();
    expect(windows).toHaveLength(2);

    // A quit asked before the window opened opens it saying so.
    openUpdatingWindow({ devRendererUrl: undefined, policy, quitPending: true });
    expect(new URL(windows[2]?.url ?? "").searchParams.get("then")).toBe("quit");
  });
});
