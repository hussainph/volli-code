/**
 * Focused packaged proof for the destructive quit/window lifecycle.
 *
 * Drives the built Electron app against one isolated scratch profile and a
 * real Project Files Monaco document. Native dialog choices are patched in
 * Electron main through ElectronApplication.evaluate: the smoke supplies
 * deterministic Cancel/Discard answers and persists every call to the scratch
 * directory so accepted quits remain inspectable after the process exits.
 *
 *   1. A real editable Project Files document becomes dirty without changing
 *      disk bytes.
 *   2. Cancel on app.quit keeps the app, window, and dirty editor alive.
 *   3. The same cancelled app still answers raw `volli` socket identify.
 *   4. Discard on app.quit exits only after removing the socket.
 *   5. The same isolated profile relaunches and answers identify again.
 *   6. Closing its dirty BrowserWindow with Discard clears the window-scoped
 *      unsaved report; macOS activation recreates a window, and an immediate
 *      quit sees no stale prompt (the patch's fallback is Cancel, so any stale
 *      prompt would keep the process alive and fail the check).
 *
 * Run after the desktop build:
 *   node apps/desktop/e2e/quit-window-lifecycle-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  identifyRequest,
  makeShortScratch,
  requestOverSocket,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  childHasExited,
  clickMonaco,
  createRunner,
  isMonacoEditable,
  launch,
  makeGitRepo,
  pathExists,
  readMonacoState,
  readSeededProjects,
  seedProjects,
  waitForChildExit,
  waitUntil,
} from "./lib/smoke-kit.mjs";

if (process.platform !== "darwin") {
  console.error(
    `quit-window-lifecycle-smoke is macOS-only (got platform "${process.platform}"): ` +
      "it proves macOS close/reactivate behavior and drives the Cmd+ArrowUp editor chord.",
  );
  process.exit(1);
}

const execFileAsync = promisify(execFile);
const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("life");
const { attempt, results, summarize } = createRunner();
const socketPath = socketPathFor(userDataDir);
const firstDialogRecord = join(scratch, "quit-dialogs.json");
const secondDialogRecord = join(scratch, "window-dialogs.json");
const windowLifecycleRecord = join(scratch, "window-lifecycle.json");

const PROJECT = {
  id: "quit-lifecycle-project",
  name: "Quit Lifecycle Project",
  prefix: "QL",
};
const TARGET = "src/lifecycle.ts";
const INITIAL = 'export const lifecycle = "clean";\n';
const FIRST_DRAFT = "// QUIT-CANCEL-DRAFT";
const SECOND_DRAFT = "// WINDOW-CLOSE-DRAFT";
const MAIN_EVALUATE_TIMEOUT_MS = 4000;
const CLEANUP_QUIT_TIMEOUT_MS = 8000;
const CLEANUP_CLOSE_TIMEOUT_MS = 4000;
const PLAYWRIGHT_CLOSE_TIMEOUT_MS = 4000;
const WINDOW_READY_TIMEOUT_MS = 15000;
const NATURAL_EXIT_RACE_TIMEOUT_MS = 500;
const FORCE_EXIT_TIMEOUT_MS = 4000;
const DIAGNOSTIC_LOG_TAIL_CHARS = 6000;

async function must(n, label, operation) {
  const resultIndex = results.length;
  await attempt(n, label, operation);
  if (results[resultIndex]?.ok !== true) {
    throw new Error(`required check ${n} failed; refusing dependent lifecycle actions`);
  }
}

async function boundedOperation(label, operation, timeout = MAIN_EVALUATE_TIMEOUT_MS) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeout}ms`)),
      timeout,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeoutPromise]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function captureElectronApplication(app, label) {
  const child = app.process();
  const run = {
    app,
    child,
    closed: false,
    closePromise: null,
    label,
    stderr: [],
    stdout: [],
  };
  child.stdout?.on("data", (chunk) => run.stdout.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => run.stderr.push(chunk.toString()));
  run.closePromise = new Promise((resolve) => {
    app.once("close", () => {
      run.closed = true;
      resolve();
    });
  });
  return run;
}

function diagnosticLogTail(chunks) {
  const body = chunks.join("").trim();
  return body.length > DIAGNOSTIC_LOG_TAIL_CHARS ? body.slice(-DIAGNOSTIC_LOG_TAIL_CHARS) : body;
}

function electronRunDiagnostics(run) {
  const { child } = run;
  return (
    `label=${JSON.stringify(run.label)} pid=${child.pid ?? "unknown"} ` +
    `exit=${child.exitCode ?? (childHasExited(child) ? "null" : "alive")} ` +
    `signal=${child.signalCode ?? "none"} ` +
    `stdout=${JSON.stringify(diagnosticLogTail(run.stdout))} ` +
    `stderr=${JSON.stringify(diagnosticLogTail(run.stderr))}`
  );
}

async function waitForPlaywrightClose(run, label, timeout = PLAYWRIGHT_CLOSE_TIMEOUT_MS) {
  if (run.closed) return;
  await boundedOperation(
    `${label} Playwright close acknowledgement`,
    () => run.closePromise,
    timeout,
  );
}

async function waitForReadyWindowOrExit(run, label, timeout = WINDOW_READY_TIMEOUT_MS) {
  let childCloseListener = null;
  let timeoutId = null;
  const ready = run.app
    .firstWindow({ timeout })
    .then(async (page) => {
      await page.waitForLoadState("domcontentloaded", { timeout });
      return { kind: "ready", page };
    })
    .catch((error) => ({ error, kind: "readiness-error" }));
  const exited = new Promise((resolve) => {
    if (childHasExited(run.child)) {
      resolve({ kind: "exit" });
      return;
    }
    childCloseListener = () => resolve({ kind: "exit" });
    run.child.once("close", childCloseListener);
  });
  const timedOut = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), timeout);
  });

  const outcome = await Promise.race([ready, exited, timedOut]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  if (childCloseListener !== null) run.child.off("close", childCloseListener);
  if (outcome.kind === "ready") return outcome.page;

  const diagnostic = electronRunDiagnostics(run);
  if (outcome.kind === "exit") {
    throw new Error(`${label} exited before its first window became ready: ${diagnostic}`);
  }
  if (outcome.kind === "readiness-error") {
    throw new Error(
      `${label} failed before its first window became ready: ${formatFailure(outcome.error)}; ${diagnostic}`,
      { cause: outcome.error },
    );
  }
  throw new Error(`${label} did not become ready within ${timeout}ms: ${diagnostic}`);
}

function navButton(page, label) {
  return page
    .locator('[data-sidebar-presentation="expanded"]')
    .getByRole("button", { name: label, exact: true });
}

function treeFile(page, relPath) {
  return page.locator(`[data-testid="file-tree-file"][data-rel-path="${relPath}"]`);
}

async function openRealDocument(page, needle = "lifecycle") {
  const filesWorkbench = page.locator('[data-testid="files-workbench"]');
  if ((await filesWorkbench.count()) === 0) {
    const files = navButton(page, "Files");
    await waitUntil("expanded Files navigation", async () =>
      (await files.isVisible().catch(() => false)) ? true : null,
    );
    await files.click();
  }
  await waitUntil(
    "Project Files workbench",
    async () => ((await filesWorkbench.count()) === 1 ? true : null),
    { timeout: 15000 },
  );

  const src = page.locator('[data-testid="file-tree-dir"][data-rel-path="src"]');
  await waitUntil("src directory row", async () => ((await src.count()) === 1 ? true : null));
  if ((await treeFile(page, TARGET).count()) === 0) await src.click();
  const row = treeFile(page, TARGET);
  await waitUntil(TARGET, async () => ((await row.count()) === 1 ? true : null));
  await row.click();

  return waitUntil(
    `real editable Monaco for ${TARGET}`,
    async () => {
      const state = await readMonacoState(page);
      return state.status === "ready" &&
        state.hasEditor &&
        state.fallbacks === 0 &&
        isMonacoEditable(state) &&
        state.lines.includes(needle)
        ? state
        : null;
    },
    { timeout: 30000 },
  );
}

async function dirtyDocument(page, projectPath, marker) {
  await openRealDocument(page);
  await clickMonaco(page);
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.type(marker);
  await page.keyboard.press("Enter");
  const state = await waitUntil(
    `${TARGET} to hold an unsaved draft`,
    async () => {
      const next = await readMonacoState(page);
      return next.dirty === "true" && next.lines.includes(marker) ? next : null;
    },
    { timeout: 15000 },
  );

  // reportUnsaved is a fire-and-forget renderer push. A real main-process IPC
  // round trip on the same bridge drains that earlier send before quit/close.
  await page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) throw new Error(`bootstrap: ${boot.error}`);
  });
  const onDisk = await fs.readFile(join(projectPath, TARGET), "utf8");
  return { state, onDisk };
}

async function waitForSeededProjectReady(page, projectPath) {
  const { byName } = await readSeededProjects(page);
  const project = byName[PROJECT.name];
  if (!project || project.path !== projectPath) {
    throw new Error(`seeded project missing after import: ${PROJECT.name}`);
  }

  await waitUntil("seeded project selection", async () => {
    const sidebar = page.locator('[data-sidebar-presentation="expanded"]');
    const selectedName = sidebar.getByText(PROJECT.name, { exact: true });
    const files = navButton(page, "Files");
    return (await selectedName.count()) === 1 && (await files.isVisible().catch(() => false))
      ? true
      : null;
  });
}

/**
 * Replaces Electron's synchronous native prompt in main and records every call
 * outside the process. `fallbackResponse` is intentionally explicit: launch
 * two uses Cancel as a tripwire for a stale unsaved report.
 */
