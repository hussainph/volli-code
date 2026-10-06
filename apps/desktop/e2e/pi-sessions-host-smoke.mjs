/**
 * E2e proof of two sidebar Session-hosting rules, against the BUILT app and a
 * real Pi turn — the parts of the retired `sessions-chat-host-smoke.mjs` that
 * are still unproven now that every structured Session (Ticket or Project)
 * attaches Pi (`project-sessions.ts`, commit 49a62640): the ticket-orphan
 * sidebar reopen, and the "Cleaned up" filter. The retired smoke's third
 * part — Home hosting a chat tab beside a terminal tab, and one prompt
 * streaming to settle — is `pi-project-chat-smoke.mjs`'s job now, so
 * it is not repeated here.
 *
 *   (a) **Ticket-orphan reopen.** A chat born inside a ticket workspace
 *       survives that ticket being hard-deleted (`ON DELETE SET NULL` on
 *       `sessions.ticket_id`, `db/migrations.ts`'s MIGRATION_003 comment: "a
 *       session outlives an archived-then-deleted ticket, purely as
 *       project-level history") — and the ticket-independent sidebar row
 *       still opens the SAME conversation. Deletion, not mere archiving, is
 *       the scenario asked for: `tickets.delete` rejects a live ticket
 *       (`ticket-commands.ts`), so the ticket is archived first, then
 *       deleted through the same preload bridge `pi-ticket-chat-smoke.mjs`
 *       uses for ticket creation.
 *   (b) **The Cleaned up filter.** A chat the cleanup rules have genuinely
 *       concluded is hidden from Previous by default and reappears — openable
 *       — once the filter is toggled. `isCleanupExempt`
 *       (`active-session-listing.ts`) protects any Session whose attachment
 *       is still `open`, whatever the task at hand — so this needs a real
 *       failed attach, not merely an unopened Draft.
 *
 * A new ticket chat is now a provisional Draft until its first Send. Promotion
 * creates the durable Session before it starts the resident client, whose
 * asynchronous attach then calls `SessionLocationResolver#prepare` first
 * (`session-runtime.ts`, ~line 677). A prepare error fails the whole attach
 * with `location_unavailable`; it does not undo the already-created Session
 * or its tab. Thus this scenario is still reachable after VC-358, but only by
 * sending once to promote the Draft before checking cleanup.
 *
 * The retired smoke got its "never attaches" chat from a deliberately-broken
 * `opencode` binary override; that lever doesn't translate to Pi (credentials
 * are read fresh per attach with no synchronous validation — corrupting
 * `auth.json` was tried and empirically still attached: Pi's `startSession`
 * does not check provider credentials before binding). The lever that DOES
 * work is local and adapter-agnostic: every native attach — Pi included —
 * runs `SessionLocationResolver#prepare` before the adapter is ever asked
 * anything. For a worktree ticket, `prepare` runs the `ensure` pipeline's
 * `git worktree add` inside the PROJECT's own directory (`location.ts`,
 * `worktree/ensure.ts`). Deleting that directory from disk, after part (a)'s
 * real turn is durably settled and needs it no further, makes `ensure` fail
 * deterministically on its missing `cwd`, with no Pi credentials or network
 * involved. The already-recorded default model (`requireDefaultModel`) remains
 * available, so promotion's `session.create` succeeds first; the missing
 * directory then produces a durable `attachment.failed` and leaves the first
 * message held for Retry. That closed attachment is exactly the state the
 * cleanup filter needs to see.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/pi-sessions-host-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real
 * `~/.pi/agent/auth.json` with `openai-codex` credentials); NOT wired into
 * `vp test`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  cardById,
  createRunner,
  ensurePiAuthInto,
  evidenceDir,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  openNewChatTab,
  pathExists,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  sleep,
  stopButton,
  TICKET_TAB_STRIP,
  waitForSettledReply,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "pi-sessions-host-project", name: "Pi Sessions Host", prefix: "SH" };
const MODEL_PIN = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-luna",
  reasoningLevel: "low",
};
// Short on purpose so the one billed setup turn remains bounded. The Session
// is addressed by its durable identity after this point, not by auto-title.
const ORPHAN_PROMPT = "Say hi before this ticket is deleted.";
// Check 6 sends only to promote the Draft. Its worktree attach fails before Pi
// receives the held message, so the Session keeps the tab strip's neutral label.
const DEFAULT_CHAT_TITLE = "Chat";
const CONCLUDE_PROMPT = "Keep this message queued while the ticket worktree is unavailable.";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("pi-sessions-host-smoke-");
const fakeHome = join(scratch, "home");
const worktreesRoot = join(scratch, "worktree-home");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = await evidenceDir("pi-sessions-host");

async function shot(page, name) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const path = join(EVIDENCE_DIR, name);
  await page.screenshot({ path }).catch(() => {});
  return path;
}

async function captureFailureEvidence(page, label) {
  const path = await shot(page, `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
  console.log(`  evidence: ${path}`);
}

/** Submits `text` and returns the moment it was sent — the turn clock's zero. */
async function submitPrompt(page, text) {
  const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press("Enter");
  return Date.now();
}

