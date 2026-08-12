/**
 * E2e proof of the authority escalation producer, end to end, against the BUILT
 * app and one real Pi turn: refusals accumulate, the runtime parks a tool call
 * on a person, the renderer draws the card, and the answer travels back down
 * through dispatch to settle the parked promise — `continue` letting the turn
 * run on, `stop` ending it.
 *
 * Everything below the card is unit-tested (`pi-adapter.test.ts`,
 * `pi/runtime.test.ts`, `pi/escalation.test.ts`) and everything above it is too
 * (`chat/interaction.ts`'s renderer suite). What no test covers is the join:
 * the blocked call, the `interaction.opened` observation, the durable event,
 * the card, the click, the `interaction.resolve` command, the dispatch that
 * claims the parked promise, and the turn that resumes or aborts behind it.
 *
 * ## Making the escalation trip DETERMINISTICALLY
 *
 * `PiBinding.runtimeSpec()` sets `fallback: { consecutiveDenials: 3,
 * sessionDenials: 20 }`. The per-Session half is out of reach on this branch —
 * nothing supplies `priorAuthorityDenials`, so that counter restarts at zero on
 * every attach and twenty refusals is not something to ask a live model for.
 * The consecutive half is three refusals in a row, and the difficulty is that a
 * live model does not make refused calls on demand: steer it toward a command
 * it can see is forbidden and it declines to try, and one ALLOWED call anywhere
 * in the run resets `#consecutiveDenials` to zero.
 *
 * So the workspace is what refuses, not the prompt. The seeded project commits
 * nine SYMLINKS — `probe-1.txt` … `probe-9.txt` — each aimed at a real file
 * OUTSIDE the tree. `git worktree add` reproduces them in the ticket's
 * worktree, and `normalize.ts` resolves a `read` path argument through
 * `realpathSync` before any rule sees it, so each one lands outside the Session
 * workspace and `path.outside-workspace` refuses it. Three properties follow,
 * and together they are what makes this run rather than flake:
 *
 *   1. **The model has no reason to decline.** It is asked to read nine
 *      ordinary files in its own workspace. Nothing in the system prompt —
 *      which does tell it to stay inside the tree — reads as a warning against
 *      them, because as written they *are* inside it.
 *   2. **The refusal is not overridable.** `path.outside-workspace` is absent
 *      from `OVERRIDABLE_AUTHORITY_RULES`, so `askOffer` mints the `question`
 *      pair — "Keep working" / "Stop the turn" — which is the offer this smoke
 *      exists to drive. An overridable rule would draw a permission instead and
 *      never reach `stop` at all.
 *   3. **Nothing in between can reset the streak.** The prompt names every
 *      file, so the model has nothing to list or search for first, and every
 *      call it does make is refused.
 *
 * Nine probes rather than three, because the count is what gives the two
 * answers their teeth. A question is due at refusal 3, 6 and 9, so:
 *
 *   • `continue` is proved by the SECOND card. A turn that did not resume never
 *     reaches refusal four, so the next question is the evidence — not the
 *     absence of an error message.
 *   • `stop` is proved by the THIRD card never arriving. Three probes are still
 *     unread when the second question is answered, so a turn that had merely
 *     run out of work would ask again; only an aborted one goes quiet.
 *
 * No production code is touched, no threshold is lowered, and no test-only seam
 * is added: a real rule refuses a real call, three times over.
 *
 * Run:
 *   pnpm run build
 *   VOLLI_SKIP_CLOSE_CONFIRM=1 node apps/desktop/e2e/authority-escalation-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real `~/.pi/agent/auth.json`
 * with `openai-codex` credentials); NOT wired into `vp test`.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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

const execFileAsync = promisify(execFile);

const PROJECT = { id: "authority-escalation-project", name: "Authority Escalation", prefix: "AE" };

/** Three refusals per question, and a third question's worth left over for `stop` to prevent. */
const PROBES = Array.from({ length: 9 }, (_, index) => `probe-${index + 1}.txt`);

