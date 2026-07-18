/**
 * RED-phase acceptance smoke for the composer's "Create & start" agent kickoff.
 *
 * The kickoff button (data-testid="composer-kickoff") is the composer's
 * primary action. Its behaviour (per the ui/ticket-creation-fix spec):
 *   • accessible name starts with "Create & start" and carries the current
 *     harness label, e.g. "Create & start · Claude Code";
 *   • a neighboring "Choose agent" picker (visible label = active harness)
 *     opens a menu of Claude Code / Codex / Opencode that switches the
 *     active harness;
 *   • clicking it creates the ticket DIRECTLY in Doing (regardless of the Status
 *     chip), navigates into the ticket detail view, creates + focuses a terminal
 *     session tab, and AUTO-LAUNCHES the harness CLI inside that session's shell
 *     with the ticket title+body as the initial prompt argument (default harness
 *     claude-code → the `claude` binary);
 *   • ⌘+Shift+Enter is the kickoff hotkey;
 *   • with "Create more" ON, kickoff still boots the agent (in the background) but
 *     keeps the composer open and does NOT navigate away.
 *
 * The terminal is a WebGPU canvas — its text isn't in the DOM — so we prove the
 * harness launched via the FAKE-HARNESS probe file (./lib/fake-harness.mjs): a
 * scratch `claude`/`codex`/`opencode` that records its argv, deterministically
 * shadowing the real ones through the PTY's login shell. We POLL that file and
 * assert the recorded binary + that its argv contains the ticket title AND body.
 *
 * Written BEFORE the composer exists ⇒ the kickoff checks are EXPECTED TO FAIL
 * now (missing composer UI), cleanly — never by crashing. The fake-harness
 * shadow precheck passes today (it runs outside the app).
 *
 *   Run:
 *     pnpm run build                                    # dist/ + dist-electron/
 *     node apps/desktop/e2e/composer-kickoff-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";

import { buildFakeHarness, harnessEnv, runShadowSanityCheck } from "./lib/fake-harness.mjs";
import {
  assertProfileIsolated,
  columnHasCard,
  createRunner,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  readFileSafe,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch(
  "volli-composer-kickoff-smoke-",
);
const { attempt, summarize } = createRunner();

const PROJECT = { id: "kickoff-project", name: "Kickoff Project", prefix: "KO" };
const harness = await buildFakeHarness(scratch);

// ---- composer / detail helpers ---------------------------------------------

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

/** Detail view is open when the chrome tab strip has rendered tabs (the board has none). */
async function detailOpen(page) {
  return (await page.getByRole("tab").count()) >= 1;
}

/** Type title + body into the composer (body via the CodeMirror content div). */
async function fillTitleAndBody(page, title, body) {
  await titleInput(page).fill(title);
  await composer(page).locator(".cm-content").click();
  await page.keyboard.type(body);
}

async function ticketsFor(page, projectId) {
  return page.evaluate(async (id) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return [];
    return boot.data.ticketsByProject?.[id] ?? [];
  }, projectId);
}

/** Reset the shared probe file so each kickoff flow reads only its own launch. */
async function resetProbe() {
  await fs.rm(harness.probe, { force: true });
}

// ---- main ------------------------------------------------------------------