async function installDialogPatch(app, recordPath, responses, fallbackResponse) {
  await fs.writeFile(recordPath, "[]\n", "utf8");
  await app.evaluate(
    ({ dialog }, config) => {
      const nodeFs = process.getBuiltinModule("node:fs");
      const state = {
        calls: [],
        fallbackResponse: config.fallbackResponse,
        recordPath: config.recordPath,
        responses: [...config.responses],
      };
      globalThis.volliQuitWindowLifecycleSmokeDialogPatch = state;
      dialog.showMessageBoxSync = (...args) => {
        const options = args.at(-1);
        const response = state.responses.shift() ?? state.fallbackResponse;
        state.calls.push({
          buttons: Array.isArray(options?.buttons) ? [...options.buttons] : [],
          detail: typeof options?.detail === "string" ? options.detail : null,
          message: typeof options?.message === "string" ? options.message : null,
          parented: args.length === 2,
          response,
        });
        nodeFs.writeFileSync(state.recordPath, `${JSON.stringify(state.calls, null, 2)}\n`);
        return response;
      };
    },
    { fallbackResponse, recordPath, responses },
  );
}

async function readDialogCalls(recordPath) {
  return JSON.parse(await fs.readFile(recordPath, "utf8"));
}

async function waitForIdentify(cwd) {
  return waitUntil(
    "raw socket identify",
    async () => {
      try {
        const response = await requestOverSocket(socketPath, identifyRequest(cwd));
        return response?.ok ? response : null;
      } catch {
        return null;
      }
    },
    { timeout: 15000 },
  );
}

