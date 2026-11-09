import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { settingsNative } from "./settings-native.mjs";

function fixture() {
  let windows;
  const makeWindow = (id, hash) => ({
    id,
    getTitle: () => (hash ? "Settings" : "Volli Code"),
    webContents: {
      getURL: () => `volli-app://app/index.html${hash}`,
      executeJavaScript: async () => ({ appearance: "dark", canvas: "#123456" }),
    },
    isVisible: () => true,
    isModal: () => false,
    getParentWindow: () => null,
    getNormalBounds: () => ({ x: 10, y: 20, width: 900, height: 680 }),
    getMinimumSize: () => [720, 520],
    getMaximumSize: () => [1440, 1200],
    getBackgroundColor: () => "#123456",
    setBounds(value) {
      this.bounds = value;
    },
    once(event, callback) {
      assert.equal(event, "closed");
      this.closed = callback;
    },
    close() {
      windows = windows.filter((window) => window !== this);
      this.closed?.();
    },
  });
  const main = makeWindow(1, "");
  const settings = makeWindow(2, "#settings");
  windows = [main, settings];
  let menuClicks = 0;
  const electronApp = new EventEmitter();
  const ports = {
    app: electronApp,
    BrowserWindow: { getAllWindows: () => windows },
    Menu: {
      getApplicationMenu: () => ({
        items: [
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => menuClicks++ },
          { role: "close" },
          { role: "windowMenu" },
        ],
      }),
    },
  };
  return {
    app: { evaluate: (fn, input) => fn(ports, input) },
    settings,
    electronApp,
    get menuClicks() {
      return menuClicks;
    },
  };
}

test("reads the native window/menu contract without changing it", async () => {
  const f = fixture();
  const result = await settingsNative(f.app);
  assert.equal(result.windows.length, 2);
  assert.equal(result.settingsAccelerator, "CmdOrCtrl+,");
  assert.equal(result.windowMenu, true);
  assert.equal(result.closeRole, true);
  assert.equal(result.windows[1].parent, null);
  assert.equal(f.menuClicks, 0);
});

test("addresses frame and native close only to Settings", async () => {
  const f = fixture();
  const bounds = { x: 30, y: 40, width: 800, height: 600 };
  await settingsNative(f.app, { action: "frame", bounds });
  assert.deepEqual(f.settings.bounds, bounds);
  const result = await settingsNative(f.app, { action: "close" });
  assert.deepEqual(
    result.windows.map((window) => window.id),
    [1],
  );
});

test("records the paint at native reveal without showing or focusing a window", async () => {
  const key = Symbol.for("volli-drive.settings-reveals");
  Reflect.deleteProperty(globalThis, key);
  const f = fixture();
  try {
    await settingsNative(f.app, { action: "watch" });
    const events = new EventEmitter();
    const candidate = { ...f.settings, isVisible: () => false, once: events.once.bind(events) };
    f.electronApp.emit("browser-window-created", {}, candidate);
    events.emit("show");
    const result = await settingsNative(f.app);
    assert.deepEqual(result.reveals, [
      {
        id: 2,
        visibleAtCreation: false,
        backgroundAtReveal: "#123456",
        paintAtReveal: { appearance: "dark", canvas: "#123456" },
      },
    ]);
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});

test("the menu action uses the installed product menu callback", async () => {
  const f = fixture();
  await settingsNative(f.app, { action: "menu" });
  assert.equal(f.menuClicks, 1);
});

test("refuses unknown actions and out-of-range frames before native execution", async () => {
  const app = {
    evaluate() {
      throw new Error("must not execute");
    },
  };
  await assert.rejects(settingsNative(app, { action: "inject" }), /action must/);
  for (const bounds of [
    undefined,
    { x: 0, y: 0, width: 700, height: 600 },
    { x: 0.5, y: 0, width: 900, height: 680 },
  ])
    await assert.rejects(settingsNative(app, { action: "frame", bounds }), /frame must/);
});
