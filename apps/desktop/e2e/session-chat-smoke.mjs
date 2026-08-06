/**
 * E2e proof of the chat Session seam, end to end, against the BUILT app: create
 * a chat Session through the real UI, stream two scripted answers through a
 * fake `opencode` binary (./lib/fake-opencode-server.mjs), and assert both
 * settle durably — then relaunch on the same profile and assert both come back
 * from the durable transcript without a live adapter.
 *
 * Two turns, not one, because turn state used to be derived from a single
 * `session.status` busy event: the second turn's `session.idle` deduped against
 * the first's and was dropped, so the second reply never settled and existed
 * only until the app was closed. One turn cannot see that.
 *
 * Two things have to be true before a single message can be typed:
 *
 *   1. The `opencode` binary Volli spawns has to BE the fake — a per-harness
 *      override (`BinaryRow` in harness-settings.tsx / `commandSet` in
 *      harness-ipc.ts), never a seeded db row: `harness-command-repo.ts`
 *      stores the raw typed value, resolved fresh at every attach. This has
 *      to land through `window.api.harness.commandSet` BEFORE anything ever
 *      probes OpenCode — `OpenCodeNativeAdapter#ensureServer()` reuses an
 *      already-running server lease for the rest of the process's life
 *      (deliberately: "no dispose", see runtime-catalog-hub.ts), so if a
 *      REAL `opencode` happens to be on this machine's login-shell PATH and
 *      answers the FIRST probe before the override is set, every later probe
 *      — override or not — keeps talking to that real server. Driving the
 *      Binary field through the UI is what surfaced this: visiting Settings →
 *      Harness Runtimes → OpenCode mounts `RuntimeCatalogSettings`, which
 *      auto-probes with the default command on mount, racing the save. Set
 *      it via the same bridge call the Save button makes, before the pane is
 *      ever opened, and there is no race.
 *   2. The chat composer's model picker reads a SAVED preference
 *      (`runtime-catalog.ts`'s `resolve()`), never a live discovery snapshot —
 *      an unsaved probe result is invisible to it. So the fake's one model has
 *      to be explicitly toggled on via the "Show … in chat" `Switch`
 *      (`runtime-catalog-settings.tsx`), the same control
 *      harness-settings-persistence-smoke.mjs drives to prove model-enable
 *      persistence.
 *
 * Model-selection caveat this smoke exists to prove isn't silently broken:
 * without both of the above, `SessionComposer`'s textarea stays permanently
 * disabled (`ready = selection.modelId.length > 0`) and no prompt can ever be
 * typed, let alone sent.
 *
 * The chat tab is addressed by TWO different labels over this run, and mixing
 * them up reads as a vanished tab rather than a renamed one: it is created as
 * `Chat N`, and the first delivered message retitles it to {@link autoTitle}.
 * Check 11 is where the rebind happens, because that is the first assertion
 * after a message has been delivered — everything from there on, including the
 * relaunch and the close, uses the title.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/session-chat-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cardById,
  createRunner,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const FAKE_SERVER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "lib",
  "fake-opencode-server.mjs",
);

// Kept byte-for-byte in sync with ANSWER_CHUNKS in lib/fake-opencode-server.mjs
// (that file can't be imported here — it argv-dispatches into `--version`/
// `serve` on load, which would hijack this process's own argv). The fake numbers
// each answer, which is what lets the relaunch below tell one turn's reply from
// the other's instead of counting identical strings.
const ANSWER_BODY = "This is a fake OpenCode answer, streamed in three pieces, and now it settles.";
const answerText = (turn) => `Answer ${turn}: ${ANSWER_BODY}`;
const promptText = (turn) => `Say hello and settle, take ${turn}.`;
// A chat titles itself from its first delivered message, so the `Chat N` label a
// tab is created with names nothing once the first prompt lands, and every
// lookup after that has to use this instead. `autoTitleFromMessage`
// (chat/rename.ts) keeps a first line of 48 characters or fewer verbatim and
// this prompt is 29, so the title IS the prompt — no transformation restated
// here, and a change to either end surfaces as this smoke failing.
const autoTitle = (turn) => promptText(turn);
// Kept in sync with MODEL_LABEL in lib/fake-opencode-server.mjs. Matched
// exactly (never a loose "any switch") so a real `opencode` install on this
// machine can never be mistaken for the fake — see the module doc comment.
const MODEL_LABEL = "Fake Model";

const PROJECT = { id: "chat-smoke-project", name: "Chat Smoke Project", prefix: "CS" };

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("session-chat-smoke-");
// `tickets.create` defaults `usesWorktree` to true, so the chat attach below
// materializes a real worktree. `VOLLI_WORKTREE_HOME_DIR` is what keeps that
// out of the developer's own `~/.volli/worktrees` — same isolation
// worktree-smoke.mjs relies on, and it is load-bearing here, not hygiene.
const fakeHome = join(scratch, "home");
const worktreesRoot = join(fakeHome, ".volli", "worktrees");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-session-chat-smoke-evidence");

async function captureFailureEvidence(page, mainOut, mainErr, fakeLog, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `session-chat-${slug}.png`), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    join(EVIDENCE_DIR, `session-chat-${slug}.log`),
    [
      `=== ${label} ===`,
      "",
      "--- main process stdout ---",
      mainOut.join(""),
      "",
      "--- main process stderr ---",
      mainErr.join(""),
      "",
      "--- fake opencode server log ---",
      await fs.readFile(fakeLog, "utf8").catch(() => "(no log file)"),
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`  evidence: ${join(EVIDENCE_DIR, `session-chat-${slug}.png`)}`);
  console.log(`  evidence: ${join(EVIDENCE_DIR, `session-chat-${slug}.log`)}`);
}

/**
 * Sets the OpenCode binary override through the SAME bridge call the Binary
 * row's Save button makes, without ever mounting Settings — see the module
 * doc comment for why order matters here: this must land before anything
 * ever probes OpenCode, or a real `opencode` on this machine's login-shell
 * PATH can win the first probe and hold the adapter's one server lease for
 * the rest of the process's life, override or not.
 */
