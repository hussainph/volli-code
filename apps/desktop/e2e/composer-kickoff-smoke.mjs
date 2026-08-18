/**
 * Acceptance smoke for the composer's "Create & start" — the product's magic
 * path, and after VC-56 a CHAT path rather than a terminal one.
 *
 * What the button does now (VC-56, subsuming VC-15):
 *   • the composer offers no terminal harness anywhere — the picker that chose
 *     which TUI a kickoff launched is gone with the launch it described;
 *   • its footer names the model and effort the Session will run on, seeded
 *     from the TICKET purpose's configured default (VC-53's Model Access
 *     defaults), not the project one;
 *   • pressing it (or ⇧⌘↵) creates the ticket DIRECTLY in Doing regardless of
 *     the Status chip, opens the ticket workspace, and lands on a CHAT tab
 *     whose agent is already working;
 *   • with "Create more" ON the Session still starts, in the background, and
 *     the composer stays open with no navigation.
 *
 * HOW THE TURN PROVES THE BRIEF. Kickoff sends one stock instruction — "Begin
 * work on this ticket. Your assignment is the Ticket Brief above." — and never
 * re-sends the ticket's own prose, because a Ticket Session's agent is handed
 * the Ticket Brief at attach. So this smoke puts its only instruction in the
 * ticket BODY and asserts the reply obeys it: an agent that answers with the
 * body's marker can only have read it off the Brief. That is also what keeps
 * this probe cheap — one short reply, one billed turn, no loops.
 *
 * Run:
 *   pnpm run build                                    # dist/ + dist-electron/
 *   node apps/desktop/e2e/composer-kickoff-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real `~/.pi/agent/auth.json`
 * with `openai-codex` credentials — it drives one live turn); NOT wired into `vp test`.
 */
import { join } from "node:path";

import {
  activeTabLabel,
  assertProfileIsolated,
  columnHasCard,
  createRunner,
  ensurePiAuthInto,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  sleep,
  tabStrip,
  TICKET_TAB_STRIP,
  typeIntoMonaco,
  waitForSettledReply,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch(
  "volli-composer-kickoff-smoke-",
);
const { attempt, summarize } = createRunner();

const PROJECT = { id: "kickoff-project", name: "Kickoff Project", prefix: "KO" };
// Pi's credential store reads `$HOME/.pi/agent/auth.json`; isolate it exactly
// as the Pi smokes do rather than touching the developer's own profile.
const fakeHome = join(scratch, "home");

/**
 * The two defaults, deliberately different models.
 *
 * The composer must read the TICKET one. Seeding both with the same model would
 * pass whichever it read, so `global` is pinned to something the row must NOT
 * name. Both are checked against the live catalog by `seedDefaultModel`, which
 * fails loudly (with what IS available) rather than silently picking another.
 */
const TICKET_MODEL = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-luna",
  reasoningLevel: "low",
};
const GLOBAL_MODEL = {
  providerId: "openai-codex",
  modelId: "gpt-5.3-codex-spark",
  reasoningLevel: "low",
};

// ---- composer / workspace helpers ------------------------------------------

const composer = (page) => page.locator('[data-testid="new-ticket-composer"]');
const kickoffButton = (page) => page.locator('[data-testid="composer-kickoff"]');
const titleInput = (page) => composer(page).getByPlaceholder("Ticket title");

