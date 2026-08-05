/**
 * E2e proof: the whole OpenCode discovery chain works when Electron itself is
 * launched with launchd's bare environment — the same PATH a Finder/Dock
 * launch (or any agent that double-clicks the .app rather than running it
 * from a terminal) hands a macOS process: `/usr/bin:/bin:/usr/sbin:/sbin`
 * and nothing else, no homebrew, no user dirs, no shell-rc PATH additions
 * visible on `process.env.PATH`.
 *
 * This is readiness-doc blocker A4
 * (`docs/plans/session-ui-migration-readiness.md`): "verify the spawned
 * server's environment against a packaged launch." Two separate resolutions
 * both have to survive a bare PATH for the model browser to load real data:
 *
 *   1. Binary resolution — `resolveOpenCodeBinary`
 *      (`apps/desktop/src/main/opencode-binary.ts`) walks the LOGIN SHELL's
 *      PATH (`apps/desktop/src/main/login-path.ts`, `zsh -l -i -c
 *      'printenv PATH'`), not `process.env.PATH`, to find `opencode`
 *      wherever it's actually installed (typically `~/.opencode/bin`).
 *   2. The spawned `opencode serve` child's OWN env —
 *      `packages/opencode-adapter/src/index.ts`'s `#startServer` merges
 *      `{ ...process.env, ...hostEnv }` where `hostEnv` comes from the
 *      adapter's `resolveEnv` option. Desktop wires that
 *      (`apps/desktop/src/main/index.ts:415-418`) to the SAME login-shell
 *      PATH, object-spread AFTER `process.env` so it wins — otherwise the
 *      child inherits Electron's bare launchd PATH and can't run its own
 *      toolchain even once the binary itself was found.
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
 *     node apps/desktop/e2e/opencode-env-smoke.mjs [evidence-dir]
 *
 * MANUALLY-RUN (needs a display + the built app + a real `opencode` install);
 * NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { createRunner, launch, makeScratch, waitUntil } from "./lib/smoke-kit.mjs";

const { userDataDir, dbPath, cleanup } = await makeScratch("opencode-env-");
const { attempt, summarize } = createRunner();

// The launchd/Finder/Dock approximation this probe simulates: no user dirs,
// no homebrew, nothing a shell rc would have added — only what
// main/login-path.ts's interactive-login-shell walk can recover. SHELL stays
// inherited (a real launchd launch still sets it; resolveShell needs it to
// know which shell to ask).
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

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
const EVIDENCE_DIR = process.argv[2] ?? join(os.tmpdir(), "volli-opencode-env-evidence");

/** Settings → Harness Runtimes → OpenCode, then poll the model browser to settle. */
async function openOpenCodeModels(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Harness Runtimes", exact: true }).click();
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();
  return waitUntil(
    "the OpenCode section to settle",
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
      const switchCount = await page.getByRole("switch").count();
      return switchCount > 0 ? { unavailable: false, switchCount } : false;
    },
    { timeout: 20000 },
  );
}

async function captureFailureEvidence(page, mainOut, mainErr, rendererConsole, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const screenshotPath = join(EVIDENCE_DIR, `opencode-env-${slug}.png`);
  const logPath = join(EVIDENCE_DIR, `opencode-env-${slug}.log`);
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
        const failed = mainStderr.some((line) =>
          line.includes("[volli] failed to generate harness wrappers"),
        );
        return {
          ok: !failed,
          detail: failed
            ? mainStderr.find((line) => line.includes("failed to generate harness wrappers"))
            : "no boot-time harness-wrapper failure logged",
        };
      },
    );

    let settled;
    await attempt(
      3,
      "the OpenCode model browser reaches its loaded state under a bare PATH",
      async () => {
        settled = await openOpenCodeModels(page).catch((error) => error);
        if (settled instanceof Error) {
          await captureFailureEvidence(
            page,
            mainStdout,
            mainStderr,
            rendererConsole,
            "settle-timeout",
          );
          return { ok: false, detail: settled.message };
        }
        if (settled.unavailable) {
          await captureFailureEvidence(
            page,
            mainStdout,
            mainStderr,
            rendererConsole,
            "unavailable",
          );
          return {
            ok: false,
            detail: `OpenCode unavailable: ${settled.reason ?? "unknown reason"} — this is a FINDING about binary/env resolution under a bare PATH, not a bug in this probe`,
          };
        }
        return {
          ok: true,
          detail: `${settled.switchCount} model switches rendered under bare PATH`,
        };
      },
    );

    await attempt(
      4,
      "runtimeCatalog.inspect independently reports a resolved, versioned runtime",
      async () => {
        const reply = await page.evaluate(() =>
          window.api.sessionRpc.request({
            procedure: "runtimeCatalog.inspect",
            input: { adapterId: "opencode" },
          }),
        );
        const ok =
          reply.ok === true &&
          reply.data.status === "available" &&
          typeof reply.data.runtimeVersion === "string" &&
          reply.data.runtimeVersion.length > 0;
        if (!ok) {
          await captureFailureEvidence(
            page,
            mainStdout,
            mainStderr,
            rendererConsole,
            "rpc-inspect",
          );
        }
        return {
          ok,
          detail: reply.ok
            ? `status=${reply.data.status} runtimeVersion=${reply.data.runtimeVersion} providers=${reply.data.providers?.length ?? 0}`
            : JSON.stringify(reply).slice(0, 300),
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
