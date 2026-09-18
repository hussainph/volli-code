/** Built-app VC-301 keyboard-boundary observation. Local fixture only. */
import { promises as fs } from "node:fs";
import http from "node:http";
import { resolve, join } from "node:path";
import {
  launch,
  seedProjects,
  makeGitRepo,
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
} from "./lib/smoke-kit.mjs";
const nativeWindow = process.argv.includes("--native-window");
const out = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "evidence/vc322/browser-boundary",
);
await fs.mkdir(out, { recursive: true });
const scratch = await fs.mkdtemp(join(out, "run-"));
const userDataDir = join(scratch, "user-data");
await fs.mkdir(userDataDir);
const server = http.createServer((_req, res) =>
  res.end(
    `<!doctype html><title>Keyboard fixture</title>
     <input aria-label="Fixture input" autofocus><button>Page action</button>
     <script>window.fixtureKeys=[];document.addEventListener('keydown',event=>{
       window.fixtureKeys.push({key:event.key,meta:event.metaKey,target:event.target.tagName});
     });</script>`,
  ),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const app = await launch({
  dbPath: join(scratch, "volli.db"),
  userDataDir,
  extraEnv: {
    HOME: join(scratch, "home"),
    VOLLI_QUIET_WINDOWS: nativeWindow ? "0" : "1",
  },
});
const results = [];
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await assertProfileIsolated(app, userDataDir);
  const path = await makeGitRepo(scratch, "project-");
  await seedProjects(page, [{ id: "boundary", name: "Boundary", prefix: "KB", path }]);
  await page.getByRole("button", { name: "Other things to open", exact: true }).click();
  await page.getByRole("menuitem", { name: "Browser", exact: true }).click();
  const address = page.getByRole("textbox", { name: "Address", exact: true });
  await address.fill(url);
  await address.press("Enter");
  await page.getByRole("tab", { name: "Keyboard fixture", exact: true }).waitFor();
  for (const key of [
    { keyCode: "k", modifiers: ["meta"] },
    { keyCode: "Escape", modifiers: [] },
    { keyCode: "Tab", modifiers: ["shift"] },
  ]) {
    await app.evaluate(
      ({ webContents, BrowserWindow }, input) => {
        if (input.nativeWindow) BrowserWindow.getAllWindows()[0].focus();
        const wc = webContents.getAllWebContents().find((w) => w.getURL() === input.url);
        wc.focus();
        wc.sendInputEvent({ type: "keyDown", ...input.key });
        wc.sendInputEvent({ type: "keyUp", ...input.key });
      },
      { url, key, nativeWindow },
    );
    await page.waitForTimeout(300);
    results.push({
      key,
      nativeWindow,
      // The fixture is authored above: prove delivery, not just a missing modal.
      delivery: await app.evaluate(async ({ webContents }, fixtureUrl) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL() === fixtureUrl);
        return wc.executeJavaScript(
          "({keys:window.fixtureKeys,active:document.activeElement.tagName})",
        );
      }, url),
      dialogs: await page.getByRole("dialog").count(),
      focus: await app.evaluate(({ webContents }) => {
        const w = webContents.getFocusedWebContents();
        return w ? { url: w.getURL(), type: w.getType() } : null;
      }),
    });
  }
  await fs.writeFile(join(out, "report.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await closeAppBounded(app);
  await new Promise((r) => server.close(r));
}
