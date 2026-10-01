/**
 * Acceptance smoke for the composer's "Create & start" — the product's magic
 * path, and after VC-56 a CHAT path rather than a terminal one.
 *
 * What the button does now (VC-56, subsuming VC-15; VC-491 stops the teleport):
 *   • the composer offers no terminal harness anywhere — the picker that chose
 *     which TUI a kickoff launched is gone with the launch it described;
 *   • its footer names the model and effort the Session will run on, seeded
 *     from the TICKET purpose's configured default (VC-53's Model Access
 *     defaults), not the project one — as ONE control at the dialog's own
 *     width, where the three commits beside it leave no room for two (VC-382);
 *   • pressing it (or ⇧⌘↵) creates the ticket DIRECTLY in Doing regardless of
 *     the Status chip and starts its CHAT Session — and NEVER navigates: the
 *     underlying workspace stays put (VC-491). The Session's chat tab is
 *     prepared on the ticket, so explicitly opening the ticket later lands on
 *     the running agent;
 *   • "Create more" no longer changes where the Session starts — it solely
 *     decides whether the composer resets in place (stays open) or closes.
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
  cardById,
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
import { setComposerCreateMore } from "./lib/composer-actions.mjs";

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

/** Whether exactly one composer dialog is mounted right now. */
async function composerOpen(page) {
  return (await composer(page).count()) === 1;
}

/**
 * VC-491's stay-put half, read after a settle window (a late navigation would
 * still be one worth catching): the board is still the surface in front and no
 * ticket workspace has mounted over it.
 */
async function boardStillInFront(page) {
  await sleep(500);
  const boardInFront = await page
    .getByRole("button", { name: "New ticket", exact: true })
    .isVisible();
  return { boardInFront, noDetail: !(await detailOpen(page)) };
}

/** A ticket's durable Session listing, or null while none is recorded yet. */
async function sessionsFor(page, ticketId) {
  if (!ticketId) return null;
  const listed = await page.evaluate(
    (id) => window.api.sessions.listForTicket({ ticketId: id }),
    ticketId,
  );
  return listed?.ok && listed.sessions.length > 0 ? listed.sessions : null;
}

/**
 * Double-click a board card to open its ticket workspace — the explicit open a
 * VC-491 kickoff no longer performs for the user (ticket-detail-smoke.mjs
 * precedent, retries included).
 */
