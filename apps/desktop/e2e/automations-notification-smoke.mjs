/**
 * Notify when an unattended Run needs a person (VC-112's Notification rule,
 * VC-133), driven through the REAL packed app and its REAL main process.
 *
 * The rule has one loud half and one silent half, and the silent half is the
 * larger one — "never on start, never on finish, never for an attended Run".
 * An absence is what a unit test is worst at proving, so this probe watches the
 * real `Notification` channel across a whole session of ordinary use and
 * requires that nothing has spoken.
 *
 * What it proves, in dependency order:
 *
 *   1. The channel is real and observable: main's own `Notification` is
 *      patched in the MAIN process, so everything below is measured where the
 *      app actually posts rather than at a stub.
 *   2. Ordinary use is silent. Importing a project, opening the Automations
 *      page, authoring an Automation and pressing Run — the whole by-hand path,
 *      including a Run that refuses — posts nothing at all.
 *   3. The attendance column is in the REAL shipped schema, after the REAL
 *      migration, and admits exactly its two words plus the honest NULL that a
 *      Run older than VC-133 carries.
 *   4. **An unattended Run whose Session enters `error` notifies, once.** Driven
 *      through the real chain end to end: a real durable Session write, folded
 *      by the real activity watch in the real main process, read by the real
 *      observer, posted through the real `Notification`.
 *   5. **The same Session, with the same state, notifies NOTHING when its Run
 *      is attended.** Same fixture, one column flipped — which is what makes
 *      this a test of the rule rather than of the plumbing.
 *   6. `waiting` speaks too, and says something different from `error`: the
 *      person's errand is not the same one, so the notification is not either.
 *   7. VC-75's preference governs it. With `needs-you` switched off in the
 *      shared preferences record, the same transition posts nothing — proving
 *      the rule reads through that seam rather than through a setting of its
 *      own.
 *
 * ── WHY THE FIXTURE IS SEEDED, AND WHAT IS STILL REAL ─────────────────────
 * A Run cannot reach a Session on this profile. `mint` resolves a model BEFORE
 * it writes anything durable, so with no default model the Run door refuses at
 * `MODEL_REQUIRED` and leaves no Session behind — check 2 below asserts exactly
 * that, and `automations-smoke`, `automations-arming-smoke` and
 * `automations-provenance-smoke` all record the same wall for the same reason.
 * A default model would mean provider credentials and spent tokens on a lane
 * that has neither.
 *
 * So the Session and its Run row are seeded directly, ONCE, while the app is
 * CLOSED — the same move `automations-schedule-smoke` makes with the
 * scheduler's cursor, and for the same reason: it stands in for the one
 * condition the probe cannot otherwise obtain. Everything downstream of the
 * fixture is the real app: the rename below is a real product IPC that submits
 * a real durable command through the real watched engine, and the notification
 * (or the silence) is whatever the shipped main process actually does with it.
 *
 * The seeded Attention is `configuration_invalid`, which is not an arbitrary
 * pick: it is the exact Attention `session-runtime/pi-adapter.ts` raises when a
 * Session's model cannot be resolved, so check 4 is VC-112's "a Run whose
 * pinned model has become unavailable lands in `error`" as the app itself
 * produces it.
 *
 * No fixed sleeps: every wait is `waitUntil` on a signal the app produced.
 *
 * MANUALLY RUN (needs a display + the built app):
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-notification-smoke.mjs
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-notification-");
const { must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/** The `app_state` key `main/notification-preferences.ts` reads. */
const PREFERENCES_KEY = "volli:notification-preferences";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** Reads/writes the closed app's database directly — only ever between launches. */
function withDb(work) {
  const db = new DatabaseSync(dbPath);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

/**
 * Patches main's own `Notification` so every post is recorded instead of shown.
 *
 * In the MAIN process, on the PROTOTYPE: `index.ts` captured the class at
 * import time, so replacing the binding would be invisible to it, while
 * replacing `show` is seen by every instance it constructs. This is also what
 * keeps the lane from firing real OS notifications.
 */
async function watchNotifications(app) {
  await app.evaluate(({ Notification }) => {
    globalThis.volliNotificationProbe = [];
    // An arrow would lose `this`, which is the instance being shown.
    // eslint-disable-next-line func-names
    Notification.prototype.show = function () {
      globalThis.volliNotificationProbe.push({ title: this.title, body: this.body });
    };
  });
}

const shownNotifications = (app) => app.evaluate(() => globalThis.volliNotificationProbe ?? []);

/**
 * Arms a renderer-side listener for the activity watch's own push.
 *
 * This is the settle signal every check below waits on, and it has to be this
 * one rather than a re-read of the Session list. The watch coalesces durable
 * writes on a short trailing timer and then, in ONE fold, hands the projection
 * to the notification rule and publishes the re-derived row. A `list` re-read
 * answers from the fetch path and is satisfied long before that fold happens —
 * which is how a first version of this probe read "no notification" from a
 * chain that was about to post one.
 *
 * So: the push is the app's own evidence that the fold ran, and the decision
 * was made inside it. Waiting on it is what makes "nothing was posted" a real
 * assertion instead of a race.
 */
async function armActivityPush(page) {
  await page.evaluate(() => {
    globalThis.volliActivityPushProbe = [];
    window.api.sessions.onActivity((notice) => globalThis.volliActivityPushProbe.push(notice));
  });
}

/**
 * A real durable Session write, through a real product IPC, and the fold it
 * causes.
 *
 * `volli:session-rename` submits `session.retitle` through the SAME watched
 * engine every other durable write goes through, so it marks the Session dirty
 * and the activity watch folds it — which is precisely the moment the rule is
 * evaluated. Nothing about a rename is special; it is simply the shortest real
 * durable write reachable on a profile with no model.
 */
async function foldSession(page, title) {
  const renamed = await page.evaluate(
    ({ sessionId, next }) => window.api.sessions.rename({ sessionId, title: next }),
    { sessionId: SESSION_ID, next: title },
  );
  if (!renamed.ok) throw new Error(`rename failed: ${renamed.error}`);
  await waitUntil(
    `the activity watch folded and published "${title}"`,
    async () =>
      page.evaluate(
        (next) =>
          (globalThis.volliActivityPushProbe ?? []).some(
            (notice) => notice.row?.record?.title === next,
          ),
        title,
      ),
    { timeout: 20000 },
  );
}

/** Folds the Session through a real write, then reports what main posted. */
async function notificationsAfter(app, page, title) {
  await foldSession(page, title);
  return shownNotifications(app);
}

let app = null;
let exitCode = 1;
try {
  const repoDir = await makeGitRepo(scratch);

  app = await launch({ dbPath, userDataDir });
  let page = await app.firstWindow();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)));
  assertBuiltRendererLoaded(page);
  await assertProfileIsolated(app, userDataDir);
  await page.waitForSelector("[data-empty-projects-state]", { timeout: 30000 });
  await seedProjects(page, [{ id: "probe-project", name: "Probe", path: repoDir, prefix: "PRB" }]);
  const seeded = await page.evaluate(async () => {
    const ticket = await window.api.tickets.create({
      projectId: "probe-project",
      title: "Probe ticket",
      status: "todo",
    });
    return ticket.ok ? { ticketId: ticket.ticket.id } : { fail: ticket.error };
  });

  await must(0, "main's own Notification channel is observable", async () => {
    await watchNotifications(app);
    const shown = await shownNotifications(app);
    return { ok: Array.isArray(shown) && shown.length === 0, detail: `shown=${shown.length}` };
  });

  await must(
    1,
    "the whole by-hand path is silent — authoring and running post nothing",
    async () => {
      await page.getByRole("button", { name: "Automations", exact: true }).first().click();
      await page.getByRole("heading", { name: "Automations" }).waitFor({ timeout: 15000 });
      await page.getByRole("button", { name: "New Automation" }).first().click();
      const form = page.getByRole("dialog");
      await form.waitFor({ timeout: 15000 });
      await form.getByLabel("Name").fill("Nightly sweep");
      await form.getByLabel("Instructions").fill("/review the day");
      await form.getByRole("button", { name: "Create automation" }).click();
      await form.waitFor({ state: "detached", timeout: 15000 });

      // And the Run door itself. It refuses for the ordinary missing-model
      // reason on this profile — which is also the proof that a Run cannot reach
      // a Session here, and therefore why the fixture below is seeded.
      const ran = await page.evaluate(async (ticketId) => {
        const listed = await window.api.automations.list({ projectId: "probe-project" });
        const automation = listed.ok
          ? listed.automations.find((a) => a.name === "Nightly sweep")
          : undefined;
        if (automation === undefined) return { fail: "not listed" };
        const outcome = await window.api.automations.run({
          commandId: crypto.randomUUID(),
          target: { kind: "automation", automationId: automation.id },
          ticketId,
          modelOverride: null,
        });
        return { code: outcome.ok ? "started" : outcome.code };
      }, seeded.ticketId);

      const shown = await shownNotifications(app);
      return {
        ok: shown.length === 0 && ran.fail === undefined,
        detail: `run=${JSON.stringify(ran)} notifications=${JSON.stringify(shown)}`,
      };
    },
  );

  await closeAppBounded(app);
  app = null;

  await must(2, "the shipped schema carries attendance, bounded to its two words", async () =>
    withDb((db) => {
      const names = db
        .prepare("SELECT name FROM pragma_table_info('automation_runs')")
        .all()
        .map((row) => row.name);
      // A Run older than VC-133 records nothing here, and the READ is what
      // turns that into `attended`. Both must be storable.
      db.prepare(
        `INSERT INTO sessions (id, project_id, ticket_id, title, created_at)
         VALUES (?, 'probe-project', NULL, 'Nightly sweep', 1000)`,
      ).run(SESSION_ID);
      const insertRun = (id, attendance) =>
        db
          .prepare(
            `INSERT INTO automation_runs
               (id, automation_id, automation_name, ticket_id, session_id, provider_id, model_id, reasoning_level, attendance, created_at)
             VALUES (?, NULL, NULL, NULL, ?, 'anthropic', 'claude-opus', 'high', ?, 1000)`,
          )
          .run(id, SESSION_ID, attendance);
      insertRun(randomUUID(), "unattended");
      insertRun(randomUUID(), null);
      let refused = false;
      try {
        insertRun(randomUUID(), "maybe");
      } catch {
        refused = true;
      }
      // Leave exactly one Run — the unattended one — bound to the Session.
      db.prepare(
        "DELETE FROM automation_runs WHERE attendance IS NULL OR attendance = 'maybe'",
      ).run();
      const remaining = db.prepare("SELECT attendance FROM automation_runs").all();
      return {
        ok: names.includes("attendance") && refused && remaining.length === 1,
        detail: `columns=${names.length} refusedThirdWord=${refused} remaining=${JSON.stringify(remaining)}`,
      };
    }),
  );

  /**
   * Puts the seeded Session into one of the two states the rule reads, by
   * appending the same durable fact the runtime appends. `attention.raised`
   * with `configuration_invalid` is what a Session whose model cannot be
   * resolved actually carries; the interaction is what an agent's question
   * leaves behind.
   */
  function seedNeed(kind) {
    withDb((db) => {
      db.prepare("DELETE FROM session_events WHERE session_id = ?").run(SESSION_ID);
      // Both states are an ACTIVE Attention, which is what lets the fixture
      // stay attachment-free: an Interaction is bound to the attachment that
      // opened it, and this Session never attached one. The kinds are the real
      // ones — `configuration_invalid` is what `pi-adapter.ts` raises when a
      // Session's model cannot be resolved (VC-112's "a Run whose pinned model
      // has become unavailable lands in error"), and `input_required` is one of
      // the three `SESSION_USER_BLOCKING_ATTENTION_KINDS` that mean a person is
      // being asked something.
      const attention =
        kind === "error"
          ? {
              id: "attention-error",
              attachmentId: null,
              kind: "configuration_invalid",
              detail: "Pi requires a Session with a selected model and Runtime Brief.",
              diagnostic: null,
            }
          : {
              id: "attention-waiting",
              attachmentId: null,
              kind: "input_required",
              detail: "Which branch should I target?",
              diagnostic: null,
            };
      const payload = { kind: "attention.raised", attention };
      db.prepare(
        `INSERT INTO session_events
           (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
         VALUES (?, ?, 1, 2000, 2000, ?, NULL, NULL, ?)`,
      ).run(
        randomUUID(),
        SESSION_ID,
        JSON.stringify({
          source: { kind: "adapter", id: "pi", detail: null },
          venue: { id: "local", kind: "local" },
        }),
        JSON.stringify(payload),
      );
    });
  }

  function setAttendance(attendance) {
    withDb((db) => {
      db.prepare("UPDATE automation_runs SET attendance = ? WHERE session_id = ?").run(
        attendance,
        SESSION_ID,
      );
    });
  }

  function setPreferences(value) {
    withDb((db) => {
      if (value === null) {
        db.prepare("DELETE FROM app_state WHERE key = ?").run(PREFERENCES_KEY);
        return;
      }
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 2000)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(PREFERENCES_KEY, JSON.stringify(value));
    });
  }

  /**
   * Closes the app, applies one fixture change, and launches a fresh main
   * process with the notification watch re-armed.
   *
   * The close comes FIRST so every write above happens against a database
   * nobody is holding — the discipline `automations-schedule-smoke` states and
   * this probe's own header claims. It also makes each check start from an
   * empty per-Session memory in the observer, which is what lets the same
   * fixture be re-asked with one column flipped.
   */
  async function relaunchWith(mutate) {
    if (app !== null) await closeAppBounded(app);
    app = null;
    mutate();
    app = await launch({ dbPath, userDataDir });
    page = await app.firstWindow();
    page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)));
    await page.waitForSelector("[data-app-ready], [data-empty-projects-state], main", {
      timeout: 30000,
    });
    await watchNotifications(app);
    await armActivityPush(page);
  }

  await relaunchWith(() => seedNeed("error"));

  await must(3, "an unattended Run whose Session is in error notifies, exactly once", async () => {
    const shown = await notificationsAfter(app, page, "Nightly sweep · error");
    return {
      ok: shown.length === 1 && shown[0]?.title === "An Automation stopped",
      detail: JSON.stringify(shown),
    };
  });

  await relaunchWith(() => setAttendance("attended"));

  await must(
    4,
    "the same Session in the same state is silent when the Run is attended",
    async () => {
      const shown = await notificationsAfter(app, page, "Nightly sweep · attended");
      return { ok: shown.length === 0, detail: JSON.stringify(shown) };
    },
  );

  await relaunchWith(() => {
    setAttendance("unattended");
    seedNeed("waiting");
  });

  await must(5, "waiting speaks too, and says something error does not", async () => {
    const shown = await notificationsAfter(app, page, "Nightly sweep · waiting");
    return {
      ok: shown.length === 1 && shown[0]?.title === "An Automation is waiting on you",
      detail: JSON.stringify(shown),
    };
  });

  await relaunchWith(() =>
    setPreferences({
      enabled: true,
      events: { "needs-you": false, finished: true, swept: true, update: true },
    }),
  );

  await must(6, "VC-75's needs-you preference governs it — no second setting", async () => {
    const shown = await notificationsAfter(app, page, "Nightly sweep · muted");
    return { ok: shown.length === 0, detail: JSON.stringify(shown) };
  });

  exitCode = summarize() ? 0 : 1;
} catch (error) {
  console.error("\nSMOKE FAILED:", error);
  exitCode = 1;
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}

process.exit(exitCode);
