/**
 * E2e proof of the chat Session seam, end to end, against the BUILT app: create
 * a chat Session through the real UI, stream a scripted answer through a fake
 * `opencode` binary (./lib/fake-opencode-server.mjs), and assert it settles
 * durably — then relaunch on the same profile and assert the durable
 * transcript comes back without a live adapter.
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
// `serve` on load, which would hijack this process's own argv).
const ANSWER_TEXT = "This is a fake OpenCode answer, streamed in three pieces, and now it settles.";
const PROMPT_TEXT = "Say hello and settle.";
// Kept in sync with MODEL_LABEL in lib/fake-opencode-server.mjs. Matched
// exactly (never a loose "any switch") so a real `opencode` install on this
// machine can never be mistaken for the fake — see the module doc comment.
const MODEL_LABEL = "Fake Model";

const PROJECT = { id: "chat-smoke-project", name: "Chat Smoke Project", prefix: "CS" };

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("session-chat-smoke-");
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

async function main() {
  const fakeLog = join(scratch, "fake-opencode.log");
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_FAKE_OPENCODE_LOG: fakeLog },
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

    await attempt(7, "the composer becomes ready once the model resolves", async () => {
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

    await attempt(8, "submitting a prompt starts a turn (Stop button appears)", async () => {
      const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
      await textarea.click();
      await textarea.fill(PROMPT_TEXT);
      await page.keyboard.press("Enter");
      await waitUntil(
        "the turn to start",
        async () => (await page.getByRole("button", { name: "Stop", exact: true }).count()) > 0,
        { timeout: 10000 },
      );
      return { ok: true };
    });

    await attempt(9, "the streamed answer renders", async () => {
      await waitUntil(
        "the streamed answer text",
        async () => (await page.getByText(ANSWER_TEXT, { exact: false }).count()) > 0,
        { timeout: 15000 },
      ).catch(async (error) => {
        await captureFailureEvidence(page, mainStdout, mainStderr, fakeLog, "answer-missing");
        throw error;
      });
      return { ok: true };
    });

    await attempt(
      10,
      "the turn settles: Stop clears and the tab's working dot clears",
      async () => {
        await waitUntil(
          "the turn to settle",
          async () => (await page.getByRole("button", { name: "Stop", exact: true }).count()) === 0,
          { timeout: 15000 },
        );
        const classes = await tabDotClasses(page, chatTabLabel);
        const stillRendered = (await page.getByText(ANSWER_TEXT, { exact: false }).count()) > 0;
        return {
          ok: !dotIsWorking(classes) && stillRendered,
          detail: `dotClasses=${classes} answerStillRendered=${stillRendered}`,
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
      extraEnv: { VOLLI_FAKE_OPENCODE_LOG: fakeLog },
    });
    try {
      const page2 = await app2.firstWindow();
      await page2.waitForLoadState("domcontentloaded");

      await attempt(
        11,
        "after relaunch, the ticket + chat tab reopen with the durable transcript",
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
          const rendered = await waitUntil(
            "the durable answer to render without a live adapter",
            async () => (await page2.getByText(ANSWER_TEXT, { exact: false }).count()) > 0,
            { timeout: 10000 },
          )
            .then(() => true)
            .catch(() => false);
          return {
            ok: rendered,
            detail: rendered ? "durable transcript rendered" : "answer did not reappear",
          };
        },
      );
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
