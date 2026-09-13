/**
 * Stress smoke for the full eight-tool Browser port (VC-351), against the BUILT
 * app through the production port — the SAME `desktopBrowserPort` the Pi
 * adapter builds, via main's `VOLLI_BROWSER_PROBE` smoke seam (the one
 * `browser-tab-smoke.mjs` uses), plus the `VOLLI_SMOKE_BROWSER_HOST` door for
 * presentation and registry facts a port cannot see.
 *
 * All eight tools are exercised over one run: tabs · navigate (url / back /
 * forward / reload, tabId-less birth of a held headless tab) · snapshot ·
 * act (click / hover / type / press / select / scroll / wait) · screenshot ·
 * console · acquire · release — plus the stress around them: multiple tabs,
 * never-shown headless tabs, shown-then-hidden-again presentation swings,
 * a minimized and an OS-hidden app window, Chromium history, a failed load and
 * recovery from it, stale refs after a navigation, hold contention between two
 * Sessions, cancellation by AbortSignal, an externally detached debugger and a
 * DevTools-owned debugger with recovery, concurrent tool calls, and turn-end /
 * dispose teardown of every headless tab.
 *
 * Every scenario is independently reported: one failure does not abort the
 * matrix. Only the app launch, the port construction, and the first tab are
 * `must()` — nothing after them can mean anything.
 *
 * No external network (the fixture is a loopback server this process owns), no
 * real profile, no provider or model call, no default browser.
 *
 * MANUALLY-RUN smoke (needs a display + the built app); NOT wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/browser-tools-stress.mjs
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
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

// ---- isolated scratch and bounded failure evidence -------------------------

const scratchRun = await makeScratch("volli-browser-tools-stress-");
const { scratch, userDataDir, dbPath } = scratchRun;
const scratchHome = join(scratch, "home");
await fs.mkdir(scratchHome, { recursive: true });
let failureEvidence = null;

// ---- fixture ---------------------------------------------------------------

/**
 * Loopback-only fixture. The pages are plain, deliberately small DOMs with one
 * observable per act kind, so each tool's effect is provable from the port's
 * own answers (snapshot text, page title, console record) and never from
 * evaluating anything inside the remote page.
 */
async function startFixtureServer() {
  const hits = new Map();
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/dead") {
      request.socket.destroy();
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");

    if (path === "/favicon.ico") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (path === "/console") {
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Stress Console</title></head>
<body><h1>Console fixture</h1><script>
  console.log("stress-console-log-marker");
  console.warn("stress-console-warn-marker");
  console.error("stress-console-error-marker");
</script></body></html>`);
      return;
    }

    if (path === "/hist-a" || path === "/hist-b" || path === "/second") {
      const title = `Stress ${path.slice(1)}`;
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1></body></html>`);
      return;
    }

    // The everything-page: one honest observable per act kind.
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Stress Start</title></head>
<body>
  <h1>Stress Start</h1>
  <p id="count">Count: 0</p>
  <button id="inc">Increment</button>
  <button id="hov">Hover target</button>
  <form id="f">
    <input id="note" name="note" aria-label="Note" />
    <button type="submit">Submit note</button>
  </form>
  <select id="opt" aria-label="Choose">
    <option value="">Choose…</option>
    <option value="beta">beta</option>
  </select>
  <a id="to-second" href="/second">Second page</a>
  <div style="height: 4000px" aria-hidden="true"></div>
  <script>
    let count = 0;
    document.getElementById("inc").addEventListener("click", () => {
      count += 1;
      document.getElementById("count").textContent = "Count: " + count;
      console.log("stress-clicked-" + count);
    });
    document.getElementById("hov").addEventListener("mouseenter", () => {
      document.title = "Stress Hovered";
    });
    document.getElementById("f").addEventListener("submit", (event) => {
      event.preventDefault();
      document.title = "Stress Typed:" + document.getElementById("note").value;
    });
    document.getElementById("opt").addEventListener("change", (event) => {
      document.title = "Stress Selected:" + event.target.value;
    });
    let scrolled = false;
    window.addEventListener("scroll", () => {
      if (scrolled) return;
      scrolled = true;
      console.log("stress-scroll-marker");
    });
    console.log("stress-console-page-marker");
  </script>
