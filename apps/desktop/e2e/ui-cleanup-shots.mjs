/**
 * Live screenshots of every UI change on `ui/cleanup-pass-v1`, driven through
 * the BUILT app.
 *
 * The branch's five tasks are visual, and four of them changed surfaces that no
 * unit test can show a person: icon weight across the transcript and the menus,
 * the summoned sidebar's four reveal states, the split session-start control in
 * each of its rooms, and the composer's chip row. This probe walks all four and
 * writes a captioned contact sheet the owner can scroll.
 *
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/ui-cleanup-shots.mjs
 *
 * Three things here are deliberate.
 *
 *   • Capture goes through `webContents.capturePage()` rather than Playwright's
 *     `page.screenshot()`, for the reason `docs-shots.mjs` gives: it reads the
 *     COMPOSITED window, so a WebGPU terminal canvas is real pixels rather than
 *     an empty rect, and it comes back at the display's scale factor — 2x on a
 *     retina Mac with no extra plumbing. The window is moved onto the highest-
 *     scale display first, so a run on an external 1x monitor still lands
 *     retina shots.
 *
 *   • The reveal is driven with a REAL POINTER. `useEdgeReveal` is pointer-
 *     intent machinery — an 8px strip, a 20ms dwell, a chrome-band cooldown —
 *     and setting the store instead would photograph a state the interaction
 *     cannot actually reach. Every reveal shot here moves the mouse in steps to
 *     the strip and waits out the dwell.
 *
 *   • The Previous band is seeded through `terminal.create` + `terminal.kill`
 *     rather than through the UI. A closed PTY is exactly what a Previous row
 *     is, and driving 16 of them through the split button would spend a minute
 *     to arrive at the same durable records. The Active band is the opposite
 *     case and IS driven through the UI: an Active row needs a live container
 *     in the renderer, which only a real open tab has.
 *
 * Cleaned (ghosted) rows come from cleanup rule (c) — "the Session predates the
 * ticket's entry into its current column". Start a ticket session, end it, then
 * move the ticket: `createdAt < statusEnteredAt`, and the row ghosts. It is the
 * only one of the four rules reachable without waiting a week or archiving the
 * ticket out from under the shot.
 *
 * The run is therefore TWO launches with a SQL step between them. Every seeded
 * Session is minutes old, so a first pass photographed a Previous band whose
 * every row read "now" — which is exactly the column whose `3ch` of tabular
 * figures this branch reserved, showing none of its range. The seeding launch
 * closes, `sqlite3` backdates the rows across minutes/hours/days (all inside the
 * seven-day window, or cleanup rule (d) would ghost the whole band), and the
 * shooting launch opens on a band that looks like a week of work.
 *
 * Like every probe in this directory this is MANUALLY RUN (needs a display and
 * the built app) and is NOT wired into `vp test`:
 *
 *   pnpm run build
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/ui-cleanup-shots.mjs
 *
 * Optional first argument overrides the output directory.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  assertProfileIsolated,
  cardById,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedDefaultModel,
  seedProjects,
  sleep,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const SHOT_DIR = process.argv[2] ?? join(os.homedir(), "Desktop", "volli-ui-cleanup-shots");

/** The demo project the repo's docs and shots already use (docs/DESIGN.md). */
const PROJECT = { id: "ui-cleanup-voltaic", name: "voltaic", prefix: "VLT", colorIndex: 2 };

/**
 * Board content. Real planner tickets rather than lorem: the shots are read as
 * screenshots of an app, and placeholder text is the one thing that makes them
 * look like a mock of one.
 */
const TICKETS = [
  ["doing", "Cache composer drafts per project", "high"],
  ["doing", "Rebuild the diff viewer on the changeset store", "high"],
  ["needs_review", "Warn before closing a session with a running process", "high"],
  ["needs_review", "Resume a parked session from the sidebar", "medium"],
  ["todo", "Native notification when an agent stops", "high"],
  ["todo", "Full-text search over session transcripts", "medium"],
  ["todo", "Show worktree disk usage in the ticket rail", "low"],
  ["backlog", "Stream PTY output through a shared ring buffer", "medium"],
  ["backlog", "Per-project setup command before the agent boots", "low"],
  ["backlog", "Remember board zoom level per project", "low"],
  ["done", "One git worktree per ticket, branched on kickoff", "high"],
  ["done", "Ghostty config adapter for the terminal", "medium"],
];

/**
 * Titles for the seeded Previous rows, in the order they are created — so the
 * band reads as a week of real work rather than "Session 1 … Session 16".
 */
const PREVIOUS_TITLES = [
  "Trace the ring buffer's back-pressure",
  "Audit the worktree cleanup sweep",
  "Reproduce the stale-base failure",
  "Check the notification entitlement",
  "Bisect the transcript search regression",
  "Measure PTY resize churn on zoom",
  "Read the session ledger migration",
  "Diff the harness manifest hashes",
  "Probe the split divider's ui-scale",
  "Walk the board's auto-move rules",
  "Re-run the coverage gate locally",
  "Sketch the archive retention policy",
  "Confirm the CLI socket handshake",
  "Time the first-paint theme stamp",
];

/** Ticket-scoped sessions whose tickets are moved afterwards — the ghosted rows. */
const CLEANED_TITLES = [
  "Land the drafts cache keying",
  "Fix the diff viewer's inline gutter",
  "Close the parked-session resume",
];

/* -------------------------------------------------------------------------- */
/* Shot registry                                                              */
/* -------------------------------------------------------------------------- */

/** Every group the contact sheet lays out, in review order. */
const GROUPS = [
  {
    key: "icons",
    title: "1 · Icons",
    blurb:
      "Interactivity decides fill, and it stopped being called a weight. The transcript's routine " +
      "column is uniform outline; the filled ember palm on a permission card is the one exception. " +
      "Context menus, the sidebar nav and the Settings nav all dropped to outline; the Sessions " +
      "empty state now wears a chat bubble, because the button under it starts a chat.",
  },
  {
    key: "sidebar",
    title: "2 · Sidebar",
    blurb:
      "Collapsed is genuinely zero — the icon strip is gone and the panel is summoned by the " +
      "pointer at the window's left edge (20ms dwell, 375ms exit grace) or pinned by ⌘B. The rail " +
      "and the panel are now independent, so all four combinations mean what they say. The sliver " +
      "shows only while the workspace rail stands. Previous-band rows carry one trailing mark, so " +
      "the age and the header's filter glyph share a single right edge.",
  },
  {
    key: "session-start",
    title: "3 · Session start",
    blurb:
      "One split button in every room that offers a Session: the press starts a chat, the caret " +
      "admits the terminal exists. The chords are announced only where a press of them starts the " +
      "same thing — the global Sessions surface — and deliberately not inside a ticket.",
  },
  {
    key: "composer",
    title: "4 · Composer",
    blurb:
      "Paper's chip row: Status, Priority, Labels and the harness picker describe the ticket on the " +
      "left; a real `base → destination` statement names the git ground on the right. The base " +
      "picker splits local heads from remote-tracking refs and dates the snapshot it is offering.",
  },
  {
    key: "fullscreen",
    title: "5 · Fullscreen / terminal focus",
    blurb:
      "Nothing shipped. The implementation found there is no fullscreen button to move — " +
      "`useFullScreen` is read-only, and issue 5's control is really terminal focus, an in-app zen " +
      "mode. It is planned in docs/plans/fullscreen-placement.md and blocked on ui/right-sidebar-" +
      "fixes landing, so there is no surface to photograph.",
    empty: true,
  },
];

/** Filled by `capture()`; the contact sheet is written from it. */
const SHOTS = [];

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-ui-cleanup-shots-");
const { attempt, check, summarize } = createRunner();

