/**
 * VC-30 — production screenshots of the Session peek, in the BUILT app.
 *
 * The peek was designed in the lab against a corpus. This probe answers the
 * only question the lab cannot: what the shipped surfaces look like when the
 * real renderer draws them over real ledger rows. It boots the built app on an
 * ISOLATED scratch profile and database, seeds the repo's demo project
 * (voltaic / VLT) with a roster of Sessions in the states the ticket names, and
 * captures:
 *
 *   left-sidebar.png        — the Active band (two-line rows, mark + vendor
 *                             logo, "VLT-14 · 2m ago" subtitles, the unread
 *                             dot) with Previous holding a ticket folder.
 *   peek-card.png           — the card, hovered open over the WAITING row.
 *   peek-pinned-question.png — the same card pinned (Answer), showing the
 *                             shipped question form.
 *   folder-peek.png         — a Previous ticket folder's ticket card.
 *   rail.png                — ticket VLT-14's right rail Sessions fold, with a
 *                             row hovered so the card opens to its left.
 *
 * SEEDING. Sessions are written straight into the scratch ledger before launch,
 * through the production writer (`createSqliteSessionLedger`): `insertSession`
 * plus `appendEvent`, every payload passing the ledger's own `assertSessionEvent`.
 * Nothing here reaches for the person's profile: the database is a fresh temp
 * file, HOME is redirected, and `assertProfileIsolated` proves it before a pixel
 * is captured.
 *
 * Capture goes through `webContents.capturePage()`, as `docs-shots.mjs` does —
 * it records the app's own web contents at the display's scale factor, so
 * nothing of the operator's desktop can land in a PNG.
 *
 * MANUALLY RUN. Needs a display and the built app; deliberately not named
 * `*-smoke.mjs`, which CI globs.
 *
 *   pnpm run build   # only if apps/desktop/dist-electron is missing
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/session-peek-shots.mjs
 *
 * Optional first argument overrides the output directory.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createServer } from "vite";

import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  REPO,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const OUT_DIR = process.argv[2] ?? join(REPO, "docs", "plans", "session-peek", "production");

/** The window the shots are composed for. */
const WINDOW = { width: 1440, height: 900 };

/** The repo's established demo project (docs/DESIGN.md). */
const PROJECT_ID = "session-peek-voltaic";
const PROJECT = { name: "voltaic", prefix: "VLT" };

/** Longer than PEEK_DWELL_MS (350 ms) plus a frame or two of content load. */
const DWELL_MS = 700;

/** Longer than PEEK_GRACE_MS (300 ms), so a parked pointer really closed the card. */
const PEEK_SETTLE_MS = 450;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const now = Date.now();

/**
 * The seeded roster. `at` is when the Session was last active, counted back
 * from launch so Active/Previous membership is decided by the product's own
 * 30-minute quiet window rather than by anything this file asserts.
 */
const TICKETS = [
  { number: 14, title: "Cache composer drafts per project", status: "doing" },
  { number: 9, title: "Full-text search over session transcripts", status: "doing" },
  // Deliberately NOT `done`: a Done ticket's Sessions leave Previous after
  // DONE_LINGER_MS (one hour), so a Done ticket with three-hour-old Sessions
  // draws no folder at all — which is the product's rule, not a bug to seed
  // around silently.
  { number: 7, title: "One git worktree per ticket, branched on kickoff", status: "needs_review" },
  { number: 3, title: "Ghostty config adapter for the terminal", status: "todo" },
];

const ANTHROPIC = {
  providerId: "anthropic",
  modelId: "claude-sonnet-4-5",
  reasoningLevel: "medium",
};
const CODEX = { providerId: "openai-codex", modelId: "gpt-5.1-codex", reasoningLevel: "medium" };

