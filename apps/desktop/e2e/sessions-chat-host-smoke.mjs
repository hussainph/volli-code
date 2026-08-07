/**
 * E2e proof of Session 5 — "ticket-independent chat hosting" — against the
 * BUILT app. `docs/plans/session-ui-migration-readiness.md`'s Session 5
 * section is the spec this smoke exists to close out; nothing here is wired
 * into `vp test`, and no other smoke drives this surface end to end.
 *
 * Three things have to be true, and each is its own check group:
 *
 *   (a) Sessions page: the "+" offers Terminal AND Chat, creating a Chat opens
 *       an active chat tab beside the scratch terminal tab, and a prompt
 *       streams and settles — the baseline chat-hosting seam.
 *   (b) The ticket-orphan flow: a chat born inside a ticket workspace survives
 *       that ticket being archived (Session 4 already proved the row stays
 *       durable and visible) and Session 5's addition — clicking the now
 *       ticket-independent sidebar row opens the SAME conversation on
 *       Sessions, not just the page.
 *   (c) The Cleaned up filter: a chat the cleanup rules have genuinely
 *       concluded is hidden from Previous by default and reappears — openable
 *       — once the filter is toggled. This is the other half of the readiness
 *       doc's sentence: "Open the exact conversation when a sidebar row
 *       represents ... a chat whose former ticket is gone. This includes rows
 *       shown by the Cleaned up filter."
 *
 * Setup for (a)/(b) reuses session-chat-smoke.mjs's fake-opencode pattern
 * near-verbatim — see that file's header for the full "why order matters"
 * writeup. Short version: the `opencode` binary Volli spawns has to BE the
 * fake (`harness.commandSet`) before anything ever probes OpenCode, and the
 * composer only reads a SAVED model preference, never a live discovery
 * snapshot — so the fake's one model is toggled on via the Settings switch
 * BEFORE the first chat tab opens.
 *
 * (c)'s "genuinely concluded" chat cannot be built the way it first looks like
 * it should: `isConcludedBusiness` (active-session-listing.ts, ~430) is gated
 * by `isCleanupExempt`, which protects any Session whose execution surface is
 * still `attached`. For a chat, `attached` is `ChatSessionRecord.live` —
 * `attachment?.status === "open"` in main (chat-attachment.ts) — and THREE
 * separate UI actions were tried and empirically confirmed NOT to clear it in
 * this build: closing the chat tab (`client.dispose()`'s own comment: "Releases
 * nothing on the harness — the Session outlives it"), relaunching the app
 * (main/index.ts's boot-recovery loop closes only `adapterId === "terminal"`
 * attachments, by design — "the durable Session itself intentionally remains
 * open"), and killing the adapter server process outright (an already-open
 * lease has nothing to notice the death with; a follow-up prompt against it
 * just hangs). The one thing that DOES record `attachment.failed` — verified
 * empirically, not inferred — is the adapter never successfully attaching in
 * the first place: point `opencode` at a binary that exits nonzero, and the
 * spawn failure lands as a closed attachment immediately. So (c)'s chat is
 * built against a deliberately-broken `opencode` override, switched in AFTER
 * (a)/(b) are done with the working fake server (confirmed not to disturb
 * their already-leased sessions — the two coexist in one app process).
 *
 * That still leaves the Active band's own gate: `activeGroup` (same file)
 * keeps ANY row with recent activity in Active for `ACTIVE_QUIET_WINDOW_MS`
 * (30 minutes) regardless of ticket or attachment state — recency, not
 * conclusion, decides Active membership. A freshly-created chat cannot age
 * out of that within a smoke's runtime, so this uses Playwright's `page.clock`
 * to fast-forward the renderer's own `Date.now()` past the window (confirmed
 * to survive a `page.reload()`, which is also what forces the sidebar's `now`
 * state — otherwise pinned to whenever it last ran a timer — to actually pick
 * up the jump). This drives the REAL predicate against a REAL later instant;
 * nothing about Zustand or IPC state is touched by hand.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/sessions-chat-host-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cardById,
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

const FAKE_SERVER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "lib",
  "fake-opencode-server.mjs",
);

// Kept in sync with fake-opencode-server.mjs's ANSWER_CHUNKS, same as
// session-chat-smoke.mjs — see that file for why this can't just be imported.
const ANSWER_BODY = "This is a fake OpenCode answer, streamed in three pieces, and now it settles.";
const answerText = (turn) => `Answer ${turn}: ${ANSWER_BODY}`;
// Kept in sync with MODEL_LABEL in lib/fake-opencode-server.mjs.
const MODEL_LABEL = "Fake Model";

const PROJECT = { id: "sessions-chat-host-project", name: "Sessions Chat Host", prefix: "SH" };
const SCRATCH_PROMPT = "Say hi from a scratch chat on the Sessions page.";
const ORPHAN_PROMPT = "Say hi before this ticket is archived.";
// The conclude-flow chat never sends a message (its harness never attaches),
// so it keeps the tab strip's own default label — see the module doc comment
// for why this is the one honest way to get a genuinely `!attached` chat.
const DEFAULT_CHAT_TITLE = "Chat 1";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("sessions-chat-host-smoke-");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-sessions-chat-host-evidence");

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

/** Verbatim from session-chat-smoke.mjs — see that file's header for why order matters. */
async function setOpenCodeBinaryOverride(page, binaryPath) {
  const result = await page.evaluate(
    ({ harnessId, command }) => window.api.harness.commandSet({ harnessId, command }),
    { harnessId: "opencode", command: binaryPath },
  );
  if (!result.ok) throw new Error(`commandSet refused: ${result.error ?? result.reason}`);
  const readBack = await page.evaluate(
    (harnessId) => window.api.harness.commandGet({ harnessId }),
    "opencode",
  );
  if (!readBack.ok || readBack.command !== binaryPath) {
    throw new Error(`commandGet did not confirm the override: ${JSON.stringify(readBack)}`);
  }
}

