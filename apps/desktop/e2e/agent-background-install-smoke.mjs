/**
 * E2e probe: the silent background CLI + skills install (VC-52).
 *
 * There is no first-boot dialog any more: the install runs in the background,
 * user-space, with no admin prompt and no opt-out — its only surfaces are the
 * detection pane and the disk. So this probe asserts the disk:
 *   1. A fresh profile's boot writes the skill pack AND links
 *      `~/.local/bin/volli` at this profile's shim, with no dialog to answer
 *      (the boot completing headless IS that assertion — a native sheet would
 *      have hung it).
 *   2. The VOLLI_SKIP_AGENT_TOOLS seam installs nothing at all —
 *      the guarantee every other smoke's home-isolation now rests on.
 *   3. A second boot of the installed profile is the hash-guarded refresh
 *      (the manifest is rewritten; managed files are not).
 *
 * The install home is redirected with VOLLI_AGENT_HOME so nothing lands in the
 * developer's real home (app.getPath("home") ignores $HOME on macOS). Smoke-kit
 * defaults VOLLI_SKIP_AGENT_TOOLS=1 for every probe; this one opts back in
 * with "0" against the scratch home.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/agent-background-install-smoke.mjs
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

const { scratch, cleanup } = await makeShortScratch("bgi");
const { attempt, summarize } = createRunner();

const harness = await buildFakeHarness(scratch);
const fakePath = `${harness.binDir}:${process.env.PATH ?? ""}`;

function profile(tag) {
  const userDataDir = join(scratch, `${tag}-ud`);
  const dbPath = join(scratch, `${tag}.db`);
  const fakeHome = join(scratch, `${tag}-home`);
  const manifest = join(fakeHome, ".agents/skills/volli/.volli-managed.json");
  const userLink = join(fakeHome, ".local/bin/volli");
  return { userDataDir, dbPath, fakeHome, manifest, userLink };
}

function boot({ userDataDir, dbPath, fakeHome }, extraEnv) {
  return launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_AGENT_HOME: fakeHome, PATH: fakePath, ...extraEnv },
  });
}

async function main() {
  // === 1. A fresh boot silently installs the pack and the user-space link ===
  const installP = profile("bg");
  await fs.mkdir(installP.fakeHome, { recursive: true });
  let installManifestMtime = 0;
  await attempt(
    1,
    "fresh boot installs skills + ~/.local/bin/volli with zero dialogs",
    async () => {
      const app = await boot(installP, { VOLLI_SKIP_AGENT_TOOLS: "0" });
      try {
        await assertProfileIsolated(app, installP.userDataDir);
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await waitUntil("skill pack to install", () => pathExists(installP.manifest), {
          timeout: 20000,
        });
        await waitUntil("user-space link to land", () => pathExists(installP.userLink), {
          timeout: 20000,
        });
        installManifestMtime = (await fs.stat(installP.manifest)).mtimeMs;
        const linkStat = await fs.lstat(installP.userLink);
        const target = await fs.readlink(installP.userLink);
        const expectedShim = join(installP.userDataDir, "bin", "volli");
        // Realpath both sides: main sees the scratch under /private/tmp while
        // the smoke names it /tmp (macOS's symlink), so a string compare would
        // fail a correct link.
        const linkOk =
          linkStat.isSymbolicLink() &&
          (await fs.realpath(target)) === (await fs.realpath(expectedShim));
        // The shim the link names must actually exist and be executable-ish.
        const shimOk = await pathExists(expectedShim);
        // And the Settings → CLI detection surface must tell the same story:
        // the pane exists to make the silent install readable, so its answer
        // is part of what "installed" means.
        const status = await page.evaluate(() => window.api.cli.status());
        const statusOk =
          status.ok === true &&
          status.status.link.state === "ours" &&
          status.status.socket.live === true;
        return {
          ok: linkOk && shimOk && statusOk,
          detail: `link=${linkOk} (→ ${target}) shim=${shimOk} status=${statusOk ? "ours+live" : JSON.stringify(status)}`,
        };
      } finally {
        await app.close();
      }
    },
  );

  // === 2. The skip seam installs nothing — every other smoke rests on this ==
  const skipP = profile("skip");
  await fs.mkdir(skipP.fakeHome, { recursive: true });
  await attempt(2, "VOLLI_SKIP_AGENT_TOOLS=1 boots without touching the home", async () => {
    const app = await boot(skipP, { VOLLI_SKIP_AGENT_TOOLS: "1" });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      // Give an (erroneous) install a moment to have written before asserting.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const noManifest = !(await pathExists(skipP.manifest));
      const noLink = !(await pathExists(skipP.userLink));
      return { ok: noManifest && noLink, detail: `noManifest=${noManifest} noLink=${noLink}` };
    } finally {
      await app.close();
    }
  });

  // === 3. A second boot is the hash-guarded refresh, not a rewrite ==========
  await attempt(
    3,
    "second boot refreshes idempotently (manifest rewritten, files skipped)",
    async () => {
      const skillMd = join(installP.fakeHome, ".agents/skills/volli/SKILL.md");
      const skillMtimeBefore = (await fs.stat(skillMd)).mtimeMs;
      const app = await boot(installP, { VOLLI_SKIP_AGENT_TOOLS: "0" });
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
        // A byte-identical managed file is skipped, not rewritten.
        const skillUntouched = (await fs.stat(skillMd)).mtimeMs === skillMtimeBefore;
        return {
          ok: refreshed && skillUntouched,
          detail: `refreshed=${refreshed} skillUntouched=${skillUntouched}`,
        };
      } finally {
        await app.close();
      }
    },
  );

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
