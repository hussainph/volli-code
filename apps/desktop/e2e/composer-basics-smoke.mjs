/**
 * RED-phase acceptance smoke for the Linear-style New-ticket composer — the
 * *creation* half (kickoff/agent-launch lives in composer-kickoff-smoke.mjs).
 *
 * The composer being built (see the ui/ticket-creation-fix spec) replaces the
 * primitive New-ticket dialog with:
 *   • a header breadcrumb: a project chip (monogram + name,
 *     data-testid="composer-project-chip") → static "New ticket" text, plus
 *     Expand and Close buttons; clicking the chip opens a project menu that
 *     RETARGETS which project the ticket is created in;
 *   • a title input (placeholder "Ticket title") + a CodeMirror markdown
 *     description editor (placeholder "Add description…");
 *   • a metadata chip row: Status ("Backlog"), Priority ("Medium"),
 *     Labels ("Labels"), and a Worktree toggle (role switch, default on);
 *   • a footer with a "Create more" switch, a secondary "Create" button, and the
 *     kickoff split button (data-testid="composer-kickoff").
 *   • the dialog root carries data-testid="new-ticket-composer".
 *
 * This file drives the REAL built app through Playwright against a scratch
 * SQLite DB + isolated profile (shared machinery in ./lib/smoke-kit.mjs) and
 * asserts the create flows: open, breadcrumb, project retarget, plain Create,
 * Create-more, ⌘+Enter, "c" hotkey, Escape. It is written BEFORE the composer
 * exists, so most checks are EXPECTED TO FAIL now — cleanly, by reporting the
 * missing composer UI, never by crashing. A few primitive-dialog checks (a
 * dialog opens via the header button / "c" hotkey / Escape closes) pass today.
 *
 *   Run:
 *     pnpm run build                                  # dist/ + dist-electron/
 *     node apps/desktop/e2e/composer-basics-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import {
  assertProfileIsolated,
  columnHasCard,
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

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-composer-basics-smoke-");
const { attempt, summarize } = createRunner();

// Two projects so the "retarget via project chip" flow has somewhere to send a
// ticket. Alpha is selected first (its board is what's on screen).
const PROJECT_ALPHA = { id: "composer-alpha", name: "Alpha Project", prefix: "AL" };
const PROJECT_BETA = { id: "composer-beta", name: "Beta Project", prefix: "BE" };

// ---- composer DOM helpers (target the SPEC'd, not-yet-built, structure) -----

const composer = (page) => page.locator('[data-testid="new-ticket-composer"]');
const projectChip = (page) => page.locator('[data-testid="composer-project-chip"]');
const titleInput = (page) => composer(page).getByPlaceholder("Ticket title");

/** Click the header "New ticket" button; return whether the COMPOSER (not the old dialog) opened. */
async function openComposerViaHeader(page) {
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await sleep(350);
  return (await composer(page).count()) === 1;
}

/** Escape and wait until no Radix dialog remains, so the next flow starts clean. */
async function closeAnyDialog(page) {
  if ((await page.getByRole("dialog").count()) === 0) return;
  await page.keyboard.press("Escape");
  await waitUntil("dialog to close", async () => (await page.getByRole("dialog").count()) === 0, {
    timeout: 3000,
  }).catch(() => {});
}

/** Read a project's tickets from the SQLite snapshot (source of truth for landing checks). */
async function ticketsFor(page, projectId) {
  return page.evaluate(async (id) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return [];
    return boot.data.ticketsByProject?.[id] ?? [];
  }, projectId);
}

// ---- main ------------------------------------------------------------------

