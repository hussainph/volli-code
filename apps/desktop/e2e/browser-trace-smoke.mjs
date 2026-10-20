/**
 * Acceptance smoke for Browser Traces (VC-453), against the BUILT app, across
 * a relaunch:
 *
 *   1. a Session that navigates, reads, finds and acts in its own tab produces a trace whose
 *      steps match its calls in order — a refused act included;
 *   2. each step's frame is on disk under userData/browser-traces, and a tab
 *      the PERSON created, driven by the same Session, left nothing there;
 *   3. the replay opens from the Activity Island's tabs card and steps
 *      through the frames with the keyboard;
 *   4. after a relaunch the trace and its frames are still there — the live
 *      picture set is empty, so every frame answers from the trace — and a
 *      trace past its age bound was swept at boot;
 *   5. the replay opened after the relaunch still steps back into the frames
 *      recorded before it.
 *
 * It takes no model turn. The Session's calls go through the SAME port a
 * Session gets (`browserAgentPort`, behind the `VOLLI_BROWSER_PROBE` door),
 * in the name of a real chat Session minted by one Send — whose turn fails on
 * the placeholder key below, which nothing here depends on.
 *
 * Run (needs a display and the built app):
 *   pnpm run build
 *   node apps/desktop/e2e/browser-trace-smoke.mjs [evidence-dir]
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createRunner,
  evidenceDir,
  HOME_TAB_STRIP,
  launch,
  makeGitRepo,
  makeScratch,
  openNewChatTab,
  seedDefaultModel,
  seedProjects,
  tabStrip,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "browser-trace-smoke-project", name: "Trace Smoke", prefix: "TR" };
const STALE_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const STALE_FRAME = "1a1b1c1d-1e1f-4a2b-8c2d-2e2f3a3b3c3d";

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const [title, colour] =
      path === "/next"
        ? ["Trace Next", "#14532d"]
        : path === "/person"
          ? ["Person", "#444"]
          : ["Trace Start", "#1e3a8a"];
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="margin:0;background:${colour};color:#fff;font:24px system-ui">` +
        `<h1>${title}</h1><button id="go" style="font-size:24px">Sign in</button>` +
        `<script>document.getElementById("go").onclick=()=>{document.title=document.title+" clicked"}</script>` +
        `</body></html>`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The Session's browser work, through the same port a Session gets. */
async function driveSession(app, input) {
  return app.evaluate(async (_electron, { origin, projectId, sessionId }) => {
    const probe = globalThis.volliBrowserProbe;
    const host = globalThis.volliBrowserHost;
    if (probe === undefined || host === undefined) throw new Error("smoke doors are not open");
    const port = probe.port({ projectId, ticketId: null }, sessionId);
    const signal = new AbortController().signal;
    const out = { calls: [] };
    try {
      const opened = await port.navigate({
        navigation: { kind: "url", url: `${origin}/` },
        signal,
      });
      out.tabId = opened.tabId;
      out.calls.push("open");
      const snap = await port.snapshot({ tabId: opened.tabId, signal });
      out.calls.push("read");
      const ref = /button[^\n]*\[ref=(e\d+)\]/.exec(snap.snapshotText)?.[1];
      await port.act({
        tabId: opened.tabId,
        generation: snap.generation,
        kind: "click",
        ref,
        signal,
      });
      out.calls.push("click");
      // A stale generation: the policy refuses, and the trace says so.
      out.refusal = await port
        .act({ tabId: opened.tabId, generation: snap.generation - 1, kind: "click", ref, signal })
        .then(
          () => null,
          (error) => error.rule ?? String(error),
        );
      out.calls.push("click(refused)");
      await port.navigate({
        tabId: opened.tabId,
        navigation: { kind: "url", url: `${origin}/next` },
        signal,
      });
      out.calls.push("open");
      const next = await port.snapshot({ tabId: opened.tabId, signal });
      out.calls.push("read");
      await port.act({
        tabId: opened.tabId,
        generation: next.generation,
        kind: "press",
        key: "Tab",
        signal,
      });
      out.calls.push("press");
      // A search (VC-364) is a call against the tab too, and a step like any other.
      await port.find({ tabId: opened.tabId, query: "Sign in", signal });
      out.calls.push("find");

      // The person's own tab, driven by the same Session: never recorded.
      const person = host.open({
        url: `${origin}/person`,
        projectId,
        ticketId: null,
        createdBy: "user",
      });
      out.personTabId = person.tabId;
      const deadline = Date.now() + 10_000;
      while (
        host.list({ projectId }).find((tab) => tab.tabId === person.tabId)?.loading !== false
      ) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const personSnap = await port.snapshot({ tabId: person.tabId, signal });
      const personRef = /button[^\n]*\[ref=(e\d+)\]/.exec(personSnap.snapshotText)?.[1];
      const acted = await port.act({
        tabId: person.tabId,
        generation: personSnap.generation,
        kind: "click",
        ref: personRef,
        signal,
      });
      out.personPicture = acted.picture;
      port.turnEnded();
    } catch (error) {
      out.error = String(error?.stack ?? error);
    }
    // Deliberately NOT disposed: the agent tab stays for the island to list.
    return out;
  }, input);
}

