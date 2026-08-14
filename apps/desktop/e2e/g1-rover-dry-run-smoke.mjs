/**
 * G1 — the interview dry run, scripted, against the BUILT app: a fresh Python
 * project, one scratch chat, and TEN consecutive real Pi turns that mirror the
 * Mars-rover pairing exercise (small prompts, tests-first, one design
 * question) — then a relaunch that must render the whole exchange from
 * durable data.
 *
 * This is the composite proof the lean-v1 checklist calls G1, and it folds in
 * the two items that were defined as "verified via G1":
 *
 *   - **A2** — ten consecutive turns through one composer, each submitted the
 *     moment the previous one settles. A stuck composer or a lost input fails
 *     the turn that hit it: submit → Stop appears (input was accepted) →
 *     Stop clears with a NEW prose reply (the turn settled). The per-turn
 *     settle wait here requires the reply COUNT to grow — the kit's
 *     `waitForSettledReply` alone would accept a previous turn's reply as
 *     settlement from turn 2 onward.
 *   - **F1** — turn 4 has the agent run `volli` bare (no path) in the
 *     session's shell, and the reply must carry `cli-chat-mode-smoke.mjs`'s
 *     exact doctor evidence: PATH position 1 AND this scratch profile's own
 *     `<userData>/bin/volli` shim — a reachable-looking answer from another
 *     profile's global shim is not proof.
 *   - **F2** — the agent runs `python3 -m unittest` (turns 3/6/8) and builds a
 *     `.venv` + pytest + coverage (turn 7); after each, this smoke REruns the
 *     same command itself from the project dir and requires exit 0, so a
 *     hallucinated "OK" in the reply cannot pass alone.
 *
 * "Diff shows change" is proven at the git layer, where the substance is: the
 * smoke commits a checkpoint after turn 6, and turn 8's edit must then show up
 * in `git diff --name-only` as a TRACKED modification. (The changeset UI has
 * its own smoke — `changeset-diff-tabs-smoke.mjs`.)
 *
 * Ten billed turns is this smoke's entire reason to exist — it is the ONE
 * deliberately multi-turn Pi smoke, so it must never be looped or wired into
 * an automated lane. Prompts still ask for terse markers (DONE / a result
 * line / G1_COMPLETE) to keep replies short, but no check hangs on them:
 * verdicts come from files on disk, independent command reruns, and the
 * doctor evidence — prose style already cost this smoke one false FAIL.
 *
 * The chat is a Sessions-strip scratch chat on purpose: a ticketless Session
 * executes in the selected project's own directory (`location.ts`), which is
 * exactly the shape of the pairing round — one repo, one chat, no worktree
 * indirection.
 *
 * Run (G1, dev-built app):
 *   pnpm run build
 *   node apps/desktop/e2e/g1-rover-dry-run-smoke.mjs
 *
 * Run (H2, the packaged app — same proof against the installed binary):
 *   VOLLI_SMOKE_APP_BINARY="/path/to/Volli.app/Contents/MacOS/Volli" \
 *     node apps/desktop/e2e/g1-rover-dry-run-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, network for one `pip
 * install`, and a real `~/.pi/agent/auth.json` with `openai-codex`
 * credentials); NOT wired into `vp test`.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { makeShortScratch } from "./lib/agent-kit.mjs";
import { inspectDoctorPathEvidence } from "./lib/cli-chat-mode-doctor-evidence.mjs";
import {
  activeTabLabel,
  assistantReplyTexts,
  createRunner,
  ensurePiAuthInto,
  goToBoard,
  launch,
  makeGitRepo,
  openNewChatTab,
  PI_TURN_BUDGET_MS,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  SESSION_TAB_STRIP,
  sleep,
  stopButton,
  tabStrip,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const PROJECT = { id: "g1-rover-dry-run-project", name: "G1 Rover Dry Run", prefix: "G1" };

// The venv turn downloads pytest into a cold cache on a bad day; everything
// else fits the kit's standard turn budget.
const VENV_TURN_BUDGET_MS = 300_000;

// SHORT scratch, not makeScratch: turn 4's `volli doctor` is real only if the
// app's own agent socket BOUND — `<userData>/volli.sock` has to fit macOS's
// ~104-byte sun_path limit. Under an os.tmpdir() root the bind fails quietly,
// the profile's shim never becomes usable, and the first run of this smoke
// proved exactly what that leaves behind: another profile's `/usr/local/bin`
// shim answering `APP_UNREACHABLE` while a not-command-not-found check waved
// it through.
const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("g1");
const fakeHome = join(scratch, "home");
const { attempt, summarize } = createRunner();

// launchd's Finder/Dock PATH — the interview launches from the Dock, so the
// dry run does too. `bare-path-env-smoke.mjs` proves this is what a Dock boot
// gets; the app recovers the login shell's PATH itself at boot (#227), which
// is the machinery a G1 pass certifies here.
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-g1-rover-dry-run-evidence");

async function captureFailureEvidence(page, mainOut, mainErr, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `g1-${slug}.png`), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    join(EVIDENCE_DIR, `g1-${slug}.log`),
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
  console.log(`  evidence: ${join(EVIDENCE_DIR, `g1-${slug}.png`)}`);
  console.log(`  evidence: ${join(EVIDENCE_DIR, `g1-${slug}.log`)}`);
}

/** Navigate to Sessions and wait for its tab strip to mount. */
async function goToSessions(page) {
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await waitUntil(
    "the Sessions tab strip to mount",
    async () => (await tabStrip(page, SESSION_TAB_STRIP).getByRole("tab").count()) >= 1,
    { timeout: 20000 },
  );
}