async function waitComposerReady(page) {
  const textarea = page.getByPlaceholder("Ask, plan, or implement…");
  await waitUntil("the composer to mount", async () => (await textarea.count()) > 0);
  await waitUntil(
    "the composer to become ready (a model is selectable)",
    async () => !(await textarea.first().isDisabled()),
    { timeout: 30000 },
  );
}

/**
 * Submit `text`, wait for the turn to start, stream, and settle — one real Pi
 * round trip, on ONE clock started at the submitting keystroke.
 *
 * The settle is `waitForSettledReply`'s, so what ends the wait here is assistant
 * PROSE and not the first `.is-assistant` node: a turn that reaches for a tool
 * draws the ActivityBundle inside the same assistant message, and this smoke's
 * own prompts are given to a Session whose Brief invites it to run the `volli`
 * CLI. See `PI_TURN_BUDGET_MS` for what the budget was measured against.
 */
async function runTurnToSettle(page, text) {
  await waitComposerReady(page);
  const submittedAt = await submitPrompt(page, text);
  await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
    timeout: 15000,
  });
  return waitForSettledReply(page, { since: submittedAt });
}

/** Returns to the board's card list from an open ticket detail (Escape moves focus off the composer first). */
async function returnToBoardFromTicket(page, displayId) {
  await page.getByRole("tab", { name: displayId, exact: true }).click();
  await page.keyboard.press("Escape");
  await waitUntil(
    "the board list to be back",
    async () => (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
    { timeout: 10000 },
  );
}

/**
 * Creates a ticket through the preload bridge (same technique
 * pi-ticket-chat-smoke.mjs uses), reloads, and returns BOTH its board display
 * id (`SH-1`, for card/tab selectors) and its real UUID (`ticket.id`) — the
 * archive/delete bridge calls take the UUID, never the display string, and
 * confusing the two is a silent "Unknown ticket" failure rather than a type
 * error in a plain preload call.
 */
async function seedTicket(page, projectId, prefix, title) {
  const result = await page.evaluate((input) => window.api.tickets.create(input), {
    projectId,
    status: "todo",
    title,
    priority: "medium",
  });
  if (!result.ok) throw new Error(`ticket seed failed: ${result.error}`);
  const displayId = `${prefix}-${result.ticket.ticketNumber}`;
  const ticketId = result.ticket.id;
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000);
  await goToBoard(page);
  return { displayId, ticketId };
}