/** Settings → Harness Runtimes → OpenCode, then wait for the model browser's first probe to settle. */
async function openOpenCodeHarnessPane(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Harness Runtimes", exact: true }).click();
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();
  return waitUntil(
    "the OpenCode model browser to settle",
    async () => {
      if ((await page.getByText("Checking the local runtime…").count()) > 0) return false;
      if ((await page.getByText("OpenCode unavailable").count()) > 0) {
        const reason = await page
          .locator("p.mt-1.text-xs.text-muted-foreground")
          .first()
          .textContent()
          .catch(() => null);
        return { unavailable: true, reason };
      }
      const switches = await page.getByRole("switch", { name: /^Show .+ in chat$/ }).count();
      return switches > 0 ? { unavailable: false, switches } : false;
    },
    { timeout: 20000 },
  );
}

/** Toggles the fake model on so `runtimeCatalog.resolve()` — what the composer reads — includes it. */
async function enableFakeModel(page, label) {
  const target = page.getByRole("switch", { name: `Show ${label} in chat`, exact: true });
  await target.click();
  await waitUntil(
    `"${label}" switch to flip to checked`,
    async () => (await page.getByRole("switch", { name: `Hide ${label} in chat` }).count()) > 0,
  );
}

/** The nearest visible tablist's own "+" — scopes past the ticket rail's identical mount. */
function tabStripNewSessionButton(page) {
  return page
    .locator('[role="tablist"]')
    .locator("xpath=..")
    .getByRole("button", { name: "New session", exact: true });
}

/** The Stop button, on screen for exactly as long as a turn is running. */
function stopButton(page) {
  return page.getByRole("button", { name: "Stop", exact: true });
}

async function submitPrompt(page, text) {
  const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press("Enter");
}

async function waitComposerReady(page) {
  const textarea = page.getByPlaceholder("Ask, plan, or implement…");
  await waitUntil("the composer to mount", async () => (await textarea.count()) > 0);
  await waitUntil(
    "the composer to become ready (a model is selectable)",
    async () => !(await textarea.first().isDisabled()),
    { timeout: 20000 },
  );
}

/** Submit `text`, wait for the turn to start, stream, and settle. */
async function runTurnToSettle(page, text, turn) {
  await waitComposerReady(page);
  await submitPrompt(page, text);
  await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
    timeout: 10000,
  });
  await waitUntil(
    "the streamed answer text",
    async () => (await page.getByText(answerText(turn), { exact: false }).count()) > 0,
    { timeout: 15000 },
  );
  await waitUntil("the turn to settle", async () => (await stopButton(page).count()) === 0, {
    timeout: 15000,
  });
}

/** Returns to the board's card list from an open ticket detail (Doc tab click moves focus off the composer first). */
async function returnToBoardFromTicket(page, displayId) {
  await page.getByRole("tab", { name: displayId, exact: true }).click();
  await page.keyboard.press("Escape");
  await waitUntil(
    "the board list to be back",
    async () => (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
    { timeout: 10000 },
  );
}

/** Archives `displayId` through the board card's own context menu. */
async function archiveTicketViaCard(page, displayId) {
  await cardById(page, displayId).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive", exact: true }).waitFor();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await waitUntil(
    "the card to leave the board",
    async () => (await cardById(page, displayId).count()) === 0,
    { timeout: 10000 },
  );
}

/** A project sidebar row (either band) whose visible text includes `text`. */
function sidebarRow(page, text) {
  return page.locator("[data-session-band] button", { hasText: text });
}

