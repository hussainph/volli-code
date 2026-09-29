#!/usr/bin/env node
/**
 * Acceptance smoke for VC-358's pre-Session chat lifecycle.
 *
 * Proves the built app keeps an empty `+ Chat` entirely renderer-local, begins
 * persistence only after words exist, restores that unsent Draft after a full
 * relaunch without creating a Session, and abandons the Draft when its tab is
 * explicitly closed.
 *
 * Run after `pnpm run build`. Needs a display; uses an isolated profile and no
 * provider credentials or network turn.
 */
import {
  closeAppBounded,
  createRunner,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  openNewChatTab,
  readSeededProjects,
  seedProjects,
  HOME_TAB_STRIP,
  sleep,
  tabStrip,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "provisional-chat-project", name: "Provisional Chat", prefix: "PC" };
const DRAFT_TEXT = "unsent provisional words survive relaunch";
const CHAT_DRAFTS_KEY = "volli:chat-drafts";
const WORKSPACE_KEY = "volli:workspace";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("chat-provisional-smoke-");
const { attempt, summarize } = createRunner();

async function goToHome(page) {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await waitUntil(
    "Home's tab strip to mount",
    async () => (await tabStrip(page, HOME_TAB_STRIP).getByRole("tab").count()) >= 1,
  );
}

async function persistedEvidence(page, projectId) {
  return page.evaluate(
    async ({ draftsKey, workspaceKey, id }) => {
      const [sessions, boot] = await Promise.all([
        window.api.sessions.list({ projectId: id }),
        window.api.data.bootstrap(),
      ]);
      if (!sessions.ok) throw new Error(sessions.error);
      if (!boot.ok) throw new Error(boot.error);
      return {
        sessions: sessions.sessions.length,
        drafts: boot.data.appState[draftsKey] ?? null,
        workspace: boot.data.appState[workspaceKey] ?? null,
      };
    },
    { draftsKey: CHAT_DRAFTS_KEY, workspaceKey: WORKSPACE_KEY, id: projectId },
  );
}

async function main() {
  let app = await launch({ dbPath, userDataDir });
  try {
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "provisional-chat-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    await attempt(1, "+ Chat opens an enabled composer without durable side effects", async () => {
      await goToHome(page);
      const label = await openNewChatTab(page, HOME_TAB_STRIP);
      await sleep(600);
      const evidence = await persistedEvidence(page, projectId);
      const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
      return {
        ok:
          label !== null &&
          (await textarea.count()) === 1 &&
          !(await textarea.isDisabled()) &&
          evidence.sessions === 0 &&
          evidence.drafts === null &&
          !(evidence.workspace?.includes('"chat:') ?? false),
        detail:
          `tab=${label} sessions=${evidence.sessions} ` +
          `draftState=${evidence.drafts === null ? "absent" : "present"}`,
      };
    });

    await attempt(
      2,
      "typing persists the Draft and its stable workspace tab, still without a Session",
      async () => {
        const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
        await textarea.fill(DRAFT_TEXT);
        const evidence = await waitUntil(
          "the typed Draft to reach app_state",
          async () => {
            const found = await persistedEvidence(page, projectId);
            return found.drafts?.includes(DRAFT_TEXT) && found.workspace?.includes('"chat:')
              ? found
              : false;
          },
          { timeout: 5000 },
        );
        return {
          ok: evidence.sessions === 0,
          detail: `sessions=${evidence.sessions} draftBytes=${evidence.drafts?.length ?? 0}`,
        };
      },
    );

    await closeAppBounded(app);
    app = await launch({ dbPath, userDataDir });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    await attempt(
      3,
      "relaunch restores the unsent Draft and sidebar row without promoting it",
      async () => {
        await goToHome(page);
        const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
        await waitUntil(
          "the unsent words to restore",
          async () => (await textarea.inputValue()) === DRAFT_TEXT,
        );
        const evidence = await persistedEvidence(page, projectId);
        const draftRows = page
          .locator('[data-session-band="active"] button')
          .filter({ hasText: "Draft" });
        return {
          ok: evidence.sessions === 0 && (await draftRows.count()) === 1,
          detail: `sessions=${evidence.sessions} draftRows=${await draftRows.count()}`,
        };
      },
    );

    await attempt(
      4,
      "closing the provisional tab abandons the Draft and persisted tab identity",
      async () => {
        const strip = tabStrip(page, HOME_TAB_STRIP);
        const before = await strip.getByRole("tab").count();
        await strip
          .locator('xpath=ancestor::*[.//button[starts-with(@aria-label,"Close ")]][1]')
          .getByRole("button", { name: /^Close / })
          .last()
          .click();
        await waitUntil(
          "the provisional tab to close",
          async () => (await strip.getByRole("tab").count()) === before - 1,
        );
        const evidence = await waitUntil(
          "the closed Draft to leave app_state",
          async () => {
            const found = await persistedEvidence(page, projectId);
            let count = -1;
            if (found.drafts !== null) {
              const parsed = JSON.parse(found.drafts);
              count = Object.keys(parsed?.state?.drafts ?? {}).length;
            }
            return count === 0 && !(found.workspace?.includes('"chat:') ?? false)
              ? { ...found, count }
              : false;
          },
          { timeout: 5000 },
        );
        return { ok: evidence.sessions === 0, detail: `sessions=${evidence.sessions}` };
      },
    );
  } finally {
    await closeAppBounded(app).catch(() => {});
  }
  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
} finally {
  await cleanup().catch(() => {});
}
process.exit(code);
