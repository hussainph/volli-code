import assert from "node:assert/strict";

/** Hide is not disposal: await the retiring Page's close before reopening.
 * Arm the event before native Quit, including when destruction is immediate.
 * The real local keepalive keeps Electron alive; no renderer or host state is
 * injected. An unacknowledged draft that retains its Page fails this journey
 * rather than racing a snapshot against its eventual destruction.
 */
export async function quitNativeWindow(app, page, { timeout = 10_000 } = {}) {
  assert.ok(!page.isClosed(), "The native Quit target is already closed");
  const closed = page.waitForEvent("close", { timeout });
  const [result] = await Promise.all([
    app.evaluate(({ Menu }) => {
      // Serialized into Electron main: no supervisor closure.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const walk = (menu) =>
        menu?.items.flatMap((item) => [item, ...(walk(item.submenu) ?? [])]) ?? [];
      const quit = walk(Menu.getApplicationMenu()).find((item) => item.role === "quit");
      if (!quit) throw new Error("Native Quit menu item missing");
      const label = quit.label;
      // Electron 44's JS role.click is a no-op for native macOS roles.
      Menu.sendActionToFirstResponder("terminate:");
      return { label };
    }),
    closed,
  ]);
  const nativeWindows = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return {
      visible: windows.filter((window) => window.isVisible()).length,
      retained: windows.length,
    };
  });
  assert.equal(nativeWindows.visible, 0, "Native Quit left a visible app window");
  return { ...result, nativeWindows };
}

/** firstWindow() may return the old Page while its close event is in flight.
 * Subscribe before activation and return the replacement Page itself, which
 * the caller must bind for subsequent snapshots and actions.
 */
export async function reopenNativeWindow(app, { timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  const created = app.waitForEvent("window", { timeout });
  const [, page] = await Promise.all([
    app.evaluate(({ app: electronApp }) => electronApp.emit("activate")),
    created,
  ]);
  await page.waitForLoadState("domcontentloaded", {
    timeout: Math.max(1, deadline - Date.now()),
  });
  return page;
}
