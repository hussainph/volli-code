import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSessionEngine } from "@volli/session-engine";
import type { RunnerIdentity, SessionEventProvenance, SessionObservation } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import {
  closeStaleAttachments,
  type BootRecoveredTurns,
  type BootRecoveryEngine,
} from "./boot-recovery";
import { createBootRecoveryEngine } from "./boot-recovery-reader";

let ctx: TestDb;
afterEach(() => ctx.cleanup());

const LOCAL: RunnerIdentity = { id: "local", kind: "local" };
const provenance = {
  source: { kind: "system" as const, id: "test", detail: null },
  venue: LOCAL,
};
/** Interactions are the structured adapter's to raise. */
const fromPi = { source: { kind: "adapter" as const, id: "pi", detail: null }, venue: LOCAL };

/**
 * Real Session facts, written through the Session Engine onto the SQLite
 * ledger: the same rows, sequences and kind index a running host writes, so
 * the reader is judged against the fold itself.
 */
function world() {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const other = testProject();
  insertProject(ctx.db, other);
  let id = 0;
  let clock = 10_000;
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(ctx.db),
    clock: { now: () => clock++ },
    ids: { next: (kind) => `${kind}-${++id}` },
  });

  async function session(name: string, projectId = project.id) {
    const { session: created } = await engine.createSession({
      commandId: `create-${name}`,
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: name,
      provenance,
    });
    const sessionId = created.id;
    let fact = 0;
    /** `at` overrides the fact's clock: a source's clock can run backwards. */
    const observe = (
      fields: Record<string, unknown>,
      at = clock++,
      by: SessionEventProvenance = provenance,
    ) =>
      engine.observe({
        id: `${name}-${++fact}`,
        sessionId,
        occurredAt: at,
        provenance: by,
        ...fields,
      } as SessionObservation);
    return {
      sessionId,
      attach: (attachmentId: string, adapterId = "pi", venue: RunnerIdentity = LOCAL) =>
        observe({
          kind: "attachment.opened",
          attachment: {
            id: attachmentId,
            sessionId,
            adapterId,
            venue,
            continuity: "fresh",
            native: null,
            authority: null,
          },
        }),
      failAttach: (attachmentId: string) =>
        observe({
          kind: "attachment.failed",
          attachment: {
            id: attachmentId,
            sessionId,
            adapterId: "pi",
            venue: LOCAL,
            continuity: "fresh",
            native: null,
            authority: null,
          },
          failure: { code: "start_failed", detail: null, diagnostic: null },
        }),
      close: (attachmentId: string) =>
        observe({ kind: "attachment.closed", attachmentId, outcome: "completed" }),
      startTurn: (attachmentId: string, turnId = "turn") =>
        observe({ kind: "turn.started", attachmentId, turnId }),
      completeTurn: (attachmentId: string, turnId = "turn", at?: number) =>
        observe({ kind: "turn.completed", attachmentId, turnId }, at),
      ask: (attachmentId: string, interactionId: string) =>
        observe(
          {
            kind: "interaction.opened",
            attachmentId,
            interaction: {
              id: interactionId,
              attachmentId,
              kind: "permission",
              title: "Allow write?",
              detail: null,
              options: [{ id: "once", label: "Allow once", description: null }],
              multiple: false,
              native: { id: `native-${interactionId}`, detail: null },
            },
          },
          undefined,
          fromPi,
        ),
      cancelAsk: (attachmentId: string, interactionId: string) =>
        observe(
          { kind: "interaction.cancelled", attachmentId, interactionId, reason: "abandoned" },
          undefined,
          fromPi,
        ),
      /** Volli bookkeeping only: a command, its retitle fact and its receipt. */
      retitle: (title: string) =>
        engine.submit({
          commandId: `${name}-retitle-${++fact}`,
          sessionId,
          intent: { kind: "session.retitle", title },
          provenance,
        }),
      /** A fact appended at `at`, then rewritten beneath the codec into `payload`. */
      async rewritten(payload: Record<string, unknown>, at = clock++) {
        await observe(
          { kind: "adapter.observed", attachmentId: null, name: "probe", native: null },
          at,
        );
        ctx.db
          .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
          .run(JSON.stringify(payload), `${name}-${fact}`);
      },
    };
  }

  /**
   * A fresh engine over the same ledger: what a relaunch folds. A log
   * rewritten beneath the codec (`rewritten`) is out of band, and an engine
   * that already folded it keeps what it folded until a new one is built.
   */
  const cold = () =>
    createSessionEngine({
      ledger: createSqliteSessionLedger(ctx.db),
      clock: { now: () => clock++ },
      ids: { next: (kind) => `${kind}-${++id}` },
    });

  return { project, other, engine, session, cold };
}

type World = ReturnType<typeof world>;

