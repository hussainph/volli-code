/**
 * E2e smoke for backward-move interrupt + resume-on-re-entry.
 *
 * Two behaviors, both wired at the CLI/socket "agent-commands" choke point
 * (`apps/desktop/src/main/agent-commands.ts`'s `ticket.move` handler, shared
 * with the renderer's own drag-drop IPC path via
 * `ticket-commands.ts#interruptOnBackwardMove`):
 *
 *   • Interrupt: a move that LEAVES the active columns (doing/needs_review →
 *     backlog/todo/done) writes a single Esc byte (`"\x1b"`) to every live
 *     AGENT session of the ticket (`PtyManager.interruptTicketSessions`) and
 *     records no terminal evidence in planner history. The PTY is never killed
 *     — the harness process must survive the Esc. A move that stays within the
 *     active columns (doing ⇄ needs_review) must not send Esc.
 *   • Resume: re-entering a ticket after an agent session ENDED can relaunch
 *     the harness via `ticket.resume: { sessionId }` on a terminal-create
 *     request. Main resolves `buildHarnessResumeCommand` off the ended
 *     session's own `harnessId`/`harnessSessionId` row, and there are three
 *     ways that row's seed comes to exist — all three are checked here:
 *       – a harness `session.link`ed its own id onto the Volli session (socket
 *         cmd `session.link`, requires `VOLLI_SESSION`) → check 3;
 *       – NOTHING seeded it, so the harness resumes by "latest in cwd" → check
 *         4. Only reachable for a harness that is not handed an id at launch:
 *         `sessionId: { kind: "reported" | "none" }` (opencode, codex), since
 *         an `argv`-tier one always has a minted seed;
 *       – the harness's own wrapper minted one for THAT LAUNCH (`volli session
 *         harness <slug> --mint`, `sessionId: { kind: "argv" }`) → check 5,
 *         which asserts the resume comes back with that exact id.
 *     Resume opens a new attachment on the same durable Volli Session; it does
 *     not mint a second Session or write terminal lifecycle into ticket events.
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
 * process, exactly as `pty.onExit` (which closes the terminal attachment and
 * pushes `volli:terminal-exit`) would for a real harness exiting or a user
 * closing the pane.
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
  typeIntoMonaco,
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

/** The composer body is Monaco Document Mode: click into it, then type. */
async function fillTitleAndBody(page, title, body) {
  await titleInput(page).fill(title);
  await typeIntoMonaco(composer(page), body);
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

async function waitForSessionEnded(page, ticketId, sessionId) {
  return waitUntil(
    "the durable Session records its ended attachment before resume",
    async () => {
      const rows = await sessionsForTicket(page, ticketId);
      return rows.find((row) => row.id === sessionId && row.endedAt !== null) ?? null;
    },
    { timeout: 10000 },
  ).catch(() => null);
}

/**
 * Boot one ticket through the real composer kickoff flow, forcing it into
 * Doing with a live fake agent session. Returns the ticket's identity plus the
 * live session's id (resolved via the durable record, not scraped from the UI).
 *
 * `opts.agentLabel` picks a harness from the composer's "Choose agent" menu
 * (composer-kickoff-smoke.mjs's same path) and `opts.command` names the fake
 * binary that choice must reach. The picker's choice is STICKY (`lastHarnessId`),
 * so every scenario that cares which harness it booted names one rather than
 * inheriting whatever the previous scenario left selected.
 */
async function kickoffTicket(page, projectId, title, body, opts = {}) {
  const command = opts.command ?? "claude";
  await resetProbe();
  const opened = await openComposerViaHeader(page);
  if (!opened || (await kickoffButton(page).count()) === 0) {
    throw new Error("composer / kickoff button missing");
  }
  if (opts.agentLabel !== undefined) {
    await composer(page).getByRole("button", { name: "Choose agent" }).click();
    await sleep(200);
    await page.getByRole("menuitem", { name: opts.agentLabel, exact: true }).click();
    await sleep(200);
    const label = (await kickoffButton(page).getAttribute("aria-label")) ?? "";
    if (!label.includes(opts.agentLabel)) {
      throw new Error(`agent picker did not settle on ${opts.agentLabel} (label=${label})`);
    }
  }
  await fillTitleAndBody(page, title, body);
  await kickoffButton(page).click();

  await waitUntil("detail view opens", () => detailOpen(page), { timeout: 8000 });
  await waitUntil(
    `harness probe records ${command} + title`,
    async () => {
      const text = await fs.readFile(harness.probe, "utf8").catch(() => null);
      return text !== null && text.includes(`${harness.binDir}/${command}`) && text.includes(title)
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

/**
 * A real resume has two durable transitions: its old attachment must first be
 * ended, then the same Session must become live again. Keep that ordering in
 * one helper so every resume scenario proves the same lifecycle rather than
 * racing an exited pane against the previous row's asynchronous close.
 */
async function resumeEndedSession(page, ticketId, displayId, sessionId) {
  const ended = await waitForSessionEnded(page, ticketId, sessionId);
  if (ended === null) return { ended, surface: null, resumedSameSession: null, error: null };
  try {
    const surface = await triggerResume(page, displayId);
    const resumedSameSession = await waitUntil(
      "the same durable Session gains a live resumed attachment",
      async () => {
        const rows = await sessionsForTicket(page, ticketId);
        return rows.find((row) => row.id === sessionId && row.endedAt === null) ?? null;
      },
      { timeout: 15000 },
    ).catch(() => null);
    return { ended, surface, resumedSameSession, error: null };
  } catch (error) {
    return {
      ended,
      surface: null,
      resumedSameSession: null,
      error: error?.message ?? String(error),
    };
  }
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
      "Interrupt (doing→todo, leaves active columns): the fake harness receives Esc, stays alive, and planner history remains Session-free",
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

        // The interrupt announces itself: a toast naming the ticket lands in
        // the window that did NOT initiate the move (it came over the socket).
        const toastVisible = await waitUntil(
          "interrupt toast announces the de-escalation",
          () => page.getByText(`${displayId}: interrupted an agent session`).first().isVisible(),
          { timeout: 8000 },
        )
          .then(() => true)
          .catch(() => false);

        const plannerHistoryClean = interruptedEvent === undefined;
        const ok = beforeBusy && receivedEsc && stillAlive && plannerHistoryClean && toastVisible;
        return {
          ok,
          detail:
            `beforeBusy=${beforeBusy} receivedEsc=${receivedEsc} stillAlive=${stillAlive} ` +
            `process=${JSON.stringify(after.ok ? after.process : after.error)} plannerHistoryClean=${plannerHistoryClean} ` +
            `toast=${toastVisible}`,
        };
      },
    );

    // === 2. No interrupt: doing -> needs_review stays in the active columns ===
    await attempt(
      2,
      "No interrupt (doing→needs_review, stays active): no Esc arrives and planner history remains Session-free",
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

        // Settle the committed move while the agent stays live, then give a
        // buggy asynchronous interrupt a real window before asserting absence.
        const settledLive = await waitUntil(
          "non-interrupt move settles with the agent still live",
          async () => {
            const rows = await sessionsForTicket(page, ticketId);
            return rows.find((row) => row.id === session.id && row.endedAt === null) ?? null;
          },
          { timeout: 8000 },
        ).catch(() => null);
        await sleep(1500);
        const buf = await readStdinLog(harness.interactiveDir, session.id);
        const noEsc = buf !== null && !buf.includes(0x1b);

        const after = await busy(page, session.id);
        const stillAlive = after.ok && after.busy === true;

        const events = await eventsFor(page, ticketId);
        const interruptedEvent = events.find((e) => e.payload.kind === "sessions_interrupted");

        // No toast either — scoped to THIS ticket's display id, since
        // scenario 1's own toast (8s lifetime) may still be on screen.
        const noToast = (await page.getByText(`${displayId}: interrupted`).count()) === 0;

        const ok =
          settledLive !== null && noEsc && stillAlive && interruptedEvent === undefined && noToast;
        return {
          ok,
          detail: `settledLive=${settledLive !== null} noEsc=${noEsc} stillAlive=${stillAlive} interruptedEventPresent=${interruptedEvent !== undefined} noToast=${noToast}`,
        };
      },
    );

    // === 3. Resume with a linked harness session id: claude --resume '<id>' ==
    await attempt(
      3,
      "Resume with a linked id: `volli session link` seeds harnessSessionId; a REAL resume UI surface relaunches `claude --resume '<uuid>'` on the same durable Session",
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
        const transition = killOk
          ? await resumeEndedSession(page, ticketId, displayId, session.id)
          : { ended: null, surface: null, resumedSameSession: null, error: null };
        if (transition.error !== null) {
          return {
            ok: false,
            detail: `linkOk=${linkOk} killOk=${killOk} resume trigger failed: ${transition.error}`,
          };
        }
        await sleep(250);
        const plannerHistoryClean = !(await eventsFor(page, ticketId)).some(
          (event) => event.payload.kind === "session_resumed",
        );

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

        const ok =
          linkOk &&
          killOk &&
          transition.ended !== null &&
          transition.resumedSameSession !== null &&
          plannerHistoryClean &&
          probeText;
        return {
          ok,
          detail:
            `linkOk=${linkOk} killOk=${killOk} ended=${transition.ended !== null} surface=${transition.surface} sameSession=${transition.resumedSameSession !== null} plannerHistoryClean=${plannerHistoryClean} ` +
            `resumeProbe=${probeText}`,
        };
      },
    );

    // === 4. Resume without any id: opencode --continue (the fallback tier) ===
    //
    // NOT claude-code any more. A harness whose adapter takes its session id on
    // argv (`sessionId.kind === "argv"`) is handed a freshly minted one by its
    // own wrapper on every launch, so it ALWAYS has a resume seed and can never
    // reach this branch — the check's old premise, not its expectation, is what
    // went stale. OpenCode is `sessionId: { kind: "reported" }`: nothing is
    // minted for it, and with the fake harness firing no events it reports
    // nothing either, so its seed is genuinely `null` and `resume.latest`
    // (`--continue`) is what a resume must build. This is the fallback tier
    // where the fallback actually lives.
    await attempt(
      4,
      "Resume without any id (OpenCode — a `reported` harness gets no minted id, and the fake reports none): resume falls back to `opencode --continue` on the same durable Session",
      async () => {
        await goToBoard(page);
        const { ticketId, displayId, session } = await kickoffTicket(
          page,
          projectId,
          "Resume unlinked ticket",
          "Resume unlinked body marker DELTA",
          { agentLabel: "OpenCode", command: "opencode" },
        );
        liveSessionIds.push(session.id);

        // The premise, asserted rather than assumed: no id was minted for this
        // launch. Without it a passing `--continue` could just mean the resume
        // seed failed to be written for a reason this check isn't about.
        const sessionRows = await sessionsForTicket(page, ticketId);
        const seed = sessionRows.find((s) => s.id === session.id)?.harnessSessionId ?? null;
        const noSeed = seed === null;

        const kill = await killSession(page, session.id);
        const killOk = kill.ok === true;
        const transition = killOk
          ? await resumeEndedSession(page, ticketId, displayId, session.id)
          : { ended: null, surface: null, resumedSameSession: null, error: null };
        if (transition.error !== null) {
          return {
            ok: false,
            detail: `killOk=${killOk} resume trigger failed: ${transition.error}`,
          };
        }
        await sleep(250);
        const plannerHistoryClean = !(await eventsFor(page, ticketId)).some(
          (event) => event.payload.kind === "session_resumed",
        );

        const probeText = await waitUntil(
          "resume probe records opencode --continue (and never a by-id resume)",
          async () => {
            const text = await fs.readFile(harness.probe, "utf8").catch(() => null);
            return text !== null &&
              text.includes(`${harness.binDir}/opencode`) &&
              text.includes("--continue")
              ? text
              : null;
          },
          { timeout: 10000 },
        )
          .then((text) => !text.includes("--session"))
          .catch(() => false);

        const ok =
          noSeed &&
          killOk &&
          transition.ended !== null &&
          transition.resumedSameSession !== null &&
          plannerHistoryClean &&
          probeText;
        return {
          ok,
          detail:
            `noSeed=${noSeed}${noSeed ? "" : `(seed=${seed})`} killOk=${killOk} ended=${transition.ended !== null} surface=${transition.surface} ` +
            `sameSession=${transition.resumedSameSession !== null} plannerHistoryClean=${plannerHistoryClean} resumeProbe=${probeText}`,
        };
      },
    );

    // === 5. Resume with the id MINTED for the launch: claude --resume '<it>' ==
    //
    // The other half of what check 4 stopped covering. An `argv`-tier harness
    // gets a fresh UUIDv4 from its own wrapper's synchronous `volli session
    // harness --mint` call on every launch, written to `harness_session_id`,
    // and a resume must come back with THAT id — not merely some uuid, and
    // emphatically not `VOLLI_SESSION` (reusing the PTY's own id per launch is
    // the collision this path replaced). Check 3 proves the `volli session
    // link` seed; this proves the minted one, which nothing else here reaches.
    await attempt(
      5,
      "Resume with the MINTED id (Claude Code — the wrapper mints a fresh uuid per launch): the ended session carries a minted `harnessSessionId` that is neither the Volli session id nor the linked-seed uuid, and resume relaunches `claude --resume '<that same id>'`",
      async () => {
        await goToBoard(page);
        const { ticketId, displayId, session } = await kickoffTicket(
          page,
          projectId,
          "Resume minted ticket",
          "Resume minted body marker EPSILON",
          // Named, not inherited: check 4 left OpenCode selected.
          { agentLabel: "Claude Code", command: "claude" },
        );
        liveSessionIds.push(session.id);

        // The wrapper's mint call is synchronous ahead of its own exec, but the
        // probe write and the socket round-trip race each other, so wait for
        // the record rather than reading it once.
        const minted = await waitUntil(
          "the launch's minted harness session id lands on the session record",
          async () => {
            const rows = await sessionsForTicket(page, ticketId);
            return rows.find((s) => s.id === session.id)?.harnessSessionId ?? null;
          },
          { timeout: 10000 },
        ).catch(() => null);
        const freshUuid =
          typeof minted === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(minted) &&
          minted !== session.id &&
          minted !== LINKED_UUID;

        const kill = await killSession(page, session.id);
        const killOk = kill.ok === true;
        const transition = killOk
          ? await resumeEndedSession(page, ticketId, displayId, session.id)
          : { ended: null, surface: null, resumedSameSession: null, error: null };
        if (transition.error !== null) {
          return {
            ok: false,
            detail: `minted=${minted} killOk=${killOk} resume trigger failed: ${transition.error}`,
          };
        }
        await sleep(250);
        const plannerHistoryClean = !(await eventsFor(page, ticketId)).some(
          (event) => event.payload.kind === "session_resumed",
        );

        const probeOk = await waitUntil(
          "resume probe records claude --resume <the minted uuid>",
          async () => {
            const text = await fs.readFile(harness.probe, "utf8").catch(() => null);
            return text !== null && text.includes("--resume") && freshUuid && text.includes(minted)
              ? text
              : null;
          },
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);

        const ok =
          freshUuid &&
          killOk &&
          transition.ended !== null &&
          transition.resumedSameSession !== null &&
          plannerHistoryClean &&
          probeOk;
        return {
          ok,
          detail:
            `minted=${minted} freshUuid=${freshUuid} killOk=${killOk} ended=${transition.ended !== null} surface=${transition.surface} ` +
            `sameSession=${transition.resumedSameSession !== null} plannerHistoryClean=${plannerHistoryClean} resumeProbe=${probeOk}`,
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
