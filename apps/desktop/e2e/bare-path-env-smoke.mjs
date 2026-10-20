/**
 * E2e proof: the app boots and recovers a usable environment when Electron
 * itself is launched with launchd's bare environment — the same PATH a
 * Finder/Dock launch (or any agent that double-clicks the .app rather than
 * running it from a terminal) hands a macOS process:
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, no homebrew, no user dirs,
 * no shell-rc PATH additions visible on `process.env.PATH`.
 *
 * This began as a session-UI migration readiness blocker (A4) about the
 * OpenCode model browser, and it kept the name `opencode-env-smoke` long after
 * that stopped being what it proved. The structured runtime is Pi now and runs in-process,
 * so there is no spawned server whose PATH could be wrong. What survives is the
 * part that was never OpenCode-specific and still guards a shipping feature:
 * harness wrapper generation for the TERMINAL companions, which walks the LOGIN
 * SHELL's PATH (`packages/host-core/src/login-shell-path.ts`, `zsh -l -i -c
 * 'printenv PATH'`) precisely because `process.env.PATH` is this useless under
 * launchd.
 *
 * A lab/dev-mode run cannot catch a regression here — `pnpm dev`'s Vite
 * process inherits a terminal's already-full PATH — only a BUILT app launch
 * with a genuinely bare PATH does, which is exactly what this probe drives.
 *
 * A FAILURE here is a finding about that chain. Main output is captured before
 * boot readiness work: Playwright drains the pipes during launch(), so attaching
 * listeners only after launch resolves can miss a completed boot entirely.
 * On failure this captures the Electron main process's own
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
import { join } from "node:path";

import {
  readBootCapture,
  wrapperGenerationOutcome,
  WRAPPER_READY_MARKER,
} from "../src/main/bare-path-boot-capture.ts";
import { createRunner, evidenceDir, launch, makeScratch, waitUntil } from "./lib/smoke-kit.mjs";

const { userDataDir, dbPath, cleanup } = await makeScratch("bare-path-env-");
const { attempt, summarize } = createRunner();

// The launchd/Finder/Dock approximation this probe simulates: no user dirs,
// no homebrew, nothing a shell rc would have added — only what
// main/login-shell-path.ts's interactive-login-shell walk can recover. SHELL stays
// inherited (a real launchd launch still sets it; resolveShell needs it to
// know which shell to ask).
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The one boot-time report from @volli/host-core's login-path-adoption.ts. */
const LOGIN_PATH_MARKER = /\[volli\] PATH (?:adopted from login shell \([1-9]\d* entries\)|kept)/;

const WAIT_TIMEOUT_MS = 12_000;

/**
 * Screenshot + main stdout/stderr + renderer console for a FAILING run. The
 * argument wins (CI names a dir it can upload); otherwise smoke-kit mkdtemp's
 * one under os.tmpdir() and prints it — see `evidenceDir` there for why it is
 * neither the scratch tree, nor the repo, nor a predictable name.
 */
const EVIDENCE_DIR = await evidenceDir("bare-path-env");

async function captureFailureEvidence(page, capture, rendererConsole, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const screenshotPath = join(EVIDENCE_DIR, `bare-path-env-${slug}.png`);
  const logPath = join(EVIDENCE_DIR, `bare-path-env-${slug}.log`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const log = [
    `=== ${label} ===`,
    `BARE_PATH=${BARE_PATH}`,
    `initial main PATH=${capture.initialPath}`,
    "",
    "--- main process stdout ---",
    capture.stdout,
    "",
    "--- main process stderr ---",
    capture.stderr,
    "",
    "--- renderer console ---",
    rendererConsole.join("\n"),
    "",
  ].join("\n");
  await fs.writeFile(logPath, log, "utf8");
  // The runner retains probe output, not this temporary evidence directory.
  // Include actual main logs in both-attempt artifacts, not just their paths.
  console.error(log);
  console.log(`  evidence: ${screenshotPath}`);
  console.log(`  evidence: ${logPath}`);
}

async function main() {
  const captureDir = join(userDataDir, "bare-path-boot-capture");
  await fs.mkdir(captureDir, { recursive: true });
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { PATH: BARE_PATH, VOLLI_BARE_PATH_CAPTURE_DIR: captureDir },
  });
  const rendererConsole = [];

  try {
    const page = await app.firstWindow();
    page.on("console", (msg) => rendererConsole.push(`[${msg.type()}] ${msg.text()}`));
    await page.waitForLoadState("domcontentloaded");

    await attempt(
      1,
      "main adopted or kept its PATH after launching under the bare PATH",
      async () => {
        try {
          const { initialPath } = readBootCapture(captureDir);
          if (initialPath !== BARE_PATH) {
            throw new Error(`main did not start with bare PATH: ${initialPath}`);
          }
          const match = await waitUntil(
            "main-process login-shell PATH outcome",
            // Main marks the ACTUAL browser-window-created event, not
            // when Playwright eventually returns that window to this client.
            // Keep descriptors separate so interleaved chunks cannot split a line.
            () => {
              const { postWindowStdout, postWindowStderr } = readBootCapture(captureDir);
              return (
                `${postWindowStdout}\n${postWindowStderr}`.match(LOGIN_PATH_MARKER)?.[0] ?? null
              );
            },
            { timeout: WAIT_TIMEOUT_MS },
          );
          const { postWindowStdout, postWindowStderr } = readBootCapture(captureDir);
          return {
            ok: true,
            detail: `${match} (post-window stdout=${postWindowStdout.length} bytes, stderr=${postWindowStderr.length} bytes)`,
          };
        } catch (error) {
          await captureFailureEvidence(
            page,
            readBootCapture(captureDir),
            rendererConsole,
            "login-shell-path-outcome",
          );
          const { postWindowStdout, postWindowStderr } = readBootCapture(captureDir);
          return {
            ok: false,
            detail: `${error.message}; post-window stdout=${postWindowStdout.length} bytes, stderr=${postWindowStderr.length} bytes`,
          };
        }
      },
    );

    await attempt(
      2,
      "boot completed harness-runtime generation without a wrapper failure",
      async () => {
        try {
          // The failure marker can straddle stderr chunks. Do not claim a
          // pass until either that joined stream reports it or main emits the
          // success marker after wrappers, configs and shell init have settled.
          const outcome = await waitUntil(
            "harness-wrapper generation to finish",
            () => wrapperGenerationOutcome(readBootCapture(captureDir)),
            { timeout: WAIT_TIMEOUT_MS },
          );
          if (outcome.kind === "failed") {
            await captureFailureEvidence(
              page,
              readBootCapture(captureDir),
              rendererConsole,
              "harness-wrappers",
            );
            return { ok: false, detail: outcome.offending };
          }
          return { ok: true, detail: WRAPPER_READY_MARKER };
        } catch (error) {
          await captureFailureEvidence(
            page,
            readBootCapture(captureDir),
            rendererConsole,
            "harness-wrapper-completion-timeout",
          );
          return { ok: false, detail: error.message };
        }
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
