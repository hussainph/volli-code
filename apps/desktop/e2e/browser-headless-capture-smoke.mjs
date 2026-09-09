/**
 * Acceptance smoke for VC-278 against the built app: a Browser Tab nobody has
 * ever shown can be screenshotted and clicked during its first cold load.
 *
 * The local fixture is intentionally deterministic. It builds a large initial
 * DOM, then starts one delayed dynamic-module request after `load`. The smoke
 * waits only until that request is in flight and immediately calls the real
 * Browser port's screenshot method. The module response lands six seconds
 * later, so a screenshot that returns inside five seconds was captured while
 * the page was still busy.
 *
 * This is equivalent to the reported cold Vite/module-graph shape; it does not
 * claim to start the UI lab or drive `/lab/#chat-activity` itself.
 *
 * It starts no Session, takes no model turn, and needs no provider credentials
 * or external network.
 *
 * Run (needs a display and the built app):
 *   pnpm run build
 *   node apps/desktop/e2e/browser-headless-capture-smoke.mjs
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
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = {
  id: "browser-headless-capture-project",
  name: "Headless Capture Smoke",
  prefix: "HC",
};

const INITIAL_ROWS = 900;
const CHUNK_ROWS = 600;
const CHUNK_DELAY_MS = 6_000;
const SCREENSHOT_BUDGET_MS = 5_000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>vc278 phase=boot clicked=0 nodes=0</title>
<style>
  body { margin:0; background:#0b1020; color:#e8ecff; font:14px/1.4 system-ui }
  #go { position:fixed; top:8px; left:8px; z-index:10; width:220px; height:56px; font-size:18px }
  .row { margin:0 0 6px 250px; padding:8px 12px; border-radius:8px;
         background:linear-gradient(90deg,#1d4ed8,#7c3aed); box-shadow:0 1px 6px #0008 }
</style></head><body>
<button id="go">Press me</button><main id="graph"></main>
<script>
  const graph = document.getElementById("graph");
  const state = {
    phase: "initial",
    clicked: 0,
    publish() {
      document.title =
        "vc278 phase=" + this.phase +
        " clicked=" + this.clicked +
        " nodes=" + document.getElementsByTagName("*").length;
    },
  };
  globalThis.vc278 = state;
  function rows(label, count) {
    const band = document.createElement("section");
    for (let index = 0; index < count; index += 1) {
      const row = document.createElement("div");
      row.className = "row";
      row.textContent = label + " row " + index;
      band.appendChild(row);
    }
    graph.appendChild(band);
    let measured = 0;
    for (const row of band.children) measured += row.getBoundingClientRect().height;
    return measured;
  }
  rows("document", ${INITIAL_ROWS});
  state.publish();
  document.getElementById("go").addEventListener("click", () => {
    state.clicked += 1;
    state.publish();
  });
  window.addEventListener("load", () => {
    setTimeout(() => {
      state.phase = "compiling";
      state.publish();
      import("/cold-chunk.mjs");
    }, 50);
  });
</script></body></html>`;

const CHUNK = `const state = globalThis.vc278;
const graph = document.getElementById("graph");
const band = document.createElement("section");
for (let index = 0; index < ${CHUNK_ROWS}; index += 1) {
  const row = document.createElement("div");
  row.className = "row";
  row.textContent = "chunk row " + index;
  band.appendChild(row);
}
graph.appendChild(band);
let measured = 0;
for (const row of band.children) measured += row.getBoundingClientRect().height;
state.phase = "ready";
state.publish();
export { measured };
`;

async function startFixtureServer() {
  const timing = {
    documentResponses: 0,
    chunkRequestedAt: null,
    chunkRespondedAt: null,
  };
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (path === "/cold-chunk.mjs") {
      timing.chunkRequestedAt = Date.now();
      await sleep(CHUNK_DELAY_MS);
      timing.chunkRespondedAt = Date.now();
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(CHUNK);
      return;
    }
    if (path !== "/") {
      response.writeHead(404).end();
      return;
    }
    timing.documentResponses += 1;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    timing,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function factsOf(title) {
  const facts = {};
  for (const [, key, value] of String(title ?? "").matchAll(/([A-Za-z]+)=(\S+)/g)) {
    facts[key] = value;
  }
  return facts;
}

async function driveHeadlessTab(app, url, projectId) {
  return app.evaluate(
    async ({ nativeImage }, { url: target, projectId: scope, chunkDelayMs }) => {
      const probe = globalThis.volliBrowserProbe;
      const host = globalThis.volliBrowserHost;
      if (probe === undefined) throw new Error("VOLLI_BROWSER_PROBE door is not open");
      if (host === undefined) throw new Error("VOLLI_SMOKE_BROWSER_HOST door is not open");
      const port = probe.port({ projectId: scope, ticketId: null }, "smoke-session-vc278");
      const signal = new AbortController().signal;
      const out = {};
      const stateOf = (tabId) =>
        host.list({ projectId: scope }).find((candidate) => candidate.tabId === tabId);
      try {
        // No tab id: this is the tab's first navigation, and it is Headless from birth.
        const opened = await port.navigate({ navigation: { kind: "url", url: target }, signal });
        out.tabId = opened.tabId;
        out.generation = opened.generation;
        out.navigationPicture = opened.picture;
        out.presentationBefore = stateOf(opened.tabId)?.presentation;

        // Wait for the deterministic equivalent of an on-demand compile to be in flight.
        const busyDeadline = Date.now() + 2_000;
        while (!stateOf(opened.tabId)?.title.includes("phase=compiling")) {
          if (Date.now() >= busyDeadline) throw new Error("the cold module request never started");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        out.titleAtScreenshot = stateOf(opened.tabId)?.title;

        out.requestedAt = Date.now();
        const shot = await port.screenshot({ tabId: opened.tabId, signal });
        out.answeredAt = Date.now();
        out.screenshotMs = out.answeredAt - out.requestedAt;
        out.screenshotBytes = Buffer.from(shot.base64Png, "base64").byteLength;
        out.screenshotPicture = shot.picture;
        out.reported = { width: shot.width, height: shot.height };
        out.presentationAfter = stateOf(opened.tabId)?.presentation;

        const image = nativeImage.createFromBuffer(Buffer.from(shot.base64Png, "base64"));
        const size = image.getSize();
        const colours = new Set();
        const bitmap = image.toBitmap();
        for (let offset = 0; offset + 3 < bitmap.length; offset += 4 * 997) {
          colours.add(`${bitmap[offset]},${bitmap[offset + 1]},${bitmap[offset + 2]}`);
          if (colours.size > 32) break;
        }
        out.pixels = { width: size.width, height: size.height, colours: colours.size };

        const snap = await port.snapshot({ tabId: opened.tabId, signal });
        const ref = /button[^\n]*\[ref=(e\d+)\]/.exec(snap.snapshotText)?.[1] ?? null;
        out.buttonRef = ref;
        if (ref !== null) {
          out.clickedAt = Date.now();
          const acted = await port.act({
            tabId: opened.tabId,
            generation: snap.generation,
            kind: "click",
            ref,
            signal,
          });
          out.titleAfterClick = acted.title;
        }

        const readyDeadline = Date.now() + chunkDelayMs + 5_000;
        while (!stateOf(opened.tabId)?.title.includes("phase=ready")) {
          if (Date.now() >= readyDeadline) throw new Error("the cold module never finished");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        out.finalTitle = stateOf(opened.tabId)?.title;
        out.presentationAtEnd = stateOf(opened.tabId)?.presentation;
      } catch (error) {
        out.error = String(error?.message ?? error);
      } finally {
        port.dispose();
      }
      return out;
    },
    { url, projectId, chunkDelayMs: CHUNK_DELAY_MS },
  );
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-headless-capture-");
const scratchHome = join(scratch, "home");
const { must, summarize } = createRunner();
const fixture = await startFixtureServer();
let app = null;
let code = 1;

async function main() {
  await fs.mkdir(scratchHome, { recursive: true });
  const projectPath = await makeGitRepo(scratch, "headless-capture-");
  app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      HOME: scratchHome,
      VOLLI_BROWSER_PROBE: "1",
      VOLLI_SMOKE_BROWSER_HOST: "1",
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
  await waitUntil("Browser probe and host doors", async () =>
    app.evaluate(
      () => globalThis.volliBrowserProbe !== undefined && globalThis.volliBrowserHost !== undefined,
    ),
  );

  const result = await driveHeadlessTab(app, `${fixture.origin}/`, PROJECT.id);
  const busyFacts = factsOf(result.titleAtScreenshot);
  const finalFacts = factsOf(result.finalTitle);

  await must(1, "the screenshot runs during the first cold module load", async () => {
    const { timing } = fixture;
    const ok =
      result.error === undefined &&
      fixture.timing.documentResponses === 1 &&
      busyFacts.phase === "compiling" &&
      timing.chunkRequestedAt !== null &&
      timing.chunkRespondedAt !== null &&
      result.answeredAt < timing.chunkRespondedAt &&
      finalFacts.phase === "ready" &&
      Number(finalFacts.nodes) >= INITIAL_ROWS + CHUNK_ROWS;
    return {
      ok,
      detail:
        `documents=${timing.documentResponses} generation=${result.generation} ` +
        `phase=${busyFacts.phase}->${finalFacts.phase} nodes=${finalFacts.nodes} ` +
        `capture answered ${timing.chunkRespondedAt - result.answeredAt}ms before the module`,
    };
  });

  await must(2, "the Headless tab returns real screenshot pixels inside the bound", async () => {
    const pixels = result.pixels ?? {};
    const reported = result.reported ?? {};
    const ok =
      result.error === undefined &&
      result.presentationBefore === "headless" &&
      result.presentationAfter === "headless" &&
      result.presentationAtEnd === "headless" &&
      result.screenshotMs < SCREENSHOT_BUDGET_MS &&
      result.screenshotBytes > 2_000 &&
      reported.width > 0 &&
      reported.height > 0 &&
      pixels.width > 0 &&
      pixels.height > 0 &&
      pixels.colours >= 4;
    return {
      ok,
      detail:
        `presentation=${result.presentationBefore}/${result.presentationAfter}/${result.presentationAtEnd} ` +
        `${result.screenshotMs}ms ${result.screenshotBytes}B reports ${reported.width}x${reported.height}, ` +
        `pixels ${pixels.width}x${pixels.height} with ${pixels.colours} colours`,
    };
  });

  await must(3, "a click reaches the page while its module is still loading", async () => {
    const clickedFacts = factsOf(result.titleAfterClick);
    const ok =
      result.error === undefined &&
      result.buttonRef !== null &&
      clickedFacts.clicked === "1" &&
      result.clickedAt < fixture.timing.chunkRespondedAt &&
      finalFacts.clicked === "1";
    return {
      ok,
      detail: `ref=${result.buttonRef} phase=${clickedFacts.phase} clicked=${clickedFacts.clicked}`,
    };
  });

  await must(4, "navigation and screenshot pictures both contain data", async () => {
    const ids = [result.navigationPicture ?? null, result.screenshotPicture ?? null];
    const lengths = await app.evaluate(
      (_electron, pictureIds) =>
        pictureIds.map((id) =>
          id === null ? 0 : (globalThis.volliBrowserHost?.pictureOf(id)?.length ?? 0),
        ),
      ids,
    );
    return {
      ok: lengths[0] > 2_000 && lengths[1] > 2_000,
      detail: `navigation=${lengths[0]} chars screenshot=${lengths[1]} chars`,
    };
  });

  code = summarize();
}

try {
  await main();
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  if (app !== null) await app.close().catch(() => undefined);
  await fixture.close();
  await cleanup();
  process.exit(code);
}
