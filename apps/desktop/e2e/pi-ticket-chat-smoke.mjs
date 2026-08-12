/**
 * E2e proof of the Pi-backed native adapter attaching a real TICKET chat,
 * against the BUILT app. New ticket chats on this branch attach the `pi`
 * manifest (`apps/desktop/src/main/session-runtime/pi-adapter.ts`, pinned
 * model `openai-codex`/`gpt-5.6-luna`) instead of OpenCode — see that file's
 * module doc comment. There is no fake server anywhere in this probe (the
 * retired `session-chat-smoke.mjs` had one): Pi runs in-process in Electron
 * main and this smoke drives ONE real
 * turn against a real provider, billed to a ChatGPT subscription ($0
 * marginal — keep it to one short prompt, never loop turns speculatively).
 *
 * One thing makes a real Pi turn possible at all, and it is set up before the
 * app ever launches: **credentials**. This smoke isolates `HOME` into a
 * scratch dir (same posture as `VOLLI_WORKTREE_HOME_DIR` — never touch the
 * developer's real profile), and Pi's credential store reads
 * `$PI_CODING_AGENT_DIR` else `~/.pi/agent/auth.json` under that `HOME`
 * (`packages/agent-runtime/src/pi/models.ts`), so the real
 * `~/.pi/agent/auth.json` is copied into `<fakeHome>/.pi/agent/auth.json`
 * first — `smoke-kit.mjs`'s `ensurePiAuthInto`, which all three Pi smokes
 * share. It fails fast with a clear message if the real file is missing, never
 * reads the copy back or logs it, and shreds it on the way out however this
 * process dies — so a killed run leaves no live token behind.
 *
 * Deliberately NOT set up: OpenCode. There is no fake OpenCode server and no
 * binary override — a Pi Session no longer asks OpenCode anything.
 *
 * One more thing every structured Session now needs before it can even start:
 * an app-wide default model (`requireDefaultModel`, `structured-sessions.ts`,
 * called by both `ticket-sessions.ts` and `project-sessions.ts`). Nothing
 * bootstraps this on a fresh profile, so check 1 records one over the same
 * `modelAccess.setDefault` tRPC mutation Settings' "Default model" section
 * uses (`smoke-kit.mjs`'s `seedDefaultModel`) before the ticket chat is ever
 * created. The composer's Model pill (`composer-ui.tsx`) is offered to every
 * Session now regardless of Role — Ticket or Project — since
 * `chat-plane.tsx` dropped its old ticket/project "pinned" carve-out, and the
 * model it names is the one Pi actually runs: `attach` carries the Session's
 * durable selection in and `model.select` reaches Pi's own picker. Check 6
 * below proves the pill names the model this Session recorded rather than the
 * placeholder a Session with nothing selected would show.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/pi-ticket-chat-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real `~/.pi/agent/auth.json`
 * with `openai-codex` credentials); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  cardById,
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
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "pi-ticket-chat-project", name: "Pi Ticket Chat", prefix: "PT" };
const PROMPT_TEXT = "Reply with one short sentence.";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("pi-ticket-chat-smoke-");
// Isolates Pi's own credential/config lookups from the developer's real
// profile — the same posture VOLLI_WORKTREE_HOME_DIR takes for worktrees.
const fakeHome = join(scratch, "home");
const worktreesRoot = join(scratch, "worktree-home");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-pi-ticket-chat-evidence");

async function captureFailureEvidence(page, mainOut, mainErr, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `pi-ticket-chat-${slug}.png`), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    join(EVIDENCE_DIR, `pi-ticket-chat-${slug}.log`),
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
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-ticket-chat-${slug}.png`)}`);
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-ticket-chat-${slug}.log`)}`);
}

/** The tab strip's direct Chat control (the rail has its own copy). */
function tabStripNewChatButton(page) {
  return page
    .locator('[role="tablist"]')
    .locator("xpath=..")
    .getByRole("button", { name: "New chat", exact: true });
}

async function openNewChatTab(page) {
  const tabsBefore = await page.locator('[role="tab"]').count();
  await tabStripNewChatButton(page).click();
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

/** Rendered assistant-role messages (`Message`'s `is-assistant` class), non-empty text only. */
async function assistantMessageTexts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".is-assistant"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => text.length > 0),
  );
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
 * The absolute path of a directory named `<needle>-*` (or exactly `needle`)
 * anywhere under `root`, or null — mirrors the same helper in
 * worktree-smoke.mjs.
 */
