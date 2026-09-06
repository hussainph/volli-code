/**
 * Notify when an unattended Run needs a person (VC-112's Notification rule,
 * VC-133), driven through the REAL packed app and its REAL main process.
 *
 * The rule has one loud half and one silent half, and the silent half is the
 * larger one — "never on start, never on finish, never for an attended Run,
 * never for a state this process did not watch change". An absence is what a
 * unit test is worst at proving, so this probe watches the real `Notification`
 * channel across a whole session of ordinary use and requires that nothing has
 * spoken.
 *
 * ── THE ONE THING THAT MAKES THIS REAL ────────────────────────────────────
 * VC-112: "a pinned model that has since become unavailable does not silently
 * fall back — let the Session fail through the existing error path." That is
 * also the only way this profile can reach a failing Session at all, and it
 * turns out to be the honest one: an Automation is pinned to a model this
 * build's catalogue does not have, and from there EVERYTHING is the shipped
 * app. The real Run door mints a real Session, the real attach asks the real
 * Agent Runtime for that model, the real `configuration_invalid` Attention is
 * raised in the real durable history, the real activity watch folds it, and
 * the real `Notification` either speaks or does not.
 *
 * What it proves, in dependency order:
 *
 *   1. The channel is real and observable: main's own `Notification` is
 *      patched in the MAIN process, so everything below is measured where the
 *      app actually posts rather than at a stub.
 *   2. Ordinary use is silent. Importing a project, opening the Automations
 *      page, authoring an Automation and pressing Run — the whole by-hand
 *      path, including a Run that refuses — posts nothing at all.
 *   3. **A Run whose pinned model has become unavailable still OPENS its
 *      Session, and that Session lands in `error`.** No door-time refusal, a
 *      Run row that exists, and the app's own `configuration_invalid`
 *      Attention: VC-133's "lands in `error` and is covered by the same rule",
 *      as the app produces it rather than as a fixture claims it.
 *   3. **That Run notified nothing, because a person started it.** Same real
 *      transition as check 6 below, one column different.
 *   4. The attendance column is in the REAL shipped schema, after the REAL
 *      migration, and admits exactly its two words plus the honest NULL that a
 *      Run older than VC-133 carries.
 *   5. **A need that was already standing at launch is not announced.** The
 *      app closed with an unattended Run waiting on a person; the next launch
 *      watched no transition, so its first fold of that Session teaches the
 *      baseline and stays quiet. "Enters `waiting`" is a verb.
 *   6. **A real entry into `error` on an unattended Run notifies, once.** The
 *      Session is quiet at launch, a real attach fails under it, and the app
 *      posts exactly one notification naming the work.
 *   7. VC-75's preference governs it. With `needs-you` switched off, the very
 *      same real transition posts nothing — so the rule reads through that
 *      seam rather than through a setting of its own.
 *
 * ── WHAT IS SEEDED, AND WHY EACH ONE ──────────────────────────────────────
 * Four fixtures, each applied to a CLOSED database (the discipline
 * `automations-schedule-smoke` states), each standing in for a condition this
 * lane cannot otherwise obtain:
 *
 *  - **the retired pin** — a model that has gone away. There is no way to make
 *    a live catalogue drop a model, and no credentials here to have had one.
 *  - **the attendance flip** — an unattended Run. Both unattended doors live
 *    inside main (the schedule timer and the agent verb); the only door a
 *    renderer can knock on is attended by construction, which is check 3.
 *  - **the cleared Attention** — putting the Session back to needing nobody, so
 *    the next failure is an ENTRY rather than a state that never moved.
 *  - **the delivered flag** — the Run's first-message intent is marked
 *    delivered so launch-time recovery does not re-attach the Session before
 *    the probe has armed. It removes a race, not a behaviour.
 *
 * `waiting` is fixtured as a state (check 5) and never driven as a
 * transition: opening a real Interaction takes a real agent turn, which takes
 * credentials this lane does not have. Its notification copy is pinned in
 * `run-attention.test.ts`; what is proved HERE is the half that is about the
 * app rather than about a string — that a standing `waiting` is not announced
 * on the next launch.
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

/**
 * The pin, and the whole reason this probe can reach a failing Session.
 *
 * A provider/model pair the Agent Runtime's catalogue does not contain, which
 * is what "a pinned model that has since become unavailable" IS at the moment
 * the Run tries to use it: `runtime.getModel` answers `undefined`, the
 * attachment is refused, and `pi-adapter.ts` raises `configuration_invalid`.
 */
