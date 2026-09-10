/**
 * Onboarding walkthrough screenshots — the fresh-profile first hour, in order.
 *
 * Boots the BUILT app against a fully isolated scratch profile (empty HOME,
 * empty user-data dir, scratch DB) and captures every surface a brand-new user
 * meets between first boot and their first running agent:
 *
 *   01-first-boot.png          — empty profile: "Add your first project".
 *   02-connect-provider.png    — project added; board's Model Access first-run
 *                                block ("Connect a model provider to start").
 *   03-provider-menu.png       — the Sign in menu, providers listed.
 *   04-signin-key-step.png     — the provider's own key step (masked input).
 *   05-signed-in.png           — Model Access: the account row, signed in.
 *   06-choose-default.png      — board again: "Choose a default model to start."
 *   07-board-ready.png         — default set: "Use Create & start…".
 *   08-new-ticket-composer.png — the composer, filled, Create & Start visible.
 *   09-kickoff-workspace.png   — after ⇧⌘↵: the ticket workspace, chat tab.
 *   10-kickoff-settled.png     — the same pane once the first turn settles.
 *
 * DOCUMENTED SKIPS (the two steps Playwright cannot drive):
 *
 *   • Adding a project uses the native macOS folder picker — undriveable, so
 *     the project is seeded through the established `seedProjects` path
 *     (board-smoke.mjs precedent). Shot 01 shows the surface the real user
 *     clicks; the picker itself is stock macOS.
 *
 *   • Auth: sign-in is driven for real through the in-app flow, but with the
 *     model-access-signin-smoke's fake Groq api key — entirely local, never
 *     validated, never billed. If real `~/.pi/agent/auth.json` credentials
 *     exist on this machine they are additionally staged (ensurePiAuthInto,
 *     shredded on exit) so the kickoff turn in shots 09/10 is a REAL turn
 *     ("Reply with OK. Run no commands." — the repo's minimal-turn
 *     convention). Without them, the fake key still exercises the whole flow
 *     and shot 10 honestly shows what a user with a bad key sees.
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`:
 *
 *   pnpm run build
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/onboarding-shots.mjs [outDir]
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
  pathExists,
  seedDefaultModel,
  seedProjects,
  sleep,
  tabStrip,
  TICKET_TAB_STRIP,
  typeIntoMonaco,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const OUT_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-onboarding-shots");

/** Same provider + key as model-access-signin-smoke.mjs: api-key flow, one
 * masked step, nothing validated, nothing billed. */
const PROVIDER_ID = "groq";
const PROVIDER_LABEL = "Groq";
const FAKE_KEY = "gsk-volli-smoke-not-a-real-key-000000";

const PROJECT = { id: "onboarding-shots-project", name: "acme-app", prefix: "ACME" };
const TICKET_TITLE = "Add a health check endpoint";
const TICKET_BODY = "Reply with OK. Run no commands.";

const REAL_PI_AUTH = join(os.homedir(), ".pi", "agent", "auth.json");

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-onboarding-shots-");
const home = join(scratch, "home");
const { attempt, check, summarize } = createRunner();

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.mkdir(home, { recursive: true });
const projectDir = await makeGitRepo(scratch, "acme-app-");

const app = await launch({ dbPath, userDataDir, extraEnv: { HOME: home } });

/** Composited-window capture (docs-shots.mjs precedent: capturePage reads the
 * pixels a person sees, at the display's device scale). */
async function capture(page, name) {
  await page.mouse.move(4, 4); // park the pointer so no hover state ships
  await sleep(500);
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  const file = join(OUT_DIR, name);
  await fs.writeFile(file, Buffer.from(base64, "base64"));
  return { ok: true, detail: file };
}