async function setOpenCodeBinaryOverride(page, binaryPath) {
  const result = await page.evaluate(
    ({ harnessId, command }) => window.api.harness.commandSet({ harnessId, command }),
    { harnessId: "opencode", command: binaryPath },
  );
  if (!result.ok) throw new Error(`commandSet refused: ${result.error ?? result.reason}`);
  const readBack = await page.evaluate(
    (harnessId) => window.api.harness.commandGet({ harnessId }),
    "opencode",
  );
  if (!readBack.ok || readBack.command !== binaryPath) {
    throw new Error(`commandGet did not confirm the override: ${JSON.stringify(readBack)}`);
  }
}

/** Settings → Harness Runtimes → OpenCode, then wait for the model browser's first probe to settle. */
async function openOpenCodeHarnessPane(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Harness Runtimes", exact: true }).click();
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();
  return waitUntil(
    "the OpenCode model browser to settle",
    async () => {
      if ((await page.getByText("Checking the local runtime…").count()) > 0) return false;
      if ((await page.getByText("OpenCode unavailable").count()) > 0) {
        const reason = await page
          .locator("p.mt-1.text-xs.text-muted-foreground")
          .first()
          .textContent()
          .catch(() => null);
        return { unavailable: true, reason };
      }
      const switches = await page.getByRole("switch", { name: /^Show .+ in chat$/ }).count();
      return switches > 0 ? { unavailable: false, switches } : false;
    },
    { timeout: 20000 },
  );
}

