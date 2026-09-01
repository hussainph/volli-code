/**
 * E2e proof of the Agent Tool Surface's tracer bullet (VC-162): a Project
 * Session delegating work by CALLING `session_start`, against the BUILT app and
 * a real model turn.
 *
 * Everything else about VC-162 is provable without a live provider, and is
 * proved that way — the resolver's ordering and refusals, the registry's tool
 * projection, the adapter binding caller identity, the door scoping resolution
 * to the caller's project, the engine deduplicating a replayed operation id.
 * What no unit test can reach is the join: a model that was OFFERED the tool
 * choosing to call it, the runtime translating the wire name back to a
 * registry key, main answering in its own process, and a second durable Session
 * existing at the end of it. That chain is what this smoke exists for, and it
 * is the one thing `pi-project-chat-smoke.mjs` deliberately does not touch.
 *
 * Three properties, in the order they can fail:
 *
 *   1. **The tool is in the room, and only for the Role that earns it.** The
 *      caller is a PROJECT Session, so `roleVerbBundle("project")` puts
 *      `session.start` in its frozen `tool-surface` record — check 3 reads that
 *      record back off the durable ledger rather than trusting the array. A
 *      Ticket Session's record would not contain it, which is the availability-
 *      as-enforcement property VC-92 asked for and `agent-tool-surface.test.ts`
 *      pins in the small.
 *   2. **The call crosses the boundary and lands a durable Session.** Check 5.
 *      The model is offered `session_start` (underscored — no provider accepts
 *      a dot in a tool name) and main is handed `session.start`, so a second
 *      Session existing on the target ticket is the whole translation proved
 *      end to end.
 *   3. **Caller identity is BOUND, never claimed.** Check 6, and the reason
 *      this door exists at all. The `session_started` planner event has to name
 *      the calling Session as its actor — a fact the model never supplied and
 *      has no schema field for. On the socket the same verb derives its actor
 *      from `VOLLI_SESSION`, which any process running as the user can set;
 *      here it comes off the attachment. If this check ever reads `user`, the
 *      tool door has started attributing instead of binding.
 *
 * Check 7 asserts the shape a replay would disturb — one `session_started`, one
 * kickoff — but note what it does NOT do: it cannot FORCE a provider to retry a
 * tool call, so it is a consistency assertion, not a replay test. The replay
 * guarantee itself is unit-tested where it can be driven deterministically
 * (`agent-tool-door.test.ts` replays one `toolCallId`; `events-repo.test.ts`
 * covers the planner fact's guard).
 *
 * One real turn against a real provider, billed to a subscription — keep the
 * prompt short and never loop turns speculatively. The prompt is unusually
 * directive because a tool call is the ONLY outcome that exercises anything: a
 * model that politely asks whether it should delegate has told us nothing, so
 * the wording removes the choice rather than testing the model's judgment.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/pi-session-start-tool-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real
 * `~/.pi/agent/auth.json`); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  createRunner,
  ensurePiAuthInto,
  evidenceDir,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  openNewChatTab,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  HOME_TAB_STRIP,
  sleep,
  stopButton,
  tabStrip,
  waitForSettledReply,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "pi-session-start-project", name: "Pi Session Start", prefix: "TS" };
const TARGET_TICKET_TITLE = "Delegated by the session_start tool";
const KICKOFF_TEXT = "Read AGENTS.md and summarize the operating rules.";

/**
 * The one prompt, written to leave a compliant model exactly one move.
 *
 * It names the tool by its WIRE spelling (`session_start`), because that is the
 * only name the model is ever shown — the dot-key `session.start` appears in
 * the durable record and nowhere the model can read. Naming the ticket by its
 * display id is deliberate too: the tool's schema takes `ticket` and no project
 * field, so resolution has to happen against the caller's bound project.
 */
const PROMPT_TEXT =
  `Call your session_start tool now, exactly once, with ticket "TS-1" and ` +
  `message "${KICKOFF_TEXT}". Do not ask for confirmation and do not explain ` +
  `first. After the tool returns, reply with one short sentence.`;

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("pi-session-start-smoke-");
const fakeHome = join(scratch, "home");
const { attempt, summarize } = createRunner();

const EVIDENCE_DIR = await evidenceDir("pi-session-start");

