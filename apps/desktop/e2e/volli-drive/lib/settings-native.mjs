/** Native-boundary observations/actions for the guarded Settings journey.
 * Renderer entry points still go through snapshots and semantic actions. Quiet
 * windows cannot become key, so native close is addressed explicitly, never by
 * focusing the person's app or sending an OS-wide keyboard event.
 */
export async function settingsNative(app, { action = "state", bounds } = {}) {
  if (!["state", "watch", "frame", "close", "menu"].includes(action))
    throw new Error("Settings native action must be state, watch, frame, close or menu");
  if (
    action === "frame" &&
    (!bounds ||
      !["x", "y", "width", "height"].every((key) => Number.isInteger(bounds[key])) ||
      bounds.width < 720 ||
      bounds.width > 1440 ||
      bounds.height < 520 ||
      bounds.height > 1200)
  )
    throw new Error("Settings frame must have integer coordinates and fit the window limits");
  return app.evaluate(
    async ({ app: electronApp, BrowserWindow, Menu }, input) => {
      const paintRead = `({
      appearance: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()
    })`;
      const observationKey = Symbol.for("volli-drive.settings-reveals");
      if (input.action === "watch" && !globalThis[observationKey]) {
        const reveals = [];
        globalThis[observationKey] = reveals;
        electronApp.on("browser-window-created", (_event, candidate) => {
          const visibleAtCreation = candidate.isVisible();
          candidate.once("show", () => {
            if (!candidate.webContents.getURL().endsWith("#settings")) return;
            const record = {
              id: candidate.id,
              visibleAtCreation,
              backgroundAtReveal: candidate.getBackgroundColor(),
            };
            reveals.push(record);
            void candidate.webContents
              .executeJavaScript(paintRead)
              .then((paint) => {
                record.paintAtReveal = paint;
              })
              .catch((error) => {
                record.error = String(error);
              });
          });
        });
      }
      const all = BrowserWindow.getAllWindows();
      const settings = all.filter((window) => {
        try {
          return new URL(window.webContents.getURL()).hash === "#settings";
        } catch {
          return false;
        }
      });
      if (settings.length > 1) throw new Error("More than one Settings window");
      const window = settings[0];
      // Serialized into Electron main: the callback cannot capture supervisor helpers.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const walk = (menu) => menu?.items.flatMap((item) => [item, ...walk(item.submenu)]) ?? [];
      const menu = walk(Menu.getApplicationMenu());
      const entry = menu.find((item) => item.label === "Settings…");
      if (input.action === "menu") {
        if (!entry) throw new Error("Settings menu item missing");
        entry.click();
      } else if (input.action !== "state" && input.action !== "watch") {
        if (!window) throw new Error("No Settings window");
        if (input.action === "frame") window.setBounds(input.bounds);
        else
          await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Settings native close did not complete")),
              10_000,
            );
            window.once("closed", () => {
              clearTimeout(timer);
              resolve();
            });
            window.close();
          });
      }
      return {
        reveals: globalThis[observationKey] ?? [],
        settingsAccelerator: entry?.accelerator,
        closeRole: menu.some((item) => item.role === "close"),
        windowMenu: menu.some((item) => item.role?.toLowerCase() === "windowmenu"),
        windows: await Promise.all(
          BrowserWindow.getAllWindows().map(async (candidate) => ({
            id: candidate.id,
            title: candidate.getTitle(),
            url: candidate.webContents.getURL(),
            visible: candidate.isVisible(),
            modal: candidate.isModal(),
            parent: candidate.getParentWindow()?.id ?? null,
            bounds: candidate.getNormalBounds(),
            minimumSize: candidate.getMinimumSize(),
            maximumSize: candidate.getMaximumSize(),
            background: candidate.getBackgroundColor(),
            paint: await candidate.webContents.executeJavaScript(paintRead),
          })),
        ),
      };
    },
    { action, bounds },
  );
}