/** One more Session step after the relaunch, so the island has a tab to open the replay from. */
async function openAfterRelaunch(app, input) {
  return app.evaluate(async (_electron, { origin, projectId, sessionId }) => {
    const port = globalThis.volliBrowserProbe.port({ projectId, ticketId: null }, sessionId);
    const opened = await port.navigate({
      navigation: { kind: "url", url: `${origin}/next` },
      signal: new AbortController().signal,
    });
    port.turnEnded();
    return opened.tabId;
  }, input);
}

/** A record as JSON with sorted keys, so two reads compare by content, not key order. */
function canonical(value) {
  return JSON.stringify(value, (_key, field) =>
    field !== null && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : field,
  );
}

const tracesOf = (page, sessionId) =>
  page.evaluate((id) => window.api.browser.traces({ sessionId: id }), sessionId);

const tabsCluster = (page) => page.locator('[data-island-cluster="tabs"]');
const tabsCard = (page) => page.locator('[data-island-card="tabs"]');
const replay = (page) => page.locator("[data-browser-trace-dialog]");
const replayPosition = (page) => replay(page).locator("[data-trace-position]");
const replayCaption = (page) => replay(page).locator("[data-trace-caption]");

async function openReplayFromIsland(page, tabId) {
  await waitUntil("the island's tabs cluster", async () =>
    (await tabsCluster(page).count()) === 1 ? true : null,
  );
  await tabsCluster(page).click();
  const row = tabsCard(page).locator(`[data-island-row="${tabId}"]`);
  await waitUntil("the tab's row in the pinned card", async () =>
    (await row.count()) === 1 ? true : null,
  );
  await row.hover();
  await row.locator("..").getByRole("button", { name: "Replay", exact: true }).click();
  await waitUntil("the replay dialog", async () =>
    (await replay(page).count()) === 1 ? true : null,
  );
  await waitUntil("the replay's first read", async () =>
    (await replayPosition(page).count()) === 1 ? true : null,
  );
}

/**
 * Walks the replay from its first step to its last with the keyboard, reading
 * each step's caption and — where the step has one — its loaded frame. A
 * capture the host declined (a cold headless tab can miss its first) is a step
 * with no frame, which the replay says rather than skipping.
 */