const SESSIONS = [
  {
    id: "peek-session-waiting",
    ticketNumber: 14,
    title: "Key the draft cache on project and ticket",
    model: ANTHROPIC,
    at: now - 2 * MINUTE,
    phase: "waiting",
  },
  {
    id: "peek-session-working",
    ticketNumber: 14,
    title: "Restore the draft when the composer reopens",
    model: CODEX,
    at: now - 40_000,
    phase: "working",
  },
  {
    id: "peek-session-unread",
    ticketNumber: 9,
    title: "Index transcripts with FTS5",
    model: ANTHROPIC,
    at: now - 11 * MINUTE,
    phase: "finished",
    unread: true,
  },
  {
    id: "peek-session-interrupted",
    ticketNumber: 9,
    title: "Backfill the search index on first open",
    model: CODEX,
    at: now - 19 * MINUTE,
    phase: "interrupted",
  },
  {
    id: "peek-session-old-a",
    ticketNumber: 7,
    title: "Branch the worktree on kickoff",
    model: ANTHROPIC,
    at: now - 3 * HOUR,
    phase: "finished",
  },
  {
    id: "peek-session-old-b",
    ticketNumber: 7,
    title: "Prune a worktree when its ticket is archived",
    model: CODEX,
    at: now - 4 * HOUR,
    phase: "finished",
  },
  {
    id: "peek-session-old-c",
    ticketNumber: 3,
    title: "Read the Ghostty config from the app bundle",
    model: ANTHROPIC,
    at: now - 5 * HOUR,
    phase: "finished",
  },
];

const QUESTION = {
  title: "Which cache key should the composer draft use?",
  detail:
    "Both projects are open, so a module-level slot throws the other draft away on the next switch.",
  options: [
    { id: "project-ticket", label: "Key on {projectId, ticketId}" },
    { id: "project-only", label: "Key on projectId only" },
    { id: "keep", label: "Keep the single slot" },
  ],
};

const PROVENANCE = {
  source: { kind: "adapter", id: "pi", detail: { fixture: "vc-30-shots" } },
  venue: { id: "local", kind: "local" },
};

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-session-peek-shots-");
const { attempt, check, summarize } = createRunner();

await fs.mkdir(OUT_DIR, { recursive: true });
const projectDir = await makeGitRepo(scratch, "voltaic-");
await seedRepoTree(projectDir);

const seedCounts = await seedLedger(projectDir);
check(
  0,
  "scratch ledger seeded",
  seedCounts.sessions === SESSIONS.length && seedCounts.events > 0,
  `${seedCounts.sessions} sessions, ${seedCounts.events} events, ${seedCounts.receipts} read receipt(s) → ${dbPath}`,
);

const app = await launch({ dbPath, userDataDir });
let page;

