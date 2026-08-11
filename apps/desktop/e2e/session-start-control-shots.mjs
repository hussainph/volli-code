/**
 * Visual + behavioral proof for the split session-start control.
 *
 * The control is one component drawn in three rooms (the Sessions strip, the
 * ticket tab strip, the ticket rail) and the questions a screenshot alone can't
 * settle are geometric and behavioral: are the two halves SEPARATE hit targets,
 * does each fire its own act, does the caret segment actually take the narrow
 * width its class asks for, and does ⌘T / ⌥⌘T reach the app at all. So every
 * shot here is paired with a measurement or a click.
 *
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/session-start-control-shots.mjs
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedDefaultModel,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const SHOT_DIR = "/tmp/session-start-control-shots";

const CHAT = { name: "New chat", exact: true };
const CARET = { name: "Other session kinds", exact: true };

/** Both halves' boxes, so "separate hit targets" is measured and not eyeballed. */
async function halves(scope) {
  const chat = scope.getByRole("button", CHAT).first();
  const caret = scope.getByRole("button", CARET).first();
  await waitUntil("control on screen", async () => (await chat.count()) >= 1);
  return { chat, caret, chatBox: await chat.boundingBox(), caretBox: await caret.boundingBox() };
}

/** Disjoint, touching, and the caret is the narrow one. */
function seamIsSound({ chatBox, caretBox }) {
  if (!chatBox || !caretBox) return { ok: false, detail: "a half had no box" };
  const gap = caretBox.x - (chatBox.x + chatBox.width);
  const sameRow = Math.abs(chatBox.y - caretBox.y) < 1;
  const sameHeight = Math.abs(chatBox.height - caretBox.height) < 1;
  return {
    // The divider is a 1px span between them, so a small positive gap is the
    // seam; anything larger is two buttons that merely sit near each other.
    ok:
      gap >= 0 &&
      gap <= 3 &&
      sameRow &&
      sameHeight &&
      caretBox.width <= 20 &&
      caretBox.width < chatBox.width,
    detail: `chat=${chatBox.width.toFixed(1)}x${chatBox.height.toFixed(1)} caret=${caretBox.width.toFixed(1)}x${caretBox.height.toFixed(1)} gap=${gap.toFixed(1)} sameRow=${sameRow}`,
  };
}

async function shoot(target, name) {
  const path = join(SHOT_DIR, `${name}.png`);
  await target.screenshot({ path });
  const stat = await fs.stat(path);
  return { ok: stat.size > 1000, detail: path };
}

/** Menu rows in order, with whatever chord each announces. */
async function menuRows(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="dropdown-menu-item"]')).map((item) => {
      const shortcut = item.querySelector('[data-slot="dropdown-menu-shortcut"]');
      return {
        label: (item.textContent ?? "").replace(shortcut?.textContent ?? "", "").trim(),
        chord: shortcut?.textContent ?? null,
        tracking: shortcut ? getComputedStyle(shortcut).letterSpacing : null,
      };
    }),
  );
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-split-shots-");
const { attempt, summarize } = createRunner();

await fs.mkdir(SHOT_DIR, { recursive: true });