async function openCardDetail(page, displayId) {
  for (let i = 0; i < 3; i += 1) {
    await cardById(page, displayId).dblclick();
    try {
      await waitUntil("the ticket workspace to open", () => detailOpen(page), { timeout: 4000 });
      return true;
    } catch {
      // fall through and retry
    }
  }
  return false;
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

    // === 0. Precondition: a Ticket default that is NOT the Board default ===
    let ticketModel = null;
    await attempt(0, "Model Access: distinct Board and Ticket defaults are recorded", async () => {
      await seedDefaultModel(page, GLOBAL_MODEL, "global");
      ticketModel = await seedDefaultModel(page, TICKET_MODEL, "ticket");
      return { ok: true, detail: `ticket=${ticketModel.providerId}/${ticketModel.modelId}` };
    });

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
        // Effort rides INSIDE that pill at this width, not beside it: the
        // composer opens at 36rem, where Create, the primary and the launch
        // caret leave the settings run no room for a second chip, so the model
        // control names both values and its popover holds both (VC-382). The
        // seeded level is the last term of that one name.
        const effort = await composer(page)
          .getByRole("button", { name: /^Model and effort:.*· Low$/i })
          .count();
        const separateEffortChip = await composer(page)
          .getByRole("button", { name: /^Reasoning effort:/ })
          .count();

        await closeAnyDialog(page);
        const ok =
          harness === 0 &&
          anyTerminalWord === 0 &&
          namesTicketModel &&
          !namesGlobalModel &&
          effort === 1 &&
          separateEffortChip === 0;
        return {
          ok,
          detail: `harnessControl=${harness} terminalWord=${anyTerminalWord} ticketModel=${namesTicketModel} globalModelLeaked=${namesGlobalModel} mergedEffort=${effort} separateEffortChip=${separateEffortChip}`,
        };
      },
    );

    // === 2. Create & start: Doing + a durable Session, and no teleport ======
    const MARKER = "KICKOFF-READY-ALPHA42";
    await attempt(
      2,
      "Create & start: ticket lands in Doing, a Session starts without navigating — and explicitly opening the ticket lands on the prepared chat, whose agent answers from the Ticket Brief alone",
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

        // VC-491's foreground contract: the composer closes, and that is ALL
        // that happens on screen — the board stays in front, no ticket
        // workspace teleports in. The close lands once the create and the
        // Session start resolve, hence the generous window.
        const composerClosed = await waitUntil(
          "the composer to close",
          async () => !(await composerOpen(page)),
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);
        const board = await boardStillInFront(page);

        const seeded = await waitUntil(
          "the created ticket to be readable",
          async () => (await ticketsFor(page, projectId)).find((t) => t.title === title) ?? false,
          { timeout: 8000 },
        ).catch(() => null);
        const displayId = seeded ? `${PROJECT.prefix}-${seeded.ticketNumber}` : "";
        const inDoingDb = seeded?.status === "doing";
        const inDoingBoard = seeded ? await columnHasCard(page, "Doing", displayId) : false;

        // The durable Session is the evidence that work actually started — the
        // screen deliberately shows none of it (VC-491).
        const sessionStarted = seeded
          ? await waitUntil(
              "a Session recorded against the ticket",
              async () => sessionsFor(page, seeded.id),
              { timeout: 20000 },
            )
              .then(() => true)
              .catch(() => false)
          : false;

        // The user drives the open now — the exact gesture this smoke repeats.
        // The CHAT tab is the one in front when they do: startTicketChat
        // prepared it at start time without navigating. Chat tabs are untitled
        // until their first delivered message names them; a kickoff names its
        // Session up front, so the strip reads "Work on KO-n" rather than "Chat".
        let onChat = false;
        if (seeded && displayId) {
          const openedCard = await openCardDetail(page, displayId);
          onChat =
            openedCard &&
            (await waitUntil(
              "the prepared chat tab to be the active tab",
              async () => {
                const label = await activeTabLabel(page, TICKET_TAB_STRIP);
                return label !== null && label.includes(`Work on ${displayId}`) ? label : null;
              },
              { timeout: 8000 },
            )
              .then(() => true)
              .catch(() => false));
        }

        // With the workspace finally open, the one billed turn can be read.
        const { texts } = await waitForSettledReply(page, { since });
        const answered = texts.some((text) => text.includes(MARKER));

        const ok =
          composerClosed &&
          board.boardInFront &&
          board.noDetail &&
          inDoingDb &&
          inDoingBoard &&
          sessionStarted &&
          onChat &&
          answered;
        return {
          ok,
          detail: `composerClosed=${composerClosed} boardInFront=${board.boardInFront} noNavigation=${board.noDetail} doingDb=${inDoingDb} doingBoard=${inDoingBoard} sessionStarted=${sessionStarted} preparedChatTab=${onChat} briefAnswered=${answered}`,
        };
      },
    );

    // === 3. Create-more ON: reset in place, still no navigation =============
    await attempt(
      3,
      "Create-more ON + kickoff: the composer resets in place and stays open, nothing navigates, and the Session starts",
      async () => {
        await goToBoard(page);
        const opened = await openComposerViaHeader(page);
        if (!opened || (await kickoffButton(page).count()) === 0) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer / kickoff button missing" };
        }
        await setComposerCreateMore(page, true);

        const title = "Kickoff background ticket";
        await fillTitleAndBody(page, title, "Reply with OK. Run no commands.");
        await kickoffButton(page).click();

        // VC-491: where the Session starts no longer depends on this toggle —
        // it solely decides reset-in-place vs close. With it on, the composer
        // stays open with its fields cleared (the reset lands once the create
        // and the Session start resolve), and nothing navigates: the durable
        // Session is the evidence, not a visible tab.
        const resetInPlace = await waitUntil(
          "the composer to reset in place and stay open",
          async () =>
            (await composerOpen(page)) &&
            (await titleInput(page)
              .inputValue()
              .catch(() => null)) === "",
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);
        const board = await boardStillInFront(page);
        const sessionStarted = await waitUntil(
          "a Session recorded against the background ticket",
          async () => {
            const ticket = (await ticketsFor(page, projectId)).find((t) => t.title === title);
            return sessionsFor(page, ticket?.id);
          },
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);
        await closeAnyDialog(page);

        const ok = resetInPlace && board.boardInFront && board.noDetail && sessionStarted;
        return {
          ok,
          detail: `resetInPlace=${resetInPlace} boardInFront=${board.boardInFront} noNavigation=${board.noDetail} sessionStarted=${sessionStarted}`,
        };
      },
    );

    // === 4. ⇧⌘↵ is the kickoff chord =========================================
    await attempt(
      4,
      "⇧⌘↵ kicks off without navigating: composer closes, the board stays in front, and the Session exists",
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

        // The chord is Create-&-start's keyboard form, so VC-491's contract is
        // the button's: the composer closes, the board stays put, and the
        // durable Session proves the start happened. (Attempt 3 left
        // create-more ON, but its trailing Escape closed the composer and every
        // open mounts it fresh — so this chord runs the default close path.)
        const composerClosed = await waitUntil(
          "the composer to close",
          async () => !(await composerOpen(page)),
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);
        const board = await boardStillInFront(page);
        const sessionStarted = await waitUntil(
          "a Session recorded against the chord ticket",
          async () => {
            const ticket = (await ticketsFor(page, projectId)).find((t) => t.title === title);
            return sessionsFor(page, ticket?.id);
          },
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);

        const ok = composerClosed && board.boardInFront && board.noDetail && sessionStarted;
        return {
          ok,
          detail: `composerClosed=${composerClosed} boardInFront=${board.boardInFront} noNavigation=${board.noDetail} sessionStarted=${sessionStarted}`,
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