async function main() {
  const app = await launch({ dbPath, userDataDir });
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    // Seed two real git-repo projects, then reload → import into SQLite.
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

    // === 1. Header button opens a dialog (passes against today's primitive dialog too)
    await attempt(1, 'Header "New ticket" button opens a dialog', async () => {
      await page.getByRole("button", { name: "New ticket", exact: true }).click();
      await sleep(300);
      const open = await page.getByRole("dialog").count();
      await closeAnyDialog(page);
      return { ok: open === 1, detail: `dialogCount=${open}` };
    });

    // === 2. The opened dialog is the COMPOSER with the full header + fields ===
    await attempt(
      2,
      'Composer structure: data-testid root, project chip + static "New ticket" + Expand/Close, title/description, Status/Priority/Labels chips, Worktree switch, Create-more + Create + kickoff',
      async () => {
        const opened = await openComposerViaHeader(page);
        const root = await composer(page).count();
        const chip = await projectChip(page).count();
        const staticNewTicket = await composer(page)
          .getByText("New ticket", { exact: true })
          .count();
        const expandBtn = await composer(page).getByRole("button", { name: "Expand" }).count();
        const closeBtn = await composer(page).getByRole("button", { name: "Close" }).count();
        const title = await titleInput(page).count();
        const desc = await composer(page).locator(".cm-editor").count();
        const statusChip = await composer(page).getByRole("button", { name: "Backlog" }).count();
        const priorityChip = await composer(page).getByRole("button", { name: "Medium" }).count();
        const labelsChip = await composer(page).getByRole("button", { name: "Labels" }).count();
        const worktree = await composer(page).getByRole("switch", { name: "Worktree" }).count();
        const createMore = await composer(page)
          .getByRole("switch", { name: "Create more" })
          .count();
        const createBtn = await composer(page)
          .getByRole("button", { name: "Create", exact: true })
          .count();
        const kickoff = await page.locator('[data-testid="composer-kickoff"]').count();
        await closeAnyDialog(page);
        const ok =
          opened &&
          root === 1 &&
          chip === 1 &&
          staticNewTicket >= 1 &&
          expandBtn === 1 &&
          closeBtn === 1 &&
          title === 1 &&
          desc >= 1 &&
          statusChip === 1 &&
          priorityChip === 1 &&
          labelsChip === 1 &&
          worktree === 1 &&
          createMore === 1 &&
          createBtn === 1 &&
          kickoff === 1;
        return {
          ok,
          detail: `root=${root} chip=${chip} newTicketText=${staticNewTicket} expand=${expandBtn} close=${closeBtn} title=${title} desc=${desc} status=${statusChip} priority=${priorityChip} labels=${labelsChip} worktree=${worktree} createMore=${createMore} create=${createBtn} kickoff=${kickoff}`,
        };
      },
    );

    // === 3. Breadcrumb chip shows the selected project's name =================
    await attempt(
      3,
      'Breadcrumb project chip shows the selected project ("Alpha Project")',
      async () => {
        const opened = await openComposerViaHeader(page);
        if (!opened) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer did not open (data-testid missing)" };
        }
        const chipText = (await projectChip(page).textContent())?.trim() ?? "";
        await closeAnyDialog(page);
        return {
          ok: chipText.includes(PROJECT_ALPHA.name),
          detail: `chip=${JSON.stringify(chipText)}`,
        };
      },
    );

    // === 4. Retarget via the chip menu: the ticket lands in Beta, not Alpha ===
    await attempt(
      4,
      'Project chip menu retargets: picking "Beta Project" creates the ticket in Beta, not Alpha',
      async () => {
        const opened = await openComposerViaHeader(page);
        if (!opened) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer did not open (data-testid missing)" };
        }
        const title = "Retargeted to Beta";
        await projectChip(page).click();
        await sleep(200);
        await page.getByRole("menuitem", { name: PROJECT_BETA.name, exact: true }).click();
        await sleep(200);
        await titleInput(page).fill(title);
        await composer(page).getByRole("button", { name: "Create", exact: true }).click();
        await waitUntil(
          "dialog closes after create",
          async () => (await composer(page).count()) === 0,
          {
            timeout: 4000,
          },
        );
        const inBeta = (await ticketsFor(page, betaId)).some((t) => t.title === title);
        const inAlpha = (await ticketsFor(page, alphaId)).some((t) => t.title === title);
        return { ok: inBeta && !inAlpha, detail: `inBeta=${inBeta} inAlpha=${inAlpha}` };
      },
    );

    // === 5. Full compose + plain Create: card lands in the chosen column ======
    await attempt(
      5,
      "Compose Status=Todo, Priority=High, a label, title + markdown body; plain Create closes the dialog and the card lands in Todo with High + the label",
      async () => {
        const opened = await openComposerViaHeader(page);
        if (!opened) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer did not open (data-testid missing)" };
        }
        const title = "Composed Alpha ticket";
        const label = "smoke";
        // Status chip → Todo.
        await composer(page).getByRole("button", { name: "Backlog" }).click();
        await sleep(150);
        await page.getByRole("menuitemradio", { name: "Todo", exact: true }).click();
        // Priority chip → High.
        await composer(page).getByRole("button", { name: "Medium" }).click();
        await sleep(150);
        await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
        // Labels chip → add "smoke".
        await composer(page).getByRole("button", { name: "Labels" }).click();
        await sleep(150);
        await page.getByPlaceholder("Add label…").fill(label);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Escape"); // close the label menu, keep the composer open
        // Title + markdown description.
        await titleInput(page).fill(title);
        await composer(page).locator(".cm-content").click();
        await page.keyboard.type("## A heading\n\nBody paragraph.");
        await composer(page).getByRole("button", { name: "Create", exact: true }).click();
        await waitUntil(
          "dialog closes after create",
          async () => (await composer(page).count()) === 0,
          {
            timeout: 4000,
          },
        );
        await goToBoard(page);
        const seeded = (await ticketsFor(page, alphaId)).find((t) => t.title === title);
        const statusOk = seeded?.status === "todo";
        const priorityOk = seeded?.priority === "high";
        const labelOk = (seeded?.labels ?? []).includes(label);
        const bodyOk = (seeded?.body ?? "").includes("## A heading");
        const displayId = seeded ? `${PROJECT_ALPHA.prefix}-${seeded.ticketNumber}` : "";
        const inTodoColumn = seeded ? await columnHasCard(page, "Todo", displayId) : false;
        const ok = !!seeded && statusOk && priorityOk && labelOk && bodyOk && inTodoColumn;
        return {
          ok,
          detail: `seeded=${!!seeded} status=${seeded?.status} priority=${seeded?.priority} labels=${JSON.stringify(seeded?.labels)} bodyHasHeading=${bodyOk} inTodo=${inTodoColumn}`,
        };
      },
    );

    // === 6. Create-more ON: two back-to-back; dialog stays open, resets, refocuses title
    await attempt(
      6,
      "Create-more ON: two tickets back-to-back keep the dialog open; title/description reset and focus returns to the title",
      async () => {
        const opened = await openComposerViaHeader(page);
        if (!opened) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer did not open (data-testid missing)" };
        }
        await composer(page).getByRole("switch", { name: "Create more" }).click();
        const before = (await ticketsFor(page, alphaId)).length;

        const first = "Create-more first";
        await titleInput(page).fill(first);
        await composer(page).getByRole("button", { name: "Create", exact: true }).click();
        // Dialog must STAY open and reset.
        const stayedOpen = await waitUntil(
          "dialog stays open + title resets after first create",
          async () =>
            (await composer(page).count()) === 1 && (await titleInput(page).inputValue()) === "",
          { timeout: 4000 },
        )
          .then(() => true)
          .catch(() => false);
        const focusedTitle = await titleInput(page).evaluate((el) => el === document.activeElement);

        const second = "Create-more second";
        await titleInput(page).fill(second);
        await composer(page).getByRole("button", { name: "Create", exact: true }).click();
        await sleep(500);
        await closeAnyDialog(page);

        const titles = (await ticketsFor(page, alphaId)).map((t) => t.title);
        const bothCreated = titles.includes(first) && titles.includes(second);
        const countGrew = titles.length === before + 2;
        const ok = stayedOpen && focusedTitle && bothCreated && countGrew;
        return {
          ok,
          detail: `stayedOpen=${stayedOpen} focusedTitle=${focusedTitle} both=${bothCreated} count ${before}->${titles.length}`,
        };
      },
    );

    // === 7. ⌘+Enter creates and closes the dialog ============================
    await attempt(7, "⌘+Enter creates the ticket and closes the composer", async () => {
      const opened = await openComposerViaHeader(page);
      if (!opened) {
        await closeAnyDialog(page);
        return { ok: false, detail: "composer did not open (data-testid missing)" };
      }
      const title = "Cmd-Enter ticket";
      await titleInput(page).fill(title);
      await page.keyboard.press("Meta+Enter");
      const closed = await waitUntil(
        "dialog closes after ⌘+Enter",
        async () => (await composer(page).count()) === 0,
        { timeout: 4000 },
      )
        .then(() => true)
        .catch(() => false);
      await closeAnyDialog(page);
      const created = (await ticketsFor(page, alphaId)).some((t) => t.title === title);
      return { ok: closed && created, detail: `closed=${closed} created=${created}` };
    });

    // === 8. "c" hotkey opens a dialog (passes against today's dialog too) =====
    await attempt(8, 'Plain "c" hotkey opens a dialog', async () => {
      await page.getByRole("heading", { name: "Board", exact: true }).click();
      await page.keyboard.press("c");
      await sleep(300);
      const open = await page.getByRole("dialog").count();
      await closeAnyDialog(page);
      return { ok: open === 1, detail: `dialogCount=${open}` };
    });

    // === 9. Escape closes the dialog (passes against today's dialog too) ======
    await attempt(9, "Escape closes the open dialog", async () => {
      await page.getByRole("button", { name: "New ticket", exact: true }).click();
      await sleep(300);
      const openCount = await page.getByRole("dialog").count();
      await page.keyboard.press("Escape");
      await sleep(300);
      const closedCount = await page.getByRole("dialog").count();
      return {
        ok: openCount === 1 && closedCount === 0,
        detail: `open=${openCount} closedAfter=${closedCount}`,
      };
    });
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