async function openComposerViaHeader(page) {
  try {
    const trigger = page.getByRole("button", { name: "New ticket", exact: true });
    await trigger.waitFor({ state: "visible", timeout: 12000 });
    await trigger.click();
    await composer(page).waitFor({ state: "visible", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function closeAnyDialog(page) {
  if ((await page.getByRole("dialog").count()) === 0) return;
  await page.keyboard.press("Escape");
  await sleep(300);
}

/** Every tab in the ticket strip — never the details rail's page switcher. */
function ticketTabs(page) {
  return tabStrip(page, TICKET_TAB_STRIP).getByRole("tab");
}

/**
 * Detail view is open when the ticket tab strip has rendered tabs (the board
 * has none).
 *
 * Scoped to the named strip: the details rail's page switcher is a tablist of
 * its own on this screen and always has a page selected, so an unscoped
 * `getByRole("tab")` counts the rail's pages and answers "yes" for a detail view
 * whose tab strip never rendered.
 */
async function detailOpen(page) {
  return (await ticketTabs(page).count()) >= 1;
}

/**
 * Type title + body into the composer. The body is Monaco Document Mode, whose
 * input surface is a `native-edit-context` div rather than a textarea, so there
 * is nothing to `fill()` — click into the editor, then type, then wait for the
 * characters to land (see `typeIntoMonaco`: a hotkey pressed the instant this
 * returns must not ship a truncated body).
 */
async function fillTitleAndBody(page, title, body) {
  await titleInput(page).fill(title);
  await typeIntoMonaco(composer(page), body);
}

async function ticketsFor(page, projectId) {
  return page.evaluate(async (id) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return [];
    return boot.data.ticketsByProject?.[id] ?? [];
  }, projectId);
}

// ---- main ------------------------------------------------------------------

async function main() {
  await ensurePiAuthInto(fakeHome);
  const app = await launch({ dbPath, userDataDir, extraEnv: { HOME: fakeHome } });
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "kickoff-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    // === 0. Precondition: a Ticket default that is NOT the project default ===
    let ticketModel = null;
    await attempt(
      0,
      "Model Access: distinct project and Ticket defaults are recorded",
      async () => {
        await seedDefaultModel(page, GLOBAL_MODEL, "global");
        ticketModel = await seedDefaultModel(page, TICKET_MODEL, "ticket");
        return { ok: true, detail: `ticket=${ticketModel.providerId}/${ticketModel.modelId}` };
      },
    );

    // === 1. The composer offers a model + effort, and no terminal anywhere ====
    await attempt(
      1,
      "Composer: the run row is seeded from the TICKET default, and no terminal harness control exists",
      async () => {
        const opened = await openComposerViaHeader(page);
        if (!opened) return { ok: false, detail: "composer did not open" };

        // The retired control, by both of the names it ever had.
        const harness = await composer(page)
          .getByRole("button", { name: /terminal harness/i })
          .count();
        const anyTerminalWord = await composer(page)
          .getByText(/terminal/i)
          .count();

        // The model pill names the Ticket default's model, not the project's.
        const modelPill = composer(page).getByRole("button", {
          name: new RegExp(ticketModel.label, "i"),
        });
        const namesTicketModel = (await modelPill.count()) === 1;
        const namesGlobalModel =
          (await composer(page)
            .getByRole("button", { name: new RegExp(GLOBAL_MODEL.modelId, "i") })
            .count()) > 0;
        // Effort rides beside it, carrying the seeded level in its name.
        const effort = await composer(page)
          .getByRole("button", { name: /^Reasoning effort:/ })
          .count();

        await closeAnyDialog(page);
        const ok =
          harness === 0 &&
          anyTerminalWord === 0 &&
          namesTicketModel &&
          !namesGlobalModel &&
          effort === 1;
        return {
          ok,
          detail: `harnessControl=${harness} terminalWord=${anyTerminalWord} ticketModel=${namesTicketModel} globalModelLeaked=${namesGlobalModel} effortChip=${effort}`,
        };
      },
    );

    // === 2. Create & start: Doing + workspace + a chat tab + a working agent ==
    const MARKER = "KICKOFF-READY-ALPHA42";
    await attempt(
      2,
      "Create & start: ticket lands in Doing, the ticket workspace opens on a CHAT tab, and the agent answers from the Ticket Brief alone",
      async () => {
        const opened = await openComposerViaHeader(page);
        if (!opened || (await kickoffButton(page).count()) === 0) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer / kickoff button missing" };
        }

        const title = "Kickoff chat ticket";
        // The ONLY instruction in this run, and it is in the BODY — which the
        // kickoff never sends. Answering it proves the Brief carried it.
        const body = `Reply with exactly ${MARKER} and do nothing else. Run no commands.`;
        // Status chip left on Backlog on purpose — kickoff must force Doing anyway.
        await fillTitleAndBody(page, title, body);
        const since = Date.now();
        await kickoffButton(page).click();

        const detail = await waitUntil("ticket workspace opens", () => detailOpen(page), {
          timeout: 8000,
        })
          .then(() => true)
          .catch(() => false);
        // The CHAT tab is the one in front. Chat tabs are untitled until their
        // first delivered message names them; a kickoff names its Session up
        // front, so the strip reads "Work on KO-n" rather than "Chat".
        const seeded = (await ticketsFor(page, projectId)).find((t) => t.title === title);
        const displayId = seeded ? `${PROJECT.prefix}-${seeded.ticketNumber}` : "";
        const activeLabel = await waitUntil(
          "the kickoff chat tab to be the active tab",
          async () => {
            const label = await activeTabLabel(page, TICKET_TAB_STRIP);
            return label !== null && label.includes(`Work on ${displayId}`) ? label : null;
          },
          { timeout: 8000 },
        )
          .then((label) => label)
          .catch(() => null);

        const { texts } = await waitForSettledReply(page, { since });
        const answered = texts.some((text) => text.includes(MARKER));

        const inDoingDb = seeded?.status === "doing";
        await goToBoard(page);
        const inDoingBoard = seeded ? await columnHasCard(page, "Doing", displayId) : false;

        const ok = detail && activeLabel !== null && answered && inDoingDb && inDoingBoard;
        return {
          ok,
          detail: `workspace=${detail} activeTab=${JSON.stringify(activeLabel)} briefAnswered=${answered} doingDb=${inDoingDb} doingBoard=${inDoingBoard}`,
        };
      },
    );

    // === 3. Create-more ON: background start, composer stays put =============
    await attempt(
      3,
      "Create-more ON + kickoff: the Session starts in the background, the composer stays open, and nothing navigates",
      async () => {
        await goToBoard(page);
        const opened = await openComposerViaHeader(page);
        if (!opened || (await kickoffButton(page).count()) === 0) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer / kickoff button missing" };
        }
        await composer(page).getByRole("switch", { name: "Create more" }).click();

        const title = "Kickoff background ticket";
        await fillTitleAndBody(page, title, "Reply with OK. Run no commands.");
        await kickoffButton(page).click();

        // The durable Session is the evidence, not a visible tab: nothing
        // navigated, so there is no strip to read. Poll the ticket's own
        // Session listing over the same IPC the rail reads.
        const started = await waitUntil(
          "a Session recorded against the background ticket",
          async () => {
            const ticket = (await ticketsFor(page, projectId)).find((t) => t.title === title);
            if (!ticket) return null;
            const listed = await page.evaluate(
              (id) => window.api.sessions.listForTicket({ ticketId: id }),
              ticket.id,
            );
            return listed?.ok && listed.sessions.length > 0 ? listed.sessions : null;
          },
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);

        const stillOpen = (await composer(page).count()) === 1;
        const noDetail = !(await detailOpen(page));
        await closeAnyDialog(page);

        return {
          ok: started && stillOpen && noDetail,
          detail: `sessionStarted=${started} composerStillOpen=${stillOpen} noNavigation=${noDetail}`,
        };
      },
    );

    // === 4. ⇧⌘↵ is the kickoff chord =========================================
    await attempt(
      4,
      "⇧⌘↵ kicks off: the ticket workspace opens on the chat tab, same as the button",
      async () => {
        await goToBoard(page);
        const opened = await openComposerViaHeader(page);
        if (!opened || (await kickoffButton(page).count()) === 0) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer / kickoff button missing" };
        }
        const title = "Kickoff chord ticket";
        await fillTitleAndBody(page, title, "Reply with OK. Run no commands.");
        await page.keyboard.press("Meta+Shift+Enter");

        const detail = await waitUntil("ticket workspace opens after the chord", () =>
          detailOpen(page),
        )
          .then(() => true)
          .catch(() => false);
        const seeded = (await ticketsFor(page, projectId)).find((t) => t.title === title);
        const displayId = seeded ? `${PROJECT.prefix}-${seeded.ticketNumber}` : "";
        const label = await activeTabLabel(page, TICKET_TAB_STRIP);
        const onChat = label !== null && label.includes(`Work on ${displayId}`);

        return {
          ok: detail && onChat,
          detail: `workspace=${detail} activeTab=${JSON.stringify(label)}`,
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