const firstRunLine = (page, text) => page.getByText(text, { exact: true });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await assertBuiltRendererLoaded(page);

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1440, 900);
    win.focus();
  });
  await sleep(1200);

  // ---- 01: first boot, empty profile --------------------------------------
  await attempt(1, "01 first boot — 'Add your first project'", async () => {
    await waitUntil("empty-projects canvas", async () => {
      return (await page.locator("[data-empty-projects-state]").count()) === 1;
    });
    return capture(page, "01-first-boot.png");
  });

  // ---- skip: native folder picker → seeded project -------------------------
  await seedProjects(page, [{ ...PROJECT, path: projectDir }]);
  console.log("SKIP  add-project native picker — project seeded via seedProjects()");

  // ---- 02: board first-run block, no provider ------------------------------
  await attempt(2, "02 board — 'Connect a model provider to start.'", async () => {
    await waitUntil(
      "model first-run block",
      async () => (await firstRunLine(page, "Connect a model provider to start.").count()) === 1,
      { timeout: 20000 },
    );
    return capture(page, "02-connect-provider.png");
  });

  // ---- 03: the provider sign-in menu --------------------------------------
  await attempt(3, "03 the Sign in provider menu", async () => {
    const trigger = page.getByRole("button", { name: "Sign in", exact: true });
    await trigger.waitFor({ timeout: 15000 });
    await trigger.click();
    await waitUntil("provider menu items", async () => {
      return (await page.getByRole("menuitem").count()) >= 3;
    });
    await sleep(300);
    return capture(page, "03-provider-menu.png");
  });

  // ---- 04: the provider's own key step (deep-linked into Settings) ---------
  await attempt(4, "04 sign-in key step (masked input)", async () => {
    await page.getByRole("menuitem", { name: PROVIDER_LABEL }).click();
    const panel = page.getByTestId(`sign-in-${PROVIDER_ID}`);
    await panel.waitFor({ timeout: 20000 });
    await panel.locator("input").fill(FAKE_KEY);
    await sleep(300);
    return capture(page, "04-signin-key-step.png");
  });

  // ---- 05: signed in -------------------------------------------------------
  await attempt(5, "05 Model Access — account signed in", async () => {
    await page
      .getByTestId(`sign-in-${PROVIDER_ID}`)
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await waitUntil(
      "the account row offers Sign out",
      async () => {
        const button = page
          .getByTestId(`account-${PROVIDER_ID}`)
          .getByRole("button", { name: "Sign out", exact: true });
        return (await button.count()) === 1;
      },
      { timeout: 20000 },
    );
    return capture(page, "05-signed-in.png");
  });

  // ---- 06: back on the board — choose a default ----------------------------
  await attempt(6, "06 board — 'Choose a default model to start.'", async () => {
    await page.keyboard.press("Escape");
    const line = firstRunLine(page, "Choose a default model to start.");
    const appeared = await waitUntil(
      "choose-default line",
      async () => (await line.count()) === 1,
      {
        timeout: 8000,
      },
    )
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      // Escape did not close Settings on this build — reload lands on Home.
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await waitUntil("choose-default line after reload", async () => (await line.count()) === 1, {
        timeout: 20000,
      });
    }
    return capture(page, "06-choose-default.png");
  });

  // ---- default model: real creds when present, fake catalog otherwise ------
  const haveRealAuth = await pathExists(REAL_PI_AUTH);
  if (haveRealAuth) {
    await ensurePiAuthInto(home);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);
    console.log("SKIP  default-model choice — real Pi creds staged; seeding via the same");
  } else {
    console.log("SKIP  default-model choice — no real creds; trying the fake-key catalog");
  }
  // `modelAccess.setDefault` mutation Settings itself uses (seedDefaultModel).
  let defaultSeeded = true;
  try {
    await seedDefaultModel(page);
  } catch (error) {
    defaultSeeded = false;
    console.error("seedDefaultModel failed:", error?.message ?? error);
  }
  check(
    7,
    "a global default model is set",
    defaultSeeded,
    haveRealAuth ? "real creds" : "fake key",
  );

  // ---- 07: the board, ready ------------------------------------------------
  await attempt(8, "07 board ready — 'Use Create & start'", async () => {
    const line = page.getByText(/immediately start a session/);
    const appeared = await waitUntil("ticket line", async () => (await line.count()) === 1, {
      timeout: 8000,
    })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await waitUntil("ticket line after reload", async () => (await line.count()) === 1, {
        timeout: 20000,
      });
    }
    await sleep(800);
    return capture(page, "07-board-ready.png");
  });

  // ---- 08: the new-ticket composer ----------------------------------------
  await attempt(9, "08 new-ticket composer with Create & Start", async () => {
    await page.getByRole("button", { name: "New ticket", exact: true }).first().click();
    const composer = page.locator('[data-testid="new-ticket-composer"]');
    await composer.waitFor({ timeout: 8000 });
    await composer.getByPlaceholder("Ticket title").fill(TICKET_TITLE);
    await typeIntoMonaco(composer, TICKET_BODY);
    await sleep(400);
    return capture(page, "08-new-ticket-composer.png");
  });

  // ---- 09: ⇧⌘↵ — the kickoff moment ---------------------------------------
  await attempt(10, "09 kickoff — ticket workspace opens on the chat tab", async () => {
    await page.keyboard.press("Meta+Shift+Enter");
    await waitUntil(
      "ticket workspace",
      async () => (await tabStrip(page, TICKET_TAB_STRIP).getByRole("tab").count()) >= 1,
      { timeout: 30000 },
    );
    await sleep(2500);
    return capture(page, "09-kickoff-workspace.png");
  });

  // ---- 10: the first turn settles ------------------------------------------
  await attempt(11, "10 the first turn settles (reply, or the honest error)", async () => {
    // With real creds this is a genuine minimal turn; with the fake key it is
    // the error surface a user with a bad key sees. Both are the truth.
    await sleep(haveRealAuth ? 60000 : 25000);
    return capture(page, "10-kickoff-settled.png");
  });
} catch (error) {
  check("!", "onboarding shots crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
  await cleanup();
}

console.log(`\nshots written to ${OUT_DIR}`);
process.exit(summarize());