/** Archives, then hard-deletes, a ticket through the preload bridge — `tickets.delete` rejects a live (non-archived) ticket. */
async function archiveAndDeleteTicket(page, ticketId) {
  const archived = await page.evaluate(
    (id) => window.api.tickets.archive({ ticketId: id }),
    ticketId,
  );
  if (!archived.ok) throw new Error(`archive failed: ${archived.error}`);
  const deleted = await page.evaluate(
    (id) => window.api.tickets.delete({ ticketId: id }),
    ticketId,
  );
  if (!deleted.ok) throw new Error(`delete failed: ${deleted.error}`);
}

/** Archives a ticket through the preload bridge, without deleting it. */
async function archiveTicket(page, ticketId) {
  const archived = await page.evaluate(
    (id) => window.api.tickets.archive({ ticketId: id }),
    ticketId,
  );
  if (!archived.ok) throw new Error(`archive failed: ${archived.error}`);
}

/** A project sidebar row (either band) whose visible text includes `text`. */
function sidebarRow(page, text) {
  return page.locator("[data-session-band] button", { hasText: text });
}

/**
 * The one row in the Active band — whatever it is currently called.
 *
 * Deliberately NOT located by its first message. A chat names itself from that
 * message and then, seconds later, renames itself again to the model's title
 * (VC-81): here "Say hi before this ticket is deleted." becomes "Farewell
 * before ticket deletion". A locator built from the prompt matches only the
 * window between those two, which is a race this smoke used to win by
 * accident — back when the model's retitle never reached the renderer at all.
 */
function chatRow(page) {
  return page.locator("[data-session-band='active'] button");
}