await fs.mkdir(SHOT_DIR, { recursive: true });

const projectDir = await makeGitRepo(scratch, "voltaic-");
await seedBranches(projectDir, scratch);

/** Content-box size, filled once the window is placed. */
let viewport = { width: 1440, height: 900 };
/** The app under test. The seeding launch closes before the shooting one opens. */
let app = await launch({ dbPath, userDataDir });

/* ========================================================================== */
/* Launch 1 — seed the durable record, then get out of the way                */
/* ========================================================================== */

let seeded = null;
try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("app surface", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );

  await seedProjects(page, [{ ...PROJECT, path: projectDir }]);

  seeded = await page.evaluate(async (tickets) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) throw new Error(boot.error);
    const project = boot.data.projects[0];
    if (!project) throw new Error("no project imported");
    const created = [];
    for (const [status, title, priority] of tickets) {
      const result = await window.api.tickets.create({
        projectId: project.id,
        status,
        title,
        priority,
      });
      if (!result.ok) throw new Error(result.error);
      created.push({ id: result.ticket.id, number: result.ticket.ticketNumber, status });
    }
    return {
      projectId: project.id,
      projectPath: project.path,
      prefix: project.ticketPrefix,
      tickets: created,
    };
  }, TICKETS);

  await attempt("seed", "durable Sessions for the Previous band", async () => {
    const result = await page.evaluate(
      async ({ project, previousTitles, cleanedTitles, ticketIds }) => {
        const made = { previous: 0, cleaned: 0, errors: [] };

        async function endedSession(title, ticketId) {
          const created = await window.api.terminal.create({
            workspaceId: project.projectId,
            cwd: project.projectPath,
            cols: 80,
            rows: 24,
            ...(ticketId === null ? {} : { ticket: { ticketId } }),
          });
          if (!created.ok) {
            made.errors.push(created.error ?? "create failed");
            return null;
          }
          await window.api.sessions.rename({ sessionId: created.sessionId, title });
          await window.api.terminal.kill(created.sessionId);
          return created.sessionId;
        }

        for (const title of previousTitles) {
          if ((await endedSession(title, null)) !== null) made.previous += 1;
        }
        // Ticket-scoped, then the ticket moves: the Session now predates its
        // ticket's entry into its current column, which is cleanup rule (c).
        for (const [index, title] of cleanedTitles.entries()) {
          const ticketId = ticketIds[index];
          if ((await endedSession(title, ticketId)) === null) continue;
          const moved = await window.api.tickets.move({
            projectId: project.projectId,
            ticketId,
            toStatus: "done",
            toIndex: 0,
          });
          if (moved.ok) made.cleaned += 1;
          else made.errors.push(moved.error ?? "move failed");
        }
        return made;
      },
      {
        project: seeded,
        previousTitles: PREVIOUS_TITLES,
        cleanedTitles: CLEANED_TITLES,
        ticketIds: seeded.tickets.slice(4, 7).map((ticket) => ticket.id),
      },
    );
    return {
      ok: result.previous >= 10 && result.cleaned >= 2,
      detail: `previous=${result.previous} cleaned=${result.cleaned} errors=${result.errors.join(" / ") || "none"}`,
    };
  });
} catch (error) {
  check("!", "seeding launch crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}

await attempt("seed", "back-date the Previous band across a week", () => backdateSessions(dbPath));

/* ========================================================================== */
/* Launch 2 — every shot                                                      */
/* ========================================================================== */

app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("app surface", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );

  // The window has to sit on the highest-scale display before anything is
  // captured: `capturePage` returns at the scale factor of the display the
  // window is ON, so a run that happens to open on an external 1x monitor would
  // silently write half-resolution shots.
  const placed = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const best = screen.getAllDisplays().reduce((a, b) => (b.scaleFactor > a.scaleFactor ? b : a));
    const width = Math.min(1440, best.workArea.width - 32);
    const height = Math.min(900, best.workArea.height - 32);
    win.setBounds({
      x: best.workArea.x + Math.round((best.workArea.width - width) / 2),
      y: best.workArea.y + 16,
      width,
      height,
    });
    win.show();
    win.focus();
    const [contentWidth, contentHeight] = win.getContentSize();
    return { scaleFactor: best.scaleFactor, contentWidth, contentHeight };
  });
  viewport = { width: placed.contentWidth, height: placed.contentHeight };
  check(
    0,
    `window placed at ${placed.contentWidth}x${placed.contentHeight} @${placed.scaleFactor}x`,
    placed.scaleFactor >= 2 && placed.contentWidth >= 1200,
    `retina=${placed.scaleFactor >= 2}`,
  );

  const heroId = `${seeded.prefix}-${seeded.tickets[0].number}`;
  await waitUntil("board", async () => (await cardById(page, heroId).count()) === 1);
  await sleep(1200);

  // The seeded Sessions survived the SQL, read back through the same edge the
  // sidebar reads. Worth its own check because the failure it catches is
  // SILENT: a ledger that refuses a Session hands back a shorter list, and the
  // sidebar simply draws an empty band — which looks like a design decision in
  // a screenshot rather than like a broken fixture.
  await attempt("seed", "the back-dated Sessions read back intact", async () => {
    const listing = await page.evaluate(async (projectId) => {
      const result = await window.api.sessions.list({ projectId });
      if (!result.ok) return { error: result.error };
      const ended = result.sessions.filter(
        (row) => row.kind === "terminal" && row.record.endedAt !== null,
      );
      return { total: result.sessions.length, ended: ended.length };
    }, seeded.projectId);
    if (listing.error !== undefined) return { ok: false, detail: listing.error };
    return {
      ok: listing.ended >= 15,
      detail: `${listing.total} Sessions, ${listing.ended} ended`,
    };
  });

  /* ------------------------------------------------------------------ */
  /* Live Sessions — the Active band and the strip's tabs both need real */
  /* open tabs, which is the one thing a durable record cannot stand in  */
  /* for. Two terminals, opened the way a person opens them.             */
  /* ------------------------------------------------------------------ */

  await attempt("seed", "two live terminals for the Active band", async () => {
    await gotoNav(page, "Sessions");
    // The surface auto-opens one terminal on first visit; add one more so the
    // strip has a tab beside the control rather than only under it.
    await waitUntil("first tab", async () => (await page.getByRole("tab").count()) >= 1, {
      timeout: 25000,
    });
    await startTerminalSession(page);
    await waitUntil("second tab", async () => (await page.getByRole("tab").count()) >= 2, {
      timeout: 25000,
    });
    await sleep(2500);
    return { ok: true, detail: `${await page.getByRole("tab").count()} live tabs` };
  });

  /* ------------------------------------------------------------------ */
  /* GROUP 2 — the sidebar                                              */
  /* ------------------------------------------------------------------ */

  await gotoNav(page, "Board");
  await sleep(600);

  await attempt("sidebar", "a: rail visible, sidebar hidden — the sliver", async () => {
    await setPinned(page, false);
    await setRailHidden(page, false);
    await parkPointer(page);
    await sleep(500);
    const shell = await shellState(page);
    await capture({
      name: "10-sidebar-rail-visible-panel-hidden",
      group: "sidebar",
      caption:
        "Rail visible, sidebar hidden. The panel is genuinely gone — no icon strip — and the only " +
        "standing evidence it exists is a 2px sliver in the 8px canvas gutter between the rail and " +
        "the card. Full window; the detail crop below is the same frame.",
    });
    await capture({
      name: "11-sidebar-sliver-detail",
      group: "sidebar",
      caption:
        "The same sliver, cropped to the rail's right edge at 2x. This is the whole hint: it is what " +
        "you aim at, and it brightens (foreground/12 → /35) while the strip is arming.",
      rect: { x: 34, y: 130, width: 66, height: 360 },
    });
    return { ok: shell === "ephemeral", detail: `shell=${shell}` };
  });

  await attempt("sidebar", "b: rail visible, sidebar revealed by hover", async () => {
    const opened = await revealByHover(page, { railVisible: true });
    await capture({
      name: "12-sidebar-rail-visible-panel-revealed",
      group: "sidebar",
      caption:
        "The same state after a real pointer sat in the 8px strip for its 20ms dwell. The panel is " +
        "an overlay — its own card, floating over the content on `--shadow-overlay` — and the " +
        "content behind it has not moved. Leaving is forgiven for 375ms.",
    });
    return { ok: opened, detail: opened ? "panel revealed" : "panel never appeared" };
  });

  await attempt("sidebar", "c: rail hidden, sidebar hidden — no sliver", async () => {
    await parkPointer(page);
    await sleep(600);
    await setRailHidden(page, true);
    await parkPointer(page);
    await sleep(600);
    const geometry = await edgeGeometry(page);
    await capture({
      name: "13-sidebar-rail-hidden-panel-hidden",
      group: "sidebar",
      caption:
        "Rail hidden, sidebar hidden. No sliver at all, and that is the rule rather than an " +
        "oversight: with the rail gone the whole window edge is the target, so there is nothing to " +
        "aim at and no hint to draw.",
    });
    await capture({
      name: "14-sidebar-rail-hidden-no-sliver-detail",
      group: "sidebar",
      caption:
        "The same left edge, cropped. Compare with shot 11 — bare canvas where the sliver was.",
      rect: { x: 0, y: 130, width: 66, height: 360 },
    });
    return {
      ok: geometry.railWidth === 0 && geometry.sliverCount === 0,
      detail: `railWidth=${geometry.railWidth} slivers=${geometry.sliverCount}`,
    };
  });

  await attempt("sidebar", "d: rail hidden, sidebar pinned — the case that regressed", async () => {
    await setPinned(page, true);
    await parkPointer(page);
    await sleep(700);
    const geometry = await edgeGeometry(page);
    await capture({
      name: "15-sidebar-rail-hidden-panel-pinned",
      group: "sidebar",
      caption:
        "Rail hidden, sidebar PINNED — the combination that used to be incoherent, because the " +
        "switcher only stood when the panel happened to be pinned. The panel now docks at x=0 and " +
        "the content starts at 258; the rail's 60px went back to the canvas rather than widening " +
        "the panel.",
    });
    return {
      ok: geometry.shell === "framed" && geometry.railWidth === 0 && geometry.panelLeft <= 1,
      detail: `shell=${geometry.shell} railWidth=${geometry.railWidth} panelLeft=${geometry.panelLeft}`,
    };
  });

  await attempt("sidebar", "the Previous band, ghosted cleaned rows at 0.80", async () => {
    await setRailHidden(page, false);
    await setPinned(page, true);
    await sleep(500);
    const filter = page.getByRole("button", { name: "Filter", exact: true }).first();
    await waitUntil("filter trigger", async () => (await filter.count()) >= 1);
    await filter.click();
    await sleep(300);
    await page.getByRole("menuitemcheckbox", { name: /Cleaned up/ }).click();
    await sleep(400);
    await page.keyboard.press("Escape");
    await sleep(400);
    await parkPointer(page);
    await sleep(400);
    const ghosts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-sidebar="menu-button"]'))
        .filter((node) => Number.parseFloat(getComputedStyle(node).opacity) < 0.99)
        .map((node) => getComputedStyle(node).opacity),
    );
    await capture({
      name: "16-sidebar-previous-band-ghosted",
      group: "sidebar",
      caption:
        "The Previous band with `Cleaned up` turned on. A cleaned row says so by ghosting to 0.80 " +
        "and by nothing else — the broom that used to ride the row was a second signifier for a " +
        "state the reader had just asked to see.",
      rect: await paneRect(page),
    });
    return { ok: ghosts.length >= 2, detail: `ghosted rows: ${ghosts.join(", ") || "none"}` };
  });

  await attempt("sidebar", "the band filter menu, open", async () => {
    const filter = page.getByRole("button", { name: "Filter", exact: true }).first();
    await filter.click();
    await waitUntil(
      "menu open",
      async () => (await page.getByRole("menuitemcheckbox").count()) >= 3,
    );
    await sleep(350);
    await capture({
      name: "17-sidebar-band-filter-menu",
      group: "sidebar",
      caption:
        "The Previous band's own filter. It belongs to that band rather than to the list: " +
        "unchecking Terminals must not empty Active of terminals, because Active is what is " +
        "happening. The trigger tints while the filter is narrowed, so a list that is hiding " +
        "something never reads as a list that is empty.",
    });
    await page.keyboard.press("Escape");
    await sleep(300);
    return { ok: true, detail: "menu captured" };
  });

  await attempt("sidebar", "the filter glyph and the age share one right edge", async () => {
    await parkPointer(page);
    await sleep(400);
    const alignment = await page.evaluate(() => {
      const trigger = document.querySelector('button[aria-label="Filter"]');
      const rows = Array.from(document.querySelectorAll('[data-sidebar="menu-button"]'));
      const ages = rows
        .map((row) => row.querySelector("span.tabular-nums:last-child"))
        .filter((node) => node !== null);
      if (trigger === null || ages.length === 0) return null;
      const glyph = trigger.querySelector("svg");
      return {
        glyphRight: (glyph ?? trigger).getBoundingClientRect().right,
        ageRights: ages.map((node) => node.getBoundingClientRect().right),
      };
    });
    const header = await page.locator('button[aria-label="Filter"]').boundingBox();
    await capture({
      name: "18-sidebar-one-right-edge",
      group: "sidebar",
      caption:
        "The band header's filter glyph and every Previous row's age, cropped tight. One trailing " +
        "mark per row means one right edge: the age reserves 3ch of tabular figures, so a ticking " +
        "row can no longer drag the title's truncation point back and forth as `59m` becomes `1h`.",
      rect:
        header === null
          ? null
          : {
              x: Math.round(header.x - 230),
              y: Math.round(header.y - 12),
              width: 268,
              height: 250,
            },
    });
    if (alignment === null) return { ok: false, detail: "no filter trigger or age column" };
    const drift = alignment.ageRights.map((right) =>
      Math.abs(right - alignment.glyphRight).toFixed(1),
    );
    return {
      ok: alignment.ageRights.every((right) => Math.abs(right - alignment.glyphRight) <= 2),
      detail: `glyph right=${alignment.glyphRight.toFixed(1)} drift=[${drift.join(", ")}]`,
    };
  });

  await attempt("sidebar", "the Previous band overflows and shows its scrollbar", async () => {
    const scroll = await scrollPreviousBand(page);
    await capture({
      name: "19-sidebar-ephemeral-scrollbar",
      group: "sidebar",
      caption:
        "The pane mid-scroll. The band overflows with sixteen Previous rows, and the scrollbar is " +
        "ephemeral — it fades in on the gesture and back out after it, so the resting sidebar is " +
        "the list and not the controls for it.",
      rect: await paneRect(page),
    });
    return { ok: scroll.scrollable, detail: `scrollTop=${scroll.top} of ${scroll.max}` };
  });

  /* ------------------------------------------------------------------ */
  /* GROUP 3 — the split session-start control                          */
  /* ------------------------------------------------------------------ */

  await attempt("session-start", "the Sessions strip, closed", async () => {
    await setPinned(page, true);
    await gotoNav(page, "Sessions");
    await sleep(1200);
    await parkPointer(page);
    await sleep(400);
    const seam = await splitSeam(page);
    await capture({
      name: "20-session-start-strip-closed",
      group: "session-start",
      caption:
        "The Sessions tab strip. One pill, two hit targets: the label half starts a chat on the " +
        "press, the 16px caret half admits the terminal exists. It replaced a bare `+` menu that " +
        "cost this surface a click on the act it exists for.",
      rect: seam.crop,
    });
    return { ok: seam.ok, detail: seam.detail };
  });

  await attempt("session-start", "the Sessions strip, menu open — chords visible", async () => {
    await page.getByRole("button", { name: "Other session kinds", exact: true }).first().click();
    await waitUntil("menu open", async () => (await menuRows(page)).length >= 2);
    await sleep(400);
    const rows = await menuRows(page);
    await capture({
      name: "21-session-start-strip-menu",
      group: "session-start",
      caption:
        "The caret's menu on the GLOBAL Sessions surface, and the only place the chords are " +
        "announced: a press of ⌘T here starts the same thing the Chat item does. The chord column " +
        "is flush right — the primitive's trailing `tracking-widest` was pushing it off the edge " +
        "`ml-auto` promised.",
      rect: await menuCrop(page),
    });
    await page.keyboard.press("Escape");
    await sleep(300);
    return {
      ok: rows.length === 2 && rows[0].chord === "⌘T" && rows[1].chord === "⌥⌘T",
      detail: JSON.stringify(rows),
    };
  });

  await attempt("session-start", "the empty surface — the solid drawing", async () => {
    for (let guard = 0; guard < 12; guard += 1) {
      const closers = page.getByRole("button", { name: /^Close / });
      if ((await closers.count()) === 0) break;
      await closers.first().click();
      await sleep(500);
    }
    await waitUntil("empty surface", async () => (await page.getByRole("tab").count()) === 0, {
      timeout: 20000,
    });
    await parkPointer(page);
    await sleep(600);
    await capture({
      name: "22-session-start-empty-surface",
      group: "session-start",
      caption:
        "The same control on an empty surface, drawn SOLID and labelled `New chat`. It is the only " +
        "affordance on screen, so it takes the emphasis and says what it does rather than naming a " +
        "kind among tabs that no longer exist. `Starting…` is gone — dimming is now the single " +
        "vocabulary for a booting Session.",
    });
    await capture({
      // Numbered into the ICONS group even though it is taken on the
      // session-start walk: the prefix is the reader's order, not the run's.
      name: "08-icons-sessions-empty-state",
      group: "icons",
      caption:
        "The same frame, cropped. The crowning glyph is a CHAT BUBBLE, not a terminal: the button " +
        "under it starts a chat, and an empty state's glyph has to name the thing the button does.",
      rect: await emptyStateCrop(page),
    });
    return { ok: true, detail: "empty surface captured" };
  });

  await attempt(
    "session-start",
    "the ticket rail's control — chords deliberately absent",
    async () => {
      await gotoNav(page, "Board");
      await sleep(700);
      await cardById(page, heroId).dblclick();
      await waitUntil("ticket detail", async () => (await page.locator("aside").count()) >= 1);
      await sleep(1200);
      const aside = page.locator("aside");
      await parkPointer(page);
      await sleep(400);
      const railBox = await aside.boundingBox();
      await capture({
        name: "24-session-start-ticket-rail",
        group: "session-start",
        caption:
          "The same component in the 300px ticket rail, one size step down so it sits level with a " +
          "`text-label` heading. The ticket surfaces used to carry a two-button Chat/Terminal cluster, " +
          "which gave the terminal a peer status the code does not have.",
        rect:
          railBox === null
            ? null
            : { x: railBox.x - 8, y: railBox.y, width: railBox.width + 16, height: 320 },
      });
      await aside.getByRole("button", { name: "Other session kinds", exact: true }).first().click();
      await waitUntil("menu open", async () => (await menuRows(page)).length >= 2);
      await sleep(400);
      const rows = await menuRows(page);
      await capture({
        name: "25-session-start-ticket-rail-menu",
        group: "session-start",
        caption:
          "The same menu inside a ticket, with NO chords. The chords are global, so a ticket menu " +
          "saying ⌘T beside Chat would be teaching a Session into the wrong owner — ⌘T from here " +
          "still starts a global chat and leaves the ticket.",
        rect: await menuCrop(page),
      });
      await page.keyboard.press("Escape");
      await sleep(400);
      return {
        ok: rows.length === 2 && rows.every((row) => row.chord === null),
        detail: JSON.stringify(rows),
      };
    },
  );

  /* ------------------------------------------------------------------ */
  /* GROUP 1 — icon weight                                              */
  /* ------------------------------------------------------------------ */

  await attempt("icons", "a context menu on a board card", async () => {
    await gotoNav(page, "Board");
    await sleep(900);
    const card = cardById(page, heroId).first();
    await card.click({ button: "right" });
    await waitUntil("context menu", async () => (await page.getByRole("menuitem").count()) >= 3);
    await sleep(400);
    await capture({
      name: "01-icons-board-card-context-menu",
      group: "icons",
      caption:
        "A context menu on a board card. Every item is now outline: each action is a peer of every " +
        "other, so a filled glyph marks nothing — and at 16px beside 14px text the mark was already " +
        "the larger object. The primitive stopped offering the choice at all.",
      rect: await menuCrop(page),
    });
    await page.keyboard.press("Escape");
    await sleep(400);
    return { ok: true, detail: "context menu captured" };
  });

  await attempt("icons", "the Settings nav column", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await waitUntil("settings nav", async () => (await page.locator("nav").count()) >= 1);
    await sleep(900);
    await parkPointer(page);
    await sleep(400);
    const nav = page.locator("nav").first();
    const box = await nav.boundingBox();
    await capture({
      name: "02-icons-settings-nav",
      group: "icons",
      caption: "Settings, with its category nav and the sidebar's own nav visible in one frame.",
    });
    await capture({
      name: "03-icons-settings-nav-column",
      group: "icons",
      caption:
        "The Settings category column, cropped. Outline throughout — a nav is a list of peers, and " +
        "the selected row is said by its fill and its ink, never by a heavier glyph.",
      rect:
        box === null
          ? null
          : { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 },
    });
    return { ok: box !== null, detail: box === null ? "no nav" : "settings nav captured" };
  });

  /* ------------------------------------------------------------------ */
  /* GROUP 4 — the ticket composer                                      */
  /* ------------------------------------------------------------------ */

  await attempt("composer", "collapsed, with the chip row", async () => {
    await page.keyboard.press("Escape");
    await gotoNav(page, "Board");
    await sleep(800);
    await page.getByRole("button", { name: "New ticket", exact: true }).first().click();
    await waitUntil("composer", async () => (await page.getByRole("dialog").count()) === 1);
    await page.keyboard.type("Collapse the session vocabulary onto RuntimeObservation");
    await sleep(1600);
    await parkPointer(page);
    await sleep(500);
    const wrap = await chipRowWrap(page);
    await capture({
      name: "40-composer-collapsed",
      group: "composer",
      caption:
        "The composer at its collapsed width (576px). Status, Priority, Labels and the terminal " +
        "harness describe the ticket; `base → new worktree` names the git ground, bound tighter " +
        "(gap-1) than the metadata chips (gap-1.5) so the arrow reads as one statement.",
      rect: await dialogCrop(page),
    });
    return {
      ok: true,
      detail: wrap.wrapped
        ? `branch pair WRAPS to a second line (chip row is ${wrap.lines} lines)`
        : "chip row fits one line",
    };
  });

  await attempt("composer", "the base-branch picker, open", async () => {
    await page.getByRole("button", { name: "Base branch", exact: true }).first().click();
    await waitUntil(
      "branch groups",
      async () =>
        (await page.getByRole("dialog").locator("text=Branches").count()) >= 0 &&
        (await page.locator("[data-radix-popper-content-wrapper]").count()) >= 1,
    );
    await sleep(700);
    const headings = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper] div"))
        .map((node) => (node.children.length === 0 ? (node.textContent ?? "").trim() : ""))
        .filter((text) => /^(Branches|Remote ·)/i.test(text)),
    );
    await capture({
      name: "42-composer-base-branch-menu",
      group: "composer",
      caption:
        "The base picker as it opens: local heads under BRANCHES, most-recently-committed first, " +
        "with the current one ticked. The `volli/VLT-*` entries are real — the fixture's ticket " +
        "Sessions each cut their own worktree branch.",
      rect: await popoverCrop(page),
    });
    // The list is taller than its 256px scroll box, so the REMOTE group — the
    // whole point of the split — opens below the fold. Filtering to a name both
    // groups hold is what puts the two headings in one frame.
    await page.getByPlaceholder("Search branches…").fill("feature");
    await sleep(600);
    await capture({
      name: "44-composer-base-branch-split",
      group: "composer",
      caption:
        "The same picker filtered to `feature`, which is what brings both headings into one frame. " +
        "Local heads and remote-tracking refs are kept in SEPARATE groups, and the remote heading " +
        "carries the AGE of the snapshot it is offering: a remote ref only moves on a fetch, and " +
        "nothing in the worktree pipeline fetches on your behalf before branching — so an " +
        "unlabelled `origin/main` beside `main` would be presenting a possibly-weeks-old ref as " +
        "the remote's tip.",
      rect: await popoverCrop(page),
    });
    await page.keyboard.press("Escape");
    await sleep(400);
    return {
      ok:
        headings.some((text) => /^Branches$/i.test(text)) &&
        headings.some((text) => /^Remote ·/i.test(text)),
      detail: headings.join(" | ") || "no headings found",
    };
  });

  await attempt("composer", "the harness chip's menu, open", async () => {
    await page.getByRole("button", { name: "Terminal harness", exact: true }).first().click();
    await waitUntil("harness menu", async () => (await page.getByRole("menuitem").count()) >= 2);
    await sleep(500);
    await capture({
      name: "43-composer-harness-menu",
      group: "composer",
      caption:
        "The harness picker, moved out of the footer into the chip row. It names a TERMINAL and " +
        "nothing else — kickoff boots a PTY and launches the chosen TUI in it; no entry here is an " +
        "Agent Runtime, which is what the terminal glyph on the chip is for.",
      rect: await menuCrop(page),
    });
    await page.keyboard.press("Escape");
    await sleep(400);
    return { ok: true, detail: "harness menu captured" };
  });

  await attempt("composer", "expanded", async () => {
    await page.getByRole("button", { name: "Expand", exact: true }).first().click();
    await sleep(900);
    await parkPointer(page);
    await sleep(500);
    const wrap = await chipRowWrap(page);
    await capture({
      name: "41-composer-expanded",
      group: "composer",
      caption:
        "Expanded (768px). The body grows to a 280px floor and the chip row gets its full width " +
        "back — which is where the open question lives: at the collapsed width the branch pair " +
        "wraps to a second right-aligned line, because Paper's mock fits one line only with a chip " +
        "reading `Explore` where ours reads a real harness name.",
      rect: await dialogCrop(page),
    });
    return { ok: true, detail: wrap.wrapped ? "still wrapping" : "one line when expanded" };
  });

  /* ------------------------------------------------------------------ */
  /* GROUP 1 — the chat transcript, which is the surface the audit was   */
  /* actually written about. It needs a LIVE Pi turn: nothing in the app */
  /* renders activity rows from a fixture, so the only honest way to     */
  /* photograph the routine column is to make an agent produce one.      */
  /* ------------------------------------------------------------------ */

  await attempt("icons", "a real Pi turn, for the transcript's routine column", async () => {
    await page.keyboard.press("Escape");
    await sleep(400);
    await gotoNav(page, "Sessions");
    await sleep(800);
    const model = await seedDefaultModel(page);
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
    await waitUntil("chat composer", async () => (await textarea.count()) > 0, { timeout: 30000 });
    await waitUntil("composer enabled", async () => !(await textarea.isDisabled()), {
      timeout: 30000,
    });
    await textarea.click();
    // A prompt whose only honest answer is several tool calls: the routine
    // column is what is being photographed, and prose alone would not draw one.
    await textarea.fill(
      "List the files in this repository, read README.md, and then create a file " +
        "called NOTES.md containing one sentence about what this repo is. Keep your " +
        "prose to two sentences.",
    );
    await page.keyboard.press("Enter");
    await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
      timeout: 60000,
    });
    // Either the turn finishes, or it parks on a permission card and waits —
    // which is itself the frame with the filled palm in it, so both are a
    // landing and neither is worth failing the shot over.
    await waitUntil("the turn to settle", async () => (await stopButton(page).count()) === 0, {
      timeout: 180000,
    }).catch(() => null);
    await sleep(1500);
    // A settled turn draws its tool calls as ONE collapsed bundle row, which is
    // a single wrench and not the column the audit is about. Opening it is what
    // puts the per-kind glyphs on screen.
    const bundle = page.locator('[class*="group/row"]').first();
    if ((await bundle.count()) > 0) {
      await bundle.click().catch(() => {});
      await sleep(900);
    }
    await parkPointer(page);
    await sleep(600);
    const census = await transcriptCensus(page);
    await capture({
      name: "04-icons-chat-transcript",
      group: "icons",
      caption:
        "The chat transcript after a real Pi turn, with the activity bundle opened — the surface " +
        "the icon audit was actually written about. Outline is the baseline and the routine rows " +
        "are uniform, which is what makes the column scannable at all.",
    });
    await capture({
      name: "05-icons-chat-transcript-column",
      group: "icons",
      caption:
        "The same rows cropped to their glyph column. The settled tick is a muted OUTLINE " +
        "CheckCircle: a filled one covered half its box to say 'this went fine', which is the one " +
        "thing a settled row should not say loudly. The bundle's own wrench lost its fill for the " +
        "same reason.",
      rect: await transcriptCrop(page),
    });
    return {
      ok: census.rows >= 1,
      detail: `model=${model.label} rows=${census.rows} assistant=${census.assistant}`,
    };
  });

  await attempt("icons", "the one filled exception — a permission card", async () => {
    const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
    await textarea.click();
    // The filled ember palm belongs to an interaction, and an interaction is
    // something the AGENT decides to raise. There is no app-side lever that
    // forces one, so this asks for the behaviour the card exists for and
    // reports honestly when the model answers in prose instead.
    await textarea.fill(
      "Before you do anything else, stop and ask me a clarifying question: should the " +
        "next file be called ALPHA.md or BETA.md? Do not guess, and do not proceed until I answer.",
    );
    await page.keyboard.press("Enter");
    await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
      timeout: 60000,
    });
    await waitUntil(
      "the turn to settle or park",
      async () => {
        if ((await interactionCard(page).count()) > 0) return true;
        return (await stopButton(page).count()) === 0;
      },
      { timeout: 180000 },
    ).catch(() => null);
    await sleep(1200);
    await parkPointer(page);
    await sleep(500);
    const cards = await interactionCard(page).count();
    await capture({
      name: "07-icons-chat-interaction",
      group: "icons",
      caption:
        cards > 0
          ? "The exception, and the only filled glyph the chat surface has left: an interaction " +
            "card's ember HandPalm. A transcript that is outline throughout is what makes one " +
            "filled mark mean 'this one is waiting for you'."
          : "ASKED FOR, NOT PRODUCED. The model answered in prose rather than raising an " +
            "interaction, so the filled ember palm is not in this frame. There is no app-side " +
            "lever that forces a permission card — the agent decides to raise one — so this is " +
            "the honest state of the surface rather than a staged one.",
      rect: cards > 0 ? await interactionCrop(page) : null,
    });
    return {
      ok: true,
      detail: cards > 0 ? "interaction card rendered" : "no card — model answered in prose",
    };
  });

  await attempt("icons", "the same transcript on a light canvas", async () => {
    const written = await page.evaluate(() => window.api.theme.setGlobalAppearance("light"));
    if (!written.ok) return { ok: false, detail: written.error };
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("light stamped", () =>
      page.evaluate(() => document.documentElement.classList.contains("light")),
    );
    await sleep(2000);
    // A scratch chat's tab does not survive a relaunch on its own; the sidebar
    // row is how a person reopens it, and it is the same path.
    const row = page.locator("[data-session-band] button").first();
    if ((await row.count()) > 0) {
      await row.click();
      await sleep(2500);
    }
    // The reload closed the bundle again; open it so the light frame shows the
    // same column the dark one does rather than a single collapsed wrench.
    const bundle = page.locator('[class*="group/row"]').first();
    if ((await bundle.count()) > 0) {
      await bundle.click().catch(() => {});
      await sleep(800);
    }
    await parkPointer(page);
    await sleep(600);
    await capture({
      name: "06-icons-chat-transcript-light",
      group: "icons",
      caption:
        "The same surface on a light canvas. Appearance resolves separately from the canvas, so " +
        "this is the same generated token set at the other end of the ladder — worth one look " +
        "because an outline glyph has less ink to lose, and thin marks are where a light theme " +
        "usually falls over.",
    });
    return { ok: true, detail: "light transcript captured" };
  });
} catch (error) {
  check("!", "ui-cleanup shots crashed", false, String(error?.stack ?? error));
} finally {
  await writeIndex();
  await app.close().catch(() => {});
  await cleanup();
}