async function findWorktreeDir(root, needle) {
  let entries;
  try {
    entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find(
    (e) => e.isDirectory() && (e.name === needle || e.name.startsWith(`${needle}-`)),
  );
  return hit ? join(hit.parentPath ?? hit.path, hit.name) : null;
}

async function main() {
  await ensurePiAuthInto(fakeHome);
  await fs.mkdir(fakeHome, { recursive: true });

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { HOME: fakeHome, VOLLI_WORKTREE_HOME_DIR: worktreesRoot },
  });
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

    const projectPath = await makeGitRepo(scratch, "pi-ticket-chat-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    let defaultModel = null;
    await attempt(
      1,
      "seed the app default model — every Session, Ticket or Project, now requires one before it can start",
      async () => {
        defaultModel = await seedDefaultModel(page);
        return { ok: defaultModel !== null, detail: JSON.stringify(defaultModel) };
      },
    );

    let displayId = null;
    await attempt(2, "seed a ticket through the preload bridge", async () => {
      const result = await page.evaluate((input) => window.api.tickets.create(input), {
        projectId,
        status: "todo",
        title: "Pi ticket chat smoke ticket",
        priority: "medium",
      });
      if (!result.ok) return { ok: false, detail: result.error };
      displayId = `${PROJECT.prefix}-${result.ticket.ticketNumber}`;
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await sleep(1000);
      await goToBoard(page);
      return { ok: (await cardById(page, displayId).count()) === 1, detail: displayId };
    });
    if (displayId === null) throw new Error("ticket seed failed — cannot continue");

    await attempt(3, "open the seeded ticket's detail", async () => {
      await cardById(page, displayId).dblclick();
      await waitUntil(
        "the ticket detail to open",
        async () => (await page.getByRole("tab", { name: displayId, exact: true }).count()) === 1,
      );
      return { ok: true };
    });

    await attempt(4, "the tab strip's + menu creates a chat tab (attaches Pi)", async () => {
      chatTabLabel = await openNewChatTab(page);
      return { ok: chatTabLabel !== null, detail: chatTabLabel };
    });

    // Carried over from the retired session-chat-smoke.mjs: a chat on
    // a worktree ticket must attach against the materialized worktree, not
    // a directory that was never provisioned.
    await attempt(5, "creating the chat materialized the ticket's worktree", async () => {
      const worktreeDir = await waitUntil(
        "the ticket's worktree to appear on disk",
        async () => (await findWorktreeDir(worktreesRoot, displayId)) ?? false,
        { timeout: 20000 },
      ).catch(async (error) => {
        await captureFailureEvidence(page, mainStdout, mainStderr, "worktree-absent");
        throw error;
      });
      const row = await page.evaluate(async (pid) => {
        const boot = await window.api.data.bootstrap();
        if (!boot.ok) return null;
        return (
          (boot.data.ticketsByProject?.[pid] ?? []).find((t) => t.worktreePath !== null) ?? null
        );
      }, projectId);
      return {
        ok: row !== null && row.worktreePath === worktreeDir,
        detail: `dir=${worktreeDir} stamped=${row?.worktreePath ?? "none"}`,
      };
    });

    await attempt(
      6,
      "the composer is ready, its Model pill naming the recorded model (not the unselected placeholder)",
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
        // Every structured Session offers the Model Access pill now, Ticket
        // or Project alike (`chat-plane.tsx` dropped its old "pinned"
        // carve-out), so the picker existing is not the regression to watch
        // for. What has to hold is that it names the model THIS Session
        // recorded (check 1's seed) rather than the bare "Model" placeholder
        // a Session with nothing selected shows.
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

    await attempt(
      7,
      "submitting the one real prompt starts a turn (streaming/working state appears)",
      async () => {
        await submitPrompt(page, PROMPT_TEXT);
        await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
          timeout: 15000,
        }).catch(async (error) => {
          await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-started");
          throw error;
        });
        return { ok: true };
      },
    );

    // Real network round trip — generous timeout (30-90s is normal for one
    // turn against a real hosted model).
    await attempt(
      8,
      "the turn settles with a non-empty assistant reply in the transcript",
      async () => {
        await waitUntil(
          "a non-empty assistant message to render",
          async () => (await assistantMessageTexts(page)).length > 0,
          { timeout: 90000 },
        ).catch(async (error) => {
          await captureFailureEvidence(page, mainStdout, mainStderr, "assistant-reply-missing");
          throw error;
        });
        await waitUntil(
          "the turn to settle (Stop clears)",
          async () => (await stopButton(page).count()) === 0,
          {
            timeout: 30000,
          },
        ).catch(async (error) => {
          await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-settled");
          throw error;
        });
        const texts = await assistantMessageTexts(page);
        // The first delivered message names the Session (`chat/client.ts`'s
        // `#autoTitle`), so the "Chat 1" captured at creation is no longer what
        // the tab is called. Re-read it, or the relaunch below looks for a tab
        // that stopped existing the moment the prompt landed.
        chatTabLabel = await page
          .locator('[role="tab"][aria-selected="true"]')
          .getAttribute("aria-label");
        return {
          ok: texts.length > 0 && chatTabLabel !== null,
          detail: `assistantMessages=${texts.length} tab=${chatTabLabel}`,
        };
      },
    );

    // ---- relaunch on the same profile, adopt (no live attach), and assert
    // the DURABLE transcript is what renders both sides of the exchange.
    await sleep(500);
    await app.close();

    const app2 = await launch({
      dbPath,
      userDataDir,
      extraEnv: { HOME: fakeHome, VOLLI_WORKTREE_HOME_DIR: worktreesRoot },
    });
    const relaunchStdout = [];
    const relaunchStderr = [];
    const proc2 = app2.process();
    proc2.stdout?.on("data", (chunk) => relaunchStdout.push(chunk.toString()));
    proc2.stderr?.on("data", (chunk) => relaunchStderr.push(chunk.toString()));
    try {
      const page2 = await app2.firstWindow();
      await page2.waitForLoadState("domcontentloaded");

      await attempt(
        9,
        "after relaunch, the ticket chat renders both messages from durable data, no live attach",
        async () => {
          const detailOpen = await waitUntil(
            "the ticket detail to reopen",
            async () =>
              (await page2.getByRole("tab", { name: displayId, exact: true }).count()) === 1,
            { timeout: 10000 },
          )
            .then(() => true)
            .catch(() => false);
          if (!detailOpen) {
            await cardById(page2, displayId)
              .dblclick()
              .catch(() => {});
          }
          const chatTab = page2.getByRole("tab", { name: chatTabLabel, exact: true });
          if ((await chatTab.count()) === 0) {
            await waitUntil(
              "the chat tab to be reachable",
              async () => (await chatTab.count()) > 0,
              { timeout: 10000 },
            );
          }
          await chatTab.click();
          const rendered = await waitUntil(
            "both durable messages to render without a live adapter",
            async () => {
              const userTexts = await userMessageTexts(page2);
              const assistantTexts = await assistantMessageTexts(page2);
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