/** Which refusal the second question is due at; the rest are what `stop` must silence. */
const SECOND_ASK_AT = 6;

/**
 * Nine reads, in order, with the failures made the point rather than a reason
 * to give up. "Using the file reader only" is not a hint about policy — it
 * keeps the model from opening with a directory listing, which would be ALLOWED
 * and would reset the consecutive counter mid-run.
 */
const PROMPT_TEXT =
  "I am checking how this workspace reports file read errors. Using the file reader only — " +
  "no shell commands — open each of these nine files in order and quote back the exact error " +
  `text you get for each one: ${PROBES.join(", ")}. ` +
  "Do not stop at the first failure; I need the result for all nine.";

/** The turn stopped early rather than reading on; nudge it into the files it skipped. */
const FOLLOW_UP_TEXT =
  "Thanks. Now do exactly the same for the ones you have not opened yet, one at a time with " +
  `the file reader: ${PROBES.slice(3).join(", ")}. ` +
  "Quote the exact error for each; do not stop at the first failure.";

/** `askTitle` for a refusal nobody can overrule, carrying Pi's own tool name. */
const CARD_TITLE = "Blocked this read call";
const CONTINUE_LABEL = "Keep working";
const STOP_LABEL = "Stop the turn";

/** A live model turn with tool calls in it; generous, and never a fixed sleep. */
const TURN_TIMEOUT = 180000;

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("authority-escalation-smoke-");
const fakeHome = join(scratch, "home");
const worktreesRoot = join(scratch, "worktree-home");
const outsideDir = join(scratch, "outside");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-authority-escalation-evidence");

async function captureFailureEvidence(page, mainOut, mainErr, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `authority-escalation-${slug}.png`), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    join(EVIDENCE_DIR, `authority-escalation-${slug}.log`),
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
  console.log(`  evidence: ${join(EVIDENCE_DIR, `authority-escalation-${slug}.png`)}`);
  console.log(`  evidence: ${join(EVIDENCE_DIR, `authority-escalation-${slug}.log`)}`);
}

/**
 * Commit one symlink per probe, each aimed at a real file outside the tree.
 *
 * Absolute targets, not relative ones: how deep the worktree sits under
 * `VOLLI_WORKTREE_HOME_DIR` is the app's business, and a `../..` that guessed
 * wrong would resolve back INSIDE the workspace and be allowed. Git stores the
 * target verbatim, so `git worktree add` reproduces each link unchanged.
 */