console.log(`\n${SHOTS.length} shots written to ${SHOT_DIR}`);
process.exit(summarize());

/* -------------------------------------------------------------------------- */
/* Capture                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Capture the composited window (or a rect of it) and register it for the
 * contact sheet. A `rect` in CSS px is rounded to the integer DIP box
 * `capturePage` takes; `null` means the whole window.
 *
 * The size check is the blank-shot detector this probe actually needs: a solid
 * black or single-colour PNG of this size compresses to a few KB, so a
 * plausible byte count is strong evidence that real pixels landed.
 */
async function capture({ name, group, caption, rect = null }) {
  const area =
    rect === null
      ? null
      : {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
  const base64 = await app.evaluate(async ({ BrowserWindow }, box) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage(box ?? undefined);
    return image.toPNG().toString("base64");
  }, area);
  const bytes = Buffer.from(base64, "base64");
  const file = `${name}.png`;
  await fs.writeFile(join(SHOT_DIR, file), bytes);
  const { width, height } = pngSize(bytes);
  const floor = area === null ? 60_000 : 2_000;
  const ok = bytes.length >= floor && width > 0;
  SHOTS.push({
    file,
    group,
    caption,
    width,
    height,
    bytes: bytes.length,
    ok,
    cropped: area !== null,
  });
  console.log(
    `    ${ok ? "shot" : "THIN"} ${file} — ${width}x${height}, ${(bytes.length / 1024).toFixed(0)} KB`,
  );
  return ok;
}