async function captureFailureEvidence(page, mainOut, mainErr, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({ path: join(EVIDENCE_DIR, `pi-session-start-${slug}.png`), fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    join(EVIDENCE_DIR, `pi-session-start-${slug}.log`),
    [
      `=== ${label} ===`,
      "",
      "--- main process stdout ---",
      mainOut.join(""),
      "",
      "--- main process stderr ---",
      mainErr.join(""),
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-session-start-${slug}.png`)}`);
}

async function goToHome(page) {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await waitUntil(
    "Home's tab strip to mount",
    async () => (await tabStrip(page, HOME_TAB_STRIP).getByRole("tab").count()) >= 1,
    { timeout: 20000 },
  );
}

async function submitPrompt(page, text) {
  const textarea = page.getByPlaceholder("Ask, plan, or implement…").first();
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press("Enter");
  return Date.now();
}

/** Creates the delegation target through the preload bridge. Returns its UUID + display id. */
async function seedTicket(page, projectId, prefix) {
  const result = await page.evaluate((input) => window.api.tickets.create(input), {
    projectId,
    status: "todo",
    title: TARGET_TICKET_TITLE,
    priority: "medium",
  });
  if (!result.ok) throw new Error(`ticket seed failed: ${result.error}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000);
  await goToBoard(page);
  return { ticketId: result.ticket.id, displayId: `${prefix}-${result.ticket.ticketNumber}` };
}

/** Every durable chat Session in the project, newest first. */
async function chatSessions(page, projectId) {
  const recs = await page.evaluate(
    (pid) => window.api.sessions.list({ projectId: pid }),
    projectId,
  );
  if (!recs.ok) throw new Error(`session list failed: ${JSON.stringify(recs)}`);
  return recs.sessions.filter((row) => row.kind === "chat").map((row) => row.record);
}

/** One Session's durable frames, straight off the ledger. */
async function sessionFrames(page, sessionId) {
  const response = await page.evaluate(
    (id) =>
      window.api.sessionRpc.request({ procedure: "session.snapshot", input: { sessionId: id } }),
    sessionId,
  );
  if (!response.ok) throw new Error(`snapshot failed: ${JSON.stringify(response).slice(0, 200)}`);
  return response.data.frames ?? [];
}

/** The `session_started` planner events on one ticket, with their actor attribution. */
async function sessionStartedEvents(page, ticketId) {
  const result = await page.evaluate((id) => window.api.tickets.events({ ticketId: id }), ticketId);
  if (!result.ok) throw new Error(`ticket events failed: ${JSON.stringify(result).slice(0, 200)}`);
  return result.events.filter((event) => event.payload.kind === "session_started");
}

async function main() {
  await ensurePiAuthInto(fakeHome);
  await fs.mkdir(fakeHome, { recursive: true });

  const app = await launch({ dbPath, userDataDir, extraEnv: { HOME: fakeHome } });
  const mainStdout = [];
  const mainStderr = [];
  const proc = app.process();
  proc.stdout?.on("data", (chunk) => mainStdout.push(chunk.toString()));
  proc.stderr?.on("data", (chunk) => mainStderr.push(chunk.toString()));

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "pi-session-start-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    let defaultModel = null;
    let target = null;
    let callerSessionId = null;

    await attempt(
      1,
      "seed the app default model and the ticket the Project Session will delegate",
      async () => {
        defaultModel = await seedDefaultModel(page);
        target = await seedTicket(page, projectId, PROJECT.prefix);
        return {
          ok: defaultModel !== null && target.displayId === "TS-1",
          // TS-1 is not incidental: the prompt names it literally, so a
          // numbering change has to surface here rather than as a model that
          // "chose not to call the tool".
          detail: `model=${defaultModel?.label} ticket=${target.displayId}`,
        };
      },
    );

    await attempt(2, "Home's Chat control creates the calling Project Session", async () => {
      await goToHome(page);
      const label = await openNewChatTab(page, HOME_TAB_STRIP);
      const caller = await waitUntil(
        "the ticketless Session to land durably",
        async () => {
          const chats = await chatSessions(page, projectId);
          return chats.find((record) => record.ticketId === null) ?? false;
        },
        { timeout: 20000 },
      );
      callerSessionId = caller.sessionId;
      return { ok: callerSessionId !== null, detail: `tab=${label} session=${callerSessionId}` };
    });

    await attempt(
      3,
      "its frozen tool-surface record carries session.start — the Role put it in the room",
      async () => {
        // Read off the durable ledger, not off the live tool array: the record
        // is what a reattach months from now rebinds, and it is the thing a
        // Ticket Session would NOT have. Spelled with the dot, because the
        // underscore exists only on the provider wire.
        const frames = await sessionFrames(page, callerSessionId);
        const recorded = frames
          .map((frame) => frame.event?.payload)
          .filter((payload) => payload?.kind === "session.input.recorded")
          .map((payload) => payload.input)
          .find((input) => input?.kind === "tool-surface");
        const tools = recorded?.tools ?? [];
        return {
          ok: tools.includes("session.start") && !tools.includes("session_start"),
          detail: `tools=${JSON.stringify(tools)}`,
        };
      },
    );

    let submittedAt = null;
    await attempt(4, "the one real prompt starts a turn", async () => {
      submittedAt = await submitPrompt(page, PROMPT_TEXT);
      await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
        timeout: 15000,
      }).catch(async (error) => {
        await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-started");
        throw error;
      });
      return { ok: true };
    });

    let started = null;
    await attempt(
      5,
      "the model's session_start call lands a real Ticket Session on TS-1",
      async () => {
        const settled = await waitForSettledReply(page, { since: submittedAt }).catch(
          async (error) => {
            await captureFailureEvidence(page, mainStdout, mainStderr, "turn-never-settled");
            throw error;
          },
        );
        // The tool returns as soon as the new Session opens, and the turn
        // settles after that — but the durable write and the model's closing
        // sentence are not ordered against each other, so this waits for the
        // Session rather than assuming the reply implies it.
        started = await waitUntil(
          "a second Session to exist on the delegated ticket",
          async () => {
            const chats = await chatSessions(page, projectId);
            return chats.find((record) => record.ticketId === target.ticketId) ?? false;
          },
          { timeout: 30000 },
        ).catch(async (error) => {
          await captureFailureEvidence(page, mainStdout, mainStderr, "no-session-started");
          throw error;
        });
        return {
          ok: started.sessionId !== callerSessionId,
          detail:
            `turn=${(settled.elapsedMs / 1000).toFixed(1)}s started=${started.sessionId} ` +
            `title=${JSON.stringify(started.title)} reply=${JSON.stringify(settled.texts[0]?.slice(0, 60) ?? "")}`,
        };
      },
    );

    await attempt(
      6,
      "the planner fact names the CALLING Session as actor — bound by the runtime, never claimed",
      async () => {
        // The property the whole door exists for. Nothing in `session_start`'s
        // schema names a Session, a project or an actor, so this attribution
        // can only have come from the attachment the call arrived through.
        const events = await sessionStartedEvents(page, target.ticketId);
        const mine = events.find((event) => event.payload.sessionId === started.sessionId);
        const boundToCaller = mine?.actorContext?.sessionId === callerSessionId;
        if (!boundToCaller) {
          await captureFailureEvidence(page, mainStdout, mainStderr, "actor-not-bound");
        }
        return {
          ok: mine?.actor === "session" && boundToCaller,
          detail: `actor=${mine?.actor} context=${JSON.stringify(mine?.actorContext ?? null)} caller=${callerSessionId}`,
        };
      },
    );

    await attempt(
      7,
      "one planner fact and one kickoff turn — the shape a duplicated start would break",
      async () => {
        // A consistency assertion, not a replay test: nothing here can make a
        // provider retry the tool call. What it does catch is a start that
        // recorded its fact or submitted its kickoff twice on ONE call.
        const events = await sessionStartedEvents(page, target.ticketId);
        const frames = await sessionFrames(page, started.sessionId);
        const kickoffs = frames.filter(
          (frame) =>
            frame.transcript?.message?.role === "user" &&
            (frame.transcript.message.parts ?? []).some(
              (part) => part.type === "text" && part.text.includes(KICKOFF_TEXT),
            ),
        );
        return {
          ok: events.length === 1 && kickoffs.length === 1,
          detail: `session_started=${events.length} kickoff=${kickoffs.length}`,
        };
      },
    );

    console.log(`\nEvidence dir: ${EVIDENCE_DIR}`);
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