/** Toggles the fake model on so `runtimeCatalog.resolve()` — what the composer reads — includes it. */
async function enableFakeModel(page, label) {
  const target = page.getByRole("switch", { name: `Show ${label} in chat`, exact: true });
  await target.click();
  await waitUntil(
    `"${label}" switch to flip to checked`,
    async () => (await page.getByRole("switch", { name: `Hide ${label} in chat` }).count()) > 0,
  );
}

/** The tab strip's own "+" (there are two identical mounts — tab strip and rail; this scopes to the strip). */
function tabStripNewSessionButton(page) {
  return page
    .locator('[role="tablist"]')
    .locator("xpath=..")
    .getByRole("button", { name: "New session", exact: true });
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

/** The Stop button, which is on screen for exactly as long as a turn is running. */
function stopButton(page) {
  return page.getByRole("button", { name: "Stop", exact: true });
}

async function submitPrompt(page, text) {
  const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press("Enter");
}

/** The `span[aria-hidden]` liveness dot on the tab named `label`, or null if the tab/dot isn't there. */
function tabDotClasses(page, label) {
  return page.evaluate((tabLabel) => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
      (el) => el.getAttribute("aria-label") === tabLabel,
    );
    const dot = tab?.querySelector("span[aria-hidden]") ?? null;
    return dot ? dot.className : null;
  }, label);
}

/** `TAB_STATUS_CLASS.working` in ticket-tabs.tsx carries a halo shadow no other status does. */
function dotIsWorking(classes) {
  return classes !== null && classes.includes("shadow-[0_0_0_3px");
}

/**
 * The absolute path of a directory named `<needle>-*` (or exactly `needle`)
 * anywhere under `root`, or null. Ground truth for "did the ensure pipeline
 * actually run", independent of anything the UI claims — mirrors the same
 * helper in worktree-smoke.mjs.
 */