/** PNG dimensions straight from the IHDR chunk. */
function pngSize(bytes) {
  if (bytes.length < 24) return { width: 0, height: 0 };
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/* -------------------------------------------------------------------------- */
/* Shell state                                                                */
/* -------------------------------------------------------------------------- */

function shellState(page) {
  return page.evaluate(
    () => document.querySelector("[data-volli-shell]")?.getAttribute("data-volli-shell") ?? null,
  );
}

/** The shell's left-edge facts, read off the live DOM rather than assumed. */
function edgeGeometry(page) {
  return page.evaluate(() => {
    const rail = document.querySelector("[data-workspace-rail]");
    const panel = document.querySelector('[data-slot="sidebar"][class*="absolute"]');
    return {
      shell: document.querySelector("[data-volli-shell]")?.getAttribute("data-volli-shell") ?? null,
      railWidth: Math.round(rail?.getBoundingClientRect().width ?? -1),
      panelLeft: Math.round(panel?.getBoundingClientRect().left ?? -1),
      // The sliver is the only `pointer-events-none` z-30 strip with a child
      // pill; count it rather than guess at its class.
      sliverCount: document.querySelectorAll(
        "div.pointer-events-none.absolute.z-30 > div.rounded-full",
      ).length,
    };
  });
}

/** The floating/docked panel's rect, for a pane-tight crop. */
async function paneRect(page) {
  const box = await page.locator('[data-slot="sidebar"][class*="absolute"]').first().boundingBox();
  if (box === null) return null;
  return { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 };
}

/* -------------------------------------------------------------------------- */
/* Crops                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A rect around `box`, padded, so a crop never shaves the thing it is framing.
 * `top` is separate because a menu's own TRIGGER sits above it, and a menu shot
 * that cuts the control it hangs from shows the reader half a gesture.
 */
function padded(box, pad = 12, top = pad) {
  return box === null
    ? null
    : {
        x: box.x - pad,
        y: box.y - top,
        width: box.width + pad * 2,
        height: box.height + top + pad,
      };
}

/** Whatever Radix has portalled — a dropdown, a context menu, a popover. */
async function overlayBox(page) {
  return page.locator("[data-radix-popper-content-wrapper]").last().boundingBox();
}

async function menuCrop(page) {
  return padded(await overlayBox(page), 18, 52);
}

async function popoverCrop(page) {
  return padded(await overlayBox(page), 16);
}

async function dialogCrop(page) {
  return padded(await page.getByRole("dialog").first().boundingBox(), 18);
}

/**
 * The split control's two halves plus a generous margin — a full-window shot of
 * a 96px pill in a 1408px window shows a person nothing.
 */
async function splitSeam(page, scope = page) {
  const chat = scope.getByRole("button", { name: "New chat", exact: true }).first();
  const caret = scope.getByRole("button", { name: "Other session kinds", exact: true }).first();
  const [chatBox, caretBox, tabsBox] = await Promise.all([
    chat.boundingBox(),
    caret.boundingBox(),
    scope.locator('[role="tablist"]').first().boundingBox(),
  ]);
  if (chatBox === null || caretBox === null) {
    return { ok: false, detail: "a half had no box", crop: null };
  }
  const gap = caretBox.x - (chatBox.x + chatBox.width);
  // Framed from the TABS across to the control. The control sits at the strip's
  // right edge, so padding it alone shows a pill floating in nothing — and the
  // tabs are what make its scale legible (h-6 beside h-7/h-8 is the whole
  // reason this placement takes the smaller size).
  const left = Math.min(tabsBox?.x ?? chatBox.x, chatBox.x) - 16;
  const right = caretBox.x + caretBox.width + 16;
  return {
    // Disjoint, touching, and the caret is the narrow one — the geometry a
    // picture alone cannot settle.
    ok: gap >= 0 && gap <= 3 && caretBox.width <= 20 && caretBox.width < chatBox.width,
    detail: `chat=${chatBox.width.toFixed(1)} caret=${caretBox.width.toFixed(1)} gap=${gap.toFixed(1)}`,
    crop: {
      x: left,
      y: Math.min(tabsBox?.y ?? chatBox.y, chatBox.y) - 14,
      width: right - left,
      height: Math.max(tabsBox?.height ?? 0, chatBox.height) + 28,
    },
  };
}

/** The empty Sessions surface's glyph + copy + control, framed together. */
async function emptyStateCrop(page) {
  const box = await page.getByText("No open sessions.").first().boundingBox();
  return box === null
    ? null
    : { x: box.x - 150, y: box.y - 70, width: box.width + 300, height: box.height + 150 };
}

/**
 * An interaction card. `border-primary/40` is its own root class
 * (interaction-ui.tsx) and the only stable handle this surface offers — it has
 * no test id, and the filled palm inside it is a path rather than an attribute.
 */
function interactionCard(page) {
  return page.locator('[class*="border-primary/40"]');
}

async function interactionCrop(page) {
  return padded(await interactionCard(page).first().boundingBox(), 26);
}

/** The Stop button — on screen for exactly as long as a turn is running. */
function stopButton(page) {
  return page.getByRole("button", { name: "Stop", exact: true });
}

/**
 * What the transcript actually drew. `group/row` is the activity row's own
 * wrapper class (activity-ui.tsx) and the nearest thing this surface has to a
 * test id; a census over it is what separates "a transcript rendered" from "a
 * turn ran and produced prose only", which look identical in a screenshot that
 * failed.
 */
function transcriptCensus(page) {
  return page.evaluate(() => ({
    rows: document.querySelectorAll('[class*="group/row"]').length,
    assistant: document.querySelectorAll(".is-assistant").length,
    // Phosphor draws fill and regular as different PATHS rather than as an
    // attribute, so the only readable proxy for "a filled mark is on screen" is
    // the ember ink the exceptions are drawn in.
    filled: Array.from(document.querySelectorAll("svg")).filter((svg) =>
      svg.closest(".text-primary"),
    ).length,
    interactions: document.querySelectorAll('[class*="border-primary"]').length,
  }));
}

/** The union of the activity rows, which is the column worth cropping to. */
function transcriptCrop(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[class*="group/row"]'));
    if (rows.length === 0) return null;
    const boxes = rows.map((row) => row.getBoundingClientRect()).filter((box) => box.height > 0);
    if (boxes.length === 0) return null;
    const top = Math.min(...boxes.map((box) => box.top));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    const left = Math.min(...boxes.map((box) => box.left));
    const right = Math.max(...boxes.map((box) => box.right));
    return {
      x: Math.max(0, left - 24),
      y: Math.max(0, top - 24),
      width: right - left + 48,
      height: Math.min(bottom - top + 48, window.innerHeight - Math.max(0, top - 24)),
    };
  });
}