async function waitForProcessExit(run, label, timeout = 15000) {
  return waitForChildExit(run.child, label, { timeout });
}

async function quitAndWait(run, label, timeout = 15000) {
  const request = boundedOperation(
    `${label} quit request`,
    () => run.app.evaluate(({ app: electronApp }) => electronApp.quit()),
    Math.min(timeout, MAIN_EVALUATE_TIMEOUT_MS),
  ).catch(() => undefined);
  const exit = await waitForProcessExit(run, label, timeout);
  await request;
  await waitForPlaywrightClose(run, label);
  return exit;
}

async function closeScratchApp(run) {
  if (run === null) return;
  const { app, child } = run;
  if (childHasExited(child)) return;
  const pid = child.pid;
  const gracefulFailures = [];

  try {
    await boundedOperation("scratch dialog cleanup patch", () =>
      app.evaluate(({ dialog }) => {
        const state = globalThis.volliQuitWindowLifecycleSmokeDialogPatch;
        if (state) {
          state.responses = [];
          state.fallbackResponse = 0;
          return;
        }

        dialog.showMessageBoxSync = (...args) => {
          const options = args.at(-1);
          const buttons = Array.isArray(options?.buttons) ? options.buttons : [];
          const discard = buttons.findIndex(
            (button) => button === "Discard and Quit" || button === "Discard and Close",
          );
          return discard >= 0
            ? discard
            : typeof options?.cancelId === "number"
              ? options.cancelId
              : 0;
        };
      }),
    );
  } catch (error) {
    gracefulFailures.push(error);
  }

  if (!childHasExited(child)) {
    try {
      await quitAndWait(run, "scratch Electron cleanup", CLEANUP_QUIT_TIMEOUT_MS);
    } catch (error) {
      gracefulFailures.push(error);
    }
  }

  if (!childHasExited(child)) {
    try {
      await boundedOperation(
        "Playwright scratch Electron close",
        () => app.close(),
        CLEANUP_CLOSE_TIMEOUT_MS,
      );
    } catch (error) {
      gracefulFailures.push(error);
    }
  }

  if (childHasExited(child)) return;

  let killSent = false;
  let killError = null;
  try {
    killSent = child.kill("SIGKILL");
  } catch (error) {
    if (childHasExited(child)) return;
    if (error?.code !== "ESRCH") {
      throw new Error(`failed to SIGKILL scratch Electron pid ${pid}`, { cause: error });
    }
    killError = error;
  }
  let exit;
  if (!killSent) {
    try {
      exit = await waitForChildExit(child, `natural scratch Electron pid ${pid} exit`, {
        timeout: NATURAL_EXIT_RACE_TIMEOUT_MS,
        interval: 20,
      });
    } catch (exitError) {
      const message = killError
        ? `scratch Electron pid ${pid} remained live after SIGKILL reported ESRCH`
        : `SIGKILL was not delivered to live scratch Electron pid ${pid}`;
      throw new Error(message, { cause: exitError });
    }
  } else {
    exit = await waitForChildExit(child, `forced scratch Electron pid ${pid} exit`, {
      timeout: FORCE_EXIT_TIMEOUT_MS,
    });
  }

  if (exit.signal !== "SIGKILL") return;
  const reasons = gracefulFailures.map((error) => error?.message ?? String(error)).join("; ");
  throw new Error(
    `scratch Electron pid ${pid} required SIGKILL after bounded graceful cleanup${reasons ? `: ${reasons}` : ""}`,
  );
}

