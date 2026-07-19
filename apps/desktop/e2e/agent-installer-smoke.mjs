/**
 * E2e probe: installer idempotency against a fake $HOME.
 *
 * Runs the REAL install pipeline (detect → plan → apply with manifest) through
 * the app, against a throwaway $HOME, three times — asserting these guarantees
 * on disk:
 *   1. First install writes the managed skill pack (canonical copy + Claude
 *      symlink + OpenCode command + manifest) for the detected harnesses.
 *   2. A second run is idempotent: the managed files are byte-identical AND
 *      their mtimes are unchanged (a skip is a genuine no-op, not a rewrite),
 *      and a user-owned `custom/` file is never touched.
 *   3. A hand-edited managed file comes back as a CONFLICT — it is preserved,
 *      not overwritten — while `custom/` still stands.
 *
 * The /usr/local/bin admin symlink is env-gated off in tests (it needs an
 * osascript admin prompt no headless run can answer) via the test seam;
 * this probe exercises exactly the skill-pack pipeline, which is where install
 * idempotency lives. First install is driven by consent=install; the two
 * follow-ups take the app-update refresh path (consent already "installed").
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/agent-installer-smoke.mjs
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

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("ins");
const { attempt, summarize } = createRunner();

// A throwaway HOME the installer writes into, and a fake-harness bin dir so all
// three first-class harnesses are "detected" (maximal install plan).
const fakeHome = join(scratch, "home");
await fs.mkdir(fakeHome, { recursive: true });
const harness = await buildFakeHarness(scratch);
const fakePath = `${harness.binDir}:${process.env.PATH ?? ""}`;

const canonical = join(fakeHome, ".agents/skills/volli");
const skillMd = join(canonical, "SKILL.md");
const cliMd = join(canonical, "cli.md");
const manifestPath = join(canonical, ".volli-managed.json");
const claudeLink = join(fakeHome, ".claude/skills/volli");
const opencodeCmd = join(fakeHome, ".config/opencode/command/volli.md");
const customFile = join(canonical, "custom/mine.md");

function bootWith(extraEnv) {
  // VOLLI_AGENT_HOME redirects the installer's home (app.getPath("home") ignores
  // $HOME on macOS); PATH carries the fake harness bins so all three are detected.
  return launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_AGENT_HOME: fakeHome, PATH: fakePath, ...extraEnv },
  });
}

async function mtimeMs(path) {
  return (await fs.stat(path)).mtimeMs;
}

async function main() {
  // ---- Install run: consent=install writes the pack into fakeHome ----------
  let app = await bootWith({ VOLLI_AGENT_CONSENT_CHOICE: "install" });
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("first install to land", () => pathExists(manifestPath), { timeout: 20000 });
    await waitUntil("skill file to land", () => pathExists(skillMd), { timeout: 20000 });
  } finally {
    await app.close();
  }

  // === 1. First install wrote the full managed pack for detected harnesses ==
  let install1 = { manifestMtime: 0, skillMtime: 0, skillContent: "" };
  await attempt(1, "first install writes the managed skill pack + symlink + manifest", async () => {
    const skillOk = await pathExists(skillMd);
    const cliOk = await pathExists(cliMd);
    const opencodeOk = await pathExists(opencodeCmd);
    const linkStat = await fs.lstat(claudeLink).catch(() => null);
    const linkOk =
      linkStat?.isSymbolicLink() === true && (await fs.readlink(claudeLink)) === canonical;
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const manifestOk =
      manifest[skillMd]?.kind === "write" && manifest[claudeLink]?.kind === "symlink";
    install1 = {
      manifestMtime: await mtimeMs(manifestPath),
      skillMtime: await mtimeMs(skillMd),
      skillContent: await fs.readFile(skillMd, "utf8"),
    };
    // Seed a user-owned custom/ file the installer must never touch.
    await fs.mkdir(join(canonical, "custom"), { recursive: true });
    await fs.writeFile(customFile, "# my own automation notes\n");
    const ok = skillOk && cliOk && opencodeOk && linkOk && manifestOk;
    return {
      ok,
      detail: `skill=${skillOk} cli=${cliOk} opencode=${opencodeOk} link=${linkOk} manifest=${manifestOk}`,
    };
  });

  // ---- Refresh run: consent already "installed" → hash-guarded refresh ------
  app = await bootWith({});
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // The refresh always rewrites the manifest; wait until it does so we know
    // the (fire-and-forget) refresh actually ran before inspecting skip-ness.
    await waitUntil(
      "refresh to rewrite manifest",
      async () => (await mtimeMs(manifestPath)) > install1.manifestMtime,
      { timeout: 20000 },
    );
  } finally {
    await app.close();
  }

  // === 2. Second run is idempotent: managed file unchanged, custom/ untouched
  await attempt(2, "second run is a no-op for managed files; custom/ untouched", async () => {
    const skillMtime = await mtimeMs(skillMd);
    const skillContent = await fs.readFile(skillMd, "utf8");
    const unchanged = skillMtime === install1.skillMtime && skillContent === install1.skillContent;
    const customIntact =
      (await pathExists(customFile)) &&
      (await fs.readFile(customFile, "utf8")) === "# my own automation notes\n";
    const ok = unchanged && customIntact;
    return {
      ok,
      detail: `skillMtimeUnchanged=${skillMtime === install1.skillMtime} skillContentUnchanged=${skillContent === install1.skillContent} customIntact=${customIntact}`,
    };
  });

  // ---- Conflict run: hand-edit a managed file, refresh must preserve it -----
  const editedContent = `${install1.skillContent}\n<!-- hand-edited by the user -->\n`;
  await fs.writeFile(skillMd, editedContent);
  const refreshBaseMtime = await mtimeMs(manifestPath);
  app = await bootWith({});
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil(
      "refresh to rewrite manifest again",
      async () => (await mtimeMs(manifestPath)) > refreshBaseMtime,
      { timeout: 20000 },
    );
  } finally {
    await app.close();
  }

  // === 3. Hand-edited managed file is preserved (conflict), custom/ stands ==
  await attempt(
    3,
    "hand-edited managed file is preserved as a conflict (not overwritten)",
    async () => {
      const afterContent = await fs.readFile(skillMd, "utf8");
      const preserved = afterContent === editedContent;
      const customIntact = await pathExists(customFile);
      const ok = preserved && customIntact;
      return { ok, detail: `edit preserved=${preserved} customIntact=${customIntact}` };
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
