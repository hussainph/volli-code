/**
 * E2e proof of CHAT MODE: a real Pi turn, running inside a real Session, calls
 * the `volli` CLI over the agent Unix socket from its own shell tool — the
 * path structured sessions could never exercise before PR #218 turned the
 * Seatbelt sandbox off. Forked from `pi-ticket-chat-smoke.mjs` (see that
 * file's header for the full ticket-chat/model/credential setup this shares);
 * the only things that differ are: a SHORT scratch root (`makeShortScratch`,
 * not `makeScratch` — the CLI's own socket has to actually bind under the
 * sun_path limit, which this probe's whole point depends on), a Finder/Dock
 * launch's BARE PATH (no `/usr/local/bin`, no homebrew — see `BARE_PATH`
 * below), the one prompt asking the agent to run `volli doctor`, and the
 * check-8 assertion reading the reply for doctor evidence instead of a short
 * sentence. If `volli` still resolves inside that turn, the structured
 * session recovered its CLI the same way a spawned PTY already did.
 *
 * ONE real turn, billed to a ChatGPT subscription — never loop turns.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/cli-chat-mode-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real `~/.pi/agent/auth.json`
 * with `openai-codex` credentials); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { makeShortScratch } from "./lib/agent-kit.mjs";
import { inspectDoctorPathEvidence } from "./lib/cli-chat-mode-doctor-evidence.mjs";
import {
  activeTabLabel,
  assistantReplyTexts,
  cardById,
  createRunner,
  ensurePiAuthInto,
  goToBoard,
  launch,
  makeGitRepo,
  openNewChatTab,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  sleep,
  stopButton,
  TICKET_TAB_STRIP,
  waitForSettledReply,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "cli-chat-mode-project", name: "CLI Chat Mode", prefix: "CC" };
const PROMPT_TEXT = "Run the shell command `volli doctor` and reply with its raw output only.";
/**
 * The model this smoke actually tests, named rather than inherited.
 *
 * Unpinned, `seedDefaultModel` takes the first AVAILABLE model at its HIGHEST
 * reasoning level, which upstream's catalog ordering silently moved to
 * `openai-codex/gpt-5.3-codex-spark` at `xhigh` while this header still said
 * Luna — a smoke reporting on a model nobody chose. `low` because the subject
 * here is the adapter, the transcript and the durable Session, none of which
 * care how hard the model thought; a fixed low level also keeps one turn short
 * and its duration comparable between runs, which is what makes
 * `PI_TURN_BUDGET_MS` a ceiling instead of a lottery. An unavailable pin fails
 * check 1 loudly with what the live catalog does offer.
 */
const MODEL_PIN = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-luna",
  reasoningLevel: "low",
};

// SHORT, not makeScratch's os.tmpdir() root: the whole point of this probe is
// the CLI's own agent socket, and `<userData>/volli.sock` has to actually bind
// under macOS's ~104-byte sun_path limit for that to be possible at all.
const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("clichat");
// Isolates Pi's own credential/config lookups from the developer's real
// profile — the same posture VOLLI_WORKTREE_HOME_DIR takes for worktrees.
const fakeHome = join(scratch, "home");
const worktreesRoot = join(scratch, "worktree-home");
const { attempt, summarize } = createRunner();

/**
 * launchd's Finder/Dock PATH — `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
 * else. Proven by `bare-path-env-smoke.mjs`. This probe used to cheat by
 * prepending `<userData>/bin` onto the *Electron process* PATH so `volli`
 * resolved even though a structured Session never got the PTY prepend. That
 * hid the real Finder-launch bug. The app under test now prepends the shim
 * dir itself (`piExecutionEnv` `pathPrefixes`) and adopts the login shell's
 * PATH at boot, so this launch is allowed to look like a Dock click. SHELL
 * stays inherited: a real launchd boot still sets it, and `resolveShell`
 * needs it.
 */
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-cli-chat-mode-evidence");

