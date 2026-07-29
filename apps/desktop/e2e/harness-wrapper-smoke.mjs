/**
 * E2e probe: the generated harness wrapper, actually executed.
 *
 * `packages/shared/src/harness/wrapper.test.ts` can only assert the script's
 * TEXT — that package may not import Node, so it cannot tell whether its shell
 * quoting holds when a shell reads it. It names six execution paths and points
 * here. This is those six, run against the REAL wrapper the app generated, with
 * the REAL environment the app injected into a live PTY:
 *
 *   1. passthrough — VOLLI_SESSION unset execs the real binary unchanged,
 *   2. injection — inside a session, the configured argv plus a session id,
 *   3. suppression — the user's own `--resume` keeps the session id out,
 *   4. a missing VOLLI_HARNESS_ARGV_* still launches (no empty word, no error),
 *   5. VOLLI_HARNESS_BIN_* names the real binary outright,
 *   6. an unresolvable binary exits 127 loudly instead of passing through.
 *
 * The environment is not recomputed here — it is read out of a live Volli PTY
 * (`printenv > file`, so a terminal's line wrapping can't corrupt the settings
 * JSON), which is what makes this a test of what the app does rather than of
 * what this file thinks it does.
 *
 * Checks 7-9 close the loop the wrapper opens: a hook fired through the real
 * shim records the harness's own session id on the session record, costs a
 * harness running outside Volli nothing, and — with the app shut down — still
 * exits 0 in silence, because a dead Volli must never wedge a live agent.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/harness-wrapper-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { makeShortScratch, shimPathFor, socketPathFor } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);
const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("hw");
const { attempt, summarize } = createRunner();

/**
 * A stand-in for the harness binary: it records `$0` and every argument, one
 * per line, into whatever `VOLLI_PROBE` names. Argv is the whole point of the
 * wrapper, so recording it verbatim is the entire assertion surface.
 */
const FAKE_BINARY = [
  "#!/bin/sh",
  ': > "$VOLLI_PROBE"',
  'printf "argv0=%s\\n" "$0" >> "$VOLLI_PROBE"',
  'for volli_arg in "$@"; do printf "arg=%s\\n" "$volli_arg" >> "$VOLLI_PROBE"; done',
  "exit 0",
  "",
].join("\n");

/** Runs the wrapper directly (shebang + mode bit included) and reads back the recorded argv. */
async function runWrapper(wrapperPath, args, env) {
  const probe = join(scratch, `probe-${Math.random().toString(36).slice(2)}`);
  let code = 0;
  let stderr = "";
  try {
    const result = await execFileAsync(wrapperPath, args, {
      env: { ...env, VOLLI_PROBE: probe },
    });
    stderr = result.stderr;
  } catch (error) {
    code = error.code ?? 1;
    stderr = error.stderr ?? "";
  }
  let recorded = null;
  try {
    recorded = await fs.readFile(probe, "utf8");
  } catch {
    recorded = null;
  }
  const lines = recorded === null ? [] : recorded.split("\n").filter(Boolean);
  return {
    code,
    stderr,
    argv0: lines.find((line) => line.startsWith("argv0="))?.slice("argv0=".length) ?? null,
    args: lines.filter((line) => line.startsWith("arg=")).map((line) => line.slice("arg=".length)),
  };
}

/**
 * Fires `volli hook …` the way a harness does — payload written to stdin, then
 * closed. Never throws: the exit code is the assertion.
 */
