/**
 * E2e proof of the Pi-backed native adapter attaching a real TICKETLESS
 * (scratch) chat, against the BUILT app — the ticketless twin of
 * `pi-ticket-chat-smoke.mjs`. Project Sessions attached OpenCode until commit
 * 49a62640 moved them onto the same Pi runtime a ticket chat uses
 * (`apps/desktop/src/main/session-runtime/project-sessions.ts`), and commit
 * 0f0e7007 gave them the ticket composer's model semantics
 * (`chat-plane.tsx` dropped its ticket/project "pinned" carve-out) — so the
 * retired `session-chat-smoke.mjs`'s fake-`opencode`-binary proof of the
 * scratch-chat lifecycle no longer has anything to attach to. This is that
 * proof, rebuilt on the real thing: there is no fake server anywhere here,
 * and this smoke drives ONE real turn against a real provider, billed to a
 * ChatGPT subscription ($0 marginal — keep it to one short prompt, never loop
 * turns speculatively).
 *
 * Two things make a real Pi turn against a TICKETLESS Session possible at
 * all, both set up before the first prompt is typed:
 *
 *   1. **Credentials.** Same posture as `pi-ticket-chat-smoke.mjs`, over the
 *      same shared helper: `HOME` is isolated into a scratch dir (never the
 *      developer's real profile), and the real `~/.pi/agent/auth.json` is
 *      copied into `<fakeHome>/.pi/agent/auth.json` by `smoke-kit.mjs`'s
 *      `ensurePiAuthInto`. Fails fast with a clear message if the real file is
 *      missing; the copy is never read back or logged, and is shredded on the
 *      way out however this process dies.
 *   2. **An app-wide default model.** `project-sessions.ts`'s `start()` calls
 *      `requireDefaultModel` exactly like a Ticket Session does — nothing
 *      bootstraps this on a fresh profile, so check 1 records one over the
 *      same `modelAccess.setDefault` tRPC mutation Settings' "Default model"
 *      section uses (`smoke-kit.mjs`'s `seedDefaultModel`), same as
 *      `pi-ticket-chat-smoke.mjs`'s own check 1.
 *
 * Once both are in place the composer offers the same Model Access pill a
 * ticket chat's does (check 3) — the "born ticketless" carve-outs that used
 * to hide it are gone.
 *
 * A scratch chat's open TAB is not itself durable — its Session is — so
 * "the session resumes" after a relaunch is a sidebar-row click, not an
 * auto-reopened tab (same finding the retired smoke made). Check 6 proves
 * that adopts the SAME conversation from durable data, with no live executor
 * attached. Check 7 proves the other end of a chat tab's life: closing it
 * retires the tab, and nothing puts it back — `client.dispose()`'s own
 * comment is "Releases nothing on the harness — the Session outlives it", so
 * this is checking the TAB's retirement, not the Session's.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/pi-scratch-chat-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real
 * `~/.pi/agent/auth.json` with `openai-codex` credentials); NOT wired into
 * `vp test`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  assistantReplyTexts,
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
  stopButton,
  waitForSettledReply,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "pi-scratch-chat-project", name: "Pi Scratch Chat", prefix: "SC" };
// Kept at or under 48 characters, on purpose: `autoTitleFromMessage`
// (chat/rename.ts) keeps a first line of 48 characters or fewer verbatim as
// the Session's title, so this prompt IS the title once delivered — no
// transformation to restate here, and a change to either end surfaces as
// this smoke failing to find its own tab after the first message lands.
const PROMPT_TEXT = "Reply with one short sentence, please.";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("pi-scratch-chat-smoke-");
// Isolates Pi's own credential/config lookups from the developer's real
// profile — the same posture VOLLI_WORKTREE_HOME_DIR takes for worktrees.
const fakeHome = join(scratch, "home");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-pi-scratch-chat-evidence");

async function captureFailureEvidence(page, mainOut, mainErr, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `pi-scratch-chat-${slug}.png`), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    join(EVIDENCE_DIR, `pi-scratch-chat-${slug}.log`),
    [
      `=== ${label} ===`,
      "",
      "--- main process stdout ---",
      mainOut.join(""),
      "",
      "--- main process stderr ---",
      mainErr.join(""),
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-scratch-chat-${slug}.png`)}`);
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-scratch-chat-${slug}.log`)}`);
}

/** The nearest visible tablist's own "+" — scopes past the ticket rail's identical mount. */
function tabStripNewSessionButton(page) {
  return page
    .locator('[role="tablist"]')
    .locator("xpath=..")
    .getByRole("button", { name: "New session", exact: true });
}