async function seedOutsideProbes(repoDir) {
  await fs.mkdir(outsideDir, { recursive: true });
  for (const [index, probe] of PROBES.entries()) {
    const target = join(outsideDir, `note-${index + 1}.txt`);
    await fs.writeFile(target, `outside note ${index + 1}\n`, "utf8");
    await fs.symlink(target, join(repoDir, probe));
  }
  await execFileAsync("git", ["add", "-A"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-q", "-m", "probe symlinks"], { cwd: repoDir });
}

/**
 * The ticket screen's OWN tab strip, named by the ticket tab inside it.
 *
 * A ticket screen can mount more than one `[role="tablist"]` — the file strip
 * is the other — so an unscoped query silently picks whichever is first in the
 * DOM. Filtering on the ticket's own tab names the strip instead of counting on
 * layout order.
 */
function ticketTabStrip(page, displayId) {
  return page
    .locator('[role="tablist"]')
    .filter({ has: page.getByRole("tab", { name: displayId, exact: true }) });
}

async function openNewChatTab(page, displayId) {
  const strip = ticketTabStrip(page, displayId);
  const before = await strip.getByRole("tab").count();
  await strip.locator("xpath=..").getByRole("button", { name: "New chat", exact: true }).click();
  await waitUntil(
    "a new chat tab to appear",
    async () => (await strip.getByRole("tab").count()) > before,
  );
}

/** The Stop control, on screen for exactly as long as a turn is running. */
function stopButton(page) {
  return page.getByRole("button", { name: "Stop", exact: true });
}

/**
 * The card for ONE question, addressed by the interaction it is asking about.
 *
 * Every escalation on this Session draws the same title, so a title-only
 * locator cannot tell the second question from the first — and answering the
 * wrong one is exactly the mistake that would make this smoke lie. The radio
 * group's `name` is `${interaction.id}:${prompt.id}`, which is the only place
 * the durable id reaches the DOM, so the card is found through it.
 */
function cardFor(page, interactionId) {
  return page
    .locator(`form[aria-label="${CARD_TITLE}"]`)
    .filter({ has: page.locator(`input[name^=${JSON.stringify(`${interactionId}:`)}]`) });
}

async function submitPrompt(page, text) {
  const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press("Enter");
}

/** The Session's durable projection, over the same tRPC edge the chat itself reads. */
async function readProjection(page, sessionId) {
  return page.evaluate(async (id) => {
    const result = await window.api.sessionRpc.request({
      procedure: "session.projection",
      input: { sessionId: id },
    });
    if (!result.ok) throw new Error(`session.projection failed: ${JSON.stringify(result)}`);
    return result.data.projection;
  }, sessionId);
}

/**
 * Wait for a NEW question to be up, read off the Session rather than the screen.
 *
 * `interactions.active` is what the Session itself says is unanswered, under
 * the frozen `ask:<toolCallId>` id the adapter minted. Deliberately NOT also
 * waiting for the card: "the runtime asked" and "a person can see it" are two
 * facts, and folding them into one wait would report a question that never
 * reached the screen as a question that was never asked. The card is asserted
 * where it belongs — check 1 reads its options, and answering one clicks it.
 */
async function waitForNewAsk(page, sessionId, answered, timeout) {
  return waitUntil(
    `a new escalation to open (answered so far: ${answered.length})`,
    async () => {
      const projection = await readProjection(page, sessionId);
      return projection.interactions.active.find((one) => !answered.includes(one.id)) ?? false;
    },
    { timeout, interval: 500 },
  );
}

/**
 * Answer one card with exactly the gesture a person would use, and exactly one.
 *
 * Which gesture sends differs by side, and `optionSubmitsOnSelect` is the rule:
 * a single-question card sends on the click that selects an ALLOWING option, so
 * "Keep working" is one click, while "Stop the turn" is refusing and waits for
 * the verdict press beside it. The rule is followed here rather than probed,
 * because a second press is not the harmless retry it looks like. The card
 * outlives its own answer by a moment — it unmounts when the resolution reaches
 * the renderer, not when the click lands — so pressing again dispatches a
 * second `interaction.resolve` for a question the adapter has already unparked,
 * which comes back `PI_INTERACTION_UNKNOWN` and leaves "Not delivered" on a
 * card that was answered correctly.
 */
async function answerCard(page, interactionId, label) {
  const card = cardFor(page, interactionId);
  await card.getByRole("radio", { name: label, exact: true }).click();
  if (label === CONTINUE_LABEL) return;
  await card.getByRole("button", { name: label, exact: true }).click();
}

/** The resolved record for one interaction id, straight off the durable projection. */
async function resolvedAnswer(page, sessionId, interactionId) {
  const projection = await readProjection(page, sessionId);
  return (
    projection.interactions.resolved.find((entry) => entry.interaction.id === interactionId) ?? null
  );
}

async function main() {
  await ensurePiAuthInto(fakeHome);

  const projectPath = await makeGitRepo(scratch, "authority-escalation-");
  await seedOutsideProbes(projectPath);

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

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");
    await seedDefaultModel(page);

    const seeded = await page.evaluate((input) => window.api.tickets.create(input), {
      projectId,
      status: "todo",
      title: "Authority escalation smoke ticket",
      priority: "medium",
    });
    if (!seeded.ok) throw new Error(`ticket seed failed: ${seeded.error}`);
    const ticketId = seeded.ticket.id;
    const displayId = `${PROJECT.prefix}-${seeded.ticket.ticketNumber}`;
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);
    await goToBoard(page);

    await cardById(page, displayId).dblclick();
    await waitUntil(
      "the ticket detail to open",
      async () => (await page.getByRole("tab", { name: displayId, exact: true }).count()) === 1,
    );
    await openNewChatTab(page, displayId);

    const textarea = page.getByPlaceholder("Ask, plan, or implement…");
    await waitUntil("the composer to mount", async () => (await textarea.count()) > 0);
    await waitUntil(
      "the composer to become ready",
      async () => !(await textarea.first().isDisabled()),
      { timeout: 60000 },
    ).catch(async (error) => {
      await captureFailureEvidence(page, mainStdout, mainStderr, "composer-inert");
      throw error;
    });

    // A listing row is `{ kind, record }`; the chat row's record carries the
    // durable Session id every projection read below is keyed by.
    const sessionId = await waitUntil("the chat Session to be listed", async () => {
      const listed = await page.evaluate(
        (id) => window.api.sessions.listForTicket({ ticketId: id }),
        ticketId,
      );
      if (!listed.ok) return false;
      return listed.sessions.find((row) => row.kind === "chat")?.record?.sessionId ?? false;
    });

    /** Every question this run has already answered, so a stale card is never re-read as a new one. */
    const answered = [];

    // ---- 1. three refusals in a row park the turn on a person ---------------
    let firstAsk = null;
    await attempt(
      1,
      "three refused reads in a row open an escalation, offering only the two escalation options",
      async () => {
        await submitPrompt(page, PROMPT_TEXT);
        firstAsk = await waitForNewAsk(page, sessionId, answered, TURN_TIMEOUT).catch(
          async (error) => {
            await captureFailureEvidence(page, mainStdout, mainStderr, "first-card-missing");
            throw error;
          },
        );
        const card = cardFor(page, firstAsk.id);
        // Drawn a frame behind the projection it comes from, so the card is
        // waited for here rather than assumed — an empty option list would
        // otherwise report a missing card as a wrong offer.
        await waitUntil("the card for the question to draw", async () => (await card.count()) > 0, {
          timeout: 15000,
        }).catch(() => {});
        const options = await card
          .getByRole("radio")
          .evaluateAll((nodes) => nodes.map((node) => node.closest("label")?.textContent ?? ""));
        // No `Reject` control: `stop` already IS the refusing side of this card,
        // so the out-of-band refusal must not be minted beside two real options.
        const strayReject = await card.getByRole("button", { name: "Reject", exact: true }).count();
        return {
          ok:
            firstAsk.kind === "question" &&
            firstAsk.id.startsWith("ask:") &&
            options.length === 2 &&
            options.includes(CONTINUE_LABEL) &&
            options.includes(STOP_LABEL) &&
            strayReject === 0,
          detail: `id=${firstAsk.id} kind=${firstAsk.kind} options=${JSON.stringify(options)} strayReject=${strayReject}`,
        };
      },
    );
    if (firstAsk === null) throw new Error("no escalation opened — cannot continue");
    answered.push(firstAsk.id);

    // ---- 2. the answer becomes a Session fact -------------------------------
    // Checked BEFORE the turn is watched, because it is the precondition: an
    // answer the Session never recorded leaves the question active forever, and
    // `footInteraction` draws the OLDEST active one — so every later question
    // would be invisible and the turn's behaviour unobservable. Failing here
    // names that cause instead of leaving a three-minute timeout to imply it.
    await attempt(
      2,
      "the `continue` answer is accepted and durably resolved, clearing the question",
      async () => {
        await answerCard(page, firstAsk.id, CONTINUE_LABEL);
        const record = await waitUntil(
          "the continue answer to land in durable history",
          async () => (await resolvedAnswer(page, sessionId, firstAsk.id)) ?? false,
          { timeout: 30000 },
        ).catch(() => null);
        const projection = await readProjection(page, sessionId);
        const stillActive = projection.interactions.active.some((one) => one.id === firstAsk.id);
        if (record === null || stillActive) {
          await captureFailureEvidence(page, mainStdout, mainStderr, "continue-not-recorded");
        }
        return {
          ok:
            record !== null &&
            record.resolution.optionIds.length === 1 &&
            record.resolution.optionIds[0] === "continue" &&
            !stillActive,
          detail: `resolved=${JSON.stringify(record?.resolution.optionIds ?? null)} stillActive=${stillActive} active=${projection.interactions.active.length}`,
        };
      },
    );

    // ---- 3. the turn runs on behind the answered question -------------------
    let secondAsk = null;
    await attempt(
      3,
      "the turn resumes after `continue` — proved by the NEXT escalation, not by an absent error",
      async () => {
        secondAsk = await waitForNewAsk(page, sessionId, answered, TURN_TIMEOUT).catch(async () => {
          // A model that stopped after three refusals rather than reading on
          // gets one nudge: the turn RESUMING is what is under test, not the
          // model's appetite for being told no.
          await waitUntil(
            "the turn to settle",
            async () => (await stopButton(page).count()) === 0,
            {
              timeout: 60000,
            },
          ).catch(() => {});
          await submitPrompt(page, FOLLOW_UP_TEXT);
          return waitForNewAsk(page, sessionId, answered, TURN_TIMEOUT).catch(() => null);
        });
        if (secondAsk === null) {
          await captureFailureEvidence(page, mainStdout, mainStderr, "turn-did-not-resume");
        }
        return { ok: secondAsk !== null, detail: `second=${secondAsk?.id ?? "none"}` };
      },
    );

    if (secondAsk === null) throw new Error("no second escalation — cannot drive the stop path");
    answered.push(secondAsk.id);

    // ---- 4. `stop` ends the turn, and does not break the Session ------------
    await attempt(
      4,
      '"Stop the turn" interrupts the turn — no further question, and the Session is not broken',
      async () => {
        await answerCard(page, secondAsk.id, STOP_LABEL);
        const settled = await waitUntil(
          "the turn to end",
          async () =>
            (await stopButton(page).count()) === 0 &&
            (await readProjection(page, sessionId)).turnActive === false,
          { timeout: 60000 },
        )
          .then(() => true)
          .catch(() => false);
        // The teeth: probes are still unread, so a turn that had merely run out
        // of work would ask a third time. Only an aborted one goes quiet.
        const third = await waitForNewAsk(page, sessionId, answered, 25000)
          .then((ask) => ask.id)
          .catch(() => null);
        // `adapter_unrecoverable`'s banner. Pi answers a mid-turn abort with a
        // synthesized `stopReason: "error"`, so without the runtime's own
        // `interrupting` flag a deliberate stop reads as a dead Session.
        const broken = await page.getByText("Session stopped", { exact: true }).count();
        if (!settled || third !== null || broken > 0) {
          await captureFailureEvidence(page, mainStdout, mainStderr, "stop-did-not-interrupt");
        }
        return {
          ok: settled && third === null && broken === 0,
          detail: `settled=${settled} thirdAsk=${third ?? "none"} brokenBanner=${broken} (asked at refusal ${SECOND_ASK_AT}, ${PROBES.length - SECOND_ASK_AT} probes left unread)`,
        };
      },
    );

    await attempt(
      5,
      "the stopping answer is durably resolved as `stop`, and nothing is left waiting",
      async () => {
        const record = await waitUntil(
          "the stop answer to land in durable history",
          async () => (await resolvedAnswer(page, sessionId, secondAsk.id)) ?? false,
          { timeout: 20000 },
        ).catch(() => null);
        const projection = await readProjection(page, sessionId);
        return {
          ok:
            record !== null &&
            record.resolution.optionIds.length === 1 &&
            record.resolution.optionIds[0] === "stop" &&
            projection.interactions.active.length === 0,
          detail: `resolved=${JSON.stringify(record?.resolution.optionIds ?? null)} active=${projection.interactions.active.length}`,
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
