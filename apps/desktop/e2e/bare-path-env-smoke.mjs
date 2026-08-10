/**
 * E2e proof: the app boots and recovers a usable environment when Electron
 * itself is launched with launchd's bare environment — the same PATH a
 * Finder/Dock launch (or any agent that double-clicks the .app rather than
 * running it from a terminal) hands a macOS process:
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, no homebrew, no user dirs,
 * no shell-rc PATH additions visible on `process.env.PATH`.
 *
 * This began as readiness-doc blocker A4
 * (`docs/plans/session-ui-migration-readiness.md`) about the OpenCode model
 * browser, and it kept the name `opencode-env-smoke` long after that stopped
 * being what it proved. The structured runtime is Pi now and runs in-process,
 * so there is no spawned server whose PATH could be wrong. What survives is the
 * part that was never OpenCode-specific and still guards a shipping feature:
 * harness wrapper generation for the TERMINAL companions, which walks the LOGIN
 * SHELL's PATH (`apps/desktop/src/main/login-path.ts`, `zsh -l -i -c 'printenv
 * PATH'`) precisely because `process.env.PATH` is this useless under launchd.
 *
 * A lab/dev-mode run cannot catch a regression here — `pnpm dev`'s Vite
 * process inherits a terminal's already-full PATH — only a BUILT app launch
 * with a genuinely bare PATH does, which is exactly what this probe drives.
 *
 * A FAILURE here is a finding about that chain, not a bug in this probe —
 * per the task this smoke was written for, do not patch `src/` to make it
 * pass. On failure this captures the Electron main process's own
 * stdout/stderr (console.error lines live there, not in the renderer) plus
 * the renderer's console and a screenshot, and prints where to find them.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/bare-path-env-smoke.mjs [evidence-dir]
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 * It needs no `opencode` install any more, so CI runs it unconditionally.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { createRunner, launch, makeScratch } from "./lib/smoke-kit.mjs";

const { userDataDir, dbPath, cleanup } = await makeScratch("bare-path-env-");
const { attempt, summarize } = createRunner();

// The launchd/Finder/Dock approximation this probe simulates: no user dirs,
// no homebrew, nothing a shell rc would have added — only what
// main/login-path.ts's interactive-login-shell walk can recover. SHELL stays
// inherited (a real launchd launch still sets it; resolveShell needs it to
// know which shell to ask).
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** What main logs when the login-shell PATH walk fails to place the wrappers. */
const WRAPPER_FAILURE_MARKER = "[volli] failed to generate harness wrappers";

/**
 * Where a FAILING run leaves its evidence — screenshot, the main process's own
 * stdout/stderr, the renderer console. Overridable by first argument, the same
 * way every other capturing probe here takes one (`docs-shots.mjs`,
 * `design-language-shots.mjs`, `button-shape-shots.mjs`), and otherwise derived
 * at runtime. A literal path is the one thing this must never be: pinned to the
 * machine the probe was written on it cannot exist anywhere else, so the single
 * artifact the failure path exists to produce lands nowhere useful — or the
 * `mkdir` throws inside the very handler that was supposed to explain the
 * failure, turning a legible finding about the discovery chain into a stack
 * trace about someone else's home directory.
 *
 * Deliberately NOT the smoke's own scratch tree: `cleanup()` removes that on
 * the way out (it owns it unless VOLLI_SMOKE_DIR says otherwise), so evidence
 * written there would be deleted seconds after capture, before anyone could
 * read it. Deliberately not inside the repo either: this is failure debris
 * rather than a checked-in artifact, and an untracked directory that appears
 * only after a red run is one `git add -A` away from being committed.
 */
const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-bare-path-env-evidence");

async function captureFailureEvidence(page, mainOut, mainErr, rendererConsole, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const screenshotPath = join(EVIDENCE_DIR, `bare-path-env-${slug}.png`);
  const logPath = join(EVIDENCE_DIR, `bare-path-env-${slug}.log`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(
    logPath,
    [
      `=== ${label} ===`,
      `BARE_PATH=${BARE_PATH}`,
      "",
      "--- main process stdout ---",
      mainOut.join(""),
      "",
      "--- main process stderr ---",
      mainErr.join(""),
      "",
      "--- renderer console ---",
      rendererConsole.join("\n"),
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`  evidence: ${screenshotPath}`);
  console.log(`  evidence: ${logPath}`);
}

async function main() {
  const app = await launch({ dbPath, userDataDir, extraEnv: { PATH: BARE_PATH } });
  const mainStdout = [];
  const mainStderr = [];
  const rendererConsole = [];
  const proc = app.process();
  proc.stdout?.on("data", (chunk) => mainStdout.push(chunk.toString()));
  proc.stderr?.on("data", (chunk) => mainStderr.push(chunk.toString()));

  try {
    const page = await app.firstWindow();
    page.on("console", (msg) => rendererConsole.push(`[${msg.type()}] ${msg.text()}`));
    await page.waitForLoadState("domcontentloaded");

    await attempt(1, "Electron's main process actually launched under the bare PATH", async () => {
      const seen = await app.evaluate(() => process.env.PATH);
      return { ok: seen === BARE_PATH, detail: `main process PATH=${seen}` };
    });

    await attempt(
      2,
      "boot did not already fail to generate harness wrappers off the bare PATH",
      async () => {
        // Node delivers stderr in arbitrary chunks, so the marker can straddle
        // two of them. Match the JOINED stream and split it into lines only to
        // name the offending one — matching per chunk reports a green PASS on
        // exactly the boot failure this probe exists to catch.
        const offending = mainStderr
          .join("")
          .split("\n")
          .find((line) => line.includes(WRAPPER_FAILURE_MARKER));
        if (offending !== undefined) {
          await captureFailureEvidence(
            page,
            mainStdout,
            mainStderr,
            rendererConsole,
            "harness-wrappers",
          );
        }
        return {
          ok: offending === undefined,
          detail: offending ?? "no boot-time harness-wrapper failure logged",
        };
      },
    );
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
