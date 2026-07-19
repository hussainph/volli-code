/**
 * e2e probe 5 (PR #70, spec §Tests → e2e): "first-launch consent flow".
 *
 * The consent moment fires once, during boot, before any Playwright client can
 * patch dialog.showMessageBox — so it is pre-answered through the documented
 * test seam VOLLI_AGENT_CONSENT_CHOICE (mirrors VOLLI_SKIP_CLOSE_CONFIRM for
 * the quit gate). Asserts the two branches of decision 7/12's consent gate:
 *   1. "defer" persists consent = "deferred" and installs NOTHING.
 *   2. "install" persists consent = "installed" and writes the skill pack.
 *   3. A subsequent boot with consent already "installed" triggers the
 *      hash-guarded app-update refresh (the installer runs again, idempotently).
 *
 * The install home is redirected with VOLLI_AGENT_HOME so nothing lands in the
 * developer's real home (app.getPath("home") ignores $HOME on macOS). The
 * /usr/local/bin admin symlink is env-gated off under the consent seam.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/agent-consent-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { buildFakeHarness } from "./lib/fake-harness.mjs";
import { makeShortScratch } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  pathExists,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, cleanup } = await makeShortScratch("con");
const { attempt, summarize } = createRunner();

const CONSENT_KEY = "volli:agent-tools-consent";
const harness = await buildFakeHarness(scratch);
const fakePath = `${harness.binDir}:${process.env.PATH ?? ""}`;

/** Poll the app's app_state (via the preload bootstrap) for the consent value. */
async function readConsent(page) {
  return page.evaluate(async (key) => {
    const res = await window.api.data.bootstrap();
    return res.ok ? (res.data.appState[key] ?? null) : null;
  }, CONSENT_KEY);
}

function profile(tag) {
  const userDataDir = join(scratch, `${tag}-ud`);
  const dbPath = join(scratch, `${tag}.db`);
  const fakeHome = join(scratch, `${tag}-home`);
  const manifest = join(fakeHome, ".agents/skills/volli/.volli-managed.json");
  return { userDataDir, dbPath, fakeHome, manifest };
}

function boot({ userDataDir, dbPath, fakeHome }, extraEnv) {
  return launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_AGENT_HOME: fakeHome, PATH: fakePath, ...extraEnv },
  });
}

async function main() {
  // === 1. "defer" persists "deferred" and installs nothing =================
  const deferP = profile("defer");
  await fs.mkdir(deferP.fakeHome, { recursive: true });
  await attempt(1, 'consent "defer" persists deferred and installs nothing', async () => {
    const app = await boot(deferP, { VOLLI_AGENT_CONSENT_CHOICE: "defer" });
    try {
      await assertProfileIsolated(app, deferP.userDataDir);
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const consent = await waitUntil("consent to persist", async () => await readConsent(page), {
        timeout: 20000,
      });
      // Give any (erroneous) install a chance to have written before asserting none did.
      const installedNothing = !(await pathExists(deferP.manifest));
      const ok = consent === '"deferred"' && installedNothing;
      return {
        ok,
        detail: `consent=${JSON.stringify(consent)} installedNothing=${installedNothing}`,
      };
    } finally {
      await app.close();
    }
  });

  // === 2. "install" persists "installed" and writes the skill pack =========
  const installP = profile("install");
  await fs.mkdir(installP.fakeHome, { recursive: true });
  let installManifestMtime = 0;
  await attempt(2, 'consent "install" persists installed and writes the pack', async () => {
    const app = await boot(installP, { VOLLI_AGENT_CONSENT_CHOICE: "install" });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const consent = await waitUntil("consent to persist", async () => await readConsent(page), {
        timeout: 20000,
      });
      await waitUntil("skill pack to install", () => pathExists(installP.manifest), {
        timeout: 20000,
      });
      installManifestMtime = (await fs.stat(installP.manifest)).mtimeMs;
      const ok = consent === '"installed"' && installManifestMtime > 0;
      return {
        ok,
        detail: `consent=${JSON.stringify(consent)} manifest=${await pathExists(installP.manifest)}`,
      };
    } finally {
      await app.close();
    }
  });

  // === 3. A boot with consent already "installed" runs the refresh =========
  await attempt(3, 'stored "installed" triggers the hash-guarded boot refresh', async () => {
    // No consent seam this time: consent is already "installed", so the prompt
    // never fires and the app-update refresh path runs instead.
    const app = await boot(installP, {});
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      // The refresh always rewrites the manifest — a later mtime proves it ran.
      const refreshed = await waitUntil(
        "refresh to rewrite the manifest",
        async () => (await fs.stat(installP.manifest)).mtimeMs > installManifestMtime,
        { timeout: 20000 },
      )
        .then(() => true)
        .catch(() => false);
      const stillInstalled = (await readConsent(page)) === '"installed"';
      const ok = refreshed && stillInstalled;
      return { ok, detail: `refreshed=${refreshed} stillInstalled=${stillInstalled}` };
    } finally {
      await app.close();
    }
  });

  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