/** What the old sweep read: every Session in scope, folded, through the engine's listing. */
function fullFold(w: World, owns: (sessionId: string) => boolean): BootRecoveryEngine {
  const listed = async (projectId: string) =>
    (await w.engine.listSessions({ projectId, scope: "all" })).filter(({ session }) =>
      owns(session.id),
    );
  return {
    listRecoveryCandidates: ({ projectId }) => listed(projectId),
    async latestActivityAt({ projectIds, excluding }) {
      let latest: number | null = null;
      for (const projectId of projectIds) {
        for (const projection of await listed(projectId)) {
          if (excluding.has(projection.session.id)) continue;
          latest = Math.max(latest ?? projection.lastActivityAt, projection.lastActivityAt);
        }
      }
      return latest;
    },
    getSession: (query) => w.engine.getSession(query),
    observe: (observation) => w.engine.observe(observation),
  };
}

/** One sweep with every write recorded rather than made, so two sweeps read one ledger. */
async function dryRun(engine: BootRecoveryEngine, projectIds: readonly string[]) {
  const observed: SessionObservation[] = [];
  const reconciled: { sessionId: string; attachmentId: string }[] = [];
  const recovered: BootRecoveredTurns[] = [];
  const errors: unknown[] = [];
  let id = 0;
  const closed = await closeStaleAttachments({
    engine: {
      ...engine,
      observe: async (observation) => {
        observed.push(observation);
      },
    },
    reconcile: async (input) => {
      reconciled.push(input);
    },
    projectIds,
    newId: () => `recovery-${++id}`,
    now: () => 99_999,
    onError: (_attachmentId, error) => errors.push(error),
    onRecovered: (turns) => recovered.push(turns),
  });
  const touched = new Set([
    ...observed.map(({ sessionId }) => sessionId),
    ...reconciled.map(({ sessionId }) => sessionId),
  ]);
  return { closed, observed, reconciled, recovered, errors, touched };
}