/** Menu rows in order, with whatever chord each announces. */
function menuRows(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="dropdown-menu-item"]')).map((item) => {
      const shortcut = item.querySelector('[data-slot="dropdown-menu-shortcut"]');
      return {
        label: (item.textContent ?? "").replace(shortcut?.textContent ?? "", "").trim(),
        chord: shortcut?.textContent ?? null,
      };
    }),
  );
}

/**
 * Whether the composer's chip row spilled onto a second line — the branch-pair
 * wrap the implementation flagged as an open question. Measured by counting
 * distinct chip tops, because `flex-wrap` leaves no attribute behind.
 */
function chipRowWrap(page) {
  return page.evaluate(() => {
    const branch = document.querySelector('button[aria-label="Base branch"]');
    const row = branch?.closest(".flex.flex-wrap") ?? null;
    if (row === null) return { wrapped: false, lines: 0 };
    const tops = new Set(
      Array.from(row.querySelectorAll(":scope > *, :scope > div > button")).map((node) =>
        Math.round(node.getBoundingClientRect().top),
      ),
    );
    return { wrapped: tops.size > 1, lines: tops.size };
  });
}

/** Land on a primary nav page, from wherever we are. */
async function gotoNav(page, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  if ((await button.count()) === 0) return;
  await button.first().click();
  await sleep(900);
}