async function captureFailureEvidence(page, mainOut, mainErr, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `cli-chat-mode-${slug}.png`), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    join(EVIDENCE_DIR, `cli-chat-mode-${slug}.log`),
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
  console.log(`  evidence: ${join(EVIDENCE_DIR, `cli-chat-mode-${slug}.png`)}`);
  console.log(`  evidence: ${join(EVIDENCE_DIR, `cli-chat-mode-${slug}.log`)}`);
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
    extraEnv: {
      HOME: fakeHome,
      VOLLI_WORKTREE_HOME_DIR: worktreesRoot,
      PATH: BARE_PATH,
      // Pre-answers the first-boot "Install the Volli CLI and agent skills?"
      // dialog (the other CLI smokes all do this) — this run spends its one
      // real, billed turn on the chat-mode assertion, not on a native sheet
      // sitting unanswered over the window it drives.
      VOLLI_AGENT_CONSENT_CHOICE: "defer",
    },
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

    const projectPath = await makeGitRepo(scratch, "cli-chat-mode-");
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
        defaultModel = await seedDefaultModel(page, MODEL_PIN);
        return { ok: defaultModel !== null, detail: JSON.stringify(defaultModel) };
      },
    );

    let displayId = null;
    await attempt(2, "seed a ticket through the preload bridge", async () => {
      const result = await page.evaluate((input) => window.api.tickets.create(input), {
        projectId,
        status: "todo",
        title: "CLI chat mode smoke ticket",
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

    await attempt(
      4,
      "the tab strip's own Chat control creates a chat tab (attaches Pi)",
      async () => {
        chatTabLabel = await openNewChatTab(page, TICKET_TAB_STRIP);
        return { ok: chatTabLabel !== null, detail: chatTabLabel };
      },
    );

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
      // The stamp is POLLED, not read once. `git worktree add` creates the
      // directory several steps before `ensure` persists the identity, and
      // since VC-16 that pipeline is async — so main serves this very
      // `bootstrap()` mid-pipeline and a single read races the stamp. The old
      // read-immediately worked only because a synchronous `ensure` blocked
      // every IPC until it finished, which is the freeze that was fixed.
      const readStamp = async () =>
        page.evaluate(async (pid) => {
          const boot = await window.api.data.bootstrap();
          if (!boot.ok) return null;
          return (
            (boot.data.ticketsByProject?.[pid] ?? []).find((t) => t.worktreePath !== null) ?? null
          );
        }, projectId);
      const row = await waitUntil(
        "the ticket's worktree identity to be stamped",
        async () => {
          const found = await readStamp();
          return found !== null && found.worktreePath === worktreeDir ? found : false;
        },
        { timeout: 20000 },
      ).catch(() => null);
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

    let submittedAt = null;
    await attempt(
      7,
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
    // — see `waitForSettledReply` and `PI_TURN_BUDGET_MS` for why both of those
    // are the kit's to own, and what the budget was measured against.
    await attempt(
      8,
      "the turn settles with successful PATH and scratch-shim evidence from `volli doctor`",
      async () => {
        const settled = await waitForSettledReply(page, { since: submittedAt }).catch(
          async (error) => {
            await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-settled");
            throw error;
          },
        );
        // The first delivered message names the Session (`chat/client.ts`'s
        // `#autoTitle`), so the neutral `Chat` fallback captured at creation is no longer what
        // the tab is called. Re-read it, or the relaunch below looks for a tab
        // that stopped existing the moment the prompt landed.
        chatTabLabel = await activeTabLabel(page, TICKET_TAB_STRIP);
        const reply = settled.texts.join("\n");
        // Require the two exact successful checks that prove this structured
        // Session put its own scratch-profile shim first. A generic report,
        // warning/failure, or another Volli profile's global shim is not proof.
        const expectedShimPath = await fs.realpath(join(userDataDir, "bin", "volli"));
        const { pathPositionOk, cliShimOk } = inspectDoctorPathEvidence(reply, expectedShimPath);
        const notFound = /command not found|not recognized|no such file or directory/i.test(reply);
        const ok =
          settled.texts.length > 0 &&
          chatTabLabel !== null &&
          pathPositionOk &&
          cliShimOk &&
          !notFound;
        if (!ok) {
          await captureFailureEvidence(page, mainStdout, mainStderr, "doctor-reply-unusable");
        }
        return {
          ok,
          detail:
            `turn=${(settled.elapsedMs / 1000).toFixed(1)}s replies=${settled.texts.length} ` +
            `tab=${chatTabLabel} pathPositionOk=${pathPositionOk} cliShimOk=${cliShimOk} ` +
            `notFound=${notFound} expectedShim=${expectedShimPath}\n` +
            `--- full reply ---\n${reply}`,
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
      extraEnv: {
        HOME: fakeHome,
        VOLLI_WORKTREE_HOME_DIR: worktreesRoot,
        PATH: BARE_PATH,
      },
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
          // PROMPT_TEXT's backticks mark a code span; the markdown renderer
          // consumes the backtick characters themselves (GuardedResponse /
          // markdown-boundary.tsx), so the rendered textContent never has them
          // even though the durable message is unchanged. Compare against the
          // same stripped form both here and in `t`.
          const promptSansBackticks = PROMPT_TEXT.replaceAll("`", "");
          const rendered = await waitUntil(
            "both durable messages to render without a live adapter",
            async () => {
              const userTexts = await userMessageTexts(page2);
              const assistantTexts = await assistantReplyTexts(page2);
              return userTexts.some((t) => t.replaceAll("`", "").includes(promptSansBackticks)) &&
                assistantTexts.length > 0
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