async function main() {
  const fakeLog = join(scratch, "fake-opencode.log");
  const app = await launch({ dbPath, userDataDir, extraEnv: { VOLLI_FAKE_OPENCODE_LOG: fakeLog } });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "sessions-chat-host-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    await attempt(
      1,
      "point the OpenCode harness binary override at the fake server before anything probes it",
      async () => {
        await setOpenCodeBinaryOverride(page, FAKE_SERVER_PATH);
        return { ok: true, detail: FAKE_SERVER_PATH };
      },
    );

    await attempt(
      2,
      "Settings' model browser discovers exactly the fake provider's model",
      async () => {
        const settled = await openOpenCodeHarnessPane(page).catch((error) => error);
        if (settled instanceof Error) {
          await captureFailureEvidence(page, "models-settle-timeout");
          return { ok: false, detail: settled.message };
        }
        if (settled.unavailable) {
          await captureFailureEvidence(page, "models-unavailable");
          return { ok: false, detail: `OpenCode unavailable: ${settled.reason ?? "unknown"}` };
        }
        return { ok: settled.switches === 1, detail: `switches=${settled.switches}` };
      },
    );

    await attempt(3, "enable the fake model so the composer's catalog includes it", async () => {
      await enableFakeModel(page, MODEL_LABEL);
      return { ok: true, detail: MODEL_LABEL };
    });

    // =====================================================================
    // (a) Sessions page hosts chat tabs beside terminal tabs
    // =====================================================================

    await attempt(
      4,
      "Sessions nav shows an auto-opened scratch terminal and a Terminal/Chat + menu",
      async () => {
        await page.getByRole("button", { name: "Sessions", exact: true }).click();
        await waitUntil(
          "the auto-opened scratch terminal tab",
          async () => (await page.locator('[role="tab"]').count()) >= 1,
          { timeout: 20000 },
        );
        const terminalTabsBefore = await page.locator('[role="tab"]').count();
        await tabStripNewSessionButton(page).click();
        const menuOk = await waitUntil(
          "the + menu to offer Terminal and Chat",
          async () =>
            (await page.getByRole("menuitem", { name: "Terminal", exact: true }).count()) === 1 &&
            (await page.getByRole("menuitem", { name: "Chat", exact: true }).count()) === 1,
        )
          .then(() => true)
          .catch(() => false);
        await shot(page, "01-sessions-new-menu.png");
        await page.keyboard.press("Escape");
        return { ok: menuOk, detail: `terminalTabsBefore=${terminalTabsBefore}` };
      },
    );

    await attempt(
      5,
      "creating a Chat from Sessions opens an active chat tab beside the terminal tab",
      async () => {
        const tabsBefore = await page.locator('[role="tab"]').count();
        await tabStripNewSessionButton(page).click();
        await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
        await waitUntil(
          "a new chat tab to appear and become active",
          async () => (await page.locator('[role="tab"]').count()) > tabsBefore,
        );
        const activeLabel = await page
          .locator('[role="tab"][aria-selected="true"]')
          .getAttribute("aria-label");
        const terminalTabStillThere = (await page.locator('[role="tab"]').count()) >= 2;
        return {
          ok: activeLabel !== null && terminalTabStillThere,
          detail: `active="${activeLabel}" totalTabs=${await page.locator('[role="tab"]').count()}`,
        };
      },
    );

    await attempt(6, "a prompt in the scratch chat streams and settles", async () => {
      await runTurnToSettle(page, SCRATCH_PROMPT, 1).catch(async (error) => {
        await captureFailureEvidence(page, "scratch-chat-turn-failed");
        throw error;
      });
      await shot(page, "02-scratch-chat-settled.png");
      return { ok: true };
    });

    // =====================================================================
    // (b) the ticket-orphan flow: archive mid-conversation, reopen from the
    //     sidebar, land on the SAME conversation
    // =====================================================================

    let orphanTicketId = null;
    await attempt(7, "a chat born in a ticket workspace sends and settles a message", async () => {
      const result = await page.evaluate((input) => window.api.tickets.create(input), {
        projectId,
        status: "todo",
        title: "Orphan chat ticket",
        priority: "medium",
      });
      if (!result.ok) return { ok: false, detail: result.error };
      orphanTicketId = `${PROJECT.prefix}-${result.ticket.ticketNumber}`;
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await sleep(1000);
      await goToBoard(page);

      await cardById(page, orphanTicketId).dblclick();
      await waitUntil(
        "the ticket detail to open",
        async () =>
          (await page.getByRole("tab", { name: orphanTicketId, exact: true }).count()) === 1,
      );
      const tabsBefore = await page.locator('[role="tab"]:visible').count();
      await tabStripNewSessionButton(page).click();
      await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
      await waitUntil(
        "the ticket's new chat tab to appear",
        async () => (await page.locator('[role="tab"]:visible').count()) > tabsBefore,
      );
      await runTurnToSettle(page, ORPHAN_PROMPT, 1).catch(async (error) => {
        await captureFailureEvidence(page, "orphan-chat-turn-failed");
        throw error;
      });
      return { ok: true, detail: orphanTicketId };
    });

    await attempt(
      8,
      "archiving the ticket via the board card's context menu takes it off the board",
      async () => {
        await returnToBoardFromTicket(page, orphanTicketId);
        await archiveTicketViaCard(page, orphanTicketId);
        await shot(page, "03-orphan-ticket-archived.png");
        return { ok: true };
      },
    );

    await attempt(
      9,
      "the ticket-independent chat's sidebar row opens the SAME conversation on Sessions, selected",
      async () => {
        const row = sidebarRow(page, ORPHAN_PROMPT);
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
          "the settled conversation to render on Sessions",
          async () => (await page.getByText(answerText(1), { exact: false }).count()) > 0,
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
        await shot(page, "04-orphan-row-reopened.png");
        return {
          ok: conversationOpen && selected,
          detail: `conversationOpen=${conversationOpen} selected=${selected}`,
        };
      },
    );

    // =====================================================================
    // (c) the Cleaned up filter: a genuinely concluded chat is hidden by
    //     default and reachable once revealed — see the module doc comment
    //     for why the harness deliberately fails to attach here.
    // =====================================================================

    let concludeTicketId = null;
    await attempt(
      10,
      "a chat whose adapter never attached, whose ticket is archived, and whose clock has moved past the Active window is hidden from Previous by default",
      async () => {
        const brokenBinary = join(scratch, "broken-opencode.sh");
        await fs.writeFile(
          brokenBinary,
          "#!/bin/sh\necho 'broken-opencode: refusing to serve' >&2\nexit 1\n",
          { mode: 0o755 },
        );
        // Switching the override does not disturb (a)/(b)'s already-attached
        // chats — each session's attach is resolved once, at its own attach
        // time, against whatever the override read then.
        await setOpenCodeBinaryOverride(page, brokenBinary);

        const result = await page.evaluate((input) => window.api.tickets.create(input), {
          projectId,
          status: "todo",
          title: "Concluded chat ticket",
          priority: "medium",
        });
        if (!result.ok) return { ok: false, detail: result.error };
        concludeTicketId = `${PROJECT.prefix}-${result.ticket.ticketNumber}`;
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1000);
        await goToBoard(page);

        await cardById(page, concludeTicketId).dblclick();
        await waitUntil(
          "the ticket detail to open",
          async () =>
            (await page.getByRole("tab", { name: concludeTicketId, exact: true }).count()) === 1,
        );
        const tabsBefore = await page.locator('[role="tab"]:visible').count();
        await tabStripNewSessionButton(page).click();
        await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
        await waitUntil(
          "the doomed chat tab to appear",
          async () => (await page.locator('[role="tab"]:visible').count()) > tabsBefore,
        );
        // No message is ever sent — the harness fails to attach before the
        // composer could deliver one, which is the whole point (see header).
        const live = await waitUntil(
          "the chat's attachment to record as closed (attach failure)",
          async () => {
            const recs = await page.evaluate(
              (pid) => window.api.sessions.list({ projectId: pid }),
              projectId,
            );
            if (!recs.ok) return false;
            const mine = recs.sessions.find(
              (s) => s.kind === "chat" && s.record.title === DEFAULT_CHAT_TITLE,
            );
            return mine !== undefined && mine.record.live === false ? true : false;
          },
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);

        await returnToBoardFromTicket(page, concludeTicketId);
        await archiveTicketViaCard(page, concludeTicketId);

        // The Active band keeps ANY recently-active row for
        // ACTIVE_QUIET_WINDOW_MS (30 min) regardless of conclusion — jump the
        // renderer's own clock past it and reload so the sidebar's `now`
        // state (otherwise pinned to whenever it last ran a timer) picks up
        // the new instant.
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
        return {
          ok: live && hiddenByDefault,
          detail: `attachFailedToLive=${live} hiddenByDefault=${hiddenByDefault}`,
        };
      },
    );

    await attempt(
      11,
      "toggling Cleaned up reveals the concluded chat, and clicking it opens its conversation on Sessions, selected",
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
        const badge = revealed
          ? (await row.first().locator('[aria-label="Cleaned up"]').count()) === 1
          : false;
        await shot(page, "05-cleaned-up-revealed.png");

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
        await shot(page, "06-cleaned-up-conversation-open.png");
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
