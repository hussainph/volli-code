/**
 * Menu-bar mode's turn journey on the BUILT app (VC-577): ⌘Q in the middle of
 * a real structured turn keeps Electron main running as the host, windowless,
 * until the turn finishes — and the turn finishes as `completed`, not
 * `interrupted`.
 *
 *   1. With `VOLLI_EXPERIMENTAL=cloud`, a Home chat starts a real Pi turn that
 *      runs one slow tool call.
 *   2. ⌘Q (`app.quit()`, the same `before-quit` the menu's Quit raises) mid-
 *      turn: the process stays, every window is gone, menu-bar mode holds.
 *   3. The turn completes with no window, and the host then drains and exits
 *      on its own: exit 0 (menu-bar residency is "quit when done").
 *   4. Relaunching the same profile shows the finished turn: the ledger has
 *      `turn.completed` for it and no `turn.interrupted`, and the transcript
 *      renders the reply that was written while no window existed.
 *
 * CREDENTIAL-GATED: it drives a live Pi turn, so it calls `ensurePiAuthInto`,
 * which `run-smokes.mjs` detects structurally and keeps out of CI — a runner
 * has no model login. `menu-bar-host-smoke.mjs` is the credential-free half
 * CI runs.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/menu-bar-turn-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real
 * `~/.pi/agent/auth.json` with `openai-codex` credentials); NOT wired into
 * `vp test`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assistantReplyTexts,
  childHasExited,
  closeAppBounded,
  createRunner,
  ensurePiAuthInto,
  goToBoard,
  HOME_TAB_STRIP,
  launch,
  makeGitRepo,
  makeScratch,
  openNewChatTab,
  PI_TURN_BUDGET_MS,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  stopButton,
  tabStrip,
  waitForChildExit,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "menu-bar-turn-project", name: "Menu Bar Turn", prefix: "MB" };
const MODEL_PIN = { providerId: "openai-codex", modelId: "gpt-5.6-luna", reasoningLevel: "low" };
const MARKER = "MENU-BAR-DONE";
// One slow tool call keeps the turn open long enough to quit in the middle of it.
const PROMPT_TEXT = `Run the shell command \`sleep 20\`, then reply with exactly: ${MARKER}`;
const ENV = { VOLLI_EXPERIMENTAL: "cloud", VOLLI_SMOKE_MENU_BAR_HOST: "1" };

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("menu-bar-turn-smoke-");
const fakeHome = join(scratch, "home");
const { must, attempt, summarize } = createRunner();

async function chatSessionIds(page, projectId) {
  const listed = await page.evaluate(
    (id) => window.api.sessions.list({ projectId: id }),
    projectId,
  );
  if (!listed.ok) throw new Error(`session list failed: ${JSON.stringify(listed)}`);
  return listed.sessions.filter((row) => row.kind === "chat").map((row) => row.record.sessionId);
}

async function turnFacts(page, sessionId) {
  const response = await page.evaluate(
    (id) =>
      window.api.sessionRpc.request({ procedure: "session.snapshot", input: { sessionId: id } }),
    sessionId,
  );
  if (!response.ok) throw new Error(`snapshot failed: ${JSON.stringify(response).slice(0, 200)}`);
  const kinds = (response.data.frames ?? []).map((frame) => frame.event.payload.kind);
  return {
    started: kinds.filter((kind) => kind === "turn.started").length,
    completed: kinds.filter((kind) => kind === "turn.completed").length,
    interrupted: kinds.filter((kind) => kind === "turn.interrupted").length,
  };
}

async function main() {
  await ensurePiAuthInto(fakeHome);
  const app = await launch({ dbPath, userDataDir, extraEnv: { ...ENV, HOME: fakeHome } });
  const child = app.process();
  let projectId = null;
  let sessionId = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const projectPath = await makeGitRepo(scratch, "menu-bar-turn-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    projectId = (await readSeededProjects(page)).byName[PROJECT.name]?.id ?? null;
    if (projectId === null) throw new Error("seeded project missing after import");
    await seedDefaultModel(page, MODEL_PIN);

    await must(1, "a real Pi turn is running in a Home chat", async () => {
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await waitUntil(
        "Home's tab strip",
        async () => (await tabStrip(page, HOME_TAB_STRIP).getByRole("tab").count()) >= 1,
        { timeout: 20000 },
      );
      await openNewChatTab(page, HOME_TAB_STRIP);
      const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
      await waitUntil("composer ready", async () => !(await textarea.isDisabled()), {
        timeout: 30000,
      });
      await textarea.fill(PROMPT_TEXT);
      await page.keyboard.press("Enter");
      await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
        timeout: 30000,
      });
      sessionId = (await chatSessionIds(page, projectId))[0] ?? null;
      return { ok: sessionId !== null, detail: `session=${sessionId}` };
    });

    await must(2, "⌘Q mid-turn: the process stays, no window, menu-bar mode holds", async () => {
      const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        electronApp.quit();
        return {
          windows: BrowserWindow.getAllWindows().length,
          resident: globalThis.volliMenuBarHost?.isResident() ?? false,
        };
      });
      const alive = !childHasExited(child);
      return {
        ok: alive && state.windows === 0 && state.resident,
        detail: `alive=${alive} windows=${state.windows} resident=${state.resident}`,
      };
    });

    await attempt(3, "the turn finishes windowless, then the host drains and exits 0", async () => {
      const exit = await waitForChildExit(child, "drain-then-exit after the turn", {
        timeout: PI_TURN_BUDGET_MS,
        interval: 500,
      });
      return { ok: exit.code === 0, detail: `exit=${exit.code} signal=${exit.signal ?? "none"}` };
    });
  } finally {
    if (!childHasExited(child)) await closeAppBounded(app).catch(() => {});
  }

  const relaunched = await launch({ dbPath, userDataDir, extraEnv: { ...ENV, HOME: fakeHome } });
  try {
    const page = await relaunched.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await attempt(
      4,
      "after relaunch the turn is completed, not interrupted, and rendered",
      async () => {
        const facts = await turnFacts(page, sessionId);
        await page.getByRole("button", { name: "Home", exact: true }).click();
        const row = page.locator('[data-session-band="active"] button');
        await waitUntil("the chat's sidebar row", async () => (await row.count()) === 1, {
          timeout: 15000,
        });
        await row.first().click();
        const replies = await waitUntil(
          "the reply written while no window existed",
          async () => {
            const texts = await assistantReplyTexts(page);
            return texts.some((text) => text.includes(MARKER)) ? texts : null;
          },
          { timeout: 15000 },
        ).catch(() => []);
        return {
          ok: facts.completed >= 1 && facts.interrupted === 0 && replies.length > 0,
          detail:
            `started=${facts.started} completed=${facts.completed} ` +
            `interrupted=${facts.interrupted} marker=${replies.length > 0}`,
        };
      },
    );
  } finally {
    await closeAppBounded(relaunched).catch(() => {});
  }
  await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
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