function runHookVerb(shimPath, args, env, payload) {
  return new Promise((resolvePromise) => {
    const child = spawn(shimPath, ["hook", ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(payload);
  });
}

async function main() {
  // A fake `claude` on PATH is what makes the app detect claude-code and write
  // its wrapper; it is also the binary that wrapper resolves to.
  const fakeBin = join(scratch, "fakebin");
  const altBin = join(scratch, "altbin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(altBin, { recursive: true });
  await fs.writeFile(join(fakeBin, "claude"), FAKE_BINARY, { mode: 0o755 });
  await fs.writeFile(join(altBin, "claude-override"), FAKE_BINARY, { mode: 0o755 });

  // A PATH-neutral login-shell rc: the developer's own dotfiles must not
  // reorder PATH under the fake.
  const zdotDir = join(scratch, "zdot");
  await fs.mkdir(zdotDir, { recursive: true });
  await fs.writeFile(join(zdotDir, ".zshrc"), "# e2e scratch zshrc — does NOT modify PATH\n");

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      VOLLI_AGENT_CONSENT_CHOICE: "defer",
      ZDOTDIR: zdotDir,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  });
  const realUserData = await fs.realpath(userDataDir);
  const wrapperPath = join(realUserData, "bin", "claude");

  let sessionEnv = null;
  let deadAppProbe = null;
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const projectPath = await makeGitRepo(scratch, "hw-");
    await seedProjects(page, [
      { id: "hw-project", name: "Wrapper Project", path: projectPath, prefix: "HW" },
    ]);

    const created = await page.evaluate(
      async ({ workspaceId, cwd }) =>
        window.api.terminal.create({ workspaceId, cwd, cols: 80, rows: 24 }),
      { workspaceId: "hw-project", cwd: projectPath },
    );
    if (!created?.ok) throw new Error(`terminal.create failed: ${created?.error}`);

    // Read the injected environment out of the live PTY, into files — the
    // settings payload is far longer than 80 columns, so anything read back
    // through the terminal's own output stream would arrive wrapped.
    const envDir = join(scratch, "env");
    await fs.mkdir(envDir, { recursive: true });
    await page.evaluate(
      ({ id, dir }) =>
        window.api.terminal.write(
          id,
          `printenv VOLLI_SESSION > '${dir}/session'; ` +
            `printenv VOLLI_HARNESS_ARGV_CLAUDE_CODE > '${dir}/argv'; ` +
            `printf done > '${dir}/ready'\n`,
        ),
      { id: created.sessionId, dir: envDir },
    );
    await waitUntil("the PTY to report its environment", async () => {
      try {
        return (await fs.readFile(join(envDir, "ready"), "utf8")) === "done";
      } catch {
        return false;
      }
    });
    sessionEnv = {
      VOLLI_SESSION: (await fs.readFile(join(envDir, "session"), "utf8")).trim(),
      VOLLI_HARNESS_ARGV_CLAUDE_CODE: (await fs.readFile(join(envDir, "argv"), "utf8")).trimEnd(),
    };
    const base = {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      VOLLI_SESSION: sessionEnv.VOLLI_SESSION,
      VOLLI_HARNESS_ARGV_CLAUDE_CODE: sessionEnv.VOLLI_HARNESS_ARGV_CLAUDE_CODE,
    };

    await attempt(0, "the app generated a wrapper and an argv payload to apply", async () => {
      const mode = (await fs.stat(wrapperPath)).mode & 0o777;
      const ok =
        mode === 0o755 &&
        sessionEnv.VOLLI_SESSION.length > 0 &&
        sessionEnv.VOLLI_HARNESS_ARGV_CLAUDE_CODE.startsWith("'--settings' '{");
      return { ok, detail: `mode=${mode.toString(8)} session=${sessionEnv.VOLLI_SESSION}` };
    });

    // === 1. passthrough outside a Volli session ==============================
    await attempt(1, "execs the real binary untouched with VOLLI_SESSION unset", async () => {
      const { PATH, VOLLI_HARNESS_ARGV_CLAUDE_CODE } = base;
      const run = await runWrapper(wrapperPath, ["--print", "hello"], {
        PATH,
        VOLLI_HARNESS_ARGV_CLAUDE_CODE,
      });
      const ok =
        run.code === 0 && JSON.stringify(run.args) === JSON.stringify(["--print", "hello"]);
      return { ok, detail: `code=${run.code} args=${JSON.stringify(run.args)}` };
    });

    // === 2. injection inside a session ======================================
    await attempt(2, "applies the configured argv and Volli's own session id", async () => {
      const run = await runWrapper(wrapperPath, ["--print", "hello"], base);
      const settingsIndex = run.args.indexOf("--settings");
      const idIndex = run.args.indexOf("--session-id");
      const settings = settingsIndex === -1 ? "" : (run.args[settingsIndex + 1] ?? "");
      let parsed = null;
      try {
        parsed = JSON.parse(settings);
      } catch {
        parsed = null;
      }
      // The settings payload must survive `eval` as ONE word with its JSON intact
      // — that is the quoting the text assertions cannot check.
      const ok =
        run.code === 0 &&
        settingsIndex === 0 &&
        // Every word of the hook line is single-quoted, the shim path included:
        // it lives under `Application Support/` in a real install.
        parsed?.hooks?.Notification?.[0]?.hooks?.[0]?.command?.includes(
          "'hook' 'claude-code' 'input.needed'",
        ) === true &&
        run.args[idIndex + 1] === base.VOLLI_SESSION &&
        JSON.stringify(run.args.slice(-2)) === JSON.stringify(["--print", "hello"]);
      return { ok, detail: `code=${run.code} argc=${run.args.length} parsed=${parsed !== null}` };
    });

    // === 3. the user's own resume wins the session ===========================
    await attempt(3, "keeps its session id out when the user is driving resume", async () => {
      const run = await runWrapper(wrapperPath, ["--resume", "abc123"], base);
      const ok =
        run.code === 0 &&
        run.args[0] === "--settings" &&
        !run.args.includes("--session-id") &&
        JSON.stringify(run.args.slice(-2)) === JSON.stringify(["--resume", "abc123"]);
      return { ok, detail: `args=${JSON.stringify(run.args.filter((a) => a.length < 40))}` };
    });

    // === 4. no configured argv at all ========================================
    await attempt(4, "launches cleanly when no argv was configured for it", async () => {
      const run = await runWrapper(wrapperPath, ["hello"], {
        PATH: base.PATH,
        VOLLI_SESSION: base.VOLLI_SESSION,
      });
      // An unset variable must expand to NOTHING, not to an empty argument the
      // harness would then have to interpret.
      const ok =
        run.code === 0 &&
        JSON.stringify(run.args) === JSON.stringify(["--session-id", base.VOLLI_SESSION, "hello"]);
      return { ok, detail: `code=${run.code} args=${JSON.stringify(run.args)}` };
    });

    // === 5. an explicit real-binary override ================================
    await attempt(5, "runs the binary VOLLI_HARNESS_BIN_* names outright", async () => {
      const override = join(altBin, "claude-override");
      const run = await runWrapper(wrapperPath, ["hello"], {
        ...base,
        VOLLI_HARNESS_BIN_CLAUDE_CODE: override,
      });
      const ok = run.code === 0 && run.argv0 === override;
      return { ok, detail: `argv0=${run.argv0}` };
    });

    // === 6. nothing to exec =================================================
    await attempt(6, "fails loudly rather than silently passing through", async () => {
      const run = await runWrapper(wrapperPath, ["hello"], {
        PATH: "/nonexistent",
        VOLLI_SESSION: base.VOLLI_SESSION,
      });
      const ok = run.code === 127 && run.stderr.includes("volli: cannot find");
      return { ok, detail: `code=${run.code} stderr=${JSON.stringify(run.stderr.trim())}` };
    });

    // === 7-8. the reporting half, end to end ==============================
    const shimPath = shimPathFor(realUserData);
    const socketPath = socketPathFor(realUserData);
    const hookEnv = { VOLLI_SESSION: created.sessionId, VOLLI_SOCKET: socketPath };

    await attempt(7, "a fired hook records the harness's own session id", async () => {
      const run = await runHookVerb(
        shimPath,
        ["claude-code", "session.started", "--socket", socketPath],
        hookEnv,
        JSON.stringify({ session_id: "smoke-harness-uuid", hook_event_name: "SessionStart" }),
      );
      const recorded = await waitUntil(
        "the session record to carry the harness session id",
        async () => {
          const result = await page.evaluate(
            (projectId) => window.api.sessions.list({ projectId }),
            "hw-project",
          );
          const row = result?.sessions?.find((s) => s.id === created.sessionId);
          return row?.harnessSessionId ?? null;
        },
      ).catch(() => null);
      const ok = run.code === 0 && run.stdout === "" && recorded === "smoke-harness-uuid";
      return {
        ok,
        detail: `code=${run.code} recorded=${recorded} stdout=${JSON.stringify(run.stdout)}`,
      };
    });

    await attempt(8, "costs a harness running outside Volli nothing", async () => {
      const run = await runHookVerb(
        shimPath,
        ["claude-code", "input.needed", "--socket", socketPath],
        { VOLLI_SESSION: "", VOLLI_SOCKET: socketPath },
        JSON.stringify({ session_id: "must-not-be-recorded" }),
      );
      const ok = run.code === 0 && run.stdout === "" && run.stderr === "";
      return { ok, detail: `code=${run.code} stderr=${JSON.stringify(run.stderr)}` };
    });

    await page.evaluate((id) => window.api.terminal.kill(id), created.sessionId).catch(() => {});
    deadAppProbe = { shimPath, socketPath, sessionId: created.sessionId };
  } finally {
    await app.close();
  }

  // === 9. a dead Volli must never wedge a live agent ======================
  await attempt(9, "exits 0 in silence when Volli is gone", async () => {
    const run = await runHookVerb(
      deadAppProbe.shimPath,
      ["claude-code", "turn.completed", "--socket", deadAppProbe.socketPath],
      { VOLLI_SESSION: deadAppProbe.sessionId, VOLLI_SOCKET: deadAppProbe.socketPath },
      JSON.stringify({ session_id: "nobody-is-listening" }),
    );
    const ok = run.code === 0 && run.stdout === "" && run.stderr === "";
    return { ok, detail: `code=${run.code} stderr=${JSON.stringify(run.stderr)}` };
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
