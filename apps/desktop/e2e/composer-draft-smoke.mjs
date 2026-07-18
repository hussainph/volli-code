/**
 * RED-phase acceptance smoke for the New-ticket composer's DRAFT persistence —
 * Linear-style implicit save of in-progress work, so an accidental Escape /
 * overlay click / app quit never destroys what was typed.
 *
 * Spec being built (follow-up to the ui/ticket-creation-fix composer):
 *   • While composing, the full draft (target project, status, priority, title,
 *     body, labels, worktree toggle) is cached continuously through the
 *     app_state kv layer (SQLite-backed, debounced).
 *   • ANY close — Escape, overlay click, the Close button — keeps the draft;
 *     the next open restores every field.
 *   • A successful Create (or kickoff) CLEARS the draft: the next open is blank.
 *   • A draft with content (title, body, or labels) survives a full app
 *     relaunch; chip-only fiddling (no content) is not a draft.
 *
 * Drives the REAL built app (shared machinery in ./lib/smoke-kit.mjs) against a
 * scratch SQLite DB + isolated profile. Written BEFORE the feature exists, so
 * the restore checks are EXPECTED TO FAIL now — cleanly, never by crashing.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/composer-draft-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import {
  assertProfileIsolated,
  createRunner,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-composer-draft-smoke-");
const { attempt, summarize } = createRunner();

const PROJECT_ALPHA = { id: "draft-alpha", name: "Alpha Project", prefix: "AL" };
const PROJECT_BETA = { id: "draft-beta", name: "Beta Project", prefix: "BE" };

const DRAFT = {
  title: "Drafted ticket OMEGA",
  body: "Draft body marker OMEGA-1",
  label: "draftlabel",
};

// ---- composer DOM helpers ---------------------------------------------------

const composer = (page) => page.locator('[data-testid="new-ticket-composer"]');
const projectChip = (page) => page.locator('[data-testid="composer-project-chip"]');
const titleInput = (page) => composer(page).getByPlaceholder("Ticket title");

async function openComposerViaHeader(page) {
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await sleep(350);
  return (await composer(page).count()) === 1;
}

async function closeAnyDialog(page) {
  if ((await page.getByRole("dialog").count()) === 0) return;
  await page.keyboard.press("Escape");
  await waitUntil("dialog to close", async () => (await page.getByRole("dialog").count()) === 0, {
    timeout: 3000,
  }).catch(() => {});
}

/** Snapshot the restorable field state of the OPEN composer. */
async function readComposerState(page) {
  const chipText = (await projectChip(page).textContent()) ?? "";
  const title = await titleInput(page).inputValue();
  const bodyText = (await composer(page).locator(".cm-content").textContent()) ?? "";
  const statusTodo = await composer(page).getByRole("button", { name: "Todo" }).count();
  const statusBacklog = await composer(page).getByRole("button", { name: "Backlog" }).count();
  const priorityHigh = await composer(page).getByRole("button", { name: "High" }).count();
  const priorityMedium = await composer(page).getByRole("button", { name: "Medium" }).count();
  return { chipText, title, bodyText, statusTodo, statusBacklog, priorityHigh, priorityMedium };
}

async function ticketsFor(page, projectId) {
  return page.evaluate(async (id) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return [];
    return boot.data.ticketsByProject?.[id] ?? [];
  }, projectId);
}

// ---- main -------------------------------------------------------------------