/** Navigate to Sessions and wait for its (auto-opened scratch terminal) tab strip to mount. */
async function goToSessions(page) {
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await waitUntil(
    "the Sessions tab strip to mount",
    async () => (await page.locator('[role="tab"]').count()) >= 1,
    { timeout: 20000 },
  );
}

async function openNewChatTab(page) {
  const tabsBefore = await page.locator('[role="tab"]').count();
  await tabStripNewSessionButton(page).click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await waitUntil(
    "a new chat tab to appear",
    async () => (await page.locator('[role="tab"]').count()) > tabsBefore,
  );
  const activeLabel = await page
    .locator('[role="tab"][aria-selected="true"]')
    .getAttribute("aria-label");
  if (activeLabel === null) throw new Error("no tab became active after New Chat");
  return activeLabel;
}

/** Submits `text` and returns the moment it was sent — the turn clock's zero. */
async function submitPrompt(page, text) {
  const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press("Enter");
  return Date.now();
}

/** User-role messages (`Message`'s `is-user` class), non-empty text only. */
async function userMessageTexts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".is-user"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => text.length > 0),
  );
}

/**
 * A project sidebar row (either band) whose visible text includes `text` — a
 * scratch chat's open tab does not survive a relaunch on its own (unlike a
 * ticket's, which the adopt path restores from the recorded active tab);
 * reopening one is a sidebar-row click, the same path a person uses.
 */
function sidebarRow(page, text) {
  return page.locator("[data-session-band] button", { hasText: text });
}

