/**
 * E2e smoke for issue #78 — backward-move interrupt + resume-on-re-entry
 * (CONCEPT decisions #20/#21).
 *
 * Two behaviors, both wired at the CLI/socket "agent-commands" choke point
 * (`apps/desktop/src/main/agent-commands.ts`'s `ticket.move` handler, shared
 * with the renderer's own drag-drop IPC path via
 * `ticket-commands.ts#interruptOnBackwardMove`):
 *
 *   • Interrupt: a move that LEAVES the active columns (doing/needs_review →
 *     backlog/todo/done) writes a single Esc byte (`"\x1b"`) to every live
 *     AGENT session of the ticket (`PtyManager.interruptTicketSessions`) and
 *     records one `sessions_interrupted` event. The PTY is never killed — the
 *     harness process must survive the Esc. A move that stays within the
 *     active columns (doing ⇄ needs_review) must do neither.
 *   • Resume: re-entering a ticket after an agent session ENDED can relaunch
 *     the harness via `ticket.resume: { sessionId }` on a terminal-create
 *     request. Main resolves `buildHarnessResumeCommand` off the ended
 *     session's own `harnessId`/`harnessSessionId` row: `claude --resume
 *     '<id>'` when a harness has `session.link`ed its own id onto the Volli
 *     session (socket cmd `session.link`, requires `VOLLI_SESSION`), else the
 *     fallback `claude --continue`. A `session_resumed` event links the new
 *     session id back to the one it resumes.
 *
 * The terminal renders to a WebGPU canvas (no text in the DOM), so — exactly
 * like composer-kickoff-smoke.mjs — the "agent" is the FAKE harness
 * (./lib/fake-harness.mjs): a scratch `claude` that records its argv. That
 * smoke's fakes exit immediately, which proves nothing about surviving an
 * Esc. This smoke instead builds the fakes in INTERACTIVE mode
 * (`interactiveDir`): after recording argv, the fake puts its pty in raw mode
 * and blocks forever copying stdin verbatim into a per-session log file keyed
 * by the app's own `VOLLI_SESSION` env var — a live process to Esc, and a
 * byte-exact record of what it received. The smoke ends a session itself
 * (`window.api.terminal.kill`) once it's done asserting against the live
 * process, exactly as `pty.onExit` (which sets `endedAt` / fires
 * `session_ended` / pushes `volli:terminal-exit`) would for a real harness
 * exiting or a user closing the pane.
 *
 * Sessions are booted through the REAL composer "Create & start" kickoff flow
 * (same helpers as composer-kickoff-smoke.mjs), not the bare
 * `window.api.terminal.create` bridge call worktree-smoke.mjs uses — kickoff
 * both forces the ticket into Doing (the "active column" precondition every
 * scenario needs) AND registers the session in the renderer's session store,
 * which is what makes the exited-pane "Resume session" button (a REAL UI
 * surface, not a bridge call) reachable for the resume scenarios.
 *
 * Ticket moves run over the socket via the built `volli` CLI shim
 * (agent-board-live-move-smoke.mjs's pattern) — the choke point named above,
 * not the Zustand store directly.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/interrupt-resume-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";

import {
  buildFakeHarness,
  harnessEnv,
  readStdinLog,
  runShadowSanityCheck,
} from "./lib/fake-harness.mjs";
import { makeShortScratch, runVolliShim, shimPathFor, socketPathFor } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  cardById,
  createRunner,
  goToBoard,
  launch,
  makeGitRepo,
  pathExists,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("intr");
const { attempt, summarize } = createRunner();

const PROJECT = { id: "interrupt-resume-project", name: "Interrupt Resume Project", prefix: "IR" };
const harness = await buildFakeHarness(scratch, undefined, {
  interactiveDir: `${scratch}/stdin-logs`,
});
const LINKED_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---- composer / detail helpers (mirrors composer-kickoff-smoke.mjs) --------

const composer = (page) => page.locator('[data-testid="new-ticket-composer"]');
const kickoffButton = (page) => page.locator('[data-testid="composer-kickoff"]');
const titleInput = (page) => composer(page).getByPlaceholder("Ticket title");

async function openComposerViaHeader(page) {
  try {
    const trigger = page.getByRole("button", { name: "New ticket", exact: true });
    await trigger.waitFor({ state: "visible", timeout: 12000 });
    await trigger.click();
    await composer(page).waitFor({ state: "visible", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function closeAnyDialog(page) {
  if ((await page.getByRole("dialog").count()) === 0) return;
  await page.keyboard.press("Escape");
  await sleep(300);
}

async function detailOpen(page) {
  return (await page.getByRole("tab").count()) >= 1;
}

async function fillTitleAndBody(page, title, body) {
  await titleInput(page).fill(title);
  await composer(page).locator(".cm-content").click();
  await page.keyboard.type(body);
}

async function ticketsFor(page, projectId) {
  return page.evaluate(async (id) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return [];
    return boot.data.ticketsByProject?.[id] ?? [];
  }, projectId);
}

async function resetProbe() {
  await fs.rm(harness.probe, { force: true });
}

// ---- bridge helpers ----------------------------------------------------

async function sessionsForTicket(page, ticketId) {
  const res = await page.evaluate(
    (tid) => window.api.sessions.listForTicket({ ticketId: tid }),
    ticketId,
  );
  if (!res.ok) throw new Error(`sessions.listForTicket: ${res.error}`);
  return res.sessions;
}

async function eventsFor(page, ticketId) {
  const res = await page.evaluate((tid) => window.api.tickets.events({ ticketId: tid }), ticketId);
  return res.ok ? res.events : [];
}

async function busy(page, sessionId) {
  return page.evaluate((id) => window.api.terminal.busy(id), sessionId);
}

async function killSession(page, sessionId) {
  return page.evaluate((id) => window.api.terminal.kill(id), sessionId);
}

/**
 * Boot one ticket through the real composer kickoff flow, forcing it into
 * Doing with a live fake-`claude` agent session. Returns the ticket's
 * identity plus the live session's id (resolved via the durable record, not
 * scraped from the UI).
 */
