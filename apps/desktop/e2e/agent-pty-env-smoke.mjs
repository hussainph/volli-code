/**
 * E2e probe: PATH and environment injection inside a spawned PTY.
 *
 * Boots a real ticket-linked PTY session through the preload bridge, then runs
 * plain shell commands INSIDE that PTY and reads the output back over the app's
 * own `terminal.onData` stream (the terminal renders to a WebGPU canvas, so the
 * text isn't in the DOM — this is how the app itself sees the bytes). Asserts
 * the agent runtime contract main injects at spawn (agentSessionEnv +
 * ticketSessionEnv):
 *   • VOLLI_SOCKET  = the app's live socket path,
 *   • VOLLI_TICKET  = the ticket's display ID,
 *   • VOLLI_SESSION = the spawned session's id,
 *   • `command -v volli` resolves to `<userData>/bin/volli` — the generated
 *     shim wins on PATH even through a login shell's path_helper pass
 *     (binDir is prepended and lives in no /etc/paths file).
 *
 * ZDOTDIR points at a PATH-neutral scratch rc so the developer's own dotfiles
 * can't reorder PATH under the fake — the same shadow technique the kickoff
 * smoke uses. Consent is pre-answered "defer" via the documented test seam.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/agent-pty-env-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  createTicketViaBridge,
  makeShortScratch,
  shimPathFor,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("pty");
const { attempt, summarize } = createRunner();

/** Strip ANSI escape sequences and normalize CR so we can grep clean lines. */
function clean(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

async function main() {
  // A PATH-neutral login-shell rc so the fake shim keeps PATH priority.
  const zdotDir = join(scratch, "zdot");
  await fs.mkdir(zdotDir, { recursive: true });
  await fs.writeFile(join(zdotDir, ".zshrc"), "# e2e scratch zshrc — does NOT modify PATH\n");

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_AGENT_CONSENT_CHOICE: "defer", ZDOTDIR: zdotDir },
  });
  // The app canonicalizes its userData path (/tmp → /private/tmp on macOS), so
  // compare env values the PTY reports against the realpath'd profile.
  const realUserData = await fs.realpath(userDataDir);
  const socketPath = socketPathFor(realUserData);
  const shimPath = shimPathFor(realUserData);
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const projectPath = await makeGitRepo(scratch, "pty-");
    await seedProjects(page, [
      { id: "pty-project", name: "PTY Project", path: projectPath, prefix: "PT" },
    ]);
    const { projectId, ticketId, displayId } = await createTicketViaBridge(page, "PTY Project", {
      title: "PTY env ticket",
      status: "todo",
    });

    // Boot a real ticket-linked PTY (bare shell, no kickoff) and start buffering
    // its output in the page. Passing `ticket` makes main inject VOLLI_TICKET on
    // top of the agentSessionEnv contract (VOLLI_SESSION / VOLLI_SOCKET / PATH).
    const sessionId = await page.evaluate(
      async ({ workspaceId, cwd, tid }) =>
        window.api.terminal.create({
          workspaceId,
          cwd,
          cols: 80,
          rows: 24,
          ticket: { ticketId: tid },
        }),
      { workspaceId: projectId, cwd: projectPath, tid: ticketId },
    );
    if (!sessionId?.ok) throw new Error(`terminal.create failed: ${sessionId?.error}`);
    const sid = sessionId.sessionId;

    await page.evaluate((id) => {
      window.volliPtyBuffer = "";
      window.api.terminal.onData((event) => {
        if (event.sessionId === id) window.volliPtyBuffer += event.data;
      });
    }, sid);

    // Give the login shell a moment to finish sourcing, then run the probe line.
    // Labeled echoes: each OUTPUT line begins with LABEL=; the echoed *input*
    // line begins with "echo", so it never collides with the parsed outputs.
    await waitUntil(
      "shell to settle",
      () => page.evaluate(() => window.volliPtyBuffer.length > 0),
      {
        timeout: 8000,
      },
    ).catch(() => {});
    await page.evaluate((id) => {
      // SPAWNPATH reads the exec-time environment (/proc/$$/environ) where the
      // kernel exposes it — a Linux login shell's /etc/profile hard-assigns
      // PATH, so the *shell's* PATH can't witness the spawn-env prepend there.
      const line =
        'echo "SOCK=$VOLLI_SOCKET"; echo "TICK=$VOLLI_TICKET"; ' +
        'echo "SESS=$VOLLI_SESSION"; echo "VOLLI=$(command -v volli)"; ' +
        'echo "SHIM=$(test -x "$(dirname "$VOLLI_SOCKET")/bin/volli" && echo ok)"; ' +
        'if [ -r /proc/$$/environ ]; then echo "SPAWN$(tr "\\0" "\\n" < /proc/$$/environ | grep "^PATH=")"; fi; ' +
        "echo PTY_PROBE_DONE\n";
      return window.api.terminal.write(id, line);
    }, sid);

    const output = await waitUntil(
      "PTY probe output",
      async () => {
        const raw = await page.evaluate(() => window.volliPtyBuffer);
        const text = clean(raw);
        return text.includes("PTY_PROBE_DONE") ? text : null;
      },
      { timeout: 20000 },
    );

    const value = (label) => {
      const match = output.match(new RegExp(`^${label}=(.*)$`, "m"));
      return match ? match[1].trim() : null;
    };

    // === 1. VOLLI_SOCKET is injected and equals the app's socket ============
    await attempt(1, "VOLLI_SOCKET inside the PTY equals the app socket", async () => {
      const got = value("SOCK");
      const ok = got === socketPath;
      return { ok, detail: `got=${JSON.stringify(got)} want=${JSON.stringify(socketPath)}` };
    });

    // === 2. VOLLI_TICKET equals the ticket's display id =====================
    await attempt(2, "VOLLI_TICKET inside the PTY equals the ticket display ID", async () => {
      const got = value("TICK");
      const ok = got === displayId;
      return { ok, detail: `got=${JSON.stringify(got)} want=${JSON.stringify(displayId)}` };
    });

    // === 3. VOLLI_SESSION equals the spawned session id =====================
    await attempt(3, "VOLLI_SESSION inside the PTY equals the spawned session id", async () => {
      const got = value("SESS");
      const ok = got === sid;
      return { ok, detail: `got=${JSON.stringify(got)} want=${JSON.stringify(sid)}` };
    });

    // === 4. the shim is executable and the spawn env prepends binDir ========
    // On macOS the interactive shell keeps the prepend (path_helper merges), so
    // `command -v volli` must resolve to the shim. On Linux the login shell's
    // /etc/profile hard-assigns PATH, so the contract is asserted where main
    // actually made it: the exec-time environment via /proc/$$/environ.
    await attempt(4, "generated shim is executable and binDir leads the spawn PATH", async () => {
      const shimOk = value("SHIM") === "ok";
      if (process.platform === "linux") {
        const spawnPath = value("SPAWNPATH");
        const binDir = join(realUserData, "bin");
        const ok = shimOk && spawnPath !== null && spawnPath.startsWith(`${binDir}:`);
        return {
          ok,
          detail: `shim=${shimOk} spawnPath=${JSON.stringify(spawnPath)} wantPrefix=${JSON.stringify(`${binDir}:`)}`,
        };
      }
      const got = value("VOLLI");
      const ok = shimOk && got === shimPath;
      return {
        ok,
        detail: `shim=${shimOk} got=${JSON.stringify(got)} want=${JSON.stringify(shimPath)}`,
      };
    });

    // Kill the PTY so teardown's close gate has nothing busy to negotiate.
    await page.evaluate((id) => window.api.terminal.kill(id), sid).catch(() => {});
  } finally {
    await app.close();
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
  await cleanup();
}
process.exit(code);
