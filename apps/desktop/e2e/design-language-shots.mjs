/**
 * Visual-verification probe for the spacing/design-language overhaul
 * (docs/DESIGN.md): launches the built app against a scratch DB, seeds a
 * project with a realistic board (several tickets, one with markdown body,
 * labels, and comments), and captures screenshots of the three key surfaces —
 * board, list view, and the ticket-detail Doc tab — at a Linear-ish window
 * size. No assertions beyond "it rendered"; a human judges the shots.
 *
 * This is a MANUALLY-RUN probe (needs a display + the built app); NOT wired
 * into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/design-language-shots.mjs [out-dir]
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron } from "playwright-core";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_DIR = join(REPO, "apps", "desktop");
const ELECTRON = join(
  APP_DIR,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);

const OUT_DIR = process.argv[2] ?? join(APP_DIR, "e2e", "shots");
const SCRATCH = await fs.mkdtemp(join(os.tmpdir(), "volli-design-shots-"));
const USER_DATA_DIR = join(SCRATCH, "user-data");
const DB_PATH = join(SCRATCH, "volli.db");
await fs.mkdir(USER_DATA_DIR, { recursive: true });
await fs.mkdir(OUT_DIR, { recursive: true });
const PROJECT_DIR = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "project-")));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = [
  "Set up the back-end for the AI agent implementation. This includes:",
  "",
  "- Setting up the core agent loop",
  "- Chat storage for each of the tasks",
  "- Adding infrastructure to support plugins and skills",
  "- Running asynchronous agents across multiple tasks at the same time",
  "",
  "We also need to make decisions around agent tooling and read/write search capabilities across the board, plus data scoping and role-based access control.",
  "",
  "```ts",
  "const loop = await agent.run({ ticket, worktree });",
  "```",
].join("\n");

const app = await _electron.launch({
  executablePath: ELECTRON,
  args: [APP_DIR, `--user-data-dir=${USER_DATA_DIR}`],
  env: {
    ...process.env,
    VOLLI_DB_PATH: DB_PATH,
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000);
  await page.setViewportSize({ width: 1680, height: 1000 });

  // Seed the project via the same localStorage-import path the other smokes use.
  await page.evaluate(
    ({ path }) => {
      localStorage.setItem(
        "volli:projects",
        JSON.stringify({
          state: {
            projects: [
              {
                id: "design-shots-project",
                name: "Volli",
                path,
                ticketPrefix: "VC",
                colorIndex: 2,
                createdAt: Date.now(),
              },
            ],
            selectedProjectId: "design-shots-project",
          },
          version: 1,
        }),
      );
    },
    { path: PROJECT_DIR },
  );
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  // Seed a realistic board + one content-rich ticket.
  const seed = await page.evaluate(async (body) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return { ok: false, error: boot.error };
    const project = boot.data.projects[0];
    if (!project) return { ok: false, error: "no project" };
    const mk = (status, title, priority) =>
      window.api.tickets.create({ projectId: project.id, status, title, priority });
    const hero = await mk("doing", "Set up agent database for agent infrastructure", "high");
    if (!hero.ok) return { ok: false, error: hero.error };
    await window.api.tickets.update({ ticketId: hero.ticket.id, body });
    await window.api.tickets.setLabels({
      ticketId: hero.ticket.id,
      labels: ["AI", "Back-end", "Feature"],
    });
    await window.api.comments.create({
      ticketId: hero.ticket.id,
      body: "We should strategize step by step before creating any front-end changes.",
    });
    await mk("backlog", "Bundle the volli CLI with the app", "medium");
    await mk("backlog", "Session transcript indexing", "low");
    await mk("todo", "Native notifications on agent stop", "high");
    await mk("todo", "Worktree setup command per project", "medium");
    await mk("needs_review", "Ghostty config adapter", "medium");
    await mk("done", "Kanban board scaffold", "low");
    return { ok: true, heroId: hero.ticket.id };
  }, BODY);
  if (!seed.ok) throw new Error(`seed failed: ${seed.error}`);

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  // Reports any element that sticks out past the viewport's right edge or has
  // horizontal scroll it shouldn't — the smoking gun for overflow reports.
  async function overflowReport(label) {
    const report = await page.evaluate(() => {
      const vw = window.innerWidth;
      const doc = document.scrollingElement;
      const offenders = [];
      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 || r.left < -1) {
          offenders.push(
            `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 90)} right=${Math.round(r.right)} left=${Math.round(r.left)}`,
          );
        }
        if (offenders.length >= 12) break;
      }
      return { vw, docScrollWidth: doc.scrollWidth, offenders };
    });
    console.log(
      `[overflow:${label}] viewport=${report.vw} docScrollWidth=${report.docScrollWidth}`,
    );
    for (const line of report.offenders) console.log(`  ${line}`);
  }

  // 1. Board (kanban).
  await page.screenshot({ path: join(OUT_DIR, "1-board.png") });
  await overflowReport("board");

  // 2. Ticket detail (Doc tab) — double-click the hero card, then Escape back.
  await page.locator("article", { hasText: "Set up agent database" }).first().dblclick();
  await sleep(1200);
  await page.screenshot({ path: join(OUT_DIR, "3-ticket-detail.png") });
  await overflowReport("ticket-detail");
  const inset = await page.evaluate(() => {
    const el = document.querySelector("main[data-slot='sidebar-inset']");
    if (!el) return "no sidebar-inset found";
    const s = getComputedStyle(el);
    return `margin=${s.margin} radius=${s.borderRadius} border=${s.borderWidth} width=${el.getBoundingClientRect().width}`;
  });
  console.log(`[inset] ${inset}`);
  await page.keyboard.press("Escape");
  await sleep(600);

  // 3. List view — the view toggle in the board header.
  const listToggle = page.getByRole("button", { name: /list/i }).first();
  if ((await listToggle.count()) > 0) {
    await listToggle.click();
    await sleep(600);
    await page.screenshot({ path: join(OUT_DIR, "2-list.png") });
    await overflowReport("list");
  }

  console.log(`shots written to ${OUT_DIR}`);
} finally {
  await app.close().catch(() => {});
  await fs.rm(SCRATCH, { recursive: true, force: true }).catch(() => {});
}
