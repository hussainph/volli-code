/**
 * E2e proof of the composer's `/` VERBS against the BUILT app — the rows that
 * run something instead of sending text (`packages/shared/src/composer-verb.ts`).
 *
 * The unit tests own the offer rule and the grammar; what only a real app can
 * show is the half that lives in the renderer's glue: that a row the picker
 * offers is a row whose press actually performs, that a refusal says the right
 * sentence, and that the draft goes exactly where each outcome promises. That
 * glue is deliberately outside the coverage gate (`vite.config.ts`: "View glue
 * (.tsx, hooks, ui/**) is deliberately outside the report — it's exercised by
 * agent-driven UI runs"), so this smoke IS its gate.
 *
 * Three contracts, checked against a real Session with a real catalog:
 *
 *   1. **Offer = perform.** `offeredComposerVerbs` filters on the same
 *      `verb.refusal(moment)` the press toasts, so what the list shows and
 *      what a press does cannot disagree. In an idle Session that has said
 *      nothing yet, that means five rows and not `/copy`.
 *   2. **An act that runs takes the words with it.** Every verb that acts
 *      clears the draft — not just the two that used to.
 *   3. **A refusal the press can see never takes the words**, and names its
 *      own cause: `/copy` with nothing said, and trailing words on a verb that
 *      reads none, both leave the draft alone and say why.
 *
 * NO TURN IS EVER SUBMITTED here, so this costs nothing at a provider: every
 * check runs against an idle composer. A default model is still seeded,
 * because the box is not `ready` (and `/model` has no catalog) without one.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/composer-verbs-smoke.mjs
 *
 * MANUALLY-RUN (needs a display and the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  createRunner,
  ensurePiAuthInto,
  launch,
  makeGitRepo,
  makeScratch,
  openNewChatTab,
  seedDefaultModel,
  seedProjects,
  sleep,
  tabStrip,
  waitUntil,
  HOME_TAB_STRIP,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "composer-verbs-project", name: "Composer Verbs", prefix: "CV" };

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("composer-verbs-smoke-");
const fakeHome = join(scratch, "home");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-composer-verbs-evidence");

async function captureFailureEvidence(page, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `composer-verbs-${slug}.png`), fullPage: true })
    .catch(() => {});
  console.log(`  evidence: ${join(EVIDENCE_DIR, `composer-verbs-${slug}.png`)}`);
}

const composer = (page) => page.getByPlaceholder("Ask, plan, or implement…").first();
const picker = (page) => page.locator('[data-slot="composer-picker"]');
const toasts = (page) => page.locator("[data-sonner-toast]");

/**
 * Settings is a surface, not a dialog: its category rail is the tell.
 *
 * The landmark rather than a category NAME — VC-111 retired "Harness Runtimes"
 * (a category whose pane held one read-only string), and a probe keyed to any
 * single category name breaks again the next time the taxonomy moves. The
 * `<nav>` and its accessible name are the surface's stable identity.
 */
async function settingsOpen(page) {
  return (await page.getByRole("navigation", { name: "Settings categories" }).count()) >= 1;
}

/**
 * Put the chat back in front, whatever the last check left up.
 *
 * Leaving Settings is a nav press, and Home comes back on whichever tab it was
 * last showing rather than necessarily this Session's — so the chat tab is
 * clicked by name rather than assumed. Every check starts here, so none of
 * them inherits the surface another one navigated to.
 */
async function focusChat(page) {
  if (await settingsOpen(page)) {
    await page.getByRole("button", { name: "Home", exact: true }).first().click();
    await waitUntil("Settings to close", async () => !(await settingsOpen(page)), {
      timeout: 10000,
    });
  }
  if ((await composer(page).count()) === 0) {
    await tabStrip(page, HOME_TAB_STRIP).getByRole("tab", { name: /Chat/ }).first().click();
  }
  await waitUntil("the composer to be in front", async () => (await composer(page).count()) >= 1, {
    timeout: 10000,
  });
  await sleep(250);
}

/** Type `text` into an empty composer and let the picker settle. */
async function typeDraft(page, text) {
  await focusChat(page);
  const box = composer(page);
  await box.click();
  await box.fill("");
  await box.fill(text);
  await sleep(400);
}

/**
 * Press the draft, the way a reader who typed the whole verb does.
 *
 * Escape first, and it is not incidental: while the `/` picker is open ⏎
 * belongs to the picker and STAGES the highlighted row into the box rather
 * than submitting it. Dismissing the list is what hands ⏎ back to the
 * composer — the same two keystrokes a person makes when they typed the name
 * out instead of arrowing to it.
 */
async function submitDraft(page) {
  if ((await picker(page).count()) > 0) {
    await page.keyboard.press("Escape");
    await sleep(250);
  }
  await page.keyboard.press("Enter");
}

/**
 * Toasts are never cleared between checks, and that is deliberate: ripping
 * `[data-sonner-toast]` nodes out of the DOM tears them out from under React,
 * which crashes the reconciler and takes the composer with it. Each check
 * looks for its own sentence instead, which no other check raises.
 */
async function toastTexts(page) {
  return (await toasts(page).allTextContents()).map((text) => text.trim()).filter(Boolean);
}

