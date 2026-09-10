#!/usr/bin/env node
/**
 * Acceptance smoke for VC-243 against the built app: a real Browser port can
 * drive page-owned navigation in a Headless tab by link click, submit-button
 * click, and Enter in a focused form field. The fixture is loopback-only and
 * every action runs through the same desktopBrowserPort factory Sessions use.
 *
 * Run (needs a display and the built app):
 *   pnpm run build
 *   node apps/desktop/e2e/browser-page-navigation-smoke.mjs
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assertBuiltRendererLoaded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = {
  id: "browser-page-navigation-project",
  name: "Browser Page Navigation Smoke",
  prefix: "BN",
};

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const { pathname, search } = requestUrl;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");

    const pages = {
      "/link": `<!doctype html><title>Link start</title><a href="/linked">Follow plain link</a>`,
      "/linked": `<!doctype html><title>Link destination</title><h1>Link destination</h1>`,
      "/form-button": `<!doctype html><title>Button form</title>
        <form action="/submitted-button" method="get">
          <label>Button query <input name="q"></label>
          <button type="submit">Submit by button</button>
        </form>`,
      "/form-enter": `<!doctype html><title>Enter form</title>
        <form action="/submitted-enter" method="get">
          <label>Enter query <input name="q"></label>
          <button type="submit">Submit by Enter</button>
        </form>`,
    };
    const page = pages[pathname];
    if (page !== undefined) {
      response.end(page);
      return;
    }
    if (pathname === "/submitted-button" || pathname === "/submitted-enter") {
      const title = `${pathname.slice(1)}${search}`;
      response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
      return;
    }
    response.statusCode = 404;
    response.end("<!doctype html><title>Not found</title><h1>Not found</h1>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function drivePageNavigation(app, origin) {
  return app.evaluate(
    async (_electron, { origin: fixtureOrigin, projectId }) => {
      const probe = globalThis.volliBrowserProbe;
      if (probe === undefined) throw new Error("VOLLI_BROWSER_PROBE door is not open");
      const port = probe.port({ projectId, ticketId: null }, "smoke-session-vc243");
      const signal = new AbortController().signal;
      const refNamed = (snapshotText, role, name) => {
        const line = snapshotText
          .split("\n")
          .find((candidate) => candidate.includes(`${role} ${JSON.stringify(name)}`));
        const ref = /\[ref=(e\d+)\]/.exec(line ?? "")?.[1];
        if (ref === undefined) {
          throw new Error(
            `no ${role} named ${JSON.stringify(name)} at ${fixtureOrigin} in ${snapshotText}`,
          );
        }
        return ref;
      };
      const open = (path) =>
        port.navigate({ navigation: { kind: "url", url: `${fixtureOrigin}${path}` }, signal });

      try {
        const linkStart = await open("/link");
        const linkEnd = await port.act({
          tabId: linkStart.tabId,
          generation: linkStart.generation,
          kind: "click",
          ref: refNamed(linkStart.snapshotText, "link", "Follow plain link"),
          signal,
        });

        const buttonStart = await open("/form-button");
        const buttonTyped = await port.act({
          tabId: buttonStart.tabId,
          generation: buttonStart.generation,
          kind: "type",
          ref: refNamed(buttonStart.snapshotText, "textbox", "Button query"),
          text: "button terms",
          signal,
        });
        const buttonEnd = await port.act({
          tabId: buttonTyped.tabId,
          generation: buttonTyped.generation,
          kind: "click",
          ref: refNamed(buttonTyped.snapshotText, "button", "Submit by button"),
          signal,
        });

        const enterStart = await open("/form-enter");
        const enterTyped = await port.act({
          tabId: enterStart.tabId,
          generation: enterStart.generation,
          kind: "type",
          ref: refNamed(enterStart.snapshotText, "textbox", "Enter query"),
          text: "enter terms",
          signal,
        });
        const enterEnd = await port.act({
          tabId: enterTyped.tabId,
          generation: enterTyped.generation,
          kind: "press",
          key: "Enter",
          signal,
        });

        return {
          link: { before: linkStart, after: linkEnd },
          button: { before: buttonTyped, after: buttonEnd },
          enter: { before: enterTyped, after: enterEnd },
        };
      } finally {
        port.dispose();
      }
    },
    { origin, projectId: PROJECT.id },
  );
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch(
  "volli-browser-page-navigation-",
);
const scratchHome = join(scratch, "home");
const fixture = await startFixtureServer();
const { must, summarize } = createRunner();
let app = null;
let code = 1;

async function main() {
  await fs.mkdir(scratchHome, { recursive: true });
  const projectPath = await makeGitRepo(scratch, "browser-page-navigation-project-");
  app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { HOME: scratchHome, VOLLI_BROWSER_PROBE: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
  await waitUntil("Browser probe door", async () =>
    app.evaluate(() => globalThis.volliBrowserProbe !== undefined),
  );

  const result = await drivePageNavigation(app, fixture.origin);
  const checks = [
    ["link", "/linked", "plain link click"],
    ["button", "/submitted-button?q=button+terms", "submit-button click"],
    ["enter", "/submitted-enter?q=enter+terms", "Enter in a focused field"],
  ];
  for (const [key, expectedPath, label] of checks) {
    await must(key, `${label} performs page-owned navigation and bumps generation`, async () => {
      const { before, after } = result[key];
      const expectedUrl = `${fixture.origin}${expectedPath}`;
      return {
        ok: after.url === expectedUrl && after.generation > before.generation,
        detail: `url=${after.url} generation=${before.generation}->${after.generation}`,
      };
    });
  }
  code = summarize();
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? error);
  code = 1;
} finally {
  if (app !== null) await app.close().catch(() => undefined);
  await fixture.close().catch(() => undefined);
  await cleanup();
  process.exit(code);
}
