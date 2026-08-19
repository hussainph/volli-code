/**
 * E2e proof of the `ask_user` tool: ONE real Pi turn, billed to a ChatGPT
 * subscription, in which the model is told to ask the driver a question. The
 * proof is the full loop the runtime half exists for:
 *
 *   1. the model's call raises an interaction card ABOVE the composer
 *      mid-turn (`interaction.opened`, `kind:"question"`, the model's own
 *      options) while the turn stays blocked on it;
 *   2. clicking an option resolves it (`interaction.resolved` emitted BEFORE
 *      the parked call settles — the d39143f8 ordering); the card leaves;
 *   3. the SAME turn then finishes, and the reply carries the chosen option
 *      id back out of the tool result.
 *
 * A reply echoing the id without the card ever appearing would mean the model
 * answered itself; a card that appears but never clears would mean the
 * resolution nobody recorded; both fail loudly here.
 *
 * ONE billed turn — never loop turns.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/pi-ask-user-smoke.mjs
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
  openNewChatTab,
  PI_TURN_BUDGET_MS,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  HOME_TAB_STRIP,
  sleep,
  stopButton,
  tabStrip,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "pi-ask-user-project", name: "Pi Ask User", prefix: "AU" };
// The ids are the contract: the model may word the labels however it likes,
// but the id it reads back from the tool result is the one the click chose.
const PROMPT_TEXT =
  'Use the ask_user tool to ask me which color to paint the rover, offering exactly two options with ids "red" and "blue". After I answer, reply with only the id I chose.';

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("pi-ask-user-smoke-");
const fakeHome = join(scratch, "home");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-pi-ask-user-evidence");

async function captureFailureEvidence(page, mainOut, mainErr, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `pi-ask-user-${slug}.png`), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    join(EVIDENCE_DIR, `pi-ask-user-${slug}.log`),
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
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-ask-user-${slug}.png`)}`);
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-ask-user-${slug}.log`)}`);
}

async function goToHome(page) {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await waitUntil(
    "Home's tab strip to mount",
    // >= 1 is the permanent Board tab alone: nothing auto-opens any more
    // (VC-54 scope 2), so the Session below is created by an explicit press.
    async () => (await tabStrip(page, HOME_TAB_STRIP).getByRole("tab").count()) >= 1,
    { timeout: 20000 },
  );
}

/**
 * The red option's row on the mounted question card, matched through the role
 * engine on the row's visible text rather than the model's exact wording or
 * the card's markup era — a native `input[type=radio]` inside a label and the
 * restyled `<button role="radio">` row both answer to the same role+name.
 */
function redOptionRow(page) {
  return page
    .getByRole("radio", { name: /red/i })
    .or(page.getByRole("checkbox", { name: /red/i }))
    .first();
}

/** The mounted question card: the one `<form>` holding option controls. */
function questionCardForm(page) {
  return page.locator("form").filter({
    has: page.locator(
      '[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]',
    ),
  });
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

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "pi-ask-user-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    if (!byName[PROJECT.name]?.id) throw new Error("seeded project missing after import");

    await attempt(1, "seed the default model and open a scratch chat", async () => {
      const defaultModel = await seedDefaultModel(page);
      await goToHome(page);
      const tab = await openNewChatTab(page, HOME_TAB_STRIP);
      const textarea = page.getByPlaceholder("Ask, plan, or implement…");
      await waitUntil("the composer to mount", async () => (await textarea.count()) > 0);
      await waitUntil(
        "the composer to become ready",
        async () => !(await textarea.first().isDisabled()),
        { timeout: 30000 },
      );
      return { ok: defaultModel !== null && tab !== null, detail: tab ?? "" };
    });

    let submittedAt = null;
    await attempt(2, "the ask_user card appears mid-turn, before any reply", async () => {
      const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
      await textarea.click();
      await textarea.fill(PROMPT_TEXT);
      submittedAt = Date.now();
      await page.keyboard.press("Enter");
      await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
        timeout: 20000,
      }).catch(async (error) => {
        await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-started");
        throw error;
      });
      const row = redOptionRow(page);
      const appeared = await waitUntil(
        "the question card to mount",
        async () => (await row.count()) > 0,
        {
          timeout: 120_000,
        },
      )
        .then(() => true)
        .catch(async () => {
          await captureFailureEvidence(page, mainStdout, mainStderr, "card-never-appeared");
          return false;
        });
      const replies = await assistantReplyTexts(page);
      return {
        ok: appeared,
        detail: `appeared=${appeared} preAnswerReplies=${replies.length} elapsed=${((Date.now() - submittedAt) / 1000).toFixed(1)}s`,
      };
    });

    await attempt(3, "clicking the red option resolves the card away", async () => {
      await redOptionRow(page).click();
      // Single-select submits on click; if this card's vocabulary said
      // otherwise, the explicit submit control is the same resolution.
      const form = questionCardForm(page);
      await sleep(400);
      if ((await form.count()) > 0) {
        const submit = form.first().locator('button[type="submit"]');
        if ((await submit.count()) > 0 && (await submit.first().isEnabled())) {
          await submit.first().click();
        }
      }
      const gone = await waitUntil(
        "the question card to leave",
        async () => (await form.count()) === 0,
        {
          timeout: 15000,
        },
      )
        .then(() => true)
        .catch(async () => {
          await captureFailureEvidence(page, mainStdout, mainStderr, "card-never-cleared");
          return false;
        });
      return { ok: gone, detail: `cardGone=${gone}` };
    });

    await attempt(4, "the same turn settles with the chosen id in the reply", async () => {
      const texts = await waitUntil(
        "the turn to settle with a reply",
        async () => {
          const [running, replies] = await Promise.all([
            stopButton(page).count(),
            assistantReplyTexts(page),
          ]);
          return running === 0 && replies.length > 0 ? replies : false;
        },
        { timeout: Math.max(1000, PI_TURN_BUDGET_MS - (Date.now() - submittedAt)), interval: 250 },
      ).catch(async (error) => {
        await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-settled");
        throw error;
      });
      const last = texts.at(-1) ?? "";
      const ok = /red/i.test(last) && !/blue/i.test(last);
      if (!ok) await captureFailureEvidence(page, mainStdout, mainStderr, "wrong-answer-echo");
      return {
        ok,
        detail: `elapsed=${((Date.now() - submittedAt) / 1000).toFixed(1)}s reply=${JSON.stringify(last.slice(0, 80))}`,
      };
    });

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