async function closeScratchApps(apps) {
  const failures = [];
  for (const app of apps) {
    try {
      await closeScratchApp(app);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "one or more scratch Electron apps failed bounded cleanup");
  }
}

function formatFailure(error) {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(formatFailure).join("; ")}`;
  }
  return error?.stack ?? error?.message ?? String(error);
}

async function main() {
  const projectPath = await makeGitRepo(scratch, "quit-lifecycle-project-");
  await fs.mkdir(join(projectPath, "src"), { recursive: true });
  await fs.writeFile(join(projectPath, TARGET), INITIAL, "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: projectPath });
  await execFileAsync("git", ["commit", "-q", "-m", "seed lifecycle file"], {
    cwd: projectPath,
  });

  const firstApp = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      VOLLI_AGENT_CONSENT_CHOICE: "defer",
      // Override smoke-kit's normal teardown bypass: native decisions are the
      // subject of this probe.
      VOLLI_SKIP_CLOSE_CONFIRM: "0",
    },
  });
  const firstRun = captureElectronApplication(firstApp, "first Electron launch");
  let secondRun = null;

  let bodyError = null;
  try {
    await assertProfileIsolated(firstApp, userDataDir);
    const firstPage = await waitForReadyWindowOrExit(firstRun, "first Electron launch");
    assertBuiltRendererLoaded(firstPage);
    await seedProjects(firstPage, [{ ...PROJECT, path: projectPath }]);
    await waitForSeededProjectReady(firstPage, projectPath);
    await installDialogPatch(firstApp, firstDialogRecord, [1, 0], 0);

    await must(1, "real Project Files Monaco holds a dirty draft only in memory", async () => {
      const { state, onDisk } = await dirtyDocument(firstPage, projectPath, FIRST_DRAFT);
      const ok =
        state.status === "ready" &&
        state.fallbacks === 0 &&
        state.dirty === "true" &&
        state.lines.includes(FIRST_DRAFT) &&
        !onDisk.includes(FIRST_DRAFT);
      return {
        ok,
        detail: `status=${state.status} fallback=${state.fallbacks} dirty=${state.dirty} draftVisible=${state.lines.includes(FIRST_DRAFT)} diskUnchanged=${!onDisk.includes(FIRST_DRAFT)}`,
      };
    });

    await must(2, "Cancel on app.quit keeps the dirty app and its window alive", async () => {
      await boundedOperation("Cancel app.quit request", () =>
        firstApp.evaluate(({ app: electronApp }) => electronApp.quit()),
      );
      const calls = await waitUntil("recorded Cancel quit dialog", async () => {
        const next = await readDialogCalls(firstDialogRecord);
        return next.length === 1 ? next : null;
      });
      const windows = await firstApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      const editor = await readMonacoState(firstPage);
      const call = calls[0];
      const ok =
        firstRun.child.exitCode === null &&
        windows === 1 &&
        editor.dirty === "true" &&
        call?.message === "Quit Volli?" &&
        call?.parented === false &&
        call?.response === 1 &&
        call?.buttons?.join("|") === "Discard and Quit|Cancel" &&
        call?.detail?.includes("lifecycle.ts");
      return {
        ok,
        detail: `alive=${firstRun.child.exitCode === null} windows=${windows} dirty=${editor.dirty} prompt=${JSON.stringify(call?.message)} response=${call?.response} namesFile=${call?.detail?.includes("lifecycle.ts")}`,
      };
    });

    await must(3, "cancelled quit preserves the raw CLI socket identify surface", async () => {
      const response = await waitForIdentify(projectPath);
      const ok =
        response?.v === 1 &&
        response?.ok === true &&
        response?.data?.project?.prefix === PROJECT.prefix &&
        typeof response?.data?.appVersion === "string";
      return {
        ok,
        detail: `v=${response?.v} ok=${response?.ok} project=${JSON.stringify(response?.data?.project?.prefix)} appVersion=${JSON.stringify(response?.data?.appVersion)}`,
      };
    });

    await must(4, "Discard on app.quit exits with its socket removed", async () => {
      const dirtyBefore = (await readMonacoState(firstPage)).dirty;
      const exit = await quitAndWait(firstRun, "accepted quit process exit");
      const socketGone = await waitUntil(
        "accepted quit socket removal",
        async () => (!(await pathExists(socketPath)) ? true : null),
        { timeout: 10000 },
      );
      const calls = await readDialogCalls(firstDialogRecord);
      const choices = calls.map((call) => call.response).join("→");
      const ok =
        dirtyBefore === "true" &&
        exit.code === 0 &&
        socketGone === true &&
        calls.length === 2 &&
        calls.every(
          (call) =>
            call.message === "Quit Volli?" &&
            call.parented === false &&
            call.buttons?.join("|") === "Discard and Quit|Cancel",
        ) &&
        choices === "1→0";
      return {
        ok,
        detail: `dirtyBefore=${dirtyBefore} exit=${exit.code} socketGone=${socketGone === true} dialogs=${calls.length} choices=${choices}`,
      };
    });

    if (!childHasExited(firstRun.child)) {
      throw new Error("first Electron process remained alive; refusing a conflicting relaunch");
    }

    let secondApp;
    try {
      secondApp = await launch({
        dbPath,
        userDataDir,
        extraEnv: {
          VOLLI_AGENT_CONSENT_CHOICE: "defer",
          VOLLI_SKIP_CLOSE_CONFIRM: "0",
        },
      });
    } catch (error) {
      throw new Error(
        `second Electron launch failed before Playwright returned an application handle: ${formatFailure(error)}`,
        { cause: error },
      );
    }
    secondRun = captureElectronApplication(secondApp, "second Electron launch");
    const secondPage = await waitForReadyWindowOrExit(secondRun, "second Electron launch");
    await assertProfileIsolated(secondApp, userDataDir);
    assertBuiltRendererLoaded(secondPage);
    await waitForSeededProjectReady(secondPage, projectPath);
    await installDialogPatch(secondApp, secondDialogRecord, [0], 1);

    await must(5, "the same isolated profile relaunches and answers identify", async () => {
      const response = await waitForIdentify(projectPath);
      const onDisk = await fs.readFile(join(projectPath, TARGET), "utf8");
      const ok =
        response?.ok === true &&
        response?.data?.project?.prefix === PROJECT.prefix &&
        onDisk === INITIAL;
      return {
        ok,
        detail: `identify=${response?.ok} project=${JSON.stringify(response?.data?.project?.prefix)} firstDraftDiscarded=${onDisk === INITIAL}`,
      };
    });

    await must(6, "relaunch can dirty the same real editor document", async () => {
      const { state, onDisk } = await dirtyDocument(secondPage, projectPath, SECOND_DRAFT);
      const ok =
        state.dirty === "true" &&
        state.lines.includes(SECOND_DRAFT) &&
        !onDisk.includes(SECOND_DRAFT);
      return {
        ok,
        detail: `dirty=${state.dirty} draftVisible=${state.lines.includes(SECOND_DRAFT)} diskUnchanged=${!onDisk.includes(SECOND_DRAFT)}`,
      };
    });

    await attempt(
      7,
      "Discarded dirty-window close clears its report; activation recreates and quits without a stale prompt",
      async () => {
        // Keep the close → closed → activate → quit sequence in Electron main.
        // The new renderer cannot report an empty set between those operations,
        // so a green result specifically exercises the closed-window clearing
        // seam rather than being masked by the recreated renderer's boot report.
        void secondApp
          .evaluate(
            ({ app: electronApp, BrowserWindow }, recordPath) =>
              new Promise((resolve, reject) => {
                const nodeFs = process.getBuiltinModule("node:fs");
                const windows = BrowserWindow.getAllWindows();
                const target = windows[0];
                if (!target) {
                  reject(new Error("no BrowserWindow available to close"));
                  return;
                }
                const startingWindows = windows.length;
                target.once("closed", () => {
                  const afterClose = BrowserWindow.getAllWindows().length;
                  electronApp.emit("activate");
                  const afterActivate = BrowserWindow.getAllWindows().length;
                  const snapshot = { afterActivate, afterClose, startingWindows };
                  nodeFs.writeFileSync(recordPath, `${JSON.stringify(snapshot, null, 2)}\n`);
                  electronApp.quit();
                  resolve(snapshot);
                });
                target.close();
              }),
            windowLifecycleRecord,
          )
          .catch(() => undefined);

        let exit = null;
        let exitError = null;
        try {
          exit = await waitForProcessExit(secondRun, "post-reactivation quit process exit", 12000);
          await waitForPlaywrightClose(secondRun, "post-reactivation quit process exit");
        } catch (error) {
          exitError = error;
        }
        const snapshot = await waitUntil(
          "closed-window activation snapshot",
          async () => {
            try {
              return JSON.parse(await fs.readFile(windowLifecycleRecord, "utf8"));
            } catch {
              return null;
            }
          },
          { timeout: 5000 },
        );
        const calls = await readDialogCalls(secondDialogRecord);
        const socketGone =
          exit === null
            ? false
            : await waitUntil(
                "post-reactivation quit socket removal",
                async () => (!(await pathExists(socketPath)) ? true : null),
                { timeout: 10000 },
              );
        const closeCall = calls[0];
        const ok =
          exit?.code === 0 &&
          socketGone === true &&
          snapshot.startingWindows === 1 &&
          snapshot.afterClose === 0 &&
          snapshot.afterActivate === 1 &&
          calls.length === 1 &&
          closeCall?.message === "Close this window?" &&
          closeCall?.parented === true &&
          closeCall?.response === 0 &&
          closeCall?.buttons?.join("|") === "Discard and Close|Cancel" &&
          closeCall?.detail?.includes("lifecycle.ts");
        return {
          ok,
          detail: `windows=${snapshot.startingWindows}→${snapshot.afterClose}→${snapshot.afterActivate} exit=${exit?.code ?? "alive"} socketGone=${socketGone} dialogs=${calls.length} closeResponse=${closeCall?.response} staleQuitPrompt=${calls.length > 1} namesFile=${closeCall?.detail?.includes("lifecycle.ts")}${exitError === null ? "" : ` wait=${exitError.message}`}`,
        };
      },
    );
  } catch (error) {
    bodyError = error;
  }

  let cleanupError = null;
  try {
    await closeScratchApps([secondRun, firstRun]);
  } catch (error) {
    cleanupError = error;
  }

  if (bodyError !== null && cleanupError !== null) {
    throw new AggregateError(
      [bodyError, cleanupError],
      "lifecycle smoke body and cleanup both failed",
    );
  }
  if (bodyError !== null) throw bodyError;
  if (cleanupError !== null) throw cleanupError;

  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(
    "\nSMOKE ABORTED:",
    error instanceof AggregateError ? formatFailure(error) : (error?.stack ?? error),
  );
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