const RETIRED_PIN = {
  providerId: "retired-provider",
  modelId: "retired-model",
  reasoningLevel: "medium",
};

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
 * This is the settle signal the silent checks wait on, and it has to be this
 * one rather than a re-read of the Session list. The watch coalesces durable
 * writes on a short trailing timer and then, in ONE fold, hands the projection
 * to the notification rule and publishes the re-derived row. A `list` re-read
 * answers from the fetch path and is satisfied long before that fold happens —
 * which is how a first version of this probe read "no notification" from a
 * chain that was about to post one.
 */
async function armActivityPush(page) {
  await page.evaluate(() => {
    globalThis.volliActivityPushProbe = [];
    window.api.sessions.onActivity((notice) => globalThis.volliActivityPushProbe.push(notice));
  });
}

let app = null;
let page = null;
let exitCode = 1;
try {
  const repoDir = await makeGitRepo(scratch);

  app = await launch({ dbPath, userDataDir });
  page = await app.firstWindow();
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

  /** The Session the Run opened, and the durable facts about it, from main. */
  const runState = () =>
    page.evaluate(async () => {
      const listed = await window.api.automations.runsForProject({ projectId: "probe-project" });
      if (!listed.ok) return { fail: listed.error };
      const [run] = listed.runs;
      if (run === undefined) return { runs: 0 };
      const answered = await window.api.sessionRpc.request({
        procedure: "session.projection",
        input: { sessionId: run.sessionId },
      });
      // The routed answer is `{ projection, throughSequence }`, scrubbed for
      // the renderer — the same shape the chat pane reads.
      const projection = answered.ok ? answered.data?.projection : null;
      return {
        runs: listed.runs.length,
        sessionId: run.sessionId,
        model: run.model,
        attention: (projection?.attention?.active ?? []).map((entry) => entry.kind),
      };
    });

  /**
   * A real attach through the real Session RPC — the same door the chat pane's
   * Retry knocks on. On this Session it fails, because its pinned model is
   * gone, and the failure is what raises `configuration_invalid`.
   */
  const attachSession = (sessionId) =>
    page.evaluate(
      ({ id, operationId }) =>
        window.api.sessionRpc.request({
          procedure: "sessions.attach",
          input: { operationId, sessionId: id },
        }),
      { id: sessionId, operationId: crypto.randomUUID() },
    );

  /**
   * A real durable Session write, and the fold it causes.
   *
   * `volli:session-rename` submits `session.retitle` through the SAME watched
   * engine every other durable write goes through, so it marks the Session
   * dirty and the activity watch folds it — which is precisely the moment the
   * rule is evaluated. Nothing about a rename is special; it is simply the
   * shortest real durable write reachable here. The silent checks use it as a
   * barrier ("a fold has happened since"), and check 6 uses it to establish
   * the baseline a relaunch legitimately lacks.
   */
  async function foldSession(sessionId, title) {
    const renamed = await page.evaluate((input) => window.api.sessions.rename(input), {
      sessionId,
      title,
    });
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
      await page
        .getByRole("heading", { name: "Automations", exact: true })
        .waitFor({ timeout: 15000 });
      await page.getByRole("button", { name: "New Automation" }).first().click();
      const form = page.locator('[data-slot="automation-editor"]');
      await form.waitFor({ timeout: 15000 });
      await form.getByLabel("Name").fill("Nightly sweep");
      await form.getByLabel("Instructions").fill("/review the day");
      await form.getByRole("button", { name: "Create automation" }).click();
      await page
        .locator("[data-automation-rail-row]")
        .filter({ hasText: "Nightly sweep" })
        .waitFor({ timeout: 15000 });

      // And the Run door itself, on an Automation with no pin: it inherits,
      // there is no default model on this profile, and it refuses for that
      // ordinary reason before anything durable exists. The same wall
      // `automations-smoke` and `automations-provenance-smoke` record.
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
        return { id: automation.id, code: outcome.ok ? "started" : outcome.code };
      }, seeded.ticketId);

      const shown = await shownNotifications(app);
      return {
        ok: shown.length === 0 && ran.code === "MODEL_REQUIRED",
        detail: `run=${JSON.stringify(ran)} notifications=${JSON.stringify(shown)}`,
      };
    },
  );

  const automationId = await page.evaluate(async () => {
    const listed = await window.api.automations.list({ projectId: "probe-project" });
    return listed.ok
      ? (listed.automations.find((a) => a.name === "Nightly sweep")?.id ?? null)
      : null;
  });

  /**
   * Closes the app, applies one fixture, and launches a fresh main process
   * with the notification watch re-armed.
   *
   * The close comes FIRST so every write happens against a database nobody is
   * holding. It also gives each check an empty per-Session memory in the
   * observer — which is no longer merely convenient: it is the very condition
   * checks 5 and 6 are about.
   */
  async function relaunchWith(mutate) {
    if (app !== null) await closeAppBounded(app);
    app = null;
    withDb(mutate);
    app = await launch({ dbPath, userDataDir });
    page = await app.firstWindow();
    page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)));
    await page.waitForSelector("[data-app-ready], [data-empty-projects-state], main", {
      timeout: 30000,
    });
    await watchNotifications(app);
    await armActivityPush(page);
  }

  // The pin goes onto the saved record, exactly where a person's chosen
  // Runtime lives — the model was there when they picked it and is not there
  // now, which is the whole scenario.
  await relaunchWith((db) => {
    db.prepare("UPDATE automations SET runtime = ? WHERE id = ?").run(
      JSON.stringify(RETIRED_PIN),
      automationId,
    );
  });

  await must(
    2,
    "a Run whose pinned model has become unavailable opens its Session and lands in error",
    async () => {
      const started = await page.evaluate((input) => window.api.automations.runForProject(input), {
        commandId: randomUUID(),
        automationId,
        projectId: "probe-project",
      });
      if (!started.ok) {
        return { ok: false, detail: `the door refused: ${started.code} ${started.error}` };
      }
      // The Attention the app raises for itself, once its own attach has asked
      // the Agent Runtime for a model that is not there.
      const state = await waitUntil(
        "the Run's Session to record its configuration_invalid Attention",
        async () => {
          const read = await runState();
          return read.attention?.includes("configuration_invalid") ? read : false;
        },
        { timeout: 60000 },
      );
      return {
        ok: state.runs === 1 && state.model?.modelId === RETIRED_PIN.modelId,
        detail: JSON.stringify(state),
      };
    },
  );

  await must(3, "and it said nothing, because a person started it", async () => {
    // The Run came through the renderer's door, which is attended by
    // construction — so this is the same real transition check 6 announces,
    // with attendance the only difference. The fold has provably happened:
    // check 2 waited on its durable result.
    const state = await runState();
    await foldSession(state.sessionId, "Nightly sweep · attended");
    const shown = await shownNotifications(app);
    return { ok: shown.length === 0, detail: JSON.stringify(shown) };
  });

  const session = await runState();

  await must(4, "the shipped schema carries attendance, bounded to its two words", async () => {
    await closeAppBounded(app);
    app = null;
    return withDb((db) => {
      const names = db
        .prepare("SELECT name FROM pragma_table_info('automation_runs')")
        .all()
        .map((row) => row.name);
      // A Run older than VC-133 records nothing here, and the READ is what
      // turns that into `attended`. Both must be storable; a third word must
      // not be.
      const set = (value) =>
        db
          .prepare("UPDATE automation_runs SET attendance = ? WHERE session_id = ?")
          .run(value, session.sessionId);
      set(null);
      set("unattended");
      let refused = false;
      try {
        set("maybe");
      } catch {
        refused = true;
      }
      const [row] = db.prepare("SELECT attendance FROM automation_runs").all();
      return {
        ok: names.includes("attendance") && refused && row?.attendance === "unattended",
        detail: `columns=${names.length} refusedThirdWord=${refused} stored=${row?.attendance}`,
      };
    });
  });

  /** Every `attention.raised` fact this Session carries — the need, durably. */
  function clearNeed(db) {
    db.prepare(
      "DELETE FROM session_events WHERE session_id = ? AND payload LIKE '%attention.raised%'",
    ).run(session.sessionId);
  }

  /** The Run's first-message intent, marked delivered so recovery leaves it alone. */
  function settleDelivery(db) {
    db.prepare("UPDATE automation_run_deliveries SET delivered_at = 2000 WHERE session_id = ?").run(
      session.sessionId,
    );
  }

  await relaunchWith((db) => {
    settleDelivery(db);
    clearNeed(db);
    // A person is being asked something — the real Attention kind a permission
    // question leaves behind, and one of the three
    // `SESSION_USER_BLOCKING_ATTENTION_KINDS` that mean `waiting`.
    db.prepare(
      `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
       VALUES (?, ?, 900000, 2000, 2000, ?, NULL, NULL, ?)`,
    ).run(
      randomUUID(),
      session.sessionId,
      JSON.stringify({
        source: { kind: "adapter", id: "pi", detail: null },
        venue: { id: "local", kind: "local" },
      }),
      JSON.stringify({
        kind: "attention.raised",
        attention: {
          id: "attention-waiting",
          attachmentId: null,
          kind: "input_required",
          detail: "Which branch should I target?",
          diagnostic: null,
        },
      }),
    );
  });

  await must(5, "a need already standing at launch is not announced", async () => {
    // The app closed with this unattended Run waiting on a person. Nothing
    // about the next launch is a transition, so the first fold — this rename,
    // or anything else that happened to write near it — teaches the rule where
    // the Session stands and says nothing. This is the case that used to be
    // loud, and the reason the rule is written on the edge.
    const standing = await runState();
    await foldSession(session.sessionId, "Nightly sweep · standing");
    const shown = await shownNotifications(app);
    return {
      ok: shown.length === 0 && standing.attention?.includes("input_required"),
      detail: `attention=${JSON.stringify(standing.attention)} notifications=${JSON.stringify(shown)}`,
    };
  });

  await relaunchWith(clearNeed);

  await must(6, "an unattended Run that ENTERS error notifies, exactly once", async () => {
    // The Session needs nobody at launch. One real durable write establishes
    // that baseline the honest way (the rule watched it), and then a real
    // attach through the real Session RPC asks the real Agent Runtime for the
    // model that is gone. Everything from there is the app: the failure, the
    // Attention, the fold, the notification.
    await foldSession(session.sessionId, "Nightly sweep · quiet");
    const quiet = await shownNotifications(app);
    if (quiet.length !== 0)
      return { ok: false, detail: `spoke too early: ${JSON.stringify(quiet)}` };

    await attachSession(session.sessionId);
    const shown = await waitUntil(
      "main to post the needs-you notification",
      async () => {
        const posted = await shownNotifications(app);
        return posted.length > 0 ? posted : false;
      },
      { timeout: 60000 },
    );
    // And once only: the same need re-folded is not a second errand.
    await foldSession(session.sessionId, "Nightly sweep · still broken");
    const after = await shownNotifications(app);
    return {
      ok:
        after.length === 1 &&
        shown[0]?.title === "An Automation stopped" &&
        after[0]?.body.includes("Nightly sweep"),
      detail: JSON.stringify(after),
    };
  });

  await relaunchWith((db) => {
    clearNeed(db);
    db.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 2000)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(
      PREFERENCES_KEY,
      JSON.stringify({
        enabled: true,
        events: { "needs-you": false, finished: true, swept: true, update: true },
      }),
    );
  });

  await must(7, "VC-75's needs-you preference governs it — no second setting", async () => {
    // The identical real transition as check 6, with one switch flipped in the
    // record VC-75's Settings pane writes.
    await foldSession(session.sessionId, "Nightly sweep · muted baseline");
    await attachSession(session.sessionId);
    await waitUntil(
      "the Session to record its Attention again",
      async () => {
        const read = await runState();
        return read.attention?.includes("configuration_invalid") ? read : false;
      },
      { timeout: 60000 },
    );
    await foldSession(session.sessionId, "Nightly sweep · muted");
    const shown = await shownNotifications(app);
    return { ok: shown.length === 0, detail: JSON.stringify(shown) };
  });

  // `summarize()` RETURNS the exit code (0 when every check passed), not a
  // boolean — every sibling smoke assigns it directly, and treating it as a
  // truthy verdict inverts the result into a green run that exits 1.
  exitCode = summarize();
} catch (error) {
  console.error("\nSMOKE FAILED:", error);
  exitCode = 1;
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}

process.exit(exitCode);