async function walkReplay(page, pictures) {
  await page.keyboard.press("Home");
  const seen = [];
  for (;;) {
    const position = await waitUntil("a step position", async () => {
      const text = await replayPosition(page).textContent();
      const match = /^Step (\d+) of (\d+)/.exec(text ?? "");
      return match !== null && Number(match[1]) === seen.length + 1 ? match : null;
    });
    const caption = await replayCaption(page).textContent();
    const expected = pictures[seen.length] ?? null;
    const frame =
      expected === null
        ? await waitUntil("the step's no-picture line", async () =>
            (await replay(page).getByText("No picture for this step").count()) === 1
              ? "none"
              : null,
          ).then(() => null)
        : await frameLoaded(page, expected);
    const troubles = replay(page).locator("[data-trace-trouble]");
    const trouble = (await troubles.count()) === 1 ? await troubles.textContent() : null;
    seen.push({ caption, frame, trouble });
    if (Number(position[1]) === Number(position[2])) break;
    await page.keyboard.press("ArrowRight");
  }
  return seen;
}

/** The frame each step of one tab's trace shows: its own, else the tab's last. */
function shownFrames(steps) {
  let last = null;
  return steps.map((step) => (last = step.pictureId ?? last));
}

/** Waits for the replay to show one frame, fully decoded. */
async function frameLoaded(page, pictureId) {
  return waitUntil(
    `frame ${pictureId.slice(0, 8)} to load`,
    async () =>
      page.evaluate((id) => {
        const img = document.querySelector("[data-browser-trace-dialog] [data-trace-frame]");
        return img instanceof HTMLImageElement &&
          img.getAttribute("data-trace-frame") === id &&
          img.complete &&
          img.naturalWidth > 0
          ? { id, width: img.naturalWidth }
          : null;
      }, pictureId),
    { timeout: 8_000 },
  );
}

async function openChat(page) {
  const label = await openNewChatTab(page, HOME_TAB_STRIP);
  const composer = page.getByPlaceholder("Ask, plan, or implement…").first();
  await composer.click();
  await composer.fill("own the traced tab");
  await page.keyboard.press("Enter");
  const sessionId = await waitUntil("the chat Session id", async () => {
    const result = await page.evaluate(
      (projectId) => window.api.sessions.list({ projectId }),
      PROJECT.id,
    );
    const chat = result.ok ? result.sessions.find((row) => row.kind === "chat") : undefined;
    return chat?.record.sessionId ?? null;
  });
  return { label, sessionId };
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-browser-trace-");
const evidence = await evidenceDir("browser-trace");
const scratchHome = join(scratch, "home");
const tracesRoot = join(userDataDir, "browser-traces");
const { must, attempt, summarize } = createRunner();
const fixture = await startFixtureServer();
const env = {
  HOME: scratchHome,
  VOLLI_BROWSER_PROBE: "1",
  VOLLI_SMOKE_BROWSER_HOST: "1",
  ANTHROPIC_API_KEY: "volli-smoke-placeholder-never-sent",
};
let app = null;
let code = 1;
const pageErrors = [];

async function boot() {
  app = await launch({ dbPath, userDataDir, extraEnv: env });
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((candidate) => !candidate.isDestroyed())
      ?.setSize(1280, 860);
  });
  await waitUntil("Browser probe and host doors", async () =>
    app.evaluate(
      () => globalThis.volliBrowserProbe !== undefined && globalThis.volliBrowserHost !== undefined,
    ),
  );
  return page;
}