async function exists(path) {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false);
}

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
  const fakeLog = join(scratch, "fake-opencode.log");
  await fs.mkdir(fakeHome, { recursive: true });
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_FAKE_OPENCODE_LOG: fakeLog, VOLLI_WORKTREE_HOME_DIR: fakeHome },
  });
  const mainStdout = [];
  const mainStderr = [];
  const proc = app.process();
  proc.stdout?.on("data", (chunk) => mainStdout.push(chunk.toString()));
  proc.stderr?.on("data", (chunk) => mainStderr.push(chunk.toString()));

  let chatTabLabel = null;
  // The directory the attach bound, kept for check 13.5 — the only way to
  // delete exactly what the live attachment is holding.
  let boundWorktreeDir = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "chat-smoke-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    let displayId = null;
    await attempt(1, "seed a ticket through the preload bridge", async () => {
      const result = await page.evaluate((input) => window.api.tickets.create(input), {
        projectId,
        status: "todo",
        title: "Chat smoke ticket",
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

    await attempt(
      2,
      "point the OpenCode harness binary override at the fake server before anything probes it",
      async () => {
        await setOpenCodeBinaryOverride(page, FAKE_SERVER_PATH);
        return { ok: true, detail: FAKE_SERVER_PATH };
      },
    );

    await attempt(
      3,
      "Settings' model browser discovers exactly the fake provider's model",
      async () => {
        const settled = await openOpenCodeHarnessPane(page).catch((error) => error);
        if (settled instanceof Error) {
          await captureFailureEvidence(
            page,
            mainStdout,
            mainStderr,
            fakeLog,
            "models-settle-timeout",
          );
          return { ok: false, detail: settled.message };
        }
        if (settled.unavailable) {
          await captureFailureEvidence(page, mainStdout, mainStderr, fakeLog, "models-unavailable");
          return {
            ok: false,
            detail: `OpenCode unavailable: ${settled.reason ?? "unknown reason"}`,
          };
        }
        const fakeModelSwitch = await page
          .getByRole("switch", { name: `Show ${MODEL_LABEL} in chat`, exact: true })
          .count();
        if (fakeModelSwitch !== 1) {
          await captureFailureEvidence(page, mainStdout, mainStderr, fakeLog, "not-the-fake-model");
        }
        return {
          ok: settled.switches === 1 && fakeModelSwitch === 1,
          detail: `switches=${settled.switches} fakeModelSwitch=${fakeModelSwitch}`,
        };
      },
    );

    await attempt(4, "enable the fake model so the composer's catalog includes it", async () => {
      await enableFakeModel(page, MODEL_LABEL);
      return { ok: true, detail: MODEL_LABEL };
    });

    await attempt(5, "return to the board and open the seeded ticket", async () => {
      await goToBoard(page);
      await cardById(page, displayId).dblclick();
      await waitUntil(
        "the ticket detail to open",
        async () => (await page.getByRole("tab", { name: displayId, exact: true }).count()) === 1,
      );
      return { ok: true };
    });

    await attempt(6, "the tab strip's + menu creates a chat tab", async () => {
      chatTabLabel = await openNewChatTab(page);
      return { ok: chatTabLabel !== null, detail: chatTabLabel };
    });

    // The regression this check exists for: a chat on a worktree ticket used to
    // attach against `ticket.worktreePath ?? project.path` and provision
    // nothing, so OpenCode got a directory that was not there and every prompt
    // died server-side. The fake server does not care what its cwd is, so the
    // prompt surviving proves nothing — the worktree being ON DISK does.
    await attempt(7, "creating the chat materialized the ticket's worktree", async () => {
      const worktreeDir = await waitUntil(
        "the ticket's worktree to appear on disk",
        async () => (await findWorktreeDir(worktreesRoot, displayId)) ?? false,
        { timeout: 20000 },
      ).catch(async (error) => {
        await captureFailureEvidence(page, mainStdout, mainStderr, fakeLog, "worktree-absent");
        throw error;
      });
      const row = await page.evaluate(async (pid) => {
        const boot = await window.api.data.bootstrap();
        if (!boot.ok) return null;
        return (
          (boot.data.ticketsByProject?.[pid] ?? []).find((t) => t.worktreePath !== null) ?? null
        );
      }, projectId);
      boundWorktreeDir = worktreeDir;
      // Stamped, not merely created: the same row the terminal path writes.
      return {
        ok: row !== null && row.worktreePath === worktreeDir,
        detail: `dir=${worktreeDir} stamped=${row?.worktreePath ?? "none"}`,
      };
    });

    await attempt(8, "the composer becomes ready once the model resolves", async () => {
      const textarea = page.getByPlaceholder("Ask, plan, or implement…");
      await waitUntil("the composer to mount", async () => (await textarea.count()) > 0);
      await waitUntil(
        "the composer to become ready (a model is selectable)",
        async () => !(await textarea.first().isDisabled()),
        { timeout: 20000 },
      ).catch(async (error) => {
        await captureFailureEvidence(page, mainStdout, mainStderr, fakeLog, "composer-inert");
        throw error;
      });
      return { ok: true };
    });

    await attempt(9, "submitting a prompt starts a turn (Stop button appears)", async () => {
      await submitPrompt(page, promptText(1));
      await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
        timeout: 10000,
      });
      return { ok: true };
    });

    await attempt(10, "the streamed answer renders", async () => {
      await waitUntil(
        "the streamed answer text",
        async () => (await page.getByText(answerText(1), { exact: false }).count()) > 0,
        { timeout: 15000 },
      ).catch(async (error) => {
        await captureFailureEvidence(page, mainStdout, mainStderr, fakeLog, "answer-missing");
        throw error;
      });
      return { ok: true };
    });

    await attempt(
      11,
      "the turn settles: Stop clears and the tab's working dot clears",
      async () => {
        await waitUntil("the turn to settle", async () => (await stopButton(page).count()) === 0, {
          timeout: 15000,
        });
        // The tab retitled itself off the first message while the turn ran, so
        // the label it was created with names nothing now. Rebound here rather
        // than by loosening the lookup below: the dot assertion only means
        // something if it is addressed at a tab that must exist, and waiting for
        // the exact expected title pins the auto-title on the way past.
        chatTabLabel = await waitUntil(
          "the chat tab to carry the title taken from its first message",
          async () => {
            const titled = autoTitle(1);
            return (await page.getByRole("tab", { name: titled, exact: true }).count()) === 1
              ? titled
              : false;
          },
          { timeout: 10000 },
        );
        const classes = await tabDotClasses(page, chatTabLabel);
        const stillRendered = (await page.getByText(answerText(1), { exact: false }).count()) > 0;
        // The dot has to BE there for the absence of a halo on it to mean
        // anything: a tab that vanished has no working dot either, and
        // `dotIsWorking(null)` is false.
        return {
          ok: classes !== null && !dotIsWorking(classes) && stillRendered,
          detail: `label=${chatTabLabel} dotClasses=${classes} answerStillRendered=${stillRendered}`,
        };
      },
    );

    await attempt(12, "a second prompt in the same Session starts its own turn", async () => {
      await submitPrompt(page, promptText(2));
      await waitUntil(
        "the second turn to start",
        async () => (await stopButton(page).count()) > 0,
        {
          timeout: 10000,
        },
      );
      await waitUntil(
        "the second answer to render",
        async () => (await page.getByText(answerText(2), { exact: false }).count()) > 0,
        { timeout: 15000 },
      ).catch(async (error) => {
        await captureFailureEvidence(
          page,
          mainStdout,
          mainStderr,
          fakeLog,
          "second-answer-missing",
        );
        throw error;
      });
      return { ok: true };
    });

    // The check that pins the bug this smoke was extended for: a Session's turn
    // state used to be derived from a busy event alone, so the second turn's
    // idle read as a repeat of the first's and was dropped — Stop stayed lit,
    // the dot kept spinning, and the reply was never written down (check 14 is
    // where that last part shows).
    await attempt(13, "the second turn settles too — Stop clears again", async () => {
      const settled = await waitUntil(
        "the second turn to settle",
        async () => (await stopButton(page).count()) === 0,
        { timeout: 15000 },
      )
        .then(() => true)
        .catch(() => false);
      if (!settled) {
        await captureFailureEvidence(page, mainStdout, mainStderr, fakeLog, "second-turn-stuck");
      }
      const classes = await tabDotClasses(page, chatTabLabel);
      return {
        ok: settled && classes !== null && !dotIsWorking(classes),
        detail: `settled=${settled} dotClasses=${classes}`,
      };
    });

    // The bug this check exists for, and the only place the real git recreate
    // runs: a worktree deleted out from under an attachment that stays OPEN
    // across the deletion. `prepare` ran once, at attach; nothing re-asked
    // afterwards, so the adapter kept being handed a path that was no longer
    // there and every prompt came back about a second later as the harness's
    // own NotFound. The fake server does not care what its cwd is — so, as in
    // check 7, the prompt surviving proves nothing and the directory being
    // back on disk is the whole assertion.
    await attempt(
      13.5,
      "a worktree deleted under the live Session comes back before the next turn",
      async () => {
        await fs.rm(boundWorktreeDir, { recursive: true, force: true });
        const deleted = !(await exists(boundWorktreeDir));
        await submitPrompt(page, promptText(3));
        await waitUntil(
          "the third answer to render",
          async () => (await page.getByText(answerText(3), { exact: false }).count()) > 0,
          { timeout: 15000 },
        ).catch(async (error) => {
          await captureFailureEvidence(page, mainStdout, mainStderr, fakeLog, "third-turn-lost");
          throw error;
        });
        await waitUntil(
          "the third turn to settle",
          async () => (await stopButton(page).count()) === 0,
          {
            timeout: 15000,
          },
        );
        // The SAME path, and a real linked worktree — git leaves a `.git` FILE
        // there, which an empty directory made to quiet an error would not have.
        const recreated = await exists(join(boundWorktreeDir, ".git"));
        return {
          ok: deleted && recreated,
          detail: `deleted=${deleted} recreated=${recreated} dir=${boundWorktreeDir}`,
        };
      },
    );

    // ---- stretch: relaunch on the same profile, adopt (no live attach), and
    // assert the DURABLE transcript (not the fake server) is what renders it.
    await sleep(500);
    await app.close();

    const app2 = await launch({
      dbPath,
      userDataDir,
      extraEnv: { VOLLI_FAKE_OPENCODE_LOG: fakeLog, VOLLI_WORKTREE_HOME_DIR: fakeHome },
    });
    // Its own buffers: the first app's are closed, and the relaunch is the one
    // check whose failure mode (a boot that adopted nothing) is only legible
    // from what THIS process said on its way up.
    const relaunchStdout = [];
    const relaunchStderr = [];
    const proc2 = app2.process();
    proc2.stdout?.on("data", (chunk) => relaunchStdout.push(chunk.toString()));
    proc2.stderr?.on("data", (chunk) => relaunchStderr.push(chunk.toString()));
    try {
      const page2 = await app2.firstWindow();
      await page2.waitForLoadState("domcontentloaded");

      await attempt(
        14,
        "after relaunch, the chat tab reopens with BOTH answers from the durable transcript",
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
            // The adopt path restores the previously-active tab; fall back to
            // selecting it explicitly if a different tab won the restore.
            await waitUntil(
              "the chat tab to be reachable",
              async () => (await chatTab.count()) > 0,
              { timeout: 10000 },
            );
          }
          await chatTab.click();
          // Both, not just the last: a turn whose settle never landed leaves its
          // reply in the transient overlay only, which a relaunch discards. The
          // first answer coming back while the second does not is precisely the
          // shape of the bug, and a one-answer assertion would call it green.
          const rendered = await waitUntil(
            "both durable answers to render without a live adapter",
            async () => {
              const first = await page2.getByText(answerText(1), { exact: false }).count();
              const second = await page2.getByText(answerText(2), { exact: false }).count();
              return first > 0 && second > 0 ? { first, second } : false;
            },
            { timeout: 10000 },
          ).catch(() => null);
          if (!rendered) {
            await captureFailureEvidence(
              page2,
              relaunchStdout,
              relaunchStderr,
              fakeLog,
              "relaunch-transcript-missing",
            );
          }
          const present = await Promise.all(
            [1, 2].map((turn) => page2.getByText(answerText(turn), { exact: false }).count()),
          );
          return {
            ok: rendered !== null,
            detail: `answer1=${present[0]} answer2=${present[1]}`,
          };
        },
      );

      // The close trap, on the one app instance where it is loaded: this tab is
      // the persisted active one AND its Session is still on the ticket's
      // durable listing, which is exactly the pair the relaunch effect adopts
      // from. Standing the active tab down before the close is the whole of
      // what stops it — and a reordering that lost it would leave a chat tab
      // nobody can close, with every check above still green.
      await attempt(15, "closing the chat tab retires it, and nothing puts it back", async () => {
        const chatTab = page2.getByRole("tab", { name: chatTabLabel, exact: true });
        await page2.getByRole("button", { name: `Close ${chatTabLabel}`, exact: true }).click();
        await waitUntil("the chat tab to go", async () => (await chatTab.count()) === 0);
        // A fixed wait, because what is being asserted is that nothing happens:
        // the resurrection would land on the effect after the close commits,
        // and there is no state to poll for its absence.
        await sleep(1500);
        const back = await chatTab.count();
        return { ok: back === 0, detail: back === 0 ? "stayed closed" : "the tab came back" };
      });
    } finally {
      await app2.close().catch(() => {});
    }
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