/**
 * One full turn on one clock: submit, require Stop to appear (the input was
 * accepted — a silently swallowed submit fails HERE), then require Stop gone
 * with MORE prose replies than before (a previous turn's reply cannot settle
 * this one). A turn so fast that Stop was never seen still passes if the
 * reply count grew inside the same window.
 */
async function runTurn(page, prompt, { budget = PI_TURN_BUDGET_MS } = {}) {
  const before = (await assistantReplyTexts(page)).length;
  const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
  await textarea.click();
  await textarea.fill(prompt);
  const since = Date.now();
  await page.keyboard.press("Enter");

  await waitUntil(
    "the turn to start (Stop appears)",
    async () => (await stopButton(page).count()) > 0,
    { timeout: 20000, interval: 100 },
  ).catch(async (error) => {
    const replies = await assistantReplyTexts(page);
    if (replies.length <= before) throw error;
  });

  const texts = await waitUntil(
    "the turn to settle with a NEW assistant reply",
    async () => {
      const [running, replies] = await Promise.all([
        stopButton(page).count(),
        assistantReplyTexts(page),
      ]);
      return running === 0 && replies.length > before ? replies : false;
    },
    { timeout: Math.max(1000, budget - (Date.now() - since)), interval: 250 },
  );
  return {
    last: texts.at(-1) ?? "",
    texts,
    replies: texts.length,
    elapsedMs: Date.now() - since,
  };
}

const fmt = (turn) => `${(turn.elapsedMs / 1000).toFixed(1)}s`;

async function fileContains(dir, rel, needle) {
  const text = await fs.readFile(join(dir, rel), "utf8").catch(() => null);
  return text !== null && text.includes(needle);
}

/** Run a command from the project dir; never throws — returns { code, output }. */
async function runInProject(projectDir, file, args) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: projectDir,
      timeout: 120_000,
      env: { ...process.env, HOME: fakeHome },
    });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    return { code: error?.code ?? 1, output: `${error?.stdout ?? ""}\n${error?.stderr ?? ""}` };
  }
}

const git = (projectDir, args) => runInProject(projectDir, "git", args);