async function main() {
  await fs.mkdir(scratchHome, { recursive: true });
  const projectPath = await makeGitRepo(scratch, "trace-project-");
  let page = await boot();
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
  await seedDefaultModel(page);
  await waitUntil("Home tab strip", async () =>
    (await tabStrip(page, HOME_TAB_STRIP).count()) === 1 ? true : null,
  );
  const { sessionId } = await openChat(page);
  const driven = await driveSession(app, {
    origin: fixture.origin,
    projectId: PROJECT.id,
    sessionId,
  });
  let recorded = null;

  await must(
    1,
    "a Session's calls in its own tab become one trace, in order — find and a refusal included",
    async () => {
      const result = await tracesOf(page, sessionId);
      recorded = result.ok ? result.traces : [];
      const steps = recorded.flatMap((trace) => trace.steps);
      const actual = steps.map((step) =>
        step.outcome === "ok" ? step.action : `${step.action}(${step.outcome})`,
      );
      const expected = driven.calls;
      return {
        ok:
          driven.error === undefined &&
          recorded.length === 1 &&
          recorded[0].tabId === driven.tabId &&
          JSON.stringify(actual) === JSON.stringify(expected) &&
          steps[2].target === "Sign in" &&
          steps[3].rule === driven.refusal &&
          steps[7].target === "Sign in" &&
          steps.every((step, index) => step.seq === index),
        detail: `calls=${JSON.stringify(driven.calls)} pictures=${JSON.stringify(steps.map((step) => step.pictureId?.slice(0, 8) ?? null))} steps=${JSON.stringify(actual)} refusal=${driven.refusal} ${driven.error ?? ""}`,
      };
    },
  );

  await must(
    2,
    "every frame is on disk in the traces directory, and the person's tab left nothing",
    async () => {
      const frameFiles = await fs.readdir(join(tracesRoot, "frames"));
      // Each frame is the picture disk's self-describing pair: bytes and record.
      const frames = frameFiles.filter((name) => name.endsWith(".jpg"));
      const sidecars = frameFiles.filter((name) => name.endsWith(".json"));
      const records = (await fs.readdir(tracesRoot)).filter((name) => name.endsWith(".json"));
      const named = recorded
        .flatMap((trace) => trace.steps)
        .flatMap((step) => (step.pictureId ? [step.pictureId] : []));
      const personFrame =
        driven.personPicture !== null &&
        frames.some((name) => name.startsWith(driven.personPicture));
      const personTrace = recorded.some((trace) => trace.tabId === driven.personTabId);
      return {
        ok:
          named.length >= 2 &&
          named.every((id) => frames.includes(`${id}.jpg`)) &&
          frames.length === named.length &&
          sidecars.length === named.length &&
          records.length === 1 &&
          driven.personPicture !== null &&
          !personFrame &&
          !personTrace,
        detail: `frames=${frames.length} named=${named.length} records=${records.length} personPicture=${driven.personPicture}`,
      };
    },
  );

  await must(
    3,
    "the replay opens from the island and steps through the frames with the keyboard",
    async () => {
      await openReplayFromIsland(page, driven.tabId);
      const opened = await replayPosition(page).textContent();
      const expectedFrames = shownFrames(recorded[0].steps);
      const walked = await walkReplay(page, expectedFrames);
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await replay(page).screenshot({ path: join(evidence, "replay-before-relaunch.png") });
      await page.keyboard.press("Escape");
      await waitUntil("the replay to close", async () =>
        (await replay(page).count()) === 0 ? true : null,
      );
      const frames = walked.map((one) => one.frame?.id ?? null);
      return {
        ok:
          opened === "Step 8 of 8" &&
          walked.length === 8 &&
          JSON.stringify(walked.map((one) => one.caption)) ===
            JSON.stringify([
              "Opened",
              "Read page",
              "Clicked “Sign in”",
              walked[3].caption,
              "Opened",
              "Read page",
              "Pressed Tab",
              "Searched for “Sign in”",
            ]) &&
          /^Clicked e\d+$/.test(walked[3].caption ?? "") &&
          walked[3].trouble === `refused by ${driven.refusal}` &&
          JSON.stringify(frames) === JSON.stringify(expectedFrames) &&
          walked.every((one) => one.frame === null || one.frame.width > 0),
        detail: `opened="${opened}" captions=${JSON.stringify(walked.map((one) => one.caption))} frames=${JSON.stringify(frames.map((id) => id?.slice(0, 8) ?? null))}`,
      };
    },
  );

  // An old trace from a "previous launch", past its age bound: the next boot sweeps it.
  await fs.writeFile(
    join(tracesRoot, `${STALE_ID}.json`),
    JSON.stringify({
      version: 1,
      traceId: STALE_ID,
      sessionId,
      tabId: "long-gone",
      startedAt: 1,
      updatedAt: 1,
      droppedSteps: 0,
      steps: [
        {
          seq: 0,
          action: "open",
          target: null,
          url: "https://example.com/",
          title: null,
          generation: 1,
          at: 1,
          outcome: "ok",
          rule: null,
          error: null,
          pictureId: STALE_FRAME,
        },
      ],
    }),
  );
  await fs.writeFile(join(tracesRoot, "frames", `${STALE_FRAME}.jpg`), "stale");
  await fs.writeFile(
    join(tracesRoot, "frames", `${STALE_FRAME}.json`),
    JSON.stringify({
      id: STALE_FRAME,
      tabId: "long-gone",
      generation: 1,
      capturedAt: 1,
      ownerSessionId: sessionId,
      mime: "image/jpeg",
    }),
  );

  await closeAppBounded(app);
  app = null;
  page = await boot();
  await waitUntil("Home tab strip after relaunch", async () =>
    (await tabStrip(page, HOME_TAB_STRIP).count()) === 1 ? true : null,
  );

  await must(
    4,
    "after a relaunch the trace and its frames answer from disk, and the stale trace is swept",
    async () => {
      const result = await tracesOf(page, sessionId);
      const after = result.ok ? result.traces : [];
      const ids = after
        .flatMap((trace) => trace.steps)
        .flatMap((step) => (step.pictureId ? [step.pictureId] : []));
      const frames = await page.evaluate(
        async (pictureIds) =>
          Promise.all(
            pictureIds.map(async (pictureId) => {
              const answer = await window.api.browser.picture({ pictureId });
              return answer.ok && answer.dataUrl !== null ? answer.dataUrl.length : 0;
            }),
          ),
        ids,
      );
      const onDisk = await fs.readdir(tracesRoot);
      const framesOnDisk = await fs.readdir(join(tracesRoot, "frames"));
      return {
        ok:
          canonical(after) === canonical(recorded) &&
          frames.length > 0 &&
          frames.every((length) => length > 1_000) &&
          !onDisk.includes(`${STALE_ID}.json`) &&
          !framesOnDisk.includes(`${STALE_FRAME}.jpg`),
        detail: `traces=${after.length} frames=${JSON.stringify(frames)} stale swept=${!onDisk.includes(`${STALE_ID}.json`)}`,
      };
    },
  );

  await must(
    5,
    "the replay after the relaunch steps back into the frames recorded before it",
    async () => {
      // The chat comes back with the Home strip; its island needs a live tab to
      // list, so the Session takes one more step — a new tab, a new trace.
      const chatTab = tabStrip(page, HOME_TAB_STRIP).getByRole("tab").last();
      await chatTab.click();
      const tabId = await openAfterRelaunch(app, {
        origin: fixture.origin,
        projectId: PROJECT.id,
        sessionId,
      });
      await openReplayFromIsland(page, tabId);
      const opened = await replayPosition(page).textContent();
      const before = shownFrames(recorded[0].steps);
      const after = await tracesOf(page, sessionId);
      const latest = after.ok ? (after.traces.at(-1)?.steps[0]?.pictureId ?? null) : null;
      const walked = await walkReplay(page, [...before, latest]);
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowRight");
      await replay(page).screenshot({ path: join(evidence, "replay-after-relaunch.png") });
      const replayed = walked.slice(0, before.length).map((one) => one.frame?.id ?? null);
      return {
        ok:
          opened === "Step 9 of 9" &&
          walked[0].caption === "Opened" &&
          JSON.stringify(replayed) === JSON.stringify(before) &&
          replayed.some((id) => id !== null),
        detail: `opened="${opened}" frames before relaunch replayed=${JSON.stringify(replayed.map((id) => id?.slice(0, 8) ?? null))}`,
      };
    },
  );

  await attempt(6, "no renderer errors while replaying", async () => ({
    ok: pageErrors.length === 0,
    detail: pageErrors.join(" | "),
  }));
  code = summarize();
}

try {
  await main();
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  if (app !== null) await closeAppBounded(app).catch(() => undefined);
  await fixture.close();
  await cleanup();
  process.exit(code);
}
