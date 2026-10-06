import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const electron = vi.hoisted(() => {
  const trays: Array<{
    title: string;
    tooltip: string;
    menu: unknown;
    destroyed: boolean;
  }> = [];
  class Tray {
    readonly state = { title: "", tooltip: "", menu: null as unknown, destroyed: false };
    constructor() {
      trays.push(this.state);
    }
    setTitle(title: string) {
      this.state.title = title;
    }
    setToolTip(tooltip: string) {
      this.state.tooltip = tooltip;
    }
    setContextMenu(menu: unknown) {
      this.state.menu = menu;
    }
    isDestroyed() {
      return this.state.destroyed;
    }
    destroy() {
      this.state.destroyed = true;
    }
  }
  return {
    trays,
    Tray,
    started: new Set<number>(),
    nextBlocker: 0,
    showMessageBoxSync: vi.fn(() => 1),
  };
});

vi.mock("electron", () => ({
  Tray: electron.Tray,
  Menu: { buildFromTemplate: (template: unknown) => ({ template }) },
  nativeImage: { createEmpty: () => ({ empty: true }) },
  powerSaveBlocker: {
    start: vi.fn((type: string) => {
      expect(type).toBe("prevent-app-suspension");
      electron.nextBlocker += 1;
      electron.started.add(electron.nextBlocker);
      return electron.nextBlocker;
    }),
    isStarted: (id: number) => electron.started.has(id),
    stop: (id: number) => electron.started.delete(id),
  },
  dialog: { showMessageBoxSync: electron.showMessageBoxSync },
}));

import {
  confirmMenuBarQuit,
  electronMenuBarPower,
  electronMenuBarTray,
  trayMenuTemplate,
} from "./menu-bar-electron";
import { trayModel } from "./menu-bar-host";

beforeEach(() => {
  electron.trays.length = 0;
  electron.started.clear();
  electron.showMessageBoxSync.mockClear();
});

describe("menu-bar Electron adapter (VC-577)", () => {
  it("renders the Tray model as a native menu, separators and checkbox included", () => {
    const onItem = vi.fn();
    const template = trayMenuTemplate(trayModel({ turns: 1, shells: 0 }, "armed"), onItem);
    expect(template.map((item) => item.type ?? item.label)).toEqual([
      "1 turn running",
      "Open Volli",
      "separator",
      "checkbox",
      "separator",
      "Quit Volli",
    ]);
    expect(template[3]).toEqual(
      expect.objectContaining({ label: "Install Update When Idle", checked: true }),
    );
    expect(template[0]?.enabled).toBe(false);
    for (const item of template) item.click?.(undefined as never, undefined, undefined as never);
    expect(onItem.mock.calls.map(([id]) => id)).toEqual([
      "status",
      "open",
      "install-when-idle",
      "quit",
    ]);
  });

  it("shows one title-only Tray, updates it in place, and destroys it once", () => {
    const tray = electronMenuBarTray(vi.fn());
    tray.update(trayModel({ turns: 1, shells: 0 }, "none"));
    expect(electron.trays).toHaveLength(0);
    tray.show(trayModel({ turns: 1, shells: 0 }, "none"));
    tray.show(trayModel({ turns: 2, shells: 0 }, "none"));
    expect(electron.trays).toHaveLength(1);
    expect(electron.trays[0]?.title).toBe("Volli 2");
    tray.update(trayModel({ turns: 0, shells: 0 }, "none"));
    expect(electron.trays[0]?.title).toBe("Volli");
    expect(electron.trays[0]?.tooltip).toBe("Volli — nothing running");
    tray.destroy();
    tray.destroy();
    expect(electron.trays[0]?.destroyed).toBe(true);
    tray.show(trayModel({ turns: 1, shells: 0 }, "none"));
    expect(electron.trays).toHaveLength(2);
  });

  it("holds one prevent-app-suspension blocker at a time", () => {
    const power = electronMenuBarPower();
    power.release();
    power.hold();
    power.hold();
    expect(electron.started.size).toBe(1);
    power.release();
    expect(electron.started.size).toBe(0);
    power.hold();
    electron.started.clear();
    // Already stopped elsewhere: release is still safe.
    power.release();
    power.hold();
    expect(electron.started.size).toBe(1);
  });

  it("asks before a Tray quit stops live work; Wait is the default and the cancel", () => {
    expect(confirmMenuBarQuit({ turns: 2, shells: 0 })).toBe("wait");
    expect(electron.showMessageBoxSync).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ["Quit Anyway", "Wait and Quit"],
        defaultId: 1,
        cancelId: 1,
        message: "2 turns are running",
      }),
    );
    electron.showMessageBoxSync.mockReturnValueOnce(0);
    expect(confirmMenuBarQuit({ turns: 1, shells: 0 })).toBe("quit");
  });
});