try {
  await assertProfileIsolated(app, userDataDir);
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`  renderer console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => console.error(`  renderer page error: ${String(error)}`));
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("app surface", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );

  const size = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    // Same reasoning as docs-shots: setContentSize is clamped to the work area,
    // simple fullscreen gives the display's whole content box, and capturePage
    // only ever reads the web contents.
    win.setSimpleFullScreen(true);
    win.focus();
    const [width, height] = win.getContentSize();
    return { width, height };
  });
  check(
    1,
    `window sized to ${WINDOW.width}x${WINDOW.height}`,
    size.width === WINDOW.width && size.height === WINDOW.height,
    `content size ${size.width}x${size.height}`,
  );

  // The roster is already in SQLite; what the renderer still lacks is a SELECTED
  // project, which lives in the `volli:projects` envelope. Seeding the same id
  // and path the ledger used makes boot's import a no-op and selects it.
  await seedProjects(page, [
    { id: PROJECT_ID, name: PROJECT.name, path: projectDir, prefix: PROJECT.prefix, colorIndex: 2 },
  ]);
  await waitUntil("app surface after reload", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );
  // Seeding the envelope puts the project in the rail but does not always land
  // as the SELECTED one, and the sidebar's bands are per-project. Click its
  // avatar the way a person would.
  // The switcher labels a project by its two-letter monogram ("VO"), not by
  // its name, and selection is not in localStorage — so the click is the seam.
  const monogram = PROJECT.name.slice(0, 2).toUpperCase();
  const projectButton = page.getByRole("button", { name: monogram, exact: true }).first();
  if ((await projectButton.count()) > 0) await projectButton.click().catch(() => {});
  await sleep(1200);

  await waitUntil(
    "seeded session rows",
    async () => (await page.locator('[data-peek-row][data-peek-surface="nav"]').count()) > 0,
    { timeout: 30_000 },
  ).catch(async (error) => {
    // A sidebar that drew no peekable row is itself the finding, so leave
    // evidence of what the app DID draw before giving up on it.
    const seen = await page.evaluate(async () => {
      const boot = await window.api?.data?.bootstrap?.().catch((bootError) => ({
        ok: false,
        error: String(bootError),
      }));
      const sessions = await window.api?.sessions?.list?.({}).catch(() => null);
      return {
        bodyText: document.body.innerText.slice(0, 600),
        sessionRows: document.querySelectorAll("[data-peek-row]").length,
        projects: boot?.ok === true ? boot.data.projects.map((p) => `${p.name}:${p.id}`) : boot,
        storedProjects: localStorage.getItem("volli:projects"),
        sessionList: sessions === null ? null : JSON.stringify(sessions).slice(0, 300),
        storageKeys: Object.keys(localStorage),
        buttons: [...document.querySelectorAll("button")]
          .map((node) => node.getAttribute("aria-label") ?? (node.textContent ?? "").trim())
          .filter((label) => label !== "")
          .slice(0, 30),
      };
    });
    await capture("debug-no-rows.png");
    throw new Error(`${error.message}\n  visible: ${JSON.stringify(seen)}`);
  });

  // ---- 1. the left sidebar's two bands -----------------------------------
  await attempt(2, "left-sidebar.png", async () => {
    await expandPreviousBand();
    await parkPointer();
    await sleep(600);
    const bands = await readNavRows();
    const shot = await capture("left-sidebar.png");
    return {
      ok: shot.ok && bands.rows.length >= 4,
      detail: `${shot.detail} · rows=${JSON.stringify(bands.rows)} folders=${JSON.stringify(bands.folders)}`,
    };
  });

  // ---- 2. the peek, hovered open over the WAITING row ---------------------
  const waitingRow = await navRowFor(SESSIONS[0].id);
  await attempt(3, "peek-card.png", async () => {
    if (waitingRow === null) return { ok: false, detail: "the WAITING Session drew no nav row" };
    const opened = await hoverRow("nav", waitingRow);
    if (!opened.ok) return opened;
    const shot = await capture("peek-card.png");
    return { ok: shot.ok, detail: `${shot.detail} · ${opened.detail}` };
  });

  // ---- 3. the pinned card, with the question form -------------------------
  await attempt(4, "peek-pinned-question.png", async () => {
    if (waitingRow === null) return { ok: false, detail: "the WAITING Session drew no nav row" };
    const open = await peekOpen();
    if (!open) {
      const reopened = await hoverRow("nav", waitingRow);
      if (!reopened.ok) return reopened;
    }
    // Pin the way a person does: carry the pointer across the grace bridge onto
    // the card and press its Answer button. (Space pins too, but only from a
    // row that has keyboard focus — a hover never takes focus.)
    const answer = await page.evaluate(() => {
      const card = document.querySelector("[data-peek-card]");
      const button = [...(card?.querySelectorAll("button") ?? [])].find(
        (node) => (node.textContent ?? "").trim() === "Answer",
      );
      if (button === undefined) return null;
      const box = button.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    if (answer === null) return { ok: false, detail: "the open card offered no Answer button" };
    await page.mouse.move(answer.x, answer.y, { steps: 8 });
    await page.mouse.click(answer.x, answer.y);
    await sleep(700);
    const pinned = await page.evaluate(() => {
      const card = document.querySelector("[data-peek-card]");
      if (card === null) return { present: false, role: null, options: 0, controls: [] };
      return {
        present: true,
        role: card.getAttribute("role"),
        // The shipped InteractionCard draws the question's choices.
        options: card.querySelectorAll('[role="radio"], input[type="radio"], [role="checkbox"]')
          .length,
        controls: [...card.querySelectorAll("button")].map((node) =>
          (node.textContent ?? "").trim(),
        ),
      };
    });
    const frame = await peekFrame();
    const shot = await capture("peek-pinned-question.png");
    return {
      ok: shot.ok && pinned.present && pinned.role === "dialog",
      detail: `${shot.detail} · role=${pinned.role} options=${pinned.options} controls=${JSON.stringify(pinned.controls)} frame=${JSON.stringify(frame)}`,
    };
  });

  // ---- 4. a Previous ticket folder's card ---------------------------------
  await attempt(5, "folder-peek.png", async () => {
    await page.keyboard.press("Escape");
    await parkPointer();
    await sleep(400);
    const folders = (await readNavRows()).folders;
    if (folders.length === 0) return { ok: false, detail: "no folder row in Previous" };
    const opened = await hoverRow("nav", folders[0]);
    if (!opened.ok) return opened;
    const shot = await capture("folder-peek.png");
    return { ok: shot.ok, detail: `${shot.detail} · ${opened.detail}` };
  });

  // ---- 5. the ticket rail's Sessions fold ---------------------------------
  await attempt(6, "rail.png", async () => {
    await page.keyboard.press("Escape");
    await parkPointer();
    await sleep(300);
    const openedTicket = await openHeroTicket();
    if (!openedTicket.ok) return openedTicket;
    await waitUntil(
      "rail session rows",
      async () => (await page.locator('[data-peek-row][data-peek-surface="rail"]').count()) > 0,
      { timeout: 20_000 },
    ).catch(() => {});
    const railRows = await page
      .locator('[data-peek-row][data-peek-surface="rail"]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.peekRow));
    if (railRows.length === 0) {
      return { ok: false, detail: "the rail's Sessions fold drew no peek rows" };
    }
    const opened = await hoverRow("rail", railRows[0]);
    const shot = await capture("rail.png");
    return {
      ok: shot.ok && opened.ok,
      detail: `${shot.detail} · railRows=${JSON.stringify(railRows)} · ${opened.detail}`,
    };
  });
} catch (error) {
  check("!", "session peek shots crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
  await cleanup();
}

console.log(`\nshots written to ${OUT_DIR}`);
process.exit(summarize());

// ---- capture ---------------------------------------------------------------

/** Capture the composited window (see the header) and write it to OUT_DIR. */
async function capture(name) {
  const stillOpenBefore = await peekOpen().catch(() => null);
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  const bytes = Buffer.from(base64, "base64");
  const path = join(OUT_DIR, name);
  await fs.writeFile(path, bytes);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const stillOpenAfter = await peekOpen().catch(() => null);
  return {
    ok: bytes.length > 20_000 && width >= WINDOW.width,
    detail: `${width}x${height}, ${(bytes.length / 1024).toFixed(0)} KB → ${path} · peek ${stillOpenBefore}→${stillOpenAfter}`,
  };
}

// ---- driving the surfaces --------------------------------------------------

/** Is a peek card on screen right now? */
function peekOpen() {
  return page.evaluate(() => document.querySelector("[data-peek-card]") !== null);
}

/**
 * What the card's frame actually is on screen: where it sits, whether it is
 * painted, and what role it carries. A card that is in the DOM but transparent,
 * zero-sized or off the viewport is a finding, not a shot.
 */
function peekFrame() {
  return page.evaluate(() => {
    const card = document.querySelector("[data-peek-card]");
    if (card === null) return null;
    const rect = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    return {
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      opacity: style.opacity,
      visibility: style.visibility,
      transform: style.transform,
      zIndex: style.zIndex,
      role: card.getAttribute("role"),
      text: (card.textContent ?? "").slice(0, 160),
      // What is actually painted where the card says it is, and what every
      // ancestor contributes to whether it can be seen at all: `opacity` does
      // not inherit, so a transparent ancestor leaves the card reporting 1.
      topmostAtCentre: (() => {
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (hit === null) return null;
        return {
          tag: hit.tagName,
          inCard: card.contains(hit),
          className: String(hit.className).slice(0, 80),
        };
      })(),
      // The finding this probe exists to be able to state: the nearest
      // ancestor that CLIPS, and whether the card's frame is outside it. A card
      // that is `visible`, opaque and laid out, and still paints nothing, is
      // clipped by a box it does not know about.
      // The card's frame is `position: fixed`, so a plain scrolling ancestor
      // does NOT clip it — but `clip-path` (and a transform/filter containing
      // block) does, and clips it wherever it is on screen.
      clippedBy: (() => {
        for (let node = card.parentElement; node !== null; node = node.parentElement) {
          const s = getComputedStyle(node);
          if (s.clipPath === "none" && s.filter === "none" && s.transform === "none") continue;
          const box = node.getBoundingClientRect();
          const outside = rect.left >= box.right || rect.right <= box.left;
          return {
            tag: `${node.tagName}${node.dataset.volliSidebar === undefined ? "" : "[data-volli-sidebar]"}`,
            clipPath: s.clipPath,
            overflow: s.overflow,
            box: { left: Math.round(box.left), right: Math.round(box.right) },
            cardOutsideHorizontally: outside,
          };
        }
        return null;
      })(),
      ancestors: (() => {
        const chain = [];
        for (let node = card.parentElement; node !== null; node = node.parentElement) {
          const s = getComputedStyle(node);
          if (
            s.opacity !== "1" ||
            s.visibility !== "visible" ||
            s.filter !== "none" ||
            s.zIndex !== "auto" ||
            s.isolation !== "auto" ||
            s.contentVisibility === "hidden" ||
            s.clipPath !== "none"
          ) {
            chain.push(
              `${node.tagName}.${String(node.className).slice(0, 30)}[op=${s.opacity} vis=${s.visibility} z=${s.zIndex} iso=${s.isolation} filter=${s.filter} clip=${s.clipPath}]`,
            );
          }
        }
        return chain;
      })(),
    };
  });
}

/** Park the pointer somewhere inert, so nothing is mid-hover. */
async function parkPointer() {
  await page.mouse.move(WINDOW.width - 6, WINDOW.height - 6);
  await sleep(PEEK_SETTLE_MS);
}

/**
 * Dispatch REAL pointer movement onto one row and wait past the dwell, which is
 * the only way the peek can open: the hook listens for `pointermove` on the
 * sidebar, so a synthetic `dispatchEvent` or a Playwright `hover()` that jumps
 * straight onto the element is not the gesture the product responds to. The
 * move is made in steps across the row for the same reason.
 */
async function hoverRow(surface, rowId) {
  const locator = page.locator(`[data-peek-row="${rowId}"][data-peek-surface="${surface}"]`);
  if ((await locator.count()) === 0) return { ok: false, detail: `no ${surface} row ${rowId}` };
  const box = await locator.first().boundingBox();
  if (box === null) return { ok: false, detail: `row ${rowId} has no box` };
  await page.mouse.move(box.x + box.width / 2, box.y - 24);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await sleep(DWELL_MS);
  const open = await peekOpen();
  if (!open) {
    // Give a slow content pull one more dwell before calling it a failure.
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 2, { steps: 4 });
    await sleep(DWELL_MS);
  }
  const settled = await peekOpen();
  await sleep(250);
  const frame = await peekFrame();
  return {
    ok: settled,
    detail: settled
      ? `peek open over ${rowId} · frame=${JSON.stringify(frame)}`
      : `peek did NOT open over ${rowId}`,
  };
}

/** The left sidebar's row id for one seeded Session, whatever prefix it carries. */
async function navRowFor(sessionId) {
  const { rows } = await readNavRows();
  return rows.find((id) => id.endsWith(`:${sessionId}`)) ?? null;
}

/** Every peekable row the left sidebar drew, split into Sessions and folders. */
function readNavRows() {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-peek-row][data-peek-surface="nav"]')];
    const rows = [];
    const folders = [];
    for (const node of nodes) {
      const id = node.dataset.peekRow ?? "";
      // The listing prefixes a Session row `chat:` or `session:`; a folder row
      // carries the ticket prefix instead (peek-subject.ts).
      (/^(?:chat|session):/.test(id) ? rows : folders).push(id);
    }
    return { rows, folders };
  });
}

/**
 * Open every collapsed ticket folder in Previous, so the band shows a folder
 * with its count rather than an empty heading.
 */
async function expandPreviousBand() {
  const previous = page.getByRole("button", { name: /Previous/i }).first();
  if ((await previous.count()) > 0) await previous.click().catch(() => {});
  await sleep(400);
}

/** Open VLT-14 from the board, which is where the right rail lives. */
async function openHeroTicket() {
  const card = page.locator("article").filter({ hasText: "VLT-14" }).first();
  if ((await card.count()) === 0) {
    const row = page.getByText(TICKETS[0].title, { exact: false }).first();
    if ((await row.count()) === 0) return { ok: false, detail: "VLT-14 is not on the board" };
    await row.dblclick();
  } else {
    await card.dblclick();
  }
  const opened = await waitUntil(
    "ticket workspace",
    async () =>
      (await page.getByRole("tablist", { name: "Ticket tabs", exact: true }).count()) === 1,
    { timeout: 20_000 },
  )
    .then(() => true)
    .catch(() => false);
  return { ok: opened, detail: opened ? "VLT-14 open" : "ticket workspace never mounted" };
}

// ---- seeding ---------------------------------------------------------------

/**
 * Write the project, its tickets and the Session roster into the scratch
 * database, through the production repos and the production ledger writer, so
 * every row and every event payload is one the app itself could have written.
 */
async function seedLedger(projectPath) {
  const vite = await createServer({
    root: REPO,
    appType: "custom",
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    logLevel: "error",
  });
  let db;
  try {
    const { openVolliDb } = await vite.ssrLoadModule("/apps/desktop/src/main/db/index.ts");
    const { insertProject } = await vite.ssrLoadModule(
      "/apps/desktop/src/main/db/projects-repo.ts",
    );
    const { insertTicket } = await vite.ssrLoadModule("/apps/desktop/src/main/db/tickets-repo.ts");
    const { createSqliteSessionLedger } = await vite.ssrLoadModule(
      "/apps/desktop/src/main/session-control/sqlite-ledger.ts",
    );

    db = openVolliDb(dbPath);
    insertProject(db, {
      id: PROJECT_ID,
      name: PROJECT.name,
      path: projectPath,
      ticketPrefix: PROJECT.prefix,
      baseBranch: "main",
      setupCommand: null,
      colorIndex: 2,
      sortOrder: 0,
      createdAt: now - 7 * HOUR,
      updatedAt: now,
    });
    for (const [index, ticket] of TICKETS.entries()) {
      insertTicket(db, {
        id: ticketId(ticket.number),
        projectId: PROJECT_ID,
        ticketNumber: ticket.number,
        title: ticket.title,
        body: "",
        status: ticket.status,
        priority: "high",
        usesWorktree: false,
        preferredHarnessId: "claude-code",
        order: index,
        worktreePath: null,
        branch: null,
        baseBranch: null,
        prUrl: null,
        createdAt: now - 6 * HOUR,
        updatedAt: now,
      });
    }

    const ledger = createSqliteSessionLedger(db);
    let events = 0;
    await ledger.transaction((transaction) => {
      for (const session of SESSIONS) {
        const createdAt = session.at - 6 * MINUTE;
        transaction.insertSession({
          id: session.id,
          projectId: PROJECT_ID,
          ticketId: ticketId(session.ticketNumber),
          role: "ticket",
          parentSessionId: null,
          title: session.title,
          createdAt,
        });
        let sequence = 0;
        const attachmentId = `${session.id}-attachment`;
        const append = (payload, occurredAt, withAttachment = true) => {
          sequence += 1;
          transaction.appendEvent({
            id: `${session.id}-event-${sequence}`,
            sessionId: session.id,
            sequence,
            occurredAt,
            recordedAt: occurredAt,
            provenance: PROVENANCE,
            payload,
            ...(withAttachment ? { attachmentId } : {}),
          });
          events += 1;
        };

        append(
          {
            kind: "session.created",
            session: {
              id: session.id,
              projectId: PROJECT_ID,
              ticketId: ticketId(session.ticketNumber),
              role: "ticket",
              parentSessionId: null,
              title: session.title,
              createdAt,
            },
          },
          createdAt,
          false,
        );
        append(
          { kind: "model.selected", selection: session.model, tier: "ticket" },
          createdAt + 1,
          false,
        );
        append(
          {
            kind: "attachment.opened",
            attachment: {
              id: attachmentId,
              sessionId: session.id,
              adapterId: "pi",
              venue: { id: "local", kind: "local" },
              continuity: "fresh",
              native: { id: `${session.id}-native`, detail: { fixture: true } },
              authority: null,
            },
          },
          createdAt + 2,
        );
        const turnId = `${session.id}-turn`;
        // A WORKING Session is one whose turn is still open, so its last event
        // IS the turn starting; every other phase starts its turn when the
        // Session was created and ends it below.
        append(
          { kind: "turn.started", attachmentId, turnId },
          session.phase === "working" ? session.at : createdAt + 3,
        );

        if (session.phase === "waiting") {
          append(
            {
              kind: "interaction.opened",
              interaction: {
                id: `ask-user:${session.id}-call`,
                attachmentId,
                kind: "question",
                title: QUESTION.title,
                detail: QUESTION.detail,
                options: QUESTION.options,
                multiple: false,
                prompts: [
                  {
                    id: "prompt:0",
                    label: QUESTION.title,
                    detail: QUESTION.detail,
                    options: QUESTION.options,
                    multiple: false,
                    custom: true,
                  },
                ],
                native: { id: `${session.id}-interaction`, detail: null },
              },
            },
            session.at,
          );
        } else if (session.phase === "interrupted") {
          append({ kind: "turn.interrupted", attachmentId, turnId }, session.at - 1_000);
          append({ kind: "attachment.closed", attachmentId, outcome: "interrupted" }, session.at);
        } else {
          append({ kind: "turn.completed", attachmentId, turnId }, session.at - 1_000);
          append({ kind: "attachment.closed", attachmentId, outcome: "completed" }, session.at);
        }
      }
    });

    let receipts = 0;
    for (const session of SESSIONS.filter((entry) => entry.unread === true)) {
      db.prepare("INSERT INTO session_read_receipts (session_id, unread_since) VALUES (?, ?)").run(
        session.id,
        session.at,
      );
      receipts += 1;
    }
    return { sessions: SESSIONS.length, events, receipts };
  } finally {
    db?.close?.();
    await vite.close();
  }
}

function ticketId(number) {
  return `peek-ticket-${number}`;
}

/** A plausible source tree, so the project reads like a real checkout. */
async function seedRepoTree(dir) {
  const files = {
    "package.json": '{\n  "name": "voltaic",\n  "private": true\n}\n',
    "README.md": "# voltaic\n\nDemo project for the VC-30 session peek screenshots.\n",
    "src/renderer/src/stores/drafts.ts": "export const drafts = new Map<string, string>();\n",
    "src/main/pty.ts": "export function spawnPty(): void {}\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    await fs.mkdir(join(path, ".."), { recursive: true });
    await fs.writeFile(path, contents);
  }
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "scaffold the renderer stores"], { cwd: dir });
  // The product regards dependencies as ready only when node_modules exists;
  // this fixture has nothing to install, so leave the same harmless marker
  // docs-shots does rather than let a setup banner cover the sidebar.
  await fs.mkdir(join(dir, "node_modules"), { recursive: true });
  await fs.writeFile(join(dir, "node_modules", ".volli-shots-fixture"), "ready\n", "utf8");
}
