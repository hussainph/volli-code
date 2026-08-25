/**
 * E2e probe: the verdict channel and the cheap poll, through the real CLI
 * (VC-85 slices A and B).
 *
 * Everything under test here has unit coverage already. What only this probe
 * can say is that the whole path works when it is assembled: the BUILT `volli`
 * bundle parses the verb, the app's socket accepts it, migration 028 ran on a
 * database that had never seen `ticket_signals`, the row and its event land,
 * and reading the ticket back prints the verdict — from a shell, the way an
 * orchestrator will actually use it.
 *
 *   1. `ticket signal` records a verdict, exit 0, and echoes what it wrote.
 *   2. A second signal of the same kind supersedes the first in the read.
 *   3. `ticket show --comments-only` prints the signal and no event log.
 *   4. `ticket show --events 0 --comments 0` is the cheapest poll: signals only.
 *   5. A signal never moves the board — the ticket is where it was.
 *   6. No VOLLI_SESSION is CONTEXT_REQUIRED, exit 1, with a next step.
 *   7. An invented kind is refused by the CLI itself, exit 2, naming the
 *      whole vocabulary.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/vc85-signal-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";

import {
  createTicketViaBridge,
  makeShortScratch,
  runVolliShim,
  shimPathFor,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  pathExists,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("sig");
const { attempt, must, summarize } = createRunner();

const PREFIX = "SG";

/** The one JSON object a `--json` reply is, or null when it is not one. */
function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function main() {
  const app = await launch({ dbPath, userDataDir, extraEnv: {} });
  // The app canonicalizes its userData path (/tmp → /private/tmp on macOS), so
  // the artifacts are addressed through the realpath'd profile.
  const realUserData = await fs.realpath(userDataDir);
  const shimPath = shimPathFor(realUserData);
  const socketPath = socketPathFor(realUserData);
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const projectPath = await makeGitRepo(scratch, "sig-");
    await seedProjects(page, [
      { id: "sig-project", name: "Signal Project", path: projectPath, prefix: PREFIX },
    ]);
    const { projectId, ticketId, displayId } = await createTicketViaBridge(page, "Signal Project", {
      title: "Verdict ticket",
      status: "todo",
    });

    await waitUntil(
      "shim + socket to exist",
      async () => (await pathExists(shimPath)) && (await pathExists(socketPath)),
    );

    // A real ticket-linked PTY, purely for its Session identity: `ticket signal`
    // refuses an unattributed caller, so the probe has to BE somebody. This is
    // the same identity a live agent's shell carries as VOLLI_SESSION.
    const created = await page.evaluate(
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
    if (!created?.ok) throw new Error(`terminal.create failed: ${created?.error}`);
    const session = { VOLLI_SESSION: created.sessionId };

    // === 1. a verdict is recorded, and the receipt echoes it ================
    await must(1, "ticket signal records a verdict and echoes what it wrote", async () => {
      const { code, stdout, stderr } = await runVolliShim(
        shimPath,
        [
          "ticket",
          "signal",
          displayId,
          "--kind",
          "review",
          "--verdict",
          "fail",
          "--detail",
          "Missing tests",
        ],
        session,
      );
      const ok = code === 0 && stdout.trim() === `${displayId}  review  fail`;
      return {
        ok,
        detail: `code=${code} stdout=${JSON.stringify(stdout.trim())} ${stderr.trim()}`,
      };
    });

    // === 2. a later signal of the same kind supersedes the earlier one ======
    await attempt(2, "the newest signal per kind is what the ticket reads back", async () => {
      const signalled = await runVolliShim(
        shimPath,
        ["ticket", "signal", displayId, "--kind", "review", "--verdict", "pass"],
        session,
      );
      const shown = await runVolliShim(shimPath, ["ticket", "show", displayId, "--json"], session);
      const data = parseJson(shown.stdout);
      const signals = data?.signals ?? [];
      const ok =
        signalled.code === 0 &&
        signals.length === 1 &&
        signals[0].kind === "review" &&
        signals[0].verdict === "pass" &&
        signals[0].detail === null &&
        typeof signals[0].session === "string";
      return { ok, detail: `signals=${JSON.stringify(signals)}` };
    });

    // === 3. --comments-only drops the event log and keeps the verdict =======
    await attempt(3, "ticket show --comments-only prints the signal and no events", async () => {
      const { code, stdout } = await runVolliShim(
        shimPath,
        ["ticket", "show", displayId, "--comments-only", "--json"],
        session,
      );
      const data = parseJson(stdout);
      const ok =
        code === 0 &&
        Array.isArray(data?.events) &&
        data.events.length === 0 &&
        (data?.signals ?? []).length === 1;
      return {
        ok,
        detail: `code=${code} events=${data?.events?.length} signals=${data?.signals?.length}`,
      };
    });

    // === 4. the cheapest poll: both counts zero, verdict still there ========
    await attempt(
      4,
      "--events 0 --comments 0 is accepted and answers with signals only",
      async () => {
        const { code, stdout } = await runVolliShim(
          shimPath,
          ["ticket", "show", displayId, "--events", "0", "--comments", "0"],
          session,
        );
        const lines = stdout.trim().split("\n");
        const ok =
          code === 0 &&
          lines.some((line) => line.startsWith("signal  ")) &&
          !lines.some((line) => line.startsWith("event  ")) &&
          !lines.some((line) => line.startsWith("comment  "));
        return { ok, detail: `code=${code} lines=${JSON.stringify(lines)}` };
      },
    );

    // === 5. signals are orthogonal to the board =============================
    await attempt(5, "two verdicts later, the ticket has not moved", async () => {
      const { code, stdout } = await runVolliShim(shimPath, ["board", "--json"], session);
      const data = parseJson(stdout);
      const todo = (data?.columns?.todo ?? []).map((ticket) => ticket.id);
      const elsewhere = ["backlog", "doing", "needs_review", "done"].flatMap((column) =>
        (data?.columns?.[column] ?? []).map((ticket) => ticket.id),
      );
      const ok = code === 0 && todo.includes(displayId) && !elsewhere.includes(displayId);
      return { ok, detail: `todo=${JSON.stringify(todo)} elsewhere=${JSON.stringify(elsewhere)}` };
    });

    // === 6. an unattributed caller is refused, with a next step =============
    await attempt(6, "no VOLLI_SESSION is CONTEXT_REQUIRED with a recovery, exit 1", async () => {
      const { code, stderr } = await runVolliShim(shimPath, [
        "ticket",
        "signal",
        displayId,
        "--kind",
        "merge",
        "--verdict",
        "pass",
      ]);
      const ok =
        code === 1 &&
        stderr.includes("error[CONTEXT_REQUIRED]") &&
        stderr.includes("Next:") &&
        stderr.includes("ticket comment");
      return { ok, detail: `code=${code} stderr=${JSON.stringify(stderr.trim())}` };
    });

    // === 7. an invented kind never reaches the socket =======================
    await attempt(7, "an unknown kind is refused as usage, naming the vocabulary", async () => {
      const { code, stderr } = await runVolliShim(
        shimPath,
        ["ticket", "signal", displayId, "--kind", "vibes", "--verdict", "pass"],
        session,
      );
      const ok =
        code === 2 &&
        stderr.includes("Unknown signal kind") &&
        stderr.includes("validate, implement, review, merge, human-gate, budget");
      return { ok, detail: `code=${code} stderr=${JSON.stringify(stderr.trim())}` };
    });
  } finally {
    await app.close().catch(() => {});
    await cleanup();
  }
}

await main();
process.exit(summarize());