async function main() {
  await ensurePiAuthInto(fakeHome);

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { HOME: fakeHome, VOLLI_WORKTREE_HOME_DIR: worktreesRoot },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "pi-sessions-host-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    let defaultModel = null;
    await attempt(
      1,
      "seed the app default model — every Ticket Session requires one before it can start",
      async () => {
        defaultModel = await seedDefaultModel(page, MODEL_PIN);
        return { ok: defaultModel !== null, detail: JSON.stringify(defaultModel) };
      },
    );

    // =====================================================================
    // (a) the ticket-orphan flow: create + settle a real turn, then archive
    //     AND hard-delete the ticket, then reopen the SAME conversation from
    //     the ticket-independent sidebar row.
    // =====================================================================

    let orphanTicketId = null;
    let orphanDisplayId = null;
    await attempt(
      2,
      "a chat born in a ticket workspace sends and settles a real message",
      async () => {
        const seeded = await seedTicket(page, projectId, PROJECT.prefix, "Orphan chat ticket");
        orphanDisplayId = seeded.displayId;
        orphanTicketId = seeded.ticketId;
        await cardById(page, orphanDisplayId).dblclick();
        await waitUntil(
          "the ticket detail to open",
          async () =>
            (await page.getByRole("tab", { name: orphanDisplayId, exact: true }).count()) === 1,
        );
        await openNewChatTab(page, TICKET_TAB_STRIP);
        const settled = await runTurnToSettle(page, ORPHAN_PROMPT).catch(async (error) => {
          await captureFailureEvidence(page, "orphan-chat-turn-failed");
          throw error;
        });
        return {
          ok: settled.texts.length > 0,
          detail: `${orphanDisplayId} turn=${(settled.elapsedMs / 1000).toFixed(1)}s`,
        };
      },
    );

    await attempt(
      3,
      "archiving then hard-deleting the ticket takes it off the board (ON DELETE SET NULL orphans the Session)",
      async () => {
        await returnToBoardFromTicket(page, orphanDisplayId);
        await archiveAndDeleteTicket(page, orphanTicketId);
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1000);
        await goToBoard(page);
        await shot(page, "01-orphan-ticket-deleted.png");
        return { ok: (await cardById(page, orphanDisplayId).count()) === 0 };
      },
    );

    await attempt(
      4,
      "the ticket-independent chat's sidebar row opens the SAME conversation, selected — its Session survived the delete",
      async () => {
        const row = chatRow(page);
        await waitUntil(
          "the orphaned chat's sidebar row to appear",
          async () => (await row.count()) >= 1,
          { timeout: 15000 },
        ).catch(async (error) => {
          await captureFailureEvidence(page, "orphan-row-missing");
          throw error;
        });
        await row.first().click();
        const conversationOpen = await waitUntil(
          "the settled conversation to render",
          async () =>
            (await page.evaluate(() =>
              Array.from(document.querySelectorAll(".is-user")).some((el) =>
                (el.textContent ?? "").includes("Say hi before this ticket is deleted"),
              ),
            )) || false,
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);
        const selected = await waitUntil(
          "the sidebar row to read selected",
          async () => (await row.first().getAttribute("data-active")) === "true",
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);
        await shot(page, "02-orphan-row-reopened.png");
        return {
          ok: conversationOpen && selected,
          detail: `conversationOpen=${conversationOpen} selected=${selected}`,
        };
      },
    );

    // =====================================================================
    // (b) the Cleaned up filter: a chat whose Pi attach never opens (its
    //     ticket's worktree can't be prepared) is concluded business once its
    //     ticket is archived and the Active window has passed — hidden from
    //     Previous by default, reachable once revealed. See the module doc
    //     comment for why the project directory is the lever, and why part
    //     (a)'s real turn had to settle first.
    // =====================================================================

    await attempt(
      5,
      "deleting the project's directory, after (a)'s real turn is durably settled and needs it no further",
      async () => {
        await fs.rm(projectPath, { recursive: true, force: true });
        return { ok: !(await pathExists(projectPath)) };
      },
    );

    let concludeTicketId = null;
    let concludeDisplayId = null;
    await attempt(
      6,
      "a ticket Draft promotes on first Send before its missing-project attach fails, keeping the durable Session and tab",
      async () => {
        const seeded = await seedTicket(page, projectId, PROJECT.prefix, "Concluded chat ticket");
        concludeDisplayId = seeded.displayId;
        concludeTicketId = seeded.ticketId;
        await cardById(page, concludeDisplayId).dblclick();
        await waitUntil(
          "the ticket detail to open",
          async () =>
            (await page.getByRole("tab", { name: concludeDisplayId, exact: true }).count()) === 1,
        );
        const chatTabLabel = await openNewChatTab(page, TICKET_TAB_STRIP);
        await sleep(600);
        const beforeSend = await page.evaluate(
          (ticketId) => window.api.sessions.listForTicket({ ticketId }),
          concludeTicketId,
        );
        if (!beforeSend.ok) throw new Error(beforeSend.error);
        const noSessionBeforeSend = beforeSend.sessions.length === 0;

        await waitComposerReady(page);
        await submitPrompt(page, CONCLUDE_PROMPT);
        const failed = await waitUntil(
          "promotion to persist the worktree attach failure before any attachment opens",
          async () => {
            const listed = await page.evaluate(
              (ticketId) => window.api.sessions.listForTicket({ ticketId }),
              concludeTicketId,
            );
            if (!listed.ok) throw new Error(listed.error);
            const chat = listed.sessions.find((session) => session.kind === "chat");
            if (chat === undefined) return false;
            const snapshot = await page.evaluate(
              async (sessionId) =>
                window.api.sessionRpc.request({
                  path: "session.snapshot",
                  type: "query",
                  input: { sessionId },
                }),
              chat.record.sessionId,
            );
            if (!snapshot.ok) throw new Error(JSON.stringify(snapshot));
            const events = (snapshot.data.frames ?? []).map((frame) => frame.event.payload);
            const failure = events.find((event) => event.kind === "attachment.failed");
            const opened = events.some((event) => event.kind === "attachment.opened");
            return failure?.failure?.code === "location_unavailable" &&
              !opened &&
              chat.record.live === false
              ? { chat, failure }
              : false;
          },
          { timeout: 30000 },
        )
          .then((result) => result)
          .catch(() => null);
        const tab = page.getByRole("tab", { name: chatTabLabel, exact: true });
        const tabLanded =
          (await tab.count()) === 1 && (await tab.getAttribute("aria-selected")) === "true";
        const failedUnattached = failed !== null;
        if (!noSessionBeforeSend || !failedUnattached || !tabLanded) {
          await captureFailureEvidence(page, "promoted-chat-attach-failed");
        }
        return {
          ok: noSessionBeforeSend && failedUnattached && tabLanded,
          detail:
            `sessionsBeforeSend=${beforeSend.sessions.length} ` +
            `attachFailure=${failed?.failure?.failure?.code ?? "missing"} ` +
            `live=${failed?.chat.record.live ?? "missing"} tabLanded=${tabLanded}`,
        };
      },
    );

    await attempt(
      7,
      "a chat whose ticket is archived, whose attach never opened, and whose clock has moved past the Active window is hidden from Previous by default",
      async () => {
        await returnToBoardFromTicket(page, concludeDisplayId);
        await archiveTicket(page, concludeTicketId);

        // The Active band keeps ANY recently-active row for
        // ACTIVE_QUIET_WINDOW_MS (30 min) regardless of conclusion — jump the
        // renderer's own clock past it and reload so the sidebar's `now`
        // state (otherwise pinned to whenever it last ran a timer) picks up
        // the new instant. Same technique the retired sessions-chat-host-smoke.mjs used.
        await page.clock.install({ time: Date.now() });
        await page.clock.fastForward("31:00");
        await sleep(1000);
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1500);
        await goToBoard(page);

        const hiddenByDefault = await waitUntil(
          "the concluded chat to be absent from both bands under the default filter",
          async () => (await sidebarRow(page, DEFAULT_CHAT_TITLE).count()) === 0,
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);
        if (!hiddenByDefault) await captureFailureEvidence(page, "concluded-row-not-hidden");
        return { ok: hiddenByDefault };
      },
    );

    await attempt(
      8,
      "toggling Cleaned up reveals the concluded chat, and clicking it reopens its retained tab, selected",
      async () => {
        await page.getByRole("button", { name: "Filter", exact: true }).click();
        await page.getByRole("menuitemcheckbox", { name: "Cleaned up", exact: true }).click();
        const row = sidebarRow(page, DEFAULT_CHAT_TITLE);
        const revealed = await waitUntil(
          "the concluded row to appear once Cleaned up is checked",
          async () => (await row.count()) >= 1,
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);
        // The rule is that a revealed row SAYS it is concluded, not which
        // element says it: the marker used to be a broom icon carrying that
        // name and is now sr-only text beside a dimmed row
        // (`session-band-row.tsx`). Either drawing satisfies the rule, so match
        // the name wherever it sits rather than one of the two carriers.
        const marker = row
          .first()
          .getByText("Cleaned up", { exact: true })
          .or(row.first().locator('[aria-label="Cleaned up"]'));
        const badge = revealed ? (await marker.count()) === 1 : false;
        await shot(page, "03-cleaned-up-revealed.png");

        await page.keyboard.press("Escape"); // close the filter menu before it intercepts the click
        await row.first().click();
        const selected = await waitUntil(
          "the row to read selected",
          async () => (await row.first().getAttribute("data-active")) === "true",
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);
        const chatTabOpen =
          (await page.getByRole("tab", { name: DEFAULT_CHAT_TITLE, exact: true }).count()) === 1;
        await shot(page, "04-cleaned-up-conversation-open.png");
        return {
          ok: revealed && badge && selected && chatTabOpen,
          detail: `revealed=${revealed} badge=${badge} selected=${selected} chatTabOpen=${chatTabOpen}`,
        };
      },
    );

    console.log(`\nEvidence dir: ${EVIDENCE_DIR}`);
  } finally {
    await app.close().catch(() => {});
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
  await cleanup().catch(() => {});
}
process.exit(code);