async function main() {
  await fs.mkdir(fakeHome, { recursive: true });
  await ensurePiAuthInto(fakeHome);
  const projectDir = await makeGitRepo(scratch, "composer-verbs-project-");

  const app = await launch({ dbPath, userDataDir, extraEnv: { HOME: fakeHome } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await assertProfileIsolated(app, userDataDir);
  assertBuiltRendererLoaded(page);

  try {
    await seedProjects(page, [{ ...PROJECT, path: projectDir }]);
    await seedDefaultModel(page);
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await waitUntil(
      "Home's tab strip to mount",
      async () => (await tabStrip(page, HOME_TAB_STRIP).getByRole("tab").count()) >= 1,
      { timeout: 20000 },
    );
    await openNewChatTab(page, HOME_TAB_STRIP);
    await waitUntil("the composer to mount", async () => (await composer(page).count()) === 1, {
      timeout: 20000,
    });

    await attempt(
      1,
      "the `/` picker offers every verb this moment can take, and no row it would refuse",
      async () => {
        await typeDraft(page, "/");
        await waitUntil("the picker to open", async () => (await picker(page).count()) === 1, {
          timeout: 10000,
        });
        const text = await picker(page).innerText();
        // An idle Session with a catalog and a project, that has said nothing
        // yet. `/copy` is the one verb whose moment has not arrived, and its
        // absence IS the offer rule — a row that could only fail is worse
        // than no row.
        const offered = ["/compact", "/model", "/reload", "/settings", "/login"].filter((name) =>
          text.includes(name),
        );
        const copyOffered = text.includes("/copy");
        if (offered.length !== 5 || copyOffered) {
          throw new Error(
            `expected 5 verbs and no /copy — offered=${JSON.stringify(offered)} copy=${copyOffered}\n${text}`,
          );
        }
        return { ok: true, detail: `offered=${offered.join(",")} copyHidden=${!copyOffered}` };
      },
    );

    await attempt(2, "/settings runs the act AND takes the words with it", async () => {
      await typeDraft(page, "/settings");
      await submitDraft(page);
      try {
        await waitUntil("Settings to open", () => settingsOpen(page), { timeout: 10000 });
        // Read the draft while Settings is up: the box is still mounted
        // behind it, and what is pinned here is that the act took the words.
        const draft = await composer(page).inputValue();
        if (draft !== "") {
          throw new Error(`draft survived an act that ran: ${JSON.stringify(draft)}`);
        }
        return { ok: true, detail: `settingsOpened=true draftCleared=true` };
      } finally {
        await focusChat(page);
      }
    });

    await attempt(3, "/copy with nothing said refuses by name, and keeps the words", async () => {
      await typeDraft(page, "/copy");
      await submitDraft(page);
      await sleep(700);
      const said = await toastTexts(page);
      const draft = await composer(page).inputValue();
      // The refusal the press could see first: it never takes the draft, and
      // the sentence is the one the row's absence in check 1 meant.
      if (!said.some((line) => line.includes("No reply to copy yet"))) {
        throw new Error(`expected the copy refusal, got ${JSON.stringify(said)}`);
      }
      if (draft !== "/copy") {
        throw new Error(`a refusal took the words: ${JSON.stringify(draft)}`);
      }
      return { ok: true, detail: `toast=${JSON.stringify(said[0])} draftKept=true` };
    });

    await attempt(4, "trailing words on a verb that reads none refuse, and keep them", async () => {
      await typeDraft(page, "/settings please");
      await submitDraft(page);
      await sleep(700);
      const said = await toastTexts(page);
      const ranAnyway = await settingsOpen(page);
      const draft = ranAnyway ? "<settings opened>" : await composer(page).inputValue();
      try {
        if (!said.some((line) => line.includes("takes no instructions"))) {
          throw new Error(`expected the instructions refusal, got ${JSON.stringify(said)}`);
        }
        if (draft !== "/settings please") {
          throw new Error(`a refusal took the words: ${JSON.stringify(draft)}`);
        }
        if (ranAnyway) throw new Error("a refused press still ran the act");
        return {
          ok: true,
          detail: `toast=${JSON.stringify(said[0])} draftKept=true actRefused=true`,
        };
      } finally {
        await focusChat(page);
      }
    });

    await attempt(5, "/reload reports the refresh only after the read answers", async () => {
      await typeDraft(page, "/reload");
      await submitDraft(page);
      await waitUntil(
        "the refresh toast",
        async () => (await toastTexts(page)).some((l) => l.includes("Commands and skills")),
        { timeout: 10000 },
      );
      const said = await toastTexts(page);
      const draft = await composer(page).inputValue();
      if (said.some((line) => line.toLowerCase().includes("couldn't load"))) {
        throw new Error(`a success toast rode beside a failure: ${JSON.stringify(said)}`);
      }
      if (draft !== "") throw new Error(`draft survived an act that ran: ${JSON.stringify(draft)}`);
      return { ok: true, detail: `toast=${JSON.stringify(said[0])} draftCleared=true` };
    });

    await attempt(
      6,
      "/model opens the pill's own list, by typing instead of clicking",
      async () => {
        await typeDraft(page, "/model");
        await submitDraft(page);
        await sleep(700);
        const said = await toastTexts(page);
        // A catalog is seeded, so this is the offered path: the popover opens
        // rather than the verb refusing.
        const listOpen = (await page.getByPlaceholder("Model").count()) >= 1;
        if (!listOpen) {
          throw new Error(`the model list did not open — toasts=${JSON.stringify(said)}`);
        }
        await page.keyboard.press("Escape");
        await sleep(300);
        return { ok: true, detail: `modelListOpened=true` };
      },
    );
  } catch (error) {
    await captureFailureEvidence(page, "aborted");
    throw error;
  } finally {
    await app.close().catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nSMOKE ABORTED: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await cleanup().catch(() => {});
}

summarize();