const projectDir = await makeGitRepo(scratch, "split-proj-");
const app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("app surface", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );

  await seedProjects(page, [
    { id: "split-proj", name: "Split Shots", path: projectDir, prefix: "SS" },
  ]);
  // Every structured Session needs an app-wide default model before it can
  // start, so without this the chat half is refused before it reaches anything
  // this smoke is about. Needs real Pi credentials on the machine.
  await seedDefaultModel(page);

  const ticket = await page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) throw new Error(boot.error);
    const project = boot.data.projects[0];
    if (!project) throw new Error("no project");
    const created = await window.api.tickets.create({
      projectId: project.id,
      status: "todo",
      title: "Split control visual proof",
      body: "Nothing to read here.",
      priority: "medium",
    });
    if (!created.ok) throw new Error(created.error);
    return { displayId: `${project.ticketPrefix}-${created.ticket.ticketNumber}` };
  });

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  /* ---------------------------------------------------------------- */
  /* Sessions surface — the global mount, the one that announces ⌘T    */
  /* ---------------------------------------------------------------- */

  const sessionsNav = page.getByRole("button", { name: "Sessions", exact: true });
  if (await sessionsNav.count()) await sessionsNav.first().click();
  await sleep(1500);

  await attempt("sessions", "split reads as one pill with two targets", async () => {
    const measured = await halves(page);
    const verdict = seamIsSound(measured);
    await shoot(page, "sessions-strip-closed");
    return verdict;
  });

  await attempt("sessions", "caret half opens the menu, Chat above Terminal", async () => {
    const { caret } = await halves(page);
    await caret.click();
    await waitUntil("menu open", async () => (await menuRows(page)).length >= 2);
    const rows = await menuRows(page);
    await shoot(page, "sessions-strip-open");
    await page.keyboard.press("Escape");
    return {
      ok:
        rows.length === 2 &&
        rows[0].label === "Chat" &&
        rows[1].label === "Terminal" &&
        rows[0].chord === "⌘T" &&
        rows[1].chord === "⌥⌘T" &&
        // The primitive fix: no trailing letter-spacing pushing the chord
        // column off the flush right edge `ml-auto` promised.
        rows.every((row) => row.tracking === "normal" || row.tracking === "0px"),
      detail: JSON.stringify(rows),
    };
  });

  await attempt("sessions", "label half starts a CHAT in one press", async () => {
    const chatTab = page.getByRole("tab", { name: /^Chat/ });
    const before = await chatTab.count();
    const { chat } = await halves(page);
    await chat.click();
    const grew = await waitUntil(
      "a chat tab appeared",
      async () => (await chatTab.count()) > before,
      { timeout: 20000 },
    )
      .then(() => true)
      .catch(() => false);
    const labels = await page.getByRole("tab").allInnerTexts();
    // A failed create toasts rather than silently doing nothing (CLAUDE.md), so
    // read the toast: it separates "the control didn't fire" from "the Session
    // edge refused", which look identical from the tab count alone.
    const toasts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-sonner-toast]")).map(
        (node) => node.textContent ?? "",
      ),
    );
    return {
      ok: grew,
      detail: `chats ${before}→${await chatTab.count()} · tabs: ${labels.join(" | ")} · toasts: ${toasts.join(" / ") || "none"}`,
    };
  });

  // The chord's own chain — predicate, landing, nav — proved WITHOUT depending
  // on a Session actually booting: a create needs the Session edge, and the one
  // fact a chord must always produce is that it moved the app to the surface
  // its Session lands on.
  await attempt("chord", "⌘T from the Board lands on Sessions", async () => {
    const boardNav = page.getByRole("button", { name: "Board", exact: true });
    if (await boardNav.count()) await boardNav.first().click();
    await sleep(700);
    const onBoard = await page.getByRole("button", { name: "New ticket", exact: true }).count();
    await page.keyboard.press("Meta+t");
    const landed = await waitUntil(
      "sessions surface in front",
      async () => (await page.getByRole("button", CARET).count()) >= 1,
      { timeout: 10000 },
    )
      .then(() => true)
      .catch(() => false);
    await shoot(page, "sessions-after-chord");
    return { ok: onBoard === 1 && landed, detail: `wasOnBoard=${onBoard === 1} landed=${landed}` };
  });

  await attempt("chord", "⌥⌘T starts a terminal without touching the pointer", async () => {
    const before = await page.getByRole("tab").count();
    await page.keyboard.press("Alt+Meta+t");
    const grew = await waitUntil(
      "chord opened a tab",
      async () => (await page.getByRole("tab").count()) > before,
      { timeout: 20000 },
    )
      .then(() => true)
      .catch(() => false);
    return { ok: grew, detail: `tabs ${before}→${await page.getByRole("tab").count()}` };
  });

  /* ---------------------------------------------------------------- */
  /* Ticket surfaces — scoped mounts, which must NOT claim the chord   */
  /* ---------------------------------------------------------------- */

  /** Walk to this ticket's detail from wherever we are. */
  async function openTicket() {
    if ((await page.locator("aside").count()) >= 1) return;
    const boardNav = page.getByRole("button", { name: "Board", exact: true });
    if (await boardNav.count()) await boardNav.first().click();
    await sleep(800);
    const card = page.locator("article").filter({
      has: page.locator("span.font-mono", { hasText: new RegExp(`^${ticket.displayId}$`) }),
    });
    await waitUntil("board card", async () => (await card.count()) === 1);
    await card.dblclick();
    await waitUntil("ticket detail", async () => (await page.locator("aside").count()) >= 1);
    await sleep(600);
  }

  await attempt("ticket", "rail and tab strip carry the same control, unchorded", async () => {
    await openTicket();
    const aside = page.locator("aside");
    const rail = await halves(aside);
    const railVerdict = seamIsSound(rail);
    // Two mounts VISIBLE at once (rail + tab strip). `getByRole` skips the
    // always-mounted Sessions strip, which is `hidden` behind this page and so
    // out of the a11y tree — a raw attribute locator would have counted it.
    const mounts = page.getByRole("button", CHAT);
    const chatCount = await mounts.count();
    const chordClaims = (
      await mounts.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-keyshortcuts")))
    ).filter((value) => value !== null);
    await shoot(page, "ticket-detail");
    await shoot(aside, "ticket-rail-control");
    return {
      ok: railVerdict.ok && chatCount === 2 && chordClaims.length === 0,
      detail: `${railVerdict.detail} mounts=${chatCount} keyshortcuts=${chordClaims.length}`,
    };
  });

  await attempt("ticket", "rail caret still reaches a terminal in two presses", async () => {
    await openTicket();
    const aside = page.locator("aside");
    const { caret } = await halves(aside);
    await caret.click();
    await waitUntil("menu open", async () => (await menuRows(page)).length >= 2);
    const rows = await menuRows(page);
    await shoot(page, "ticket-rail-open");
    // Escape closes the menu — and, here, the ticket behind it. The next check
    // re-opens the ticket rather than fighting that; a second click on the
    // trigger cannot work, since an open Radix menu `aria-hidden`s the page
    // and takes its own trigger out of the a11y tree.
    await page.keyboard.press("Escape");
    return {
      ok:
        rows.length === 2 &&
        rows[0].label === "Chat" &&
        rows[1].label === "Terminal" &&
        // Scoped mount: the items must not announce the global chord.
        rows.every((row) => row.chord === null),
      detail: JSON.stringify(rows),
    };
  });

  await attempt("chord", "⌘T inside a ticket is still global — the user's ruling", async () => {
    // Ticket detail is a STATE of the board nav, so this is the case the
    // rejected reading would have made ticket-scoped. Runs last of the ticket
    // group because passing means leaving the ticket.
    await openTicket();
    const inTicket = await page.locator("aside").count();
    await page.keyboard.press("Meta+t");
    const leftTheTicket = await waitUntil(
      "sessions surface in front",
      async () => (await page.getByRole("button", CARET).count()) === 1,
      { timeout: 10000 },
    )
      .then(() => true)
      .catch(() => false);
    await shoot(page, "chord-from-ticket");
    return {
      ok: inTicket >= 1 && leftTheTicket,
      detail: `wasInTicket=${inTicket >= 1} landedOnSessions=${leftTheTicket}`,
    };
  });

  /* ---------------------------------------------------------------- */
  /* The two states a static shot of the resting strip cannot show     */
  /* ---------------------------------------------------------------- */

  await attempt("hover", "the seam reads when one half is pointed at", async () => {
    const sessionsNavAgain = page.getByRole("button", { name: "Sessions", exact: true });
    if (await sessionsNavAgain.count()) await sessionsNavAgain.first().click();
    await sleep(900);
    const { chat, caret } = await halves(page);
    await chat.hover();
    await sleep(200);
    const onLabel = await shoot(page, "hover-label-half");
    await caret.hover();
    await sleep(200);
    const onCaret = await shoot(page, "hover-caret-half");
    // Hovering one half must not paint the other: that is what says "two
    // targets" without a border doing the talking.
    const [labelBg, caretBg] = await Promise.all([
      chat.evaluate((n) => getComputedStyle(n).backgroundColor),
      caret.evaluate((n) => getComputedStyle(n).backgroundColor),
    ]);
    return {
      ok: onLabel.ok && onCaret.ok && labelBg !== caretBg,
      detail: `label=${labelBg} caret=${caretBg}`,
    };
  });

  await attempt("empty", "the solid drawing on an empty surface", async () => {
    // The surface auto-opens one terminal on first visit, so an empty strip is
    // only reachable by closing what is there.
    for (let guard = 0; guard < 12; guard += 1) {
      const closers = page.getByRole("button", { name: /^Close / });
      if ((await closers.count()) === 0) break;
      await closers.first().click();
      await sleep(400);
    }
    await waitUntil("empty surface", async () => (await page.getByRole("tab").count()) === 0, {
      timeout: 10000,
    });
    await sleep(400);
    const { chatBox, caretBox } = await halves(page);
    const shot = await shoot(page, "empty-surface");
    return {
      ok: shot.ok && chatBox !== null && caretBox !== null,
      detail: `${shot.detail} chat=${chatBox?.width.toFixed(1)}x${chatBox?.height.toFixed(1)} caret=${caretBox?.width.toFixed(1)}`,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Light appearance — the control is drawn in both                   */
  /* ---------------------------------------------------------------- */

  await attempt("light", "the pill survives a light canvas", async () => {
    const written = await page.evaluate(() => window.api.theme.setGlobalAppearance("light"));
    if (!written.ok) return { ok: false, detail: written.error };
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("light stamped", () =>
      page.evaluate(() => document.documentElement.classList.contains("light")),
    );
    await sleep(1200);
    return shoot(page, "light");
  });
} finally {
  await app.close().catch(() => {});
  await cleanup().catch(() => {});
}

summarize("session-start control");