/**
 * Spread the seeded Sessions back across a few days, in SQL, between the two
 * launches.
 *
 * Every seeded row is seconds old, and a Previous band whose every age reads
 * "now" photographs the one thing this branch's row geometry is about — the
 * `3ch` tabular column — showing none of its range. The offsets stay well inside
 * `PREVIOUS_MAX_AGE_MS`: past seven days cleanup rule (d) fires and the whole
 * band ghosts, which is a different shot than the one wanted.
 *
 * Each Session is SHIFTED rather than stamped, and EVERY session-scoped
 * timestamp in the schema moves by the same delta — discovered from
 * `PRAGMA table_info` rather than listed here. Migration 018 made `sessions` an
 * identity-only ledger, so a Session's "when" is spread across the event log,
 * the command log and their receipts; a first attempt moved three columns it
 * had picked by hand and the ledger dropped all seventeen Sessions on the next
 * read, because a durable history whose parts disagree is corruption and this
 * ledger fails loudly on it rather than guessing. Shifting the whole Session by
 * one delta keeps every internal relation exactly as the app wrote it, and
 * asking the schema which columns those are means a new dated table cannot
 * silently fall out of the set.
 *
 * Shifting BACKWARD also strengthens the ghost rule rather than disturbing it:
 * rule (c) wants `createdAt < statusEnteredAt`, and the tickets moved seconds
 * before this runs.
 */