async function kickoffTicket(page, projectId, title, body) {
  await resetProbe();
  const opened = await openComposerViaHeader(page);
  if (!opened || (await kickoffButton(page).count()) === 0) {
    throw new Error("composer / kickoff button missing");
  }
  await fillTitleAndBody(page, title, body);
  await kickoffButton(page).click();

  await waitUntil("detail view opens", () => detailOpen(page), { timeout: 8000 });
  await waitUntil(
    "harness probe records claude + title",
    async () => {
      const text = await fs.readFile(harness.probe, "utf8").catch(() => null);
      return text !== null && text.includes(`${harness.binDir}/claude`) && text.includes(title)
        ? text
        : null;
    },
    { timeout: 20000 },
  );

  const ticket = (await ticketsFor(page, projectId)).find((t) => t.title === title);
  if (ticket === undefined) throw new Error(`ticket "${title}" missing after kickoff`);
  const sessions = await waitUntil(
    "live agent session recorded for ticket",
    async () => {
      const rows = await sessionsForTicket(page, ticket.id);
      const live = rows.find((s) => s.launchKind === "agent" && s.endedAt === null);
      return live ? rows : null;
    },
    { timeout: 8000 },
  );
  const session = sessions.find((s) => s.launchKind === "agent" && s.endedAt === null);

  // Readiness gate: the fake has recorded argv but may still be a moment from
  // reaching its raw-mode stdin-capture loop. Its log file is created only
  // once `exec cat >> <log>` opens it, so waiting for the file to exist (even
  // empty) is proof the capture loop is live before we send anything.
  await waitUntil(
    "fake harness reaches its stdin-capture loop",
    async () => (await readStdinLog(harness.interactiveDir, session.id)) !== null,
    { timeout: 8000 },
  );

  return { ticketId: ticket.id, displayId: `${PROJECT.prefix}-${ticket.ticketNumber}`, session };
}

/** Real-UI resume trigger: the exited pane's "Resume session" button, with the
 *  ticket context menu's "Resume last session" as the documented fallback if
 *  the pane button doesn't surface (see the smoke's header comment / task
 *  instructions — one real UI surface must be exercised either way). */
async function triggerResume(page, displayId) {
  const paneButton = page.getByRole("button", { name: "Resume session" });
  const paneVisible = await waitUntil(
    "exited-pane Resume session button visible",
    () => paneButton.isVisible(),
    { timeout: 15000 },
  )
    .then(() => true)
    .catch(() => false);
  if (paneVisible) {
    await resetProbe();
    await paneButton.click();
    return "pane";
  }

  // Fallback: the board card's context menu "Resume last session" item.
  await goToBoard(page);
  const card = cardById(page, displayId);
  await card.first().click({ button: "right" });
  await sleep(300);
  const menuItem = page.getByRole("menuitem", { name: "Resume last session" });
  if ((await menuItem.count()) === 0) {
    await closeAnyDialog(page);
    throw new Error('neither the pane "Resume session" button nor the context menu item appeared');
  }
  await resetProbe();
  await menuItem.click();
  return "context-menu";
}