async function main() {
  await ensurePiAuthInto(fakeHome);
  await fs.mkdir(fakeHome, { recursive: true });

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { HOME: fakeHome, PATH: BARE_PATH },
  });
  const mainStdout = [];
  const mainStderr = [];
  const proc = app.process();
  proc.stdout?.on("data", (chunk) => mainStdout.push(chunk.toString()));
  proc.stderr?.on("data", (chunk) => mainStderr.push(chunk.toString()));

  let chatTabLabel = null;
  let projectPath = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    projectPath = await makeGitRepo(scratch, "g1-rover-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    if (!byName[PROJECT.name]?.id) throw new Error("seeded project missing after import");

    await attempt(
      1,
      "seed the app default model and open a scratch chat on the project",
      async () => {
        const defaultModel = await seedDefaultModel(page);
        await goToSessions(page);
        chatTabLabel = await openNewChatTab(page, SESSION_TAB_STRIP);
        const textarea = page.getByPlaceholder("Ask, plan, or implement…");
        await waitUntil("the composer to mount", async () => (await textarea.count()) > 0);
        await waitUntil(
          "the composer to become ready",
          async () => !(await textarea.first().isDisabled()),
          { timeout: 30000 },
        );
        return { ok: defaultModel !== null && chatTabLabel !== null, detail: chatTabLabel ?? "" };
      },
    );

    // ---- the ten consecutive turns -------------------------------------

    await attempt(2, "T1: agent writes direction.py into the PROJECT dir", async () => {
      const turn = await runTurn(
        page,
        "Create direction.py: a Direction enum N, E, S, W in clockwise order whose values are (dx, dy) move deltas. Nothing else. Reply DONE.",
      );
      // First delivered message retitles the Session; capture what the tab —
      // and the relaunch's sidebar row — is actually called now.
      chatTabLabel = await activeTabLabel(page, SESSION_TAB_STRIP);
      // Substance over prose everywhere below: the file on disk (or an
      // independent rerun) is the verdict; the reply is recorded, not judged —
      // the first run of this smoke failed a green check on the model
      // phrasing a result line without the literal word "OK".
      const written = await fileContains(projectPath, "direction.py", "Direction");
      return {
        ok: written && turn.last.length > 0,
        detail: `${fmt(turn)} written=${written} tab=${chatTabLabel}`,
      };
    });

    await attempt(3, "T2: agent writes rover.py (turns via index arithmetic)", async () => {
      const turn = await runTurn(
        page,
        "Create rover.py: class Rover(x, y, direction) with turn_left and turn_right using clockwise index arithmetic over Direction, and move_forward() applying the direction's delta. Reply DONE.",
      );
      const written = await fileContains(projectPath, "rover.py", "class Rover");
      return { ok: written && turn.last.length > 0, detail: `${fmt(turn)} written=${written}` };
    });

    await attempt(4, "T3: agent writes unittest tests and runs them green", async () => {
      const turn = await runTurn(
        page,
        "Create tests/__init__.py and tests/test_rover.py using unittest with tests: test_turn_right_cycles, test_turn_left_cycles, test_move_north_increments_y. Run python3 -m unittest and reply with the final result line.",
      );
      const written = await fileContains(projectPath, "tests/test_rover.py", "unittest");
      const rerun = await runInProject(projectPath, "python3", ["-m", "unittest"]);
      return {
        ok: written && rerun.code === 0,
        detail: `${fmt(turn)} written=${written} independentUnittest=${rerun.code === 0 ? "OK" : rerun.output.slice(-120)}`,
      };
    });

    await attempt(5, "T4: THIS profile's `volli` shim answers doctor in-session (F1)", async () => {
      const turn = await runTurn(
        page,
        "Run the shell command `volli doctor` and reply with its raw output only.",
      );
      // Same bar as `cli-chat-mode-smoke.mjs` check 8: the two exact doctor
      // checks that prove the Session resolved THIS scratch profile's shim,
      // first on PATH — a reachable-looking reply from another profile's
      // global shim is not proof.
      const reply = turn.texts.join("\n");
      const expectedShimPath = await fs.realpath(join(userDataDir, "bin", "volli"));
      const { pathPositionOk, cliShimOk } = inspectDoctorPathEvidence(reply, expectedShimPath);
      const notFound = /command not found|not recognized|no such file or directory/i.test(reply);
      const ok = pathPositionOk && cliShimOk && !notFound;
      if (!ok) await captureFailureEvidence(page, mainStdout, mainStderr, "doctor-reply-unusable");
      return {
        ok,
        detail:
          `${fmt(turn)} pathPositionOk=${pathPositionOk} cliShimOk=${cliShimOk} ` +
          `notFound=${notFound} reply=${JSON.stringify(turn.last.slice(0, 100))}`,
      };
    });

    await attempt(6, "T5: agent writes world.py with in_bounds", async () => {
      const turn = await runTurn(
        page,
        "Create world.py: class World(width, height) with in_bounds(x, y). Reply DONE.",
      );
      const written = await fileContains(projectPath, "world.py", "in_bounds");
      return { ok: written && turn.last.length > 0, detail: `${fmt(turn)} written=${written}` };
    });

    await attempt(7, "T6: blocked moves refuse (False), tests stay green", async () => {
      const turn = await runTurn(
        page,
        "Change move_forward to take a world and return False without moving when the target is out of bounds, True otherwise. Update the tests, run python3 -m unittest, reply with the final result line.",
      );
      const rerun = await runInProject(projectPath, "python3", ["-m", "unittest"]);
      return {
        ok: rerun.code === 0,
        detail: `${fmt(turn)} independentUnittest=${rerun.code === 0 ? "OK" : rerun.output.slice(-120)}`,
      };
    });

    // Checkpoint BEFORE the venv exists, so turn 8's edit shows up as a
    // tracked modification and `.venv` never enters the index.
    await fs.writeFile(join(projectPath, ".gitignore"), ".venv/\n__pycache__/\n");
    await git(projectPath, ["add", "-A"]);
    const checkpoint = await git(projectPath, ["commit", "-q", "-m", "g1 checkpoint"]);
    if (checkpoint.code !== 0) throw new Error(`g1 checkpoint commit failed: ${checkpoint.output}`);

    await attempt(8, "T7: agent builds .venv and runs pytest --cov (F2)", async () => {
      const turn = await runTurn(
        page,
        "Create a virtualenv at .venv, install pytest and pytest-cov into it, run .venv/bin/python -m pytest --cov=. and reply with the TOTAL coverage line.",
        { budget: VENV_TURN_BUDGET_MS },
      );
      const rerun = await runInProject(projectPath, ".venv/bin/python", [
        "-m",
        "pytest",
        "--cov=.",
      ]);
      return {
        ok: rerun.code === 0,
        detail: `${fmt(turn)} independentPytest=${rerun.code === 0 ? "OK" : rerun.output.slice(-160)}`,
      };
    });

    await attempt(9, "T8: an edit lands as a TRACKED git diff, tests green", async () => {
      const turn = await runTurn(
        page,
        "Add turn_around() to Rover (two right turns) and one test for it. Run python3 -m unittest and reply with the final result line.",
      );
      const rerun = await runInProject(projectPath, "python3", ["-m", "unittest"]);
      const diff = await git(projectPath, ["diff", "--name-only"]);
      const changed = diff.output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        ok: rerun.code === 0 && changed.includes("rover.py"),
        detail: `${fmt(turn)} diff=[${changed.join(", ")}] independentUnittest=${rerun.code === 0 ? "OK" : "FAIL"}`,
      };
    });

    await attempt(10, "T9: a design question gets a prose answer", async () => {
      const turn = await runTurn(
        page,
        "In one short sentence: why does move_forward not need an if/elif over headings?",
      );
      return {
        ok: turn.last.length > 10,
        detail: `${fmt(turn)} reply=${JSON.stringify(turn.last.slice(0, 100))}`,
      };
    });

    await attempt(11, "T10: the tenth consecutive turn settles clean", async () => {
      const turn = await runTurn(page, "Reply with exactly: G1_COMPLETE");
      return {
        ok: turn.last.includes("G1_COMPLETE"),
        detail: `${fmt(turn)} replies=${turn.replies}`,
      };
    });

    // ---- relaunch: the whole exchange must come back from durable data --

    await sleep(500);
    await app.close();

    const app2 = await launch({
      dbPath,
      userDataDir,
      extraEnv: { HOME: fakeHome, PATH: BARE_PATH },
    });
    const relaunchStdout = [];
    const relaunchStderr = [];
    const proc2 = app2.process();
    proc2.stdout?.on("data", (chunk) => relaunchStdout.push(chunk.toString()));
    proc2.stderr?.on("data", (chunk) => relaunchStderr.push(chunk.toString()));
    try {
      const page2 = await app2.firstWindow();
      await page2.waitForLoadState("domcontentloaded");
      await sleep(1000);

      await attempt(12, "after relaunch, all ten exchanges render from durable data", async () => {
        const row = page2.locator("[data-session-band] button", { hasText: chatTabLabel });
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
        await waitUntil("the chat tab to open", async () => (await chatTab.count()) > 0, {
          timeout: 10000,
        });
        await chatTab.click();
        const rendered = await waitUntil(
          "the durable transcript to render both sides of all ten turns",
          async () => {
            const [userCount, assistantTexts] = await Promise.all([
              page2.evaluate(
                () =>
                  Array.from(document.querySelectorAll(".is-user")).filter(
                    (el) => (el.textContent?.trim() ?? "").length > 0,
                  ).length,
              ),
              assistantReplyTexts(page2),
            ]);
            const complete = assistantTexts.some((t) => t.includes("G1_COMPLETE"));
            return userCount >= 10 && assistantTexts.length >= 10 && complete
              ? { userCount, assistantCount: assistantTexts.length }
              : false;
          },
          { timeout: 15000 },
        ).catch(async (error) => {
          await captureFailureEvidence(
            page2,
            relaunchStdout,
            relaunchStderr,
            "relaunch-transcript-incomplete",
          );
          throw error;
        });
        return {
          ok: true,
          detail: `user=${rendered.userCount} assistant=${rendered.assistantCount}`,
        };
      });
    } finally {
      await app2.close().catch(() => {});
    }

    console.log(`\nEvidence dir: ${EVIDENCE_DIR}`);
    console.log(`Project dir (inspect the rover code the run produced): ${projectPath}`);
  } catch (error) {
    const page = app.windows()[0];
    if (page) await captureFailureEvidence(page, mainStdout, mainStderr, "aborted");
    throw error;
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