async function main() {
  await ensurePiAuthInto(fakeHome);
  await fs.mkdir(fakeHome, { recursive: true });

  const app = await launch({ dbPath, userDataDir, extraEnv: { HOME: fakeHome } });
  const mainStdout = [];
  const mainStderr = [];
  const proc = app.process();
  proc.stdout?.on("data", (chunk) => mainStdout.push(chunk.toString()));
  proc.stderr?.on("data", (chunk) => mainStderr.push(chunk.toString()));

  let chatTabLabel = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "pi-scratch-chat-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    let defaultModel = null;
    await attempt(
      1,
      "seed the app default model — a ticketless Session requires one before it can start",
      async () => {
        defaultModel = await seedDefaultModel(page);
        return { ok: defaultModel !== null, detail: JSON.stringify(defaultModel) };
      },
    );

    await attempt(
      2,
      "the Sessions page's + menu creates a ticketless (scratch) chat tab",
      async () => {
        await goToSessions(page);
        chatTabLabel = await openNewChatTab(page);
        return { ok: chatTabLabel !== null, detail: chatTabLabel };
      },
    );

    await attempt(
      3,
      "the composer is ready, its Model pill naming the recorded model — the ticket-only 'pinned' carve-out is gone",
      async () => {
        const textarea = page.getByPlaceholder("Ask, plan, or implement…");
        await waitUntil("the composer to mount", async () => (await textarea.count()) > 0);
        await waitUntil(
          "the composer to become ready",
          async () => !(await textarea.first().isDisabled()),
          { timeout: 30000 },
        ).catch(async (error) => {
          await captureFailureEvidence(page, mainStdout, mainStderr, "composer-inert");
          throw error;
        });
        const pill = page.getByRole("button", { name: defaultModel.label });
        const shown = await waitUntil(
          "the model pill to name the recorded model",
          async () => (await pill.count()) > 0,
        )
          .then(() => true)
          .catch(() => false);
        const placeholderShown =
          (await page.getByRole("button", { name: "Model", exact: true }).count()) > 0;
        return {
          ok: shown && !placeholderShown,
          detail: `label=${defaultModel.label} shown=${shown} placeholderShown=${placeholderShown}`,
        };
      },
    );

    let submittedAt = null;
    await attempt(
      4,
      "submitting the one real prompt starts a turn (streaming/working state appears)",
      async () => {
        submittedAt = await submitPrompt(page, PROMPT_TEXT);
        await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
          timeout: 15000,
        }).catch(async (error) => {
          await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-started");
          throw error;
        });
        return { ok: true };
      },
    );

    // One real network round trip, on ONE clock started at the keystroke above
    // — see `waitForSettledReply` and `PI_TURN_BUDGET_MS` in the kit for what
    // that budget was measured against and why prose is what ends the wait.
    await attempt(
      5,
      "the turn settles with a non-empty assistant reply in the transcript",
      async () => {
        const settled = await waitForSettledReply(page, { since: submittedAt }).catch(
          async (error) => {
            await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-settled");
            throw error;
          },
        );
        // The first delivered message names the Session (`chat/client.ts`'s
        // `#autoTitle`), so the "Chat 1" captured at creation is no longer
        // what the tab — or the sidebar row the relaunch below looks for —
        // is called.
        chatTabLabel = await page
          .locator('[role="tab"][aria-selected="true"]')
          .getAttribute("aria-label");
        return {
          ok: settled.texts.length > 0 && chatTabLabel !== null,
          detail:
            `turn=${(settled.elapsedMs / 1000).toFixed(1)}s replies=${settled.texts.length} ` +
            `tab=${chatTabLabel} reply=${JSON.stringify(settled.texts[0]?.slice(0, 80) ?? "")}`,
        };
      },
    );

    // ---- relaunch on the same profile, adopt (no live attach), and assert
    // the DURABLE transcript is what renders both sides of the exchange.
    await sleep(500);
    await app.close();

    const app2 = await launch({ dbPath, userDataDir, extraEnv: { HOME: fakeHome } });
    const relaunchStdout = [];
    const relaunchStderr = [];
    const proc2 = app2.process();
    proc2.stdout?.on("data", (chunk) => relaunchStdout.push(chunk.toString()));
    proc2.stderr?.on("data", (chunk) => relaunchStderr.push(chunk.toString()));
    try {
      const page2 = await app2.firstWindow();
      await page2.waitForLoadState("domcontentloaded");
      await sleep(1000);

      await attempt(
        6,
        "after relaunch, the sidebar reopens the scratch chat and resumes BOTH messages from durable data, no live attach",
        async () => {
          const row = sidebarRow(page2, chatTabLabel);
          await waitUntil(
            "the chat's sidebar row to reappear after relaunch",
            async () => (await row.count()) >= 1,
            { timeout: 15000 },
          ).catch(async (error) => {
            await captureFailureEvidence(
              page2,
              relaunchStdout,
              relaunchStderr,
              "relaunch-row-missing",
            );
            throw error;
          });
          await row.first().click();
          const chatTab = page2.getByRole("tab", { name: chatTabLabel, exact: true });
          await waitUntil(
            "the chat tab to open from the sidebar row",
            async () => (await chatTab.count()) > 0,
            { timeout: 10000 },
          ).catch(async (error) => {
            await captureFailureEvidence(
              page2,
              relaunchStdout,
              relaunchStderr,
              "relaunch-tab-not-opened",
            );
            throw error;
          });
          await chatTab.click();
          const rendered = await waitUntil(
            "both durable messages to render without a live adapter",
            async () => {
              const userTexts = await userMessageTexts(page2);
              const assistantTexts = await assistantReplyTexts(page2);
              return userTexts.some((t) => t.includes(PROMPT_TEXT)) && assistantTexts.length > 0
                ? { userTexts, assistantTexts }
                : false;
            },
            { timeout: 10000 },
          ).catch(() => null);
          if (!rendered) {
            await captureFailureEvidence(
              page2,
              relaunchStdout,
              relaunchStderr,
              "relaunch-transcript-missing",
            );
          }
          return {
            ok: rendered !== null,
            detail: rendered
              ? `user=${rendered.userTexts.length} assistant=${rendered.assistantTexts.length}`
              : "missing",
          };
        },
      );

      // The close trap this smoke exists to catch: this tab is the persisted
      // active one AND its Session is still on the sidebar's durable listing —
      // exactly the pair a relaunch-effect regression would adopt from.
      // Standing the active tab down before the close is the whole of what
      // stops it; a reordering that lost it would leave a chat tab nobody can
      // close, with every check above still green.
      await attempt(7, "closing the chat tab retires it, and nothing puts it back", async () => {
        const chatTab = page2.getByRole("tab", { name: chatTabLabel, exact: true });
        await page2.getByRole("button", { name: `Close ${chatTabLabel}`, exact: true }).click();
        await waitUntil("the chat tab to go", async () => (await chatTab.count()) === 0);
        // A fixed wait, because what is being asserted is that nothing
        // happens: a resurrection would land on the effect after the close
        // commits, and there is no state to poll for its absence.
        await sleep(1500);
        const back = await chatTab.count();
        return { ok: back === 0, detail: back === 0 ? "stayed closed" : "the tab came back" };
      });
    } finally {
      await app2.close().catch(() => {});
    }

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