// ---- main --------------------------------------------------------------

async function main() {
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: harnessEnv(harness),
  });
  const shimPath = shimPathFor(userDataDir);
  const socketPath = socketPathFor(userDataDir);
  const liveSessionIds = [];

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "intr-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    await waitUntil(
      "shim + socket to exist",
      async () => (await pathExists(shimPath)) && (await pathExists(socketPath)),
    );

    // === 0. Precondition: the fake harness deterministically shadows claude ===
    await attempt(
      0,
      "Fake-harness shadow: zsh -lic resolves claude to the scratch bin",
      async () => {
        const result = await runShadowSanityCheck(harness, "claude");
        return {
          ok: result.ok,
          detail: `${result.resolved}${result.ok ? "" : `!=${result.expected}`}`,
        };
      },
    );

    // === 1. Interrupt: doing -> todo Escs the live agent, never kills it =====
    await attempt(
      1,
      "Interrupt (doing→todo, leaves active columns): the fake harness receives Esc, stays alive, and one sessions_interrupted event is recorded",
      async () => {
        const { ticketId, displayId, session } = await kickoffTicket(
          page,
          projectId,
          "Interrupt ticket",
          "Interrupt body marker ALPHA",
        );
        liveSessionIds.push(session.id);

        const before = await busy(page, session.id);
        const beforeBusy = before.ok && before.busy === true;

        const move = await runVolliShim(shimPath, ["ticket", "move", displayId, "--to", "todo"]);
        if (move.code !== 0) {
          return {
            ok: false,
            detail: `CLI move failed code=${move.code} stderr=${move.stderr.trim()}`,
          };
        }

        const escBuf = await waitUntil(
          "Esc byte (0x1b) arrives in the fake harness's stdin log",
          async () => {
            const buf = await readStdinLog(harness.interactiveDir, session.id);
            return buf !== null && buf.includes(0x1b) ? buf : null;
          },
          { timeout: 8000 },
        ).catch(() => null);
        const receivedEsc = escBuf !== null;

        const after = await busy(page, session.id);
        const stillAlive = after.ok && after.busy === true;

        const events = await eventsFor(page, ticketId);
        const interruptedEvent = events.find(
          (e) =>
            e.payload.kind === "sessions_interrupted" && e.payload.sessionIds.includes(session.id),
        );

        const ok = beforeBusy && receivedEsc && stillAlive && interruptedEvent !== undefined;
        return {
          ok,
          detail:
            `beforeBusy=${beforeBusy} receivedEsc=${receivedEsc} stillAlive=${stillAlive} ` +
            `process=${JSON.stringify(after.ok ? after.process : after.error)} interruptedEvent=${interruptedEvent !== undefined}`,
        };
      },
    );

    // === 2. No interrupt: doing -> needs_review stays in the active columns ===
    await attempt(
      2,
      "No interrupt (doing→needs_review, stays active): no Esc arrives and no sessions_interrupted event is recorded",
      async () => {
        await goToBoard(page);
        const { ticketId, displayId, session } = await kickoffTicket(
          page,
          projectId,
          "No-interrupt ticket",
          "No-interrupt body marker BETA",
        );
        liveSessionIds.push(session.id);

        const move = await runVolliShim(shimPath, [
          "ticket",
          "move",
          displayId,
          "--to",
          "needs-review",
        ]);
        if (move.code !== 0) {
          return {
            ok: false,
            detail: `CLI move failed code=${move.code} stderr=${move.stderr.trim()}`,
          };
        }

        // Give a buggy interrupt a real window to show up before asserting its
        // absence (worktree-smoke.mjs's same settle-then-assert discipline).
        await sleep(1500);
        const buf = await readStdinLog(harness.interactiveDir, session.id);
        const noEsc = buf !== null && !buf.includes(0x1b);

        const after = await busy(page, session.id);
        const stillAlive = after.ok && after.busy === true;

        const events = await eventsFor(page, ticketId);
        const interruptedEvent = events.find((e) => e.payload.kind === "sessions_interrupted");

        const ok = noEsc && stillAlive && interruptedEvent === undefined;
        return {
          ok,
          detail: `noEsc=${noEsc} stillAlive=${stillAlive} interruptedEventPresent=${interruptedEvent !== undefined}`,
        };
      },
    );

    // === 3. Resume with a linked harness session id: claude --resume '<id>' ==
    await attempt(
      3,
      "Resume with a linked id: `volli session link` seeds harnessSessionId; after the session ends, a REAL resume UI surface relaunches `claude --resume '<uuid>'` and a session_resumed event lands",
      async () => {
        await goToBoard(page);
        const { ticketId, displayId, session } = await kickoffTicket(
          page,
          projectId,
          "Resume linked ticket",
          "Resume linked body marker GAMMA",
        );
        liveSessionIds.push(session.id);

        const link = await runVolliShim(shimPath, ["session", "link", LINKED_UUID], {
          VOLLI_SESSION: session.id,
        });
        const linkOk = link.code === 0;

        const kill = await killSession(page, session.id);
        const killOk = kill.ok === true;

        let surface;
        try {
          surface = await triggerResume(page, displayId);
        } catch (error) {
          return {
            ok: false,
            detail: `linkOk=${linkOk} killOk=${killOk} resume trigger failed: ${error?.message ?? error}`,
          };
        }

        const events = await waitUntil(
          "session_resumed event recorded",
          async () => {
            const rows = await eventsFor(page, ticketId);
            const resumed = rows.find(
              (e) =>
                e.payload.kind === "session_resumed" && e.payload.previousSessionId === session.id,
            );
            return resumed ? rows : null;
          },
          { timeout: 15000 },
        ).catch(() => []);
        const resumedEvent = events.find(
          (e) => e.payload.kind === "session_resumed" && e.payload.previousSessionId === session.id,
        );
        if (resumedEvent) liveSessionIds.push(resumedEvent.payload.sessionId);

        const probeText = await waitUntil(
          "resume probe records claude --resume <uuid>",
          async () => {
            const text = await fs.readFile(harness.probe, "utf8").catch(() => null);
            return text !== null && text.includes("--resume") && text.includes(LINKED_UUID)
              ? text
              : null;
          },
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);

        const ok = linkOk && killOk && resumedEvent !== undefined && probeText;
        return {
          ok,
          detail:
            `linkOk=${linkOk} killOk=${killOk} surface=${surface} resumedEvent=${resumedEvent !== undefined} ` +
            `resumeProbe=${probeText}`,
        };
      },
    );

    // === 4. Resume without a linked id: claude --continue (fallback) ========
    await attempt(
      4,
      "Resume without a linked id: after the session ends, resume falls back to `claude --continue`, and a session_resumed event lands",
      async () => {
        await goToBoard(page);
        const { ticketId, displayId, session } = await kickoffTicket(
          page,
          projectId,
          "Resume unlinked ticket",
          "Resume unlinked body marker DELTA",
        );
        liveSessionIds.push(session.id);

        const kill = await killSession(page, session.id);
        const killOk = kill.ok === true;

        let surface;
        try {
          surface = await triggerResume(page, displayId);
        } catch (error) {
          return {
            ok: false,
            detail: `killOk=${killOk} resume trigger failed: ${error?.message ?? error}`,
          };
        }

        const events = await waitUntil(
          "session_resumed event recorded",
          async () => {
            const rows = await eventsFor(page, ticketId);
            const resumed = rows.find(
              (e) =>
                e.payload.kind === "session_resumed" && e.payload.previousSessionId === session.id,
            );
            return resumed ? rows : null;
          },
          { timeout: 15000 },
        ).catch(() => []);
        const resumedEvent = events.find(
          (e) => e.payload.kind === "session_resumed" && e.payload.previousSessionId === session.id,
        );
        if (resumedEvent) liveSessionIds.push(resumedEvent.payload.sessionId);

        const probeText = await waitUntil(
          "resume probe records claude --continue (and never --resume)",
          async () => {
            const text = await fs.readFile(harness.probe, "utf8").catch(() => null);
            return text !== null && text.includes("--continue") ? text : null;
          },
          { timeout: 10000 },
        )
          .then((text) => !text.includes("--resume"))
          .catch(() => false);

        const ok = killOk && resumedEvent !== undefined && probeText;
        return {
          ok,
          detail: `killOk=${killOk} surface=${surface} resumedEvent=${resumedEvent !== undefined} resumeProbe=${probeText}`,
        };
      },
    );

    for (const sessionId of liveSessionIds) {
      await killSession(page, sessionId).catch(() => {});
    }
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