</body></html>`);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind an IPv4 loopback port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    hits: (path) => hits.get(path) ?? 0,
    stop: ({ force = false } = {}) =>
      new Promise((resolve) => {
        if (force) server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const fixture = await startFixtureServer();
const START_URL = `${fixture.origin}/start`;
const SECOND_URL = `${fixture.origin}/second`;
const CONSOLE_URL = `${fixture.origin}/console`;
const HIST_A_URL = `${fixture.origin}/hist-a`;
const HIST_B_URL = `${fixture.origin}/hist-b`;
const DEAD_URL = `${fixture.origin}/dead`; // owned server drops the connection

// ---- port-side helpers -----------------------------------------------------

const PROJECT = { id: "browser-tools-stress-project", name: "Browser Tools Stress", prefix: "BS" };

/**
 * Build one production port in an invented Session's name, through main's
 * probe seam — the same factory the adapter calls.
 */
async function makePort(app, which) {
  return app.evaluate(
    (_electron, input) => {
      const probe = globalThis.volliBrowserProbe;
      if (probe === undefined) throw new Error("VOLLI_BROWSER_PROBE door is not open");
      globalThis.volliStressPorts ??= {};
      globalThis.volliStressPorts[input.which] = probe.port(
        { projectId: input.projectId, ticketId: null },
        input.which,
      );
      return input.which;
    },
    { which, projectId: PROJECT.id },
  );
}
const callPort = (app, portName, request) =>
  app.evaluate(
    async (_electron, { which, call }) => {
      const port = globalThis.volliStressPorts?.[which];
      if (port === undefined) throw new Error(`stress port ${which} does not exist`);
      const signal = new AbortController().signal;
      try {
        return { ok: true, value: await port[call.tool]({ ...call.input, signal }) };
      } catch (error) {
        return { ok: false, rule: error?.rule ?? null, message: String(error?.message ?? error) };
      }
    },
    { which: portName, call: request },
  );

/** The host's registry view, through the smoke door. */
const hostList = (app) =>
  app.evaluate(
    (_electron, projectId) =>
      globalThis.volliBrowserHost.list({ projectId }).map((tab) => ({
        tabId: tab.tabId,
        url: tab.url,
        title: tab.title,
        presentation: tab.presentation,
        error: tab.error ?? null,
        generation: tab.generation,
      })),
    PROJECT.id,
  );
/** Call one host method positionally: hostCall(app, "setPresentation", [tabId, "preview"]). */
const hostCall = (app, method, methodArgs = []) =>
  app.evaluate(
    async (_electron, { tool, args }) => {
      const host = globalThis.volliBrowserHost;
      if (host === undefined) throw new Error("VOLLI_SMOKE_BROWSER_HOST door is not open");
      const fn = host[tool];
      if (typeof fn !== "function") throw new Error(`host has no ${tool}`);
      return { tool, value: await fn.apply(host, args) };
    },
    { tool: method, args: methodArgs },
  );

/** The URLs of every remote WebContentsView the app window currently holds. */
async function attachedViews(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed());
    return (
      window?.contentView.children.flatMap((view) =>
        "webContents" in view && !view.webContents.isDestroyed() ? [view.webContents.getURL()] : [],
      ) ?? []
    );
  });
}

/** Fetch the port's tab list in raw form (throws on refusal). */
const rawTabs = (app, which) => callPort(app, which, { tool: "tabs", input: {} });

const findTab = async (app, which, url) => {
  const listing = await rawTabs(app, which);
  if (!listing.ok) throw new Error(`tabs refused: ${listing.message}`);
  return listing.value.tabs.find((tab) => tab.url === url) ?? null;
};

/** One snapshot, plus the ref named `accessibleName`, from the current generation. */
async function snapWithRef(app, which, tabId, accessibleName) {
  const snap = await callPort(app, which, { tool: "snapshot", input: { tabId } });
  if (!snap.ok) throw new Error(`snapshot refused: ${snap.message}`);
  // Snapshot lines print as `- role "name" [ref=eN]` — the name precedes its ref.
  const ref =
    new RegExp(`^[\\s\\-]*[^\\n]*${accessibleName}[^\\n]*\\[ref=(e\\d+)\\]`, "m").exec(
      snap.value.snapshotText,
    )?.[1] ?? null;
  return { ...snap.value, ref };
}

/** Poll until the tab's reported title contains `text` (title changes propagate async). */
const waitForTitle = (app, which, tabId, text, timeout = 15000) =>
  waitUntil(
    `title to contain ${JSON.stringify(text)}`,
    async () => {
      const snap = await callPort(app, which, { tool: "snapshot", input: { tabId } });
      return snap.ok && snap.value.title.includes(text) ? snap.value.title : null;
    },
    { timeout, interval: 250 },
  );

const okUrl = (r, url) => r.ok && r.value.url === url && r.value.snapshotText.length > 0;
const { must, attempt, summarize } = createRunner();

// A hard watchdog: an ill-behaved tool must cost the run its own budget, not
// the whole harness. Generous, because several scenarios legitimately wait on
// load bounds; it exists to catch a hang, not to time the matrix.
const WATCHDOG_MS = 12 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`\nSTRESS SMOKE WATCHDOG: ${WATCHDOG_MS / 1000}s elapsed; aborting.`);
  void keepAndExit();
}, WATCHDOG_MS);
watchdog.unref();

let app = null;
let code = 1;
let tabA = null; // the everything-page tab: shown/hidden, acted on
let tabB = null; // the never-shown headless tab
let tabC = null; // the history tab
let interrupted = false;

async function saveFailureEvidence(reason) {
  if (failureEvidence !== null) return failureEvidence;
  failureEvidence = await evidenceDir("browser-tools-stress");
  await fs.mkdir(failureEvidence, { recursive: true });
  await fs.writeFile(join(failureEvidence, "failure.txt"), `${reason}\n`);
  if (app !== null) {
    await (
      await app.firstWindow()
    )
      .screenshot({ path: join(failureEvidence, "failure.png") })
      .catch(() => undefined);
  }
  console.error(`evidence kept at: ${failureEvidence}`);
  return failureEvidence;
}

async function keepAndExit() {
  if (interrupted) return;
  interrupted = true;
  clearTimeout(watchdog);
  console.error("\nSTRESS SMOKE INTERRUPTED");
  try {
    await saveFailureEvidence("Browser tools stress smoke interrupted");
    if (app !== null) await closeAppBounded(app);
  } finally {
    await fixture.stop({ force: true });
    await scratchRun.cleanup();
    process.exit(1);
  }
}
process.once("SIGINT", () => void keepAndExit());
process.once("SIGTERM", () => void keepAndExit());

async function main() {
  const projectPath = await makeGitRepo(scratch, "stress-project-");
  app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      HOME: scratchHome,
      VOLLI_BROWSER_PROBE: "1",
      VOLLI_SMOKE_BROWSER_HOST: "1",
    },
  });
  await assertProfileIsolated(app, userDataDir);

  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);

  await must("0", "stress ports built through the production seam", async () => {
    const a = await makePort(app, "stress-alpha");
    const b = await makePort(app, "stress-beta");
    return { ok: a === "stress-alpha" && b === "stress-beta", detail: `ports=${a},${b}` };
  });

  // ---- 1. tabs ----
  await attempt("1", "tabs(): empty listing before any tab exists", async () => {
    const listing = await rawTabs(app, "stress-alpha");
    return {
      ok: listing.ok && listing.value.tabs.length === 0,
      detail: JSON.stringify(listing),
    };
  });

  // ---- 2. navigate, tabId-less: a headless tab is born, owned and held ----
  await attempt(
    "2",
    "navigate(url, no tabId) opens a headless tab owned and held by the Session",
    async () => {
      const nav = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { navigation: { kind: "url", url: START_URL } },
      });
      const tabs = await rawTabs(app, "stress-alpha");
      const host = await hostList(app);
      const mine = tabs.ok ? tabs.value.tabs.find((t) => t.url === START_URL) : null;
      const attached = await attachedViews(app);
      tabA = mine?.tabId ?? null;
      return {
        ok:
          nav.ok &&
          mine !== null &&
          mine.createdBy === "session" &&
          mine.ownerSessionId === "stress-alpha" &&
          mine.heldBy?.kind === "session" &&
          mine.heldBy?.self === true &&
          host.some((t) => t.tabId === tabA && t.presentation === "headless") &&
          !attached.includes(START_URL),
        detail: `nav=${JSON.stringify(nav)} mine=${JSON.stringify(mine)} host=${JSON.stringify(host.map((t) => t.presentation))} attached=${attached.length}`,
      };
    },
  );
  if (tabA === null) {
    summarize();
    throw new Error("no tab A; every later scenario needs it");
  }

  // ---- 3. second tab, never shown at all ----
  await attempt(
    "3",
    "a second headless tab opens and is never shown: no native view ever attaches",
    async () => {
      const nav = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { navigation: { kind: "url", url: CONSOLE_URL } },
      });
      const mine = await findTab(app, "stress-alpha", CONSOLE_URL);
      tabB = mine?.tabId ?? null;
      const attached = await attachedViews(app);
      const host = await hostList(app);
      const bothHeadless =
        host.filter((t) => [START_URL, CONSOLE_URL].includes(t.url)).length === 2 &&
        host.every((t) => t.presentation === "headless");
      return {
        ok: nav.ok && tabB !== null && bothHeadless && attached.length === 0,
        detail: `tabB=${tabB} attached=${JSON.stringify(attached)}`,
      };
    },
  );

  // ---- 4. snapshot ----
  await attempt(
    "4",
    "snapshot() of a never-shown headless tab returns refs, a title and a generation",
    async () => {
      const snap = await callPort(app, "stress-alpha", {
        tool: "snapshot",
        input: { tabId: tabA },
      });
      const text = snap.ok ? snap.value.snapshotText : "";
      return {
        ok:
          snap.ok &&
          snap.value.title === "Stress Start" &&
          snap.value.url === START_URL &&
          typeof snap.value.generation === "number" &&
          snap.value.generation >= 1 &&
          /\[ref=e\d+\]/.test(text) &&
          text.includes("Increment") &&
          snap.value.truncated === false,
        detail: `title=${snap.value?.title} gen=${snap.value?.generation} refs=${/\[ref=e\d+\]/.test(text)} len=${text.length}`,
      };
    },
  );

  // ---- 5. act: click ----
  await attempt("5", "act(click) increments the fixture counter and names its target", async () => {
    const before = await snapWithRef(app, "stress-alpha", tabA, "Increment");
    if (before.ref === null) throw new Error("no ref for the Increment button");
    const acted = await callPort(app, "stress-alpha", {
      tool: "act",
      input: { tabId: tabA, generation: before.generation, kind: "click", ref: before.ref },
    });
    const counter = await waitUntil("the counter to read Count: 1", async () => {
      const snap = await callPort(app, "stress-alpha", {
        tool: "snapshot",
        input: { tabId: tabA },
      });
      return snap.ok && snap.value.snapshotText.includes("Count: 1") ? true : null;
    }).catch(() => null);
    return {
      ok: acted.ok && acted.value.target?.name === "Increment" && counter === true,
      detail: `target=${JSON.stringify(acted.value?.target)} counter=${counter} rule=${acted.rule ?? "-"}`,
    };
  });

  // ---- 6. act: type + press ----
  await attempt(
    "6",
    "act(type) then act(press Enter) submits the form: title carries the typed text",
    async () => {
      const field = await snapWithRef(app, "stress-alpha", tabA, "Note");
      if (field.ref === null) throw new Error("no ref for the Note field");
      const typed = await callPort(app, "stress-alpha", {
        tool: "act",
        input: {
          tabId: tabA,
          generation: field.generation,
          kind: "type",
          ref: field.ref,
          text: "stressed",
        },
      });
      const pressed = await callPort(app, "stress-alpha", {
        tool: "act",
        input: { tabId: tabA, generation: field.generation, kind: "press", key: "Enter" },
      });
      const title = await waitForTitle(app, "stress-alpha", tabA, "Stress Typed:stressed").catch(
        () => null,
      );
      return {
        ok: typed.ok && pressed.ok && title !== null,
        detail: `typed=${typed.ok} pressed=${pressed.ok} title=${JSON.stringify(title)} err=${typed.message ?? pressed.message ?? "-"}`,
      };
    },
  );

  // ---- 7. act: select ----
  await attempt(
    "7",
    "act(select) chooses the option and the page reports it in its title",
    async () => {
      const box = await snapWithRef(app, "stress-alpha", tabA, "Choose");
      if (box.ref === null) throw new Error("no ref for the select");
      const acted = await callPort(app, "stress-alpha", {
        tool: "act",
        input: {
          tabId: tabA,
          generation: box.generation,
          kind: "select",
          ref: box.ref,
          text: "beta",
        },
      });
      const title = await waitForTitle(app, "stress-alpha", tabA, "Stress Selected:beta").catch(
        () => null,
      );
      return {
        ok: acted.ok && title !== null,
        detail: `ok=${acted.ok} title=${JSON.stringify(title)} err=${acted.message ?? "-"}`,
      };
    },
  );

  // ---- 8. act: hover ----
  await attempt("8", "act(hover) fires the fixture's mouseenter", async () => {
    const target = await snapWithRef(app, "stress-alpha", tabA, "Hover target");
    if (target.ref === null) throw new Error("no ref for the hover target");
    const acted = await callPort(app, "stress-alpha", {
      tool: "act",
      input: { tabId: tabA, generation: target.generation, kind: "hover", ref: target.ref },
    });
    const title = await waitForTitle(app, "stress-alpha", tabA, "Stress Hovered").catch(() => null);
    return {
      ok: acted.ok && title !== null,
      detail: `ok=${acted.ok} title=${JSON.stringify(title)}`,
    };
  });

  // ---- 9. act: scroll ----
  await attempt("9", "act(scroll down) scrolls the tall fixture, which logs once", async () => {
    const acted = await callPort(app, "stress-alpha", {
      tool: "act",
      input: { tabId: tabA, generation: 0, kind: "scroll", direction: "down" },
    });
    // generation is unknown-and-irrelevant for scroll (no ref); if the port
    // refuses on a stale generation, take a fresh snapshot and retry once.
    let result = acted;
    if (!acted.ok && acted.rule === "browser.stale-ref") {
      const snap = await callPort(app, "stress-alpha", {
        tool: "snapshot",
        input: { tabId: tabA },
      });
      result = await callPort(app, "stress-alpha", {
        tool: "act",
        input: {
          tabId: tabA,
          generation: snap.value?.generation,
          kind: "scroll",
          direction: "down",
        },
      });
    }
    const recorded = await callPort(app, "stress-alpha", {
      tool: "console",
      input: { tabId: tabA },
    });
    const sawScroll = recorded.ok
      ? recorded.value.messages.some((m) => m.text?.includes("stress-scroll-marker"))
      : false;
    return {
      ok: result.ok && sawScroll,
      detail: `ok=${result.ok} sawScroll=${sawScroll} err=${result.message ?? "-"}`,
    };
  });

  // ---- 10. act: wait ----
  await attempt("10", "act(wait) resolves within its waitMs and answers a snapshot", async () => {
    const snap = await callPort(app, "stress-alpha", { tool: "snapshot", input: { tabId: tabA } });
    const started = Date.now();
    const acted = await callPort(app, "stress-alpha", {
      tool: "act",
      input: { tabId: tabA, generation: snap.value.generation, kind: "wait", waitMs: 400 },
    });
    return {
      ok: acted.ok && Date.now() - started >= 300 && acted.value.snapshotText.length > 0,
      detail: `ok=${acted.ok} elapsed≈${Date.now() - started}ms`,
    };
  });

  // ---- 11. console ----
  await attempt(
    "11",
    "console() of the console fixture returns its log/warn/error markers",
    async () => {
      const stranger = await callPort(app, "stress-beta", {
        tool: "console",
        input: { tabId: tabB },
      });
      const record = await callPort(app, "stress-alpha", {
        tool: "console",
        input: { tabId: tabB },
      });
      const texts = record.ok ? record.value.messages.map((m) => m.text ?? "").join("\n") : "";
      return {
        ok:
          stranger.rule === "browser.unknown-tab" &&
          record.ok &&
          texts.includes("stress-console-log-marker") &&
          texts.includes("stress-console-warn-marker") &&
          texts.includes("stress-console-error-marker") &&
          record.value.truncated === false,
        detail: `ok=${record.ok} truncated=${record.value?.truncated} markers=${["log", "warn", "error"].map((k) => texts.includes(`stress-console-${k}-marker`)).join(",")}`,
      };
    },
  );

  // ---- 12. screenshot ----
  await attempt(
    "12",
    "screenshot() returns real PNG bytes and the host keeps the picture",
    async () => {
      const shot = await callPort(app, "stress-alpha", {
        tool: "screenshot",
        input: { tabId: tabA },
      });
      const value = shot.value;
      const bytes = value?.base64Png ? Buffer.from(value.base64Png, "base64") : Buffer.alloc(0);
      const isPng =
        bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG";
      let kept = null;
      if (shot.ok && value.picture) {
        kept = await hostCall(app, "pictureOf", [value.picture]);
      }
      return {
        ok: shot.ok && isPng && kept !== null && kept.value !== null,
        detail: `ok=${shot.ok} bytes=${bytes.length} png=${isPng} picture=${value?.picture ?? "-"} kept=${kept?.value !== null && kept?.value !== undefined}`,
      };
    },
  );

  // ---- 13. history: back / forward / reload (on a tab with clean history) ----
  await attempt(
    "13",
    "navigate(back/forward/reload) walks Chromium history on the tab",
    async () => {
      const open = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { navigation: { kind: "url", url: HIST_A_URL } },
      });
      tabC = open.value?.tabId ?? null;
      const b = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { tabId: tabC, navigation: { kind: "url", url: HIST_B_URL } },
      });
      const back = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { tabId: tabC, navigation: { kind: "back" } },
      });
      const forward = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { tabId: tabC, navigation: { kind: "forward" } },
      });
      const beforeReload = fixture.hits("/hist-b");
      const reload = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { tabId: tabC, navigation: { kind: "reload" } },
      });
      return {
        ok:
          tabC !== null &&
          okUrl(b, HIST_B_URL) &&
          okUrl(back, HIST_A_URL) &&
          okUrl(forward, HIST_B_URL) &&
          okUrl(reload, HIST_B_URL) &&
          fixture.hits("/hist-b") > beforeReload,
        detail: `tabC=${tabC} urls=[${[b.value?.url, back.value?.url, forward.value?.url, reload.value?.url].join(" | ")}] histBhits=${fixture.hits("/hist-b")}`,
      };
    },
  );

  // ---- 14. failed load and recovery ----
  await attempt(
    "14",
    "a dead-port navigation fails the tab without killing it, and a good navigation recovers",
    async () => {
      const dead = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { tabId: tabA, navigation: { kind: "url", url: DEAD_URL } },
      });
      const errored = await waitUntil(
        "the tab to report a load error",
        async () => {
          const host = await hostList(app);
          const mine = host.find((t) => t.tabId === tabA);
          return mine !== undefined && mine.error !== null && mine.error !== undefined
            ? mine.error
            : null;
        },
        { timeout: 20000 },
      ).catch(() => null);
      const recovered = await callPort(app, "stress-alpha", {
        tool: "navigate",
        input: { tabId: tabA, navigation: { kind: "url", url: SECOND_URL } },
      });
      const cleared = await waitUntil(
        "the error to clear after recovery",
        async () => {
          const host = await hostList(app);
          const mine = host.find((t) => t.tabId === tabA);
          return mine?.url === SECOND_URL && (mine.error === null || mine.error === undefined)
            ? true
            : null;
        },
        { timeout: 20000 },
      ).catch(() => null);
      const snap = await callPort(app, "stress-alpha", {
        tool: "snapshot",
        input: { tabId: tabA },
      });
      return {
        ok: errored !== null && recovered.ok && cleared === true && snap.ok,
        detail: `dead=${dead.ok ? "resolved" : dead.rule} error=${JSON.stringify(errored)} recovered=${recovered.ok} cleared=${cleared}`,
      };
    },
  );

  // ---- 15. stale refs ----
  await attempt("15", "a ref from before a navigation refuses as browser.stale-ref", async () => {
    await callPort(app, "stress-alpha", {
      tool: "navigate",
      input: { tabId: tabA, navigation: { kind: "url", url: START_URL } },
    });
    const stale = await snapWithRef(app, "stress-alpha", tabA, "Increment");
    if (stale.ref === null) throw new Error("no ref captured before the navigation");
    await callPort(app, "stress-alpha", {
      tool: "navigate",
      input: { tabId: tabA, navigation: { kind: "reload" } },
    });
    const refused = await callPort(app, "stress-alpha", {
      tool: "act",
      input: { tabId: tabA, generation: stale.generation, kind: "click", ref: stale.ref },
    });
    // And a fresh snapshot makes the same button actionable again.
    const fresh = await snapWithRef(app, "stress-alpha", tabA, "Increment");
    const retry = await callPort(app, "stress-alpha", {
      tool: "act",
      input: { tabId: tabA, generation: fresh.generation, kind: "click", ref: fresh.ref },
    });
    return {
      ok: refused.rule === "browser.stale-ref" && retry.ok === true,
      detail: `refused=${refused.rule} retried=${retry.ok}`,
    };
  });

  // ---- 16. holds on a person's tab, visible to both Sessions ----
  await attempt(
    "16",
    "acquire holds; a second Session's act and acquire are refused naming the holder; release frees",
    async () => {
      const personal = await hostCall(app, "open", [
        { url: START_URL, projectId: PROJECT.id, ticketId: null, createdBy: "user" },
      ]);
      const tabId = personal.value.tabId;
      try {
        const acquired = await callPort(app, "stress-alpha", { tool: "acquire", input: { tabId } });
        const betaAct = await callPort(app, "stress-beta", {
          tool: "act",
          input: { tabId, generation: 1, kind: "scroll", direction: "down" },
        });
        const betaAcquire = await callPort(app, "stress-beta", {
          tool: "acquire",
          input: { tabId },
        });
        const released = await callPort(app, "stress-alpha", { tool: "release", input: { tabId } });
        const betaNow = await callPort(app, "stress-beta", { tool: "acquire", input: { tabId } });
        return {
          ok:
            acquired.value?.kind === "held" &&
            betaAct.rule === "browser.tab-held" &&
            betaAcquire.value?.kind === "refused" &&
            betaAcquire.value?.holder?.kind === "session" &&
            betaAcquire.value?.holder?.self === false &&
            released.ok &&
            betaNow.value?.kind === "held",
          detail: `acquired=${JSON.stringify(acquired)} betaAct=${betaAct.rule} betaAcquire=${JSON.stringify(betaAcquire)} betaNow=${JSON.stringify(betaNow)}`,
        };
      } finally {
        await hostCall(app, "close", [tabId]);
      }
    },
  );

  // ---- 17. shown → hidden again; tools work in both states ----
  await attempt(
    "17",
    "presentation swing: shown tab attaches a native view, tools keep working, hide detaches again",
    async () => {
      await hostCall(app, "setPresentation", [tabA, "preview"]);
      await hostCall(app, "show", [tabA]);
      const shown = await waitUntil("the shown tab to attach", async () =>
        (await attachedViews(app)).includes(START_URL) ? true : null,
      ).catch(() => null);
      const snapShown = await callPort(app, "stress-alpha", {
        tool: "snapshot",
        input: { tabId: tabA },
      });
      const shotShown = await callPort(app, "stress-alpha", {
        tool: "screenshot",
        input: { tabId: tabA },
      });
      await hostCall(app, "setPresentation", [tabA, "headless"]);
      const hidden = await waitUntil("the hidden tab to detach", async () =>
        (await attachedViews(app)).includes(START_URL) ? null : true,
      ).catch(() => null);
      const snapHidden = await callPort(app, "stress-alpha", {
        tool: "snapshot",
        input: { tabId: tabA },
      });
      const host = await hostList(app);
      return {
        ok:
          shown === true &&
          snapShown.ok &&
          shotShown.ok &&
          hidden === true &&
          snapHidden.ok &&
          host.find((t) => t.tabId === tabA)?.presentation === "headless",
        detail: `shown=${shown} snapShown=${snapShown.ok} shotShown=${shotShown.ok} hidden=${hidden} snapHidden=${snapHidden.ok}`,
      };
    },
  );

  // ---- 18. minimized / OS-hidden window ----
  await attempt(
    "18",
    "with the app window minimized and then OS-hidden, port tools keep answering",
    async () => {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => !w.isDestroyed())
          ?.minimize();
      });
      const whileMinimized = await Promise.allSettled([
        callPort(app, "stress-alpha", { tool: "snapshot", input: { tabId: tabA } }),
        callPort(app, "stress-alpha", { tool: "screenshot", input: { tabId: tabA } }),
        callPort(app, "stress-alpha", { tool: "tabs", input: {} }),
      ]);
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed());
        w?.restore();
        w?.hide();
      });
      const whileHidden = await callPort(app, "stress-alpha", {
        tool: "console",
        input: { tabId: tabA },
      });
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => !w.isDestroyed())
          ?.show();
      });
      const allOk = whileMinimized.every((r) => r.status === "fulfilled" && r.value?.ok === true);
      return {
        ok: allOk && whileHidden.ok === true,
        detail: `minimized=[${whileMinimized.map((r) => (r.status === "fulfilled" ? String(r.value?.ok) : "threw")).join(",")}] hiddenConsole=${whileHidden.ok}`,
      };
    },
  );

  // ---- 19. cancellation ----
  await attempt(
    "19",
    "an aborted signal cancels a call cleanly and the port keeps working",
    async () => {
      const aborted = await app.evaluate(
        async (_electron, { tabId }) => {
          const port = globalThis.volliStressPorts["stress-alpha"];
          const controller = new AbortController();
          controller.abort();
          try {
            await port.snapshot({ tabId, signal: controller.signal });
            return { rejected: false };
          } catch (error) {
            return { rejected: true, message: String(error?.message ?? error) };
          }
        },
        { tabId: tabA },
      );
      const after = await callPort(app, "stress-alpha", { tool: "tabs", input: {} });
      return {
        ok: aborted.rejected === true && after.ok === true,
        detail: `aborted=${JSON.stringify(aborted)} after=${after.ok}`,
      };
    },
  );

  // ---- 20. debugger detach and recovery ----
  await attempt(
    "20",
    "an externally detached debugger is re-attached on the next call",
    async () => {
      const detached = await app.evaluate(({ webContents }, url) => {
        const contents = webContents
          .getAllWebContents()
          .find((c) => !c.isDestroyed() && c.getURL() === url);
        if (contents === undefined) return "no-contents";
        if (!contents.debugger.isAttached()) return "was-not-attached";
        contents.debugger.detach();
        return "detached";
      }, START_URL);
      const snap = await callPort(app, "stress-alpha", {
        tool: "snapshot",
        input: { tabId: tabA },
      });
      return {
        ok:
          detached === "detached" &&
          snap.ok === true &&
          /\[ref=e\d+\]/.test(snap.value?.snapshotText ?? ""),
        detail: `detach=${detached} snap=${snap.ok}`,
      };
    },
  );

  await attempt(
    "21",
    "DevTools coexists or refuses control clearly; closing it leaves control working",
    async () => {
      await hostCall(app, "toggleDevTools", [tabA]);
      const openState = await waitUntil("DevTools to attach", async () => {
        const attached = await app.evaluate(
          ({ webContents }) =>
            webContents
              .getAllWebContents()
              .some((c) => !c.isDestroyed() && c.getURL().startsWith("devtools://")),
          START_URL,
        );
        return attached ? true : null;
      }).catch(() => null);
      const refused = await callPort(app, "stress-alpha", {
        tool: "snapshot",
        input: { tabId: tabA },
      });
      await hostCall(app, "toggleDevTools", [tabA]);
      const recovered = await waitUntil("the snapshot to recover", async () => {
        const snap = await callPort(app, "stress-alpha", {
          tool: "snapshot",
          input: { tabId: tabA },
        });
        return snap.ok && /\[ref=e\d+\]/.test(snap.value.snapshotText) ? true : null;
      }).catch(() => null);
      return {
        ok:
          openState === true &&
          (refused.ok || refused.rule === "browser.debugger-unavailable") &&
          recovered === true,
        detail: `devtoolsAttached=${openState} refused=${refused.rule} recovered=${recovered}`,
      };
    },
  );

  // ---- 22. concurrency ----
  await attempt("22", "concurrent tool calls across two tabs all succeed", async () => {
    const results = await Promise.allSettled([
      callPort(app, "stress-alpha", { tool: "tabs", input: {} }),
      callPort(app, "stress-alpha", { tool: "snapshot", input: { tabId: tabA } }),
      callPort(app, "stress-alpha", { tool: "snapshot", input: { tabId: tabB } }),
      callPort(app, "stress-alpha", { tool: "console", input: { tabId: tabB } }),
      callPort(app, "stress-alpha", { tool: "screenshot", input: { tabId: tabB } }),
      callPort(app, "stress-beta", { tool: "tabs", input: {} }),
      callPort(app, "stress-alpha", { tool: "release", input: { tabId: tabA } }),
    ]);
    const oks = results.map((r) => (r.status === "fulfilled" ? r.value?.ok === true : false));
    return {
      ok: oks.every(Boolean),
      detail: `[${oks.map((o) => (o ? "ok" : "FAIL")).join(",")}]`,
    };
  });

  // ---- 23. turn end and dispose ----
  await attempt(
    "23",
    "turnEnded() and dispose() free holds and close every headless tab the Sessions owned",
    async () => {
      // A hold to lose: alpha re-acquires, then ends its turn.
      await callPort(app, "stress-alpha", { tool: "acquire", input: { tabId: tabA } });
      await app.evaluate(() => globalThis.volliStressPorts["stress-alpha"].turnEnded());
      const freedByTurn = await waitUntil("the hold to end with the turn", async () => {
        const held = await app.evaluate(
          (_electron, tabId) => globalThis.volliBrowserHost.heldBy(tabId),
          tabA,
        );
        return held === null ? true : null;
      }).catch(() => null);
      await app.evaluate(() => {
        globalThis.volliStressPorts["stress-alpha"].dispose();
        globalThis.volliStressPorts["stress-beta"].dispose();
        delete globalThis.volliStressPorts;
      });
      const remaining = await waitUntil(
        "every session-owned headless tab to close with its port",
        async () => ((await hostList(app)).length === 0 ? true : null),
        { timeout: 20000 },
      ).catch(() => null);
      return {
        ok: freedByTurn === true && remaining === true,
        detail: `freedByTurn=${freedByTurn} tabsRemaining=${remaining === true ? 0 : JSON.stringify(await hostList(app))} pageErrors=${JSON.stringify(pageErrors)}`,
      };
    },
  );

  return summarize();
}

try {
  code = await main();
} catch (error) {
  console.error("\nSTRESS SMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  clearTimeout(watchdog);
  if (code !== 0) await saveFailureEvidence(`Browser tools stress smoke exited ${code}`);
  if (app !== null) {
    const close = await closeAppBounded(app).catch((error) => ({ kind: "close-threw", error }));
    console.log(`  app close: ${close.kind}`);
    if (close.kind === "sigkill") code = code || 1;
  }
  await fixture.stop({ force: true }).catch(() => {});
  await scratchRun.cleanup().catch(() => {});
}
process.exit(code);