async function backdateSessions(path) {
  const MINUTE = 60_000;
  // A plausible spread: a couple of live-feeling minutes, an afternoon, then
  // days — which is what puts "3m" and "2d" in one right-aligned column.
  const offsets = [
    3, 11, 26, 48, 95, 140, 190, 260, 320, 400, 520, 700, 1000, 1500, 2200, 3200, 4300,
  ].map((minutes) => minutes * MINUTE);
  const sql = (statements) => execFileAsync("sqlite3", [path, statements]);
  const read = async (statements) => (await sql(statements)).stdout;

  const ids = (await read("SELECT id FROM sessions ORDER BY created_at DESC;"))
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (ids.length === 0) return { ok: false, detail: "no sessions to back-date" };

  // Every table that dates a Session, and the columns in it that hold a stamp.
  const tables = (
    await read("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session%';")
  )
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const dated = [];
  for (const table of tables) {
    const columns = (await read(`PRAGMA table_info(${table});`))
      .split("\n")
      .map((line) => line.split("|")[1])
      .filter((column) => column !== undefined && column.endsWith("_at"));
    if (columns.length === 0) continue;
    const key = table === "sessions" ? "id" : "session_id";
    const hasKey = (await read(`PRAGMA table_info(${table});`)).includes(`|${key}|`);
    if (hasKey) dated.push({ table, columns, key });
  }

  const statements = ids.flatMap((id, index) => {
    const delta = offsets[index % offsets.length] ?? 60 * MINUTE;
    return [
      // A receipt's stamp is written TWICE — once in the event's envelope
      // column and once inside its JSON payload — and `assertEvent` refuses any
      // event where the two disagree. So the payload copy moves first, off its
      // own current value, and the envelope column follows below.
      `UPDATE session_events
          SET payload = json_set(payload, '$.receipt.recordedAt',
                                 json_extract(payload, '$.receipt.recordedAt') - ${delta})
        WHERE session_id = '${id}'
          AND json_extract(payload, '$.kind') = 'command.receipt.recorded';`,
      ...dated.map(
        ({ table, columns, key }) =>
          `UPDATE ${table} SET ${columns.map((column) => `${column} = ${column} - ${delta}`).join(", ")} WHERE ${key} = '${id}';`,
      ),
    ];
  });
  await sql(statements.join("\n"));
  return {
    ok: true,
    detail: `${ids.length} sessions over ${(offsets.at(-1) / 3_600_000).toFixed(0)}h · shifted ${dated.map((entry) => `${entry.table}(${entry.columns.join(",")})`).join(" ")}`,
  };
}

async function setPinned(page, pinned) {
  const wanted = pinned ? "framed" : "ephemeral";
  if ((await shellState(page)) === wanted) return;
  await page
    .getByRole("button", { name: "Toggle navigation sidebar", exact: true })
    .first()
    .click();
  await waitUntil(`shell ${wanted}`, async () => (await shellState(page)) === wanted);
  await sleep(400);
}