async function main() {
  let app = await launch({ dbPath, userDataDir });
  try {
    await assertProfileIsolated(app, userDataDir);
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const alphaPath = await makeGitRepo(scratch, "alpha-");
    const betaPath = await makeGitRepo(scratch, "beta-");
    await seedProjects(page, [
      { ...PROJECT_ALPHA, path: alphaPath },
      { ...PROJECT_BETA, path: betaPath },
    ]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const alphaId = byName[PROJECT_ALPHA.name]?.id;
    const betaId = byName[PROJECT_BETA.name]?.id;
    if (!alphaId || !betaId) throw new Error("seeded projects missing after import");

    // === 1. Escape keeps the draft; reopen restores EVERY field ==============
    await attempt(
      1,
      "Escape mid-compose keeps the draft: reopening restores target project (Beta), Status=Todo, Priority=High, title and body",
      async () => {
        const opened = await openComposerViaHeader(page);
        if (!opened) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer did not open" };
        }
        // Retarget to Beta + set chips + type content.
        await projectChip(page).click();
        await sleep(200);
        await page.getByRole("menuitem", { name: PROJECT_BETA.name, exact: true }).click();
        await sleep(200);
        await composer(page).getByRole("button", { name: "Backlog" }).click();
        await sleep(150);
        await page.getByRole("menuitemradio", { name: "Todo", exact: true }).click();
        await composer(page).getByRole("button", { name: "Medium" }).click();
        await sleep(150);
        await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
        await composer(page).getByRole("button", { name: "Labels" }).click();
        await sleep(150);
        await page.getByPlaceholder("Add label…").fill(DRAFT.label);
        await page.keyboard.press("Enter");
        await sleep(200);
        await page.keyboard.press("Escape"); // close the label menu only
        await sleep(200);
        await titleInput(page).fill(DRAFT.title);
        await composer(page).locator(".cm-content").click();
        await page.keyboard.type(DRAFT.body);

        // Accidental Escape.
        await closeAnyDialog(page);
        if ((await composer(page).count()) !== 0) {
          return { ok: false, detail: "composer did not close on Escape" };
        }

        // Reopen → everything restored.
        const reopened = await openComposerViaHeader(page);
        if (!reopened) return { ok: false, detail: "composer did not reopen" };
        const s = await readComposerState(page);
        await closeAnyDialog(page);
        const ok =
          s.chipText.includes(PROJECT_BETA.name) &&
          s.title === DRAFT.title &&
          s.bodyText.includes(DRAFT.body) &&
          s.statusTodo === 1 &&
          s.priorityHigh === 1;
        return {
          ok,
          detail: `chip=${JSON.stringify(s.chipText)} title=${JSON.stringify(s.title)} bodyHasMarker=${s.bodyText.includes(DRAFT.body)} statusTodo=${s.statusTodo} priorityHigh=${s.priorityHigh}`,
        };
      },
    );

    // === 2. Overlay click (the accidental click-outside) also keeps it =======
    await attempt(
      2,
      "Clicking outside the dialog (overlay) keeps the draft, including an edit made after reopening",
      async () => {
        const opened = await openComposerViaHeader(page);
        if (!opened) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer did not open" };
        }
        const editedTitle = `${DRAFT.title} v2`;
        await titleInput(page).fill(editedTitle);
        // Click the overlay well outside the centered dialog.
        await page.mouse.click(8, 400);
        await waitUntil(
          "dialog closes on overlay click",
          async () => (await composer(page).count()) === 0,
          { timeout: 3000 },
        );
        const reopened = await openComposerViaHeader(page);
        if (!reopened) return { ok: false, detail: "composer did not reopen" };
        const title = await titleInput(page).inputValue();
        await closeAnyDialog(page);
        return { ok: title === editedTitle, detail: `title=${JSON.stringify(title)}` };
      },
    );

    // === 3. Create consumes the draft: ticket carries it, next open is blank ==
    await attempt(
      3,
      "Create on a restored draft lands the full ticket (Beta/Todo/High/label/body) and CLEARS the draft — next open is blank with defaults",
      async () => {
        await closeAnyDialog(page); // isolation: a prior check may have left the dialog open
        const opened = await openComposerViaHeader(page);
        if (!opened) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer did not open" };
        }
        // The restored draft (from checks 1-2) is created as-is. Without a
        // restored title the Create button is disabled — bail cleanly rather
        // than clicking into a timeout (red-phase behavior).
        if ((await titleInput(page).inputValue()) === "") {
          await closeAnyDialog(page);
          return { ok: false, detail: "no restored draft to create from (draft feature missing)" };
        }
        await composer(page).getByRole("button", { name: "Create", exact: true }).click();
        await waitUntil(
          "dialog closes after create",
          async () => (await composer(page).count()) === 0,
          { timeout: 4000 },
        );
        const seeded = (await ticketsFor(page, betaId)).find(
          (t) => t.title === `${DRAFT.title} v2`,
        );
        const ticketOk =
          seeded !== undefined &&
          seeded.status === "todo" &&
          seeded.priority === "high" &&
          (seeded.labels ?? []).includes(DRAFT.label) &&
          (seeded.body ?? "").includes(DRAFT.body);

        // Next open: blank, defaults, back on the selected project (Alpha).
        const reopened = await openComposerViaHeader(page);
        if (!reopened) return { ok: false, detail: "composer did not reopen after create" };
        const s = await readComposerState(page);
        await closeAnyDialog(page);
        const blankOk =
          s.title === "" &&
          !s.bodyText.includes(DRAFT.body) &&
          s.statusBacklog === 1 &&
          s.priorityMedium === 1 &&
          s.chipText.includes(PROJECT_ALPHA.name);
        return {
          ok: ticketOk && blankOk,
          detail: `ticket=${ticketOk} (found=${seeded !== undefined} status=${seeded?.status} priority=${seeded?.priority} labels=${JSON.stringify(seeded?.labels)}) blank=${blankOk} (title=${JSON.stringify(s.title)} statusBacklog=${s.statusBacklog} priorityMedium=${s.priorityMedium} chip=${JSON.stringify(s.chipText)})`,
        };
      },
    );

    // === 4. A draft survives a full app relaunch ==============================
    await attempt(
      4,
      "A content-bearing draft survives quitting and relaunching the app",
      async () => {
        await closeAnyDialog(page); // isolation: a prior check may have left the dialog open
        const opened = await openComposerViaHeader(page);
        if (!opened) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer did not open" };
        }
        const restartTitle = "Restart survivor draft";
        await titleInput(page).fill(restartTitle);
        await composer(page).locator(".cm-content").click();
        await page.keyboard.type("Body across restarts DELTA-9");
        // Let the debounced app_state write land in SQLite before quitting.
        await sleep(700);
        await closeAnyDialog(page);
        await app.close();

        app = await launch({ dbPath, userDataDir });
        page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1000);
        await goToBoard(page);
        const reopened = await openComposerViaHeader(page);
        if (!reopened) return { ok: false, detail: "composer did not reopen after relaunch" };
        const title = await titleInput(page).inputValue();
        const bodyText = (await composer(page).locator(".cm-content").textContent()) ?? "";
        await closeAnyDialog(page);
        const ok = title === restartTitle && bodyText.includes("DELTA-9");
        return {
          ok,
          detail: `title=${JSON.stringify(title)} bodyHasMarker=${bodyText.includes("DELTA-9")}`,
        };
      },
    );
  } finally {
    await app.close();
  }
  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