describe("createBootRecoveryEngine (VC-1095)", () => {
  it("keeps every Session the full fold's sweep acts on, and the sweep over it does exactly the same", async () => {
    const w = world();
    const ids: Record<string, string> = {};
    const add = async (
      name: string,
      build: (s: Awaited<ReturnType<World["session"]>>) => Promise<unknown>,
    ) => {
      const s = await w.session(name);
      ids[name] = s.sessionId;
      await build(s);
    };

    // History: the bulk of a long-lived profile. The sweep leaves all of it alone.
    await add("never-attached", async () => {});
    await add("idle-chat", async (s) => {
      // An open structured binding between turns: resumed lazily, not swept.
      await s.attach("idle-pi");
      await s.startTurn("idle-pi");
      await s.completeTurn("idle-pi");
    });
    await add("finished-chat", async (s) => {
      await s.attach("finished-pi");
      await s.startTurn("finished-pi");
      await s.completeTurn("finished-pi");
      await s.close("finished-pi");
    });
    await add("closed-terminal", async (s) => {
      await s.attach("closed-term", "terminal");
      await s.close("closed-term");
    });
    await add("ended-by-a-failed-start", async (s) => {
      // `attachment.failed` ends the turn the open binding was running.
      await s.attach("ended-pi");
      await s.startTurn("ended-pi");
      await s.failAttach("ended-retry");
    });
    await add("answered", async (s) => {
      await s.attach("answered-pi");
      await s.ask("answered-pi", "answered-question");
      await s.cancelAsk("answered-pi", "answered-question");
    });

    await add("every-question-answered", async (s) => {
      await s.attach("both-pi");
      await s.ask("both-pi", "both-first");
      await s.ask("both-pi", "both-second");
      await s.cancelAsk("both-pi", "both-second");
      await s.cancelAsk("both-pi", "both-first");
    });

    // Candidates: each a state the sweep acts on.
    await add("one-of-two-questions-waiting", async (s) => {
      await s.attach("two-pi");
      await s.ask("two-pi", "two-first");
      await s.ask("two-pi", "two-second");
      await s.cancelAsk("two-pi", "two-second");
    });
    await add("asked-again", async (s) => {
      // A reopening replaces the Interaction its id named.
      await s.attach("again-pi");
      await s.ask("again-pi", "again-question");
      await s.cancelAsk("again-pi", "again-question");
      await s.ask("again-pi", "again-question");
    });
    await add("open-terminal", (s) => s.attach("open-term", "terminal"));
    await add("retired-runtime", (s) => s.attach("retired", "opencode"));
    await add("mid-turn", async (s) => {
      await s.attach("mid-pi");
      await s.startTurn("mid-pi");
    });
    await add("mid-second-turn", async (s) => {
      await s.attach("second-pi");
      await s.startTurn("second-pi", "one");
      await s.completeTurn("second-pi", "one");
      await s.startTurn("second-pi", "two");
    });
    await add("stranded-question", async (s) => {
      // A question outlives the attachment that asked it, and is still retired.
      await s.attach("stranded-pi");
      await s.ask("stranded-pi", "stranded-question");
      await s.close("stranded-pi");
    });
    // Wider than the fold, never narrower: kept here, then left alone by it.
    await add("another-runners-terminal", (s) =>
      s.attach("remote-term", "terminal", { id: "elsewhere", kind: "remote" }),
    );

    const reader = createBootRecoveryEngine({ db: ctx.db, engine: w.engine });
    const candidates = (await reader.listRecoveryCandidates({ projectId: w.project.id })).map(
      ({ session }) => session.id,
    );
    expect(new Set(candidates)).toEqual(
      new Set(
        [
          "open-terminal",
          "retired-runtime",
          "mid-turn",
          "mid-second-turn",
          "stranded-question",
          "another-runners-terminal",
          "one-of-two-questions-waiting",
          "asked-again",
        ].map((name) => ids[name]),
      ),
    );
    // In listing order, as the full sweep walked them.
    const listing = (await w.engine.listSessions({ projectId: w.project.id, scope: "all" })).map(
      ({ session }) => session.id,
    );
    expect(candidates).toEqual(listing.filter((id) => candidates.includes(id)));

    const projects = [w.project.id, w.other.id];
    const full = await dryRun(
      fullFold(w, () => true),
      projects,
    );
    const narrowed = await dryRun(reader, projects);
    // The pin: everything the full fold's sweep touched is a candidate.
    for (const sessionId of full.touched) expect(candidates).toContain(sessionId);
    expect(full.touched.size).toBeGreaterThan(0);
    expect(narrowed).toEqual(full);
    expect(narrowed.recovered).toEqual([
      {
        turns: [
          { sessionId: ids["mid-second-turn"], attachmentId: "second-pi" },
          { sessionId: ids["mid-turn"], attachmentId: "mid-pi" },
        ].toSorted((a, b) => listing.indexOf(a.sessionId) - listing.indexOf(b.sessionId)),
        lostAt: expect.any(Number),
      },
    ]);
  });

  it("names the moment the prior process was last alive exactly as the fold does", async () => {
    const w = world();
    const shapes: Record<string, (s: Awaited<ReturnType<World["session"]>>) => Promise<unknown>> = {
      "created-only": async () => {},
      // Bookkeeping after the last turn does not move it.
      "retitled-last": async (s) => {
        await s.attach("retitled-pi");
        await s.startTurn("retitled-pi");
        await s.completeTurn("retitled-pi");
        await s.retitle("renamed later");
      },
      // The LAST counted fact by sequence, not the newest clock.
      "clock-ran-backwards": async (s) => {
        await s.attach("backwards-pi");
        await s.startTurn("backwards-pi");
        await s.completeTurn("backwards-pi", "turn", 5);
      },
      // A kind this build does not know is dropped by the fold's read.
      "unknown-kind-last": async (s) => {
        await s.attach("unknown-pi");
        await s.rewritten({ kind: "a.kind.from.a.later.build", value: 1 }, 50_000_000);
      },
      // A retired kind decodes as inert evidence the fold still counts.
      "retired-kind-last": async (s) => {
        await s.retitle("before the retired fact");
        await s.rewritten({ kind: "authority.denied", attachmentId: null }, 40_000_000);
      },
      "retired-command-last": async (s) => {
        await s.rewritten(
          { kind: "command.recorded", command: { intent: { kind: "approval.revoke" } } },
          30_000_000,
        );
      },
      "ordinary-chat": async (s) => {
        await s.attach("ordinary-pi");
        await s.startTurn("ordinary-pi");
        await s.completeTurn("ordinary-pi");
      },
    };
    const ids: string[] = [];
    for (const [name, build] of Object.entries(shapes)) {
      const s = await w.session(name);
      ids.push(s.sessionId);
      await build(s);
    }
    // A checkpoint folded part of one log, which then grew.
    await w.engine.getSession({ sessionId: ids.at(-1)! });
    const grown = await w.session("checkpointed");
    ids.push(grown.sessionId);
    await grown.attach("grown-pi");
    await w.engine.getSession({ sessionId: grown.sessionId });
    await grown.retitle("after the checkpoint");

    const reader = createBootRecoveryEngine({ db: ctx.db, engine: w.engine });
    const folded = await w.cold().listSessions({ projectId: w.project.id, scope: "all" });
    // Session by Session: each answer alone is that Session's own fold.
    for (const projection of folded) {
      const others = new Set(ids.filter((id) => id !== projection.session.id));
      expect(
        await reader.latestActivityAt({ projectIds: [w.project.id], excluding: others }),
        projection.session.title ?? projection.session.id,
      ).toBe(projection.lastActivityAt);
    }
    expect(
      await reader.latestActivityAt({ projectIds: [w.project.id], excluding: new Set() }),
    ).toBe(Math.max(...folded.map(({ lastActivityAt }) => lastActivityAt)));
    // The retired fact is the newest thing the fold counts.
    expect(
      await reader.latestActivityAt({ projectIds: [w.project.id], excluding: new Set() }),
    ).toBe(40_000_000);
    expect(
      await reader.latestActivityAt({ projectIds: [w.other.id], excluding: new Set() }),
    ).toBeNull();
  });

  it("records the sweep's facts and rereads a failed reconcile through the engine", async () => {
    const w = world();
    const terminal = await w.session("terminal");
    await terminal.attach("open-term", "terminal");
    const chat = await w.session("chat");
    await chat.attach("chat-pi");
    await chat.startTurn("chat-pi");
    const reader = createBootRecoveryEngine({ db: ctx.db, engine: w.engine });
    const failures: string[] = [];
    let id = 0;
    const closed = await closeStaleAttachments({
      engine: reader,
      // Rebuilt, then failed: the sweep rereads the ledger before closing.
      reconcile: async () => {
        throw new Error("reconcile failed");
      },
      holdsBinding: () => true,
      projectIds: [w.project.id],
      newId: () => `recovery-${++id}`,
      now: () => 99_999,
      onError: () => {},
      onFailure: ({ reason, outcome }) => failures.push(`${reason}:${outcome}`),
    });
    expect(closed).toBe(2);
    expect(failures).toEqual(["reconcile_failed:closed"]);
    for (const sessionId of [terminal.sessionId, chat.sessionId]) {
      const projection = await w.engine.getSession({ sessionId });
      expect(projection!.attachments.map(({ status }) => status)).toEqual(["closed"]);
    }
    // Nothing is left for the next launch to sweep.
    expect(await reader.listRecoveryCandidates({ projectId: w.project.id })).toEqual([]);
  });

  it("fails loudly on a malformed fact of a known kind, as the fold does", async () => {
    const w = world();
    const broken = await w.session("broken");
    await broken.rewritten({ kind: "turn.started" });
    const reader = createBootRecoveryEngine({ db: ctx.db, engine: w.engine });
    await expect(
      reader.latestActivityAt({ projectIds: [w.project.id], excluding: new Set() }),
    ).rejects.toThrow(/turnId|attachmentId/);
    await expect(w.cold().listSessions({ projectId: w.project.id, scope: "all" })).rejects.toThrow(
      /turnId|attachmentId/,
    );

    // Not a candidate, so the sweep still runs: what it did stands, and the
    // moment the prior process was last alive is unknown rather than wrong.
    const lost = await w.session("lost");
    await lost.attach("lost-pi");
    await lost.startTurn("lost-pi");
    const terminal = await w.session("terminal");
    await terminal.attach("lost-term", "terminal");
    const swept = await dryRun(reader, [w.project.id]);
    expect(swept.closed).toBe(1);
    expect(swept.reconciled).toEqual([{ sessionId: lost.sessionId, attachmentId: "lost-pi" }]);
    expect(swept.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/turnId|attachmentId/) }),
    ]);
    expect(swept.recovered).toEqual([
      { turns: [{ sessionId: lost.sessionId, attachmentId: "lost-pi" }], lostAt: null },
    ]);
  });

  it("neither sweeps nor counts a Session outside the launch's scope", async () => {
    const w = world();
    const mine = await w.session("mine");
    await mine.attach("mine-term", "terminal");
    const theirs = await w.session("theirs");
    await theirs.attach("theirs-term", "terminal");
    await theirs.rewritten({ kind: "authority.denied", attachmentId: null }, 70_000_000);
    const owns = (sessionId: string) => sessionId !== theirs.sessionId;
    const reader = createBootRecoveryEngine({ db: ctx.db, engine: w.engine, owns });

    expect(
      (await reader.listRecoveryCandidates({ projectId: w.project.id })).map(
        ({ session }) => session.id,
      ),
    ).toEqual([mine.sessionId]);
    const mineFold = await w.engine.getSession({ sessionId: mine.sessionId });
    expect(
      await reader.latestActivityAt({ projectIds: [w.project.id], excluding: new Set() }),
    ).toBe(mineFold!.lastActivityAt);
    const projects = [w.project.id];
    expect(await dryRun(reader, projects)).toEqual(await dryRun(fullFold(w, owns), projects));
    // The scoped engine has the last word: a Session it will not fold is not swept.
    const hidden = createBootRecoveryEngine({
      db: ctx.db,
      engine: {
        getSession: async (query) =>
          query.sessionId === mine.sessionId ? null : w.engine.getSession(query),
        observe: (observation) => w.engine.observe(observation),
      },
      owns,
    });
    expect(await hidden.listRecoveryCandidates({ projectId: w.project.id })).toEqual([]);
  });
});
