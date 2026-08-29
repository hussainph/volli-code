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
 *   • `<userData>/bin` is FIRST on the session's PATH, and `volli` resolves to
 *     this profile's own shim.
 *
 * That last one used to assert only membership, and membership is not the
 * property. macOS `path_helper` re-hoists /etc/paths in every login shell, so
 * the bin dir was a member of PATH throughout an outage in which no wrapper
 * ever ran — this check printed the disagreeing `resolved`/`want` pair and
 * passed anyway. Volli now re-asserts the prepend after the user's own shell
 * startup (see `shell-init`), so primacy is a property it can and must hold.
 *
 * ZDOTDIR points at a PATH-neutral scratch rc so the developer's own dotfiles
 * can't reorder PATH under the fake — the same shadow technique the kickoff
 * smoke uses. Note that this no longer makes check 4 pass: the session's own
 * ZDOTDIR is Volli's generated chain, which sources this scratch rc and then
 * prepends. Consent is pre-answered "defer" via the documented test seam.
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

/**
 * Whether `shellPath` is a zsh, and so whether the PATH-restoring chain applies.
 *
 * Mirrors `isZshShell` in packages/shared/src/harness/shell-init.ts, which is
 * the source of truth. Restated here rather than imported because these probes
 * are plain .mjs run straight from node and none of them pulls in a workspace
 * package. Matched on the basename, so `/bin/zsh`, `/opt/homebrew/bin/zsh` and
 * a versioned `zsh-5.9` all count while `/bin/bash` does not.
 */
function isZshShell(shellPath) {
  // `ps -o comm=` reports a LOGIN shell as "-zsh", so the leading dash goes
  // before the basename is matched.
  const base = shellPath.slice(shellPath.lastIndexOf("/") + 1).replace(/^-/, "");
  return base === "zsh" || base.startsWith("zsh-");
}

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
    extraEnv: { ZDOTDIR: zdotDir },
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
        'echo "SHELLPATH=$PATH"; ' +
        // Which shell actually runs the session. The chain that puts binDir
        // back in FRONT after macOS `path_helper` reorders it is zsh-only
        // (main/shell-init.ts), so the position guarantee below is only a
        // guarantee where this says zsh.
        //
        // Read from the PROCESS, not from $SHELL: $SHELL is the user's login
        // shell preference and is not exported into this PTY at all (it read
        // back as "" here, which silently disabled the position assertion — a
        // check that skips itself is worse than one that fails).
        'echo "SHELLBIN=$(ps -o comm= -p $$)"; ' +
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

    // === 4. the shim is executable and binDir reaches the session's PATH =====
    // Linux: the login shell's /etc/profile hard-assigns PATH, so the contract
    // is asserted where main actually made it — the exec-time environment via
    // /proc/$$/environ, which still shows the prepend.
    //
    // macOS: /etc/zprofile runs `path_helper`, which REBUILDS PATH in every
    // login shell — /etc/paths entries (including /usr/local/bin) are hoisted
    // above the spawn env's prepend. Membership survives; precedence does not.
    // So a pre-existing /usr/local/bin/volli link legitimately wins
    // `command -v`, and asserting the shim wins would fail on any machine that
    // has ever installed the global link. That is not a session-identity bug:
    // every generated shim resolves its socket as ${VOLLI_SOCKET:-<baked>}, so
    // whichever shim runs still talks to THIS app. Assert what main controls —
    // binDir is on the session PATH and this profile's shim is executable.
    await attempt(
      4,
      "generated shim is executable and binDir is FIRST on the session PATH",
      async () => {
        const shimOk = value("SHIM") === "ok";
        const binDir = join(realUserData, "bin");
        if (process.platform === "linux") {
          const spawnPath = value("SPAWNPATH");
          const ok = shimOk && spawnPath !== null && spawnPath.startsWith(`${binDir}:`);
          return {
            ok,
            detail: `shim=${shimOk} spawnPath=${JSON.stringify(spawnPath)} wantPrefix=${JSON.stringify(`${binDir}:`)}`,
          };
        }
        // Membership was the assertion here, and membership is not the
        // property: the bin dir was a member of PATH throughout the outage
        // where no wrapper ever ran, because a macOS login shell rebuilds PATH
        // and pushed it to position 20 of 30. This check PRINTED the disagreeing
        // `resolved`/`want` pair and passed anyway. Assert position, and assert
        // what `volli` actually resolves to — the two facts that were wrong.
        const shellPath = value("SHELLPATH");
        const entries = shellPath === null ? [] : shellPath.split(":");
        const index = entries.indexOf(binDir);
        const resolved = value("VOLLI");
        const shellBin = value("SHELLBIN") ?? "";

        // What must hold everywhere: the shim exists, is executable, and is
        // the `volli` this session resolves. That pair is the property the
        // outage actually violated — binDir was a MEMBER of PATH the whole
        // time while a different `volli` won `command -v`.
        //
        // Position 0 is the stronger claim, and it is only available where the
        // zsh chain runs: `path_helper` rebuilds PATH in every macOS login
        // shell, and main/shell-init.ts puts binDir back in front afterwards
        // for zsh ONLY. On a non-zsh login shell there is no such hook, so
        // binDir keeps whatever position path_helper left it in — position 26
        // of 32 on a CI runner, with the correct shim still winning. Asserting
        // it there would fail a machine whose behaviour is correct.
        const chainApplies = isZshShell(shellBin);
        const ok = shimOk && resolved === shimPath && (!chainApplies || index === 0);
        return {
          ok,
          detail:
            `shim=${shimOk} shell=${JSON.stringify(shellBin)} chainApplies=${chainApplies} ` +
            `binDirPosition=${index === -1 ? "absent" : `${index + 1} of ${entries.length}`} ` +
            `resolved=${JSON.stringify(resolved)} want=${JSON.stringify(shimPath)}`,
        };
      },
    );

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