async function main() {
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: harnessEnv(harness),
  });
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

    // === 0. Precondition: the fake harness deterministically shadows the real one
    // Runs OUTSIDE Electron (login shell + path_helper), so it passes today and
    // proves the probe-based kickoff assertions below are trustworthy.
    await attempt(
      0,
      "Fake-harness shadow: zsh -lic resolves claude/codex/opencode to the scratch bin",
      async () => {
        const results = await Promise.all(
          harness.binaries.map((bin) => runShadowSanityCheck(harness, bin)),
        );
        const ok = results.every((r) => r.ok);
        return {
          ok,
          detail: results.map((r) => `${r.resolved}${r.ok ? "" : `!=${r.expected}`}`).join(", "),
        };
      },
    );

    // === 1. Default kickoff: Doing + detail view + session tab + claude launched with title+body
    await attempt(
      1,
      "Kickoff (default claude-code): ticket created in Doing, detail view opens with the session tab FOCUSED (terminal front and center), and the `claude` harness is auto-launched with the title+body prompt",
      async () => {
        await resetProbe();
        const opened = await openComposerViaHeader(page);
        if (!opened || (await kickoffButton(page).count()) === 0) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer / kickoff button missing (composer not built)" };
        }
        // Default harness label present on the kickoff primary.
        const kickoffLabel = (await kickoffButton(page).getAttribute("aria-label")) ?? "";
        const labelOk = kickoffLabel.startsWith("Create & start");

        const title = "Kickoff default ticket";
        const body = "Kickoff body marker ALPHA-42";
        // Status chip left on Backlog on purpose — kickoff must force Doing anyway.
        await fillTitleAndBody(page, title, body);
        await kickoffButton(page).click();

        // Detail view opens with the booted session's tab FOCUSED — one-step
        // kickoff lands the user in the terminal as the agent starts, not on
        // the Doc tab with the session parked behind it.
        const detail = await waitUntil("detail view opens", () => detailOpen(page), {
          timeout: 8000,
        })
          .then(() => true)
          .catch(() => false);
        const sessionFocused = await waitUntil(
          "session tab is the active tab",
          async () => {
            const active = page.locator('[role="tab"][aria-selected="true"]');
            if ((await active.count()) !== 1) return null;
            const text = (await active.textContent()) ?? "";
            return text.includes("Session") ? true : null;
          },
          { timeout: 8000 },
        )
          .then(() => true)
          .catch(() => false);
        const sessionTab = (await page.getByRole("tab").count()) >= 2; // Doc + session

        // Harness launched: poll the probe for the claude fake + title AND body.
        const probe = await waitUntil(
          "harness probe records claude + title + body",
          async () => {
            const text = await readFileSafe(harness.probe);
            if (text === null) return null;
            return text.includes(`${harness.binDir}/claude`) &&
              text.includes(title) &&
              text.includes(body)
              ? text
              : null;
          },
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);

        // Ticket is in Doing (SQLite) and on the board's Doing column. The Doc
        // tab (labeled with the display id) proves the detail belongs to the
        // ticket we just created — checked while still inside the detail view.
        const seeded = (await ticketsFor(page, projectId)).find((t) => t.title === title);
        const inDoingDb = seeded?.status === "doing";
        const displayId = seeded ? `${PROJECT.prefix}-${seeded.ticketNumber}` : "";
        const docTab = seeded
          ? (await page.getByRole("tab").filter({ hasText: displayId }).count()) >= 1
          : false;
        await goToBoard(page);
        const inDoingBoard = seeded ? await columnHasCard(page, "Doing", displayId) : false;

        const ok =
          labelOk &&
          detail &&
          sessionFocused &&
          docTab &&
          sessionTab &&
          probe &&
          inDoingDb &&
          inDoingBoard;
        return {
          ok,
          detail: `label=${JSON.stringify(kickoffLabel)} detail=${detail} sessionFocused=${sessionFocused} docTab=${docTab} sessionTab=${sessionTab} probe=${probe} doingDb=${inDoingDb} doingBoard=${inDoingBoard}`,
        };
      },
    );

    // === 2. Harness picker: choosing Codex launches the `codex` fake binary ===
    await attempt(
      2,
      'Choose agent → "Codex": kickoff auto-launches the `codex` harness (probe records the codex fake binary)',
      async () => {
        await resetProbe();
        await goToBoard(page);
        const opened = await openComposerViaHeader(page);
        if (!opened || (await kickoffButton(page).count()) === 0) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer / kickoff button missing (composer not built)" };
        }
        // Pick Codex from the "Choose agent" caret menu.
        await composer(page).getByRole("button", { name: "Choose agent" }).click();
        await sleep(200);
        await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
        await sleep(200);
        const label = (await kickoffButton(page).getAttribute("aria-label")) ?? "";
        const labelHasCodex = label.includes("Codex");

        const title = "Kickoff codex ticket";
        const body = "Kickoff body marker BETA-7";
        await fillTitleAndBody(page, title, body);
        await kickoffButton(page).click();

        const probe = await waitUntil(
          "harness probe records codex + title + body",
          async () => {
            const text = await readFileSafe(harness.probe);
            if (text === null) return null;
            return text.includes(`${harness.binDir}/codex`) &&
              !text.includes(`${harness.binDir}/claude`) &&
              text.includes(title) &&
              text.includes(body)
              ? text
              : null;
          },
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);

        // The fake harness writes its probe before the renderer necessarily
        // completes detail navigation. Synchronize on that UI transition so
        // the next check cannot race a late board -> detail change.
        const detail = await waitUntil(
          "detail view opens after Codex kickoff",
          () => detailOpen(page),
          { timeout: 12000 },
        )
          .then(() => true)
          .catch(() => false);

        const ok = labelHasCodex && probe && detail;
        return {
          ok,
          detail: `label=${JSON.stringify(label)} codexProbe=${probe} detail=${detail}`,
        };
      },
    );

    // === 3. Create-more + kickoff: agent boots in the BACKGROUND, no navigation
    await attempt(
      3,
      "Create-more ON + kickoff: the composer stays open and the app does NOT navigate to the detail view, but the harness still launches (background boot)",
      async () => {
        await resetProbe();
        await goToBoard(page);
        const opened = await openComposerViaHeader(page);
        if (!opened || (await kickoffButton(page).count()) === 0) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer / kickoff button missing (composer not built)" };
        }
        await composer(page).getByRole("switch", { name: "Create more" }).click();

        const title = "Kickoff background ticket";
        const body = "Kickoff body marker GAMMA-9";
        await fillTitleAndBody(page, title, body);
        await kickoffButton(page).click();

        const probe = await waitUntil(
          "background harness launch recorded",
          async () => {
            const text = await readFileSafe(harness.probe);
            return text !== null && text.includes(title) && text.includes(body) ? text : null;
          },
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);

        // Composer still open, no detail navigation.
        const stillOpen = (await composer(page).count()) === 1;
        const noDetail = !(await detailOpen(page));
        await closeAnyDialog(page);

        const ok = probe && stillOpen && noDetail;
        return {
          ok,
          detail: `probe=${probe} composerStillOpen=${stillOpen} noDetailNav=${noDetail}`,
        };
      },
    );

    // === 4. ⌘+Shift+Enter is the kickoff hotkey ==============================
    await attempt(
      4,
      "⌘+Shift+Enter kicks off: launches the harness and opens the detail view",
      async () => {
        await resetProbe();
        await goToBoard(page);
        const opened = await openComposerViaHeader(page);
        if (!opened || (await kickoffButton(page).count()) === 0) {
          await closeAnyDialog(page);
          return { ok: false, detail: "composer / kickoff button missing (composer not built)" };
        }
        const title = "Kickoff hotkey ticket";
        const body = "Kickoff body marker DELTA-3";
        await fillTitleAndBody(page, title, body);
        await page.keyboard.press("Meta+Shift+Enter");

        const probe = await waitUntil(
          "hotkey harness launch recorded",
          async () => {
            const text = await readFileSafe(harness.probe);
            return text !== null && text.includes(title) && text.includes(body) ? text : null;
          },
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);
        const detail = await waitUntil("detail view opens after hotkey", () => detailOpen(page), {
          timeout: 8000,
        })
          .then(() => true)
          .catch(() => false);

        const ok = probe && detail;
        return { ok, detail: `probe=${probe} detail=${detail}` };
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