async function setRailHidden(page, hidden) {
  const label = hidden ? "Hide workspace switcher" : "Show workspace switcher";
  const button = page.getByRole("button", { name: label, exact: true });
  if ((await button.count()) === 0) return;
  await button.first().click();
  await sleep(400);
}

/** Park the pointer somewhere no hover rule cares about. */
async function parkPointer(page) {
  await page.mouse.move(viewport.width - 60, viewport.height - 60, { steps: 8 });
}

/**
 * Summon the panel the way a person does: travel to the arming strip and stay
 * there. The strip is 8px wide starting at the rail's right edge, and dead for
 * the first 24px under the chrome band — so the approach is horizontal at
 * mid-height, never down the edge, which is the one path the dwell cannot tell
 * from intent.
 */
async function revealByHover(page, { railVisible }) {
  const x = (railVisible ? 60 : 0) + 4;
  const y = Math.round(viewport.height / 2);
  await page.mouse.move(viewport.width - 200, y, { steps: 4 });
  await sleep(300);
  await page.mouse.move(x + 120, y, { steps: 12 });
  await page.mouse.move(x, y, { steps: 10 });
  await sleep(120);
  // Nudge inside the strip so a single settled sample cannot be the only one.
  await page.mouse.move(x + 1, y + 6, { steps: 2 });
  return waitUntil(
    "panel revealed",
    async () => {
      const left = (await edgeGeometry(page)).panelLeft;
      return left >= 0 && left < viewport.width / 2;
    },
    { timeout: 4000 },
  )
    .then(() => true)
    .catch(() => false);
}

/** Scroll the sidebar's own scroll area and report whether it had anywhere to go. */
async function scrollPreviousBand(page) {
  const box = await page.locator('[data-slot="sidebar"][class*="absolute"]').first().boundingBox();
  if (box !== null) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7, { steps: 8 });
    await sleep(200);
    await page.mouse.wheel(0, 320);
    await sleep(120);
    await page.mouse.wheel(0, 220);
    await sleep(150);
  }
  return page.evaluate(() => {
    const area = Array.from(document.querySelectorAll("div")).find((node) => {
      const style = getComputedStyle(node);
      return (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        node.scrollHeight - node.clientHeight > 20 &&
        node.closest('[data-slot="sidebar"]') !== null
      );
    });
    return area === undefined
      ? { scrollable: false, top: 0, max: 0 }
      : {
          scrollable: true,
          top: Math.round(area.scrollTop),
          max: Math.round(area.scrollHeight - area.clientHeight),
        };
  });
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Give the fixture repo a branch list worth photographing AND a real remote,
 * because the composer's base picker draws its two groups off exactly that:
 * `refs/heads` under BRANCHES, `refs/remotes` under REMOTE, and the remote
 * heading's age off `FETCH_HEAD`'s mtime — which only a real `git fetch`
 * creates.
 */
async function seedBranches(repo, parent) {
  const run = (args, cwd = repo) => execFileAsync("git", args, { cwd });
  const upstream = join(parent, "voltaic-origin.git");
  await execFileAsync("git", ["init", "--bare", "-q", upstream]);
  const head = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  for (const branch of [
    "feature/ring-buffer",
    "feature/worktree-retention",
    "fix/stale-base",
    "chore/coverage-gate",
  ]) {
    await run(["branch", branch]);
  }
  await run(["remote", "add", "origin", upstream]);
  await run(["push", "-q", "origin", `${head}:${head}`, "feature/ring-buffer:feature/ring-buffer"]);
  await run(["fetch", "-q", "origin"]);
}

/* -------------------------------------------------------------------------- */
/* Contact sheet                                                              */
/* -------------------------------------------------------------------------- */

/** Caption text is author-written, but it goes into markup all the same. */
function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The scrollable review page. Written from {@link SHOTS} so a shot can never be
 * on disk without a caption, and rewritten on every run — including a crashed
 * one, which is why it is in the `finally`.
 */
async function writeIndex() {
  const sections = GROUPS.map((group) => {
    // By FILENAME, not by capture order. The `NN-` prefix is the review order,
    // and the run walks the surfaces in whatever order is cheapest to reach —
    // the composer's four shots, for one, are taken 40/42/44/43/41 because the
    // expanded frame is the last thing the dialog can be put into.
    const shots = SHOTS.filter((shot) => shot.group === group.key).toSorted((a, b) =>
      a.file.localeCompare(b.file),
    );
    const body =
      group.empty === true
        ? `<p class="none">Nothing to show — deliberately, not a gap in this sheet.</p>`
        : shots.length === 0
          ? `<p class="none">No shots landed for this group in the last run.</p>`
          : shots
              .map(
                (shot) => `
        <figure${shot.ok ? "" : ' class="thin"'}>
          <img src="${shot.file}" alt="${escape(shot.caption.slice(0, 120))}" loading="lazy" />
          <figcaption>
            <span class="file">${shot.file}</span>
            <p>${escape(shot.caption)}</p>
            <span class="meta">${shot.width}×${shot.height} · ${(shot.bytes / 1024).toFixed(0)} KB${shot.cropped ? " · crop" : ""}${shot.ok ? "" : " · SUSPICIOUSLY SMALL"}</span>
          </figcaption>
        </figure>`,
              )
              .join("\n");
    return `
    <section id="${group.key}">
      <h2>${escape(group.title)}</h2>
      <p class="blurb">${escape(group.blurb)}</p>
      ${body}
    </section>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Volli · ui/cleanup-pass-v1 — live screenshots</title>
<style>
  :root { color-scheme: dark; --ink: #ECE9E4; --mute: #9A948C; --edge: #2A2724; --ember: #E8652A; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 64px 32px 160px; background: #121110; color: var(--ink);
    font: 400 16px/1.6 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
  }
  main { max-width: 1180px; margin: 0 auto; }
  header { margin-bottom: 72px; }
  h1 { font-size: 34px; line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.01em; }
  header p { color: var(--mute); max-width: 68ch; margin: 0 0 6px; }
  nav { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 10px; }
  nav a {
    color: var(--ink); text-decoration: none; font-size: 14px;
    border: 1px solid var(--edge); border-radius: 999px; padding: 6px 14px;
  }
  nav a:hover { border-color: var(--ember); color: var(--ember); }
  section { margin: 0 0 96px; scroll-margin-top: 32px; }
  h2 { font-size: 24px; margin: 0 0 10px; letter-spacing: -0.01em; }
  .blurb { color: var(--mute); max-width: 76ch; margin: 0 0 40px; }
  .none { color: var(--mute); font-style: italic; }
  figure { margin: 0 0 56px; }
  figure img {
    display: block; width: 100%; height: auto; border-radius: 10px;
    border: 1px solid var(--edge); background: #000;
  }
  figure.thin img { border-color: #7A2B18; }
  figcaption { margin-top: 14px; }
  figcaption p { margin: 6px 0; color: var(--ink); max-width: 82ch; }
  .file { font: 500 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ember); }
  .meta { font: 400 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--mute); }
</style>
</head>
<body>
<main>
  <header>
    <h1>ui/cleanup-pass-v1 — live screenshots</h1>
    <p>Every shot below came out of the real built Electron app, captured from the composited window
       at 2&times; through <code>webContents.capturePage()</code>. Nothing is a mock and nothing is
       from the UI lab.</p>
    <p>Reproduce with <code>env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/ui-cleanup-shots.mjs</code>.</p>
    <nav>${GROUPS.map((group) => `<a href="#${group.key}">${escape(group.title)}</a>`).join("")}</nav>
  </header>
${sections}
</main>
</body>
</html>
`;
  await fs.writeFile(join(SHOT_DIR, "index.html"), html);
}
