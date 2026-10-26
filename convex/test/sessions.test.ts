import { randomUUID } from "node:crypto";

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  RUNNER_TOKEN_ISSUER,
  CLOUD_SESSION_FOLD_VERSION,
  CLOUD_SESSION_STATE_MAX_BYTES,
  type UserId,
} from "@volli/shared/cloud";
import { parseRendererSessionEvent, type SessionEvent } from "@volli/shared";

import { api, internal } from "../functions/_generated/api";
import { seedTestRunner, seedTestWorld } from "../functions/lib/testWorld";
import schema from "../functions/schema";
import { enrollPreview } from "./preview-fixtures";
import { localProjection, userProvenance, wire, writeSession } from "./sessionFixtures";

/** The next fact after `history`, from the executor that history opened. */
function nextFact(
  history: readonly SessionEvent[],
  payload: SessionEvent["payload"],
  extra = 0,
): SessionEvent {
  const last = history.at(-1)!;
  return {
    id: randomUUID(),
    sessionId: last.sessionId,
    sequence: last.sequence + 1 + extra,
    occurredAt: last.occurredAt + 1 + extra,
    recordedAt: last.recordedAt + 1 + extra,
    provenance: {
      source: { kind: "adapter", id: "pi", detail: null },
      venue: { id: "local", kind: "local" },
    },
    attachmentId: null,
    payload,
  };
}

const modules = import.meta.glob("../functions/**/*.ts");
const ISSUER = "https://issuer.test";

type T = ReturnType<typeof convexTest>;

function code(value: string, extra: Record<string, unknown> = {}) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value, ...extra }) });
}

async function signIn(t: T, name: string): Promise<UserId> {
  const result = await t
    .withIdentity({ subject: `user:${name}`, issuer: ISSUER })
    .mutation(api.accounts.ensureViewer, {});
  // Every product call rechecks the grant and the accepted agreement, for a
  // person and for a runner token's owner alike.
  await enrollPreview(t, result.userId);
  return result.userId as UserId;
}

const asUser = (t: T, name: string) => t.withIdentity({ subject: `user:${name}`, issuer: ISSUER });
const asRunner = (t: T, runnerId: string) =>
  t.withIdentity({ subject: `runner:${runnerId}`, issuer: RUNNER_TOKEN_ISSUER });

/** Alice owns the world and its runners; Bob is a teammate; Carol is outside it. */
async function world(options: { shareAll?: boolean; runners?: number } = {}) {
  const t = convexTest(schema, modules);
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const carol = await signIn(t, "carol");
  const seeded = await t.run((ctx) =>
    seedTestWorld(ctx, {
      ownerUserId: alice,
      memberUserIds: [bob],
      runners: options.runners ?? 2,
      ...(options.shareAll === undefined ? {} : { shareAll: options.shareAll }),
    }),
  );
  return { t, alice, bob, carol, ...seeded, runner: seeded.runnerIds[0]! };
}

function accept(
  t: T,
  runnerId: string,
  sessionId: string,
  events: readonly SessionEvent[],
  generation = 1,
) {
  return asRunner(t, runnerId).mutation(api.sessions.accept, {
    sessionId,
    generation,
    events: events.map(wire),
  });
}

/** Accepts a history one fact per mutation, as the drain does in steady state. */
async function drain(
  t: T,
  runnerId: string,
  sessionId: string,
  events: readonly SessionEvent[],
  generation = 1,
) {
  for (const event of events) await accept(t, runnerId, sessionId, [event], generation);
}

async function snapshot(t: T, user: string, sessionId: string) {
  const result = await asUser(t, user).query(api.sessions.snapshot, { sessionId });
  return { ...result, state: result.state === null ? null : JSON.parse(result.state) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sessions.accept", () => {
  test("listing presentation is authoritative and older rows read through their fold", async () => {
    const { t, runner, projectId, ticketId } = await world();
    const { sessionId, events } = await writeSession({ projectId, ticketId });
    // Stop at the open input attention so its waiting reason is observable.
    const asking = events.findIndex((event) => event.payload.kind === "attention.raised");
    await accept(t, runner, sessionId, events.slice(0, asking + 1));
    const read = () =>
      asUser(t, "alice").query(api.sessions.list, {
        projectId,
        paginationOpts: { cursor: null, numItems: 100 },
      });
    const stored = (await read()).page[0]!.listing;
    expect(stored).toMatchObject({
      activity: "waiting",
      waitingOn: "question",
      live: true,
      bornTicketless: false,
    });
    await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", sessionId))
        .unique();
      await ctx.db.patch(session!._id, { listing: undefined });
    });
    expect((await read()).page[0]!.listing).toEqual(stored);
    expect((await snapshot(t, "alice", sessionId)).session.listing).toEqual(stored);
    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("sessionStates")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique();
      await ctx.db.delete(state!._id);
    });
    expect((await read()).page[0]!.listing).toEqual({
      activity: "idle",
      waitingOn: null,
      live: false,
      bornTicketless: false,
    });
    expect((await snapshot(t, "alice", sessionId)).session.listing).toEqual({
      activity: "idle",
      waitingOn: null,
      live: false,
      bornTicketless: false,
    });
  });
  test("a runner's first accept creates the Session for its owner, claimed by that runner", async () => {
    const { t, alice, runner, projectId, ticketId } = await world();
    const { sessionId, events } = await writeSession({ projectId, ticketId });
    await expect(accept(t, runner, sessionId, events.slice(0, 1))).resolves.toEqual({
      acceptedThrough: 1,
      duplicates: 0,
      quarantined: 0,
      unknownKinds: 0,
    });
    const rows = await t.run(async (ctx) => ({
      session: await ctx.db.query("sessions").first(),
      intake: await ctx.db.query("sessionIntake").first(),
      state: await ctx.db.query("sessionStates").first(),
    }));
    expect(rows.session).toMatchObject({
      id: sessionId,
      ownerUserId: alice,
      ticketId,
      role: "ticket",
      visibility: "shared",
      visibilityReason: "ticket",
      placeRunnerId: runner,
      origin: { kind: "user" },
      title: "Intake",
    });
    expect(rows.intake).toMatchObject({
      claim: { runnerId: runner, generation: 1 },
      acceptedThrough: 1,
      lastEventId: events[0]!.id,
      state: "active",
    });
    expect(rows.state).toMatchObject({
      throughSequence: 1,
      foldVersion: CLOUD_SESSION_FOLD_VERSION,
    });
  });

  test("folds a real history fact by fact to what the local projection says", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, turns: 2 });
    await drain(t, runner, sessionId, events);
    const local = localProjection(events);
    const { session, state, catchingUp, foldedThrough } = await snapshot(t, "alice", sessionId);
    expect(catchingUp).toBe(false);
    expect(foldedThrough).toBe(events.length);
    expect(state).toMatchObject({
      turnActive: local.turnActive,
      lastTurnOutcome: local.lastTurnOutcome,
      latestTurnId: local.latestTurnId,
      latestTurnOrigin: local.latestTurnOrigin,
      modelSelection: local.modelSelection,
      usage: local.usage,
      lastActivityAt: local.lastActivityAt,
      signal: local.signal,
      needsUser: false,
    });
    expect(state.liveAttachment).toMatchObject({ id: local.liveExecutor!.id, status: "open" });
    // Renderer-safe: no executor routing or native locator.
    expect(state.liveAttachment).not.toHaveProperty("adapterId");
    expect(state.liveAttachment).not.toHaveProperty("native");
    expect(session).toMatchObject({
      turnActive: false,
      lastTurnOutcome: "completed",
      signal: { signal: "blocked", reason: "Need a key" },
      model: {
        providerId: "anthropic",
        modelId: "opus",
        reasoningLevel: "high",
        connectionId: "local",
      },
      usageTotals: {
        costUsd: 1.5,
        inputTokens: 300,
        outputTokens: 30,
        coverage: "complete",
        summary: local.usage,
      },
      attentionCount: 0,
      needsUser: false,
    });
    const turns = await t.run((ctx) => ctx.db.query("sessionTurns").collect());
    expect(turns).toHaveLength(3);
    expect(
      turns.every(
        ({ outcome, endedSequence }) => outcome === "completed" && endedSequence !== null,
      ),
    ).toBe(true);
    expect(turns[0]).toMatchObject({
      origin: { kind: "user" },
      usage: { requestCount: 1, inputTokens: 100, knownCostUsd: 0.5 },
    });
  });

  test("writes the listing row only when a listing-visible field changes", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, turns: 2 });
    const row = () => t.run(async (ctx) => JSON.stringify(await ctx.db.query("sessions").first()));
    let previous = "";
    let writes = 0;
    let attachmentWrites = 0;
    let turnActive = false;
    for (const event of events) {
      await accept(t, runner, sessionId, [event]);
      const current = await row();
      const changed = current !== previous;
      if (changed) writes += 1;
      const kind = event.payload.kind;
      if (kind === "turn.started" || kind === "turn.completed") expect(changed).toBe(true);
      if (kind === "attachment.opened") {
        // Liveness is now a listing-visible field too, independent of a turn.
        expect(changed).toBe(true);
        attachmentWrites += 1;
      }
      // Spend inside a running turn, and bookkeeping, do not churn the list.
      if (
        (kind === "usage.recorded" && turnActive) ||
        (kind === "command.recorded" && event.sequence > 1)
      ) {
        expect(changed, `${event.sequence} ${kind}: ${previous} -> ${current}`).toBe(false);
      }
      if (kind === "turn.started") turnActive = true;
      if (kind === "turn.completed") turnActive = false;
      previous = current;
    }
    // Keep the original churn bound for the existing fields, plus the one
    // deliberate liveness transition introduced by the attachment listing.
    expect(writes - attachmentWrites).toBeLessThan(events.length / 2);
  });

  test("refuses a gap, and a batch that is not contiguous, naming the head", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await accept(t, runner, sessionId, events.slice(0, 2));
    await expect(accept(t, runner, sessionId, [events[3]!])).rejects.toThrow(
      code("out_of_order", { acceptedThrough: 2 }),
    );
    await expect(accept(t, runner, sessionId, [events[2]!, events[4]!])).rejects.toThrow(
      code("out_of_order", { acceptedThrough: 2 }),
    );
    await expect(accept(t, runner, sessionId, [events[2]!])).resolves.toMatchObject({
      acceptedThrough: 3,
    });
  });

  test("answers a resend as duplicates, and a changed resend as a conflict", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await accept(t, runner, sessionId, events.slice(0, 3));
    await expect(accept(t, runner, sessionId, events.slice(0, 4))).resolves.toEqual({
      acceptedThrough: 4,
      duplicates: 3,
      quarantined: 0,
      unknownKinds: 0,
    });
    await expect(accept(t, runner, sessionId, events.slice(1, 3))).resolves.toMatchObject({
      acceptedThrough: 4,
      duplicates: 2,
    });
    // Key order is not identity: the same fact with its keys reordered is a duplicate.
    const reordered = Object.fromEntries(Object.entries(events[1]!).toReversed());
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: [wire(reordered)],
      }),
    ).resolves.toMatchObject({ duplicates: 1 });
    await expect(
      accept(t, runner, sessionId, [{ ...events[1]!, occurredAt: events[1]!.occurredAt + 1 }]),
    ).rejects.toThrow(code("conflict", { acceptedThrough: 4 }));
    await expect(accept(t, runner, sessionId, [{ ...events[1]!, id: "forked" }])).rejects.toThrow(
      code("conflict"),
    );
    expect(await t.run((ctx) => ctx.db.query("sessionEvents").collect())).toHaveLength(4);
  });

  test("fences every runner but the claimed one at the claimed generation", async () => {
    const { t, runner, runnerIds, projectId } = await world();
    const other = runnerIds[1]!;
    const { sessionId, events } = await writeSession({ projectId });
    await accept(t, runner, sessionId, events.slice(0, 2));
    await expect(accept(t, other, sessionId, [events[2]!])).rejects.toThrow(
      code("fenced", { acceptedThrough: 2 }),
    );
    await expect(accept(t, runner, sessionId, [events[2]!], 2)).rejects.toThrow(code("fenced"));
  });

  test("after the claim moves, the old runner is fenced and the new one carries on", async () => {
    vi.useFakeTimers();
    const { t, alice, runner, runnerIds, projectId } = await world();
    const next = runnerIds[1]!;
    const { sessionId, events } = await writeSession({ projectId });
    await accept(t, runner, sessionId, events.slice(0, 3));
    const commandId = randomUUID();
    await asUser(t, "alice").mutation(api.sessions.command, {
      sessionId,
      commandId,
      intent: JSON.stringify({ kind: "session.retitle", title: "Moved" }),
    });
    await expect(
      t.mutation(internal.sessions.transferClaim, { sessionId, toRunnerId: next, headSequence: 2 }),
    ).rejects.toThrow(code("not_drained"));
    const stranger = await t.run((ctx) => seedTestRunner(ctx, randomUUID(), "theirs"));
    await expect(
      t.mutation(internal.sessions.transferClaim, {
        sessionId,
        toRunnerId: stranger,
        headSequence: 3,
      }),
    ).rejects.toThrow(code("not_your_runner"));
    await expect(
      t.mutation(internal.sessions.transferClaim, { sessionId, toRunnerId: next, headSequence: 3 }),
    ).resolves.toEqual({ generation: 2 });

    await expect(accept(t, runner, sessionId, [events[3]!])).rejects.toThrow(code("fenced"));
    await expect(accept(t, next, sessionId, [events[3]!], 1)).rejects.toThrow(code("fenced"));
    await expect(accept(t, next, sessionId, [events[3]!], 2)).resolves.toMatchObject({
      acceptedThrough: 4,
    });
    const rows = await t.run(async (ctx) => ({
      session: await ctx.db.query("sessions").first(),
      job: await ctx.db.query("runnerJobs").first(),
    }));
    expect(rows.session).toMatchObject({ placeRunnerId: next, ownerUserId: alice });
    expect(rows.job).toMatchObject({ id: commandId, runnerId: next, status: "queued" });
  });

  test("stores an unknown kind unread, and quarantines a malformed known kind loudly", async () => {
    const { t, alice, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await accept(t, runner, sessionId, events.slice(0, 2));
    const unknown = { ...events[2]!, payload: { kind: "future.kind", detail: 1 } };
    const malformed = {
      ...events[3]!,
      payload: { kind: "session.retitled", title: 42 },
    };
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: [wire(unknown), wire(malformed)],
      }),
    ).resolves.toEqual({ acceptedThrough: 4, duplicates: 0, quarantined: 1, unknownKinds: 1 });
    const stored = await t.run((ctx) => ctx.db.query("sessionEvents").collect());
    expect(stored[2]).toMatchObject({ kind: "future.kind", kindKnown: false, quarantine: null });
    expect(stored[3]).toMatchObject({
      kind: "session.retitled",
      kindKnown: true,
      quarantine: { code: "malformed_event" },
    });
    // The fold moved past both and folded neither.
    const { state, foldedThrough } = await snapshot(t, "alice", sessionId);
    expect(foldedThrough).toBe(4);
    expect(state.session.title).toBe("Intake");
    const items = await asUser(t, "alice").query(api.sessions.attention, { sessionId });
    expect(items).toEqual([
      expect.objectContaining({
        source: "runner_alert",
        kind: "event_quarantined",
        sourceId: "volli:quarantine:4",
      }),
    ]);
    void alice;
    // The rest of the history keeps folding.
    await expect(accept(t, runner, sessionId, [events[4]!])).resolves.toMatchObject({
      acceptedThrough: 5,
    });
  });

  test("carries payload keys a Convex value refuses, verbatim", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, dollarKeys: true });
    await drain(t, runner, sessionId, events);
    const page = await asUser(t, "alice").query(api.sessions.history, { sessionId, limit: 200 });
    expect(page.events.every(({ status }) => status === "ok")).toBe(true);
    expect(page.events.map(({ eventId }) => eventId)).toEqual(events.map(({ id }) => id));
  });

  test("refuses a caller that is not a live runner", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    // A runner subject from an issuer not trusted for Runner tokens is not a runner.
    await expect(
      t
        .withIdentity({ subject: `runner:${runner}`, issuer: ISSUER })
        .mutation(api.sessions.accept, { sessionId, generation: 1, events: [wire(events[0]!)] }),
    ).rejects.toThrow(code("not_a_runner"));
    // And a Runner token is never a person.
    await expect(asRunner(t, runner).mutation(api.accounts.ensureViewer, {})).rejects.toThrow(
      code("not_a_person"),
    );
    await expect(
      asUser(t, "alice").mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: [wire(events[0]!)],
      }),
    ).rejects.toThrow(code("not_a_runner"));
    await expect(accept(t, randomUUID(), sessionId, events.slice(0, 1))).rejects.toThrow(
      code("revoked"),
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", runner))
        .unique();
      await ctx.db.patch(row!._id, { revokedAt: 1 });
    });
    await expect(accept(t, runner, sessionId, events.slice(0, 1))).rejects.toThrow(code("revoked"));
  });

  test("creates a Session only from its creation fact, in a project its owner can see", async () => {
    const { t, runner, projectId, carol } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await expect(accept(t, runner, sessionId, events.slice(1, 2))).rejects.toThrow(
      code("unknown_session"),
    );
    await expect(accept(t, runner, sessionId, events.slice(0, 1), 2)).rejects.toThrow(
      code("fenced"),
    );
    const elsewhere = await writeSession({ projectId: randomUUID() });
    await expect(
      accept(t, runner, elsewhere.sessionId, elsewhere.events.slice(0, 1)),
    ).rejects.toThrow(code("not_found"));
    // A runner whose owner is not a Member of the project's Workspace.
    const outsider = await t.run((ctx) => seedTestRunner(ctx, carol, "outsider"));
    await expect(accept(t, outsider, sessionId, events.slice(0, 1))).rejects.toThrow(
      code("not_found"),
    );
    // The owner the Engine stamps on its creation fact must be the runner's owner.
    const stamped = {
      ...events[1]!,
      payload: {
        ...events[1]!.payload,
        session: {
          ...(events[1]!.payload as { session: object }).session,
          ownerUserId: randomUUID(),
        },
      },
    };
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: [wire(events[0]!), wire(stamped)],
      }),
    ).rejects.toThrow(code("not_your_runner"));
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: ["{"],
      }),
    ).rejects.toThrow(code("invalid_request"));
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId: "nope",
        generation: 1,
        events: [wire(events[0]!)],
      }),
    ).rejects.toThrow(code("invalid_request"));
  });

  test("holds a fact with huge adapter-native detail, and sets aside one the fold cannot hold", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await drain(t, runner, sessionId, events);
    const opened = events.find(({ payload }) => payload.kind === "attachment.opened")!;
    const attachmentId = (opened.payload as { attachment: { id: string } }).attachment.id;
    const bigNative = nextFact(events, {
      kind: "interaction.opened",
      interaction: {
        id: "big-interaction",
        attachmentId,
        kind: "permission",
        title: "Write the file?",
        detail: null,
        options: [{ id: "once", label: "Allow once", description: null }],
        multiple: false,
        native: { id: "n", detail: { content: "x".repeat(200_000) } },
      },
    } as never);
    await expect(accept(t, runner, sessionId, [bigNative])).resolves.toMatchObject({
      acceptedThrough: events.length + 1,
      quarantined: 0,
    });
    expect((await snapshot(t, "alice", sessionId)).state.interactions.active).toHaveLength(1);
    const unfoldable = nextFact([...events, bigNative], {
      kind: "model.selected",
      selection: { providerId: "p".repeat(70_000), modelId: "m", reasoningLevel: "high" },
    });
    await expect(accept(t, runner, sessionId, [unfoldable])).resolves.toMatchObject({
      acceptedThrough: events.length + 2,
      quarantined: 1,
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query("sessionEvents")
        .withIndex("by_session_sequence", (q) =>
          q.eq("sessionId", sessionId).eq("sequence", unfoldable.sequence),
        )
        .unique(),
    );
    expect(row?.quarantine?.code).toBe("fold_too_large");
    const after = nextFact([...events, bigNative, unfoldable], {
      kind: "session.retitled",
      title: "Still going",
    });
    await expect(accept(t, runner, sessionId, [after])).resolves.toMatchObject({
      acceptedThrough: events.length + 3,
    });
    expect((await snapshot(t, "alice", sessionId)).session.title).toBe("Still going");
  });

  test("refuses a new fact that reuses an accepted id, and every refusal names the head", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await accept(t, runner, sessionId, events.slice(0, 3));
    await expect(
      accept(t, runner, sessionId, [{ ...events[3]!, id: events[0]!.id }]),
    ).rejects.toThrow(code("conflict", { acceptedThrough: 3 }));
    await expect(
      accept(t, runner, sessionId, [events[3]!, { ...events[4]!, id: events[3]!.id }]),
    ).rejects.toThrow(code("conflict", { acceptedThrough: 3 }));
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: ["{"],
      }),
    ).rejects.toThrow(code("invalid_request", { acceptedThrough: 3 }));
  });

  test("clears the attention rows the fold's cap dropped, so Needs you matches the listing", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await drain(t, runner, sessionId, events);
    const history = [...events];
    for (let index = 0; index < 34; index += 1) {
      const raised = nextFact(history, {
        kind: "attention.raised",
        attention: {
          id: `many-${index}`,
          kind: "input_required",
          attachmentId: null,
          detail: null,
          diagnostic: null,
        },
      });
      history.push(raised);
      await accept(t, runner, sessionId, [raised]);
    }
    const open = await asUser(t, "alice").query(api.sessions.attention, { sessionId });
    const { session } = await snapshot(t, "alice", sessionId);
    // 32 attention items kept, plus the blocked signal.
    expect(open.filter(({ source }) => source === "session_attention")).toHaveLength(32);
    expect(session.attentionCount).toBe(32);
    expect(open.some(({ sourceId }) => sourceId === "many-0")).toBe(false);
  });

  test("bounds batch and fact sizes", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    const huge = { ...events[0]!, padding: "x".repeat(256 * 1024) };
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: [wire(huge)],
      }),
    ).rejects.toThrow(code("event_too_large"));
    const wide = { ...events[1]!, padding: "x".repeat(130 * 1024) };
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: [wire(events[0]!), wire(wide)],
      }),
    ).rejects.toThrow(code("batch_too_large"));
    await expect(
      asRunner(t, runner).mutation(api.sessions.accept, { sessionId, generation: 1, events: [] }),
    ).rejects.toThrow(code("invalid_request"));
  });
});

describe("the fold catch-up", () => {
  test("a refold rebuilds the same state and derived rows, page by page", async () => {
    vi.useFakeTimers();
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, turns: 3 });
    await drain(t, runner, sessionId, events);
    const before = await snapshot(t, "alice", sessionId);
    const turnsBefore = await t.run((ctx) => ctx.db.query("sessionTurns").collect());
    await expect(t.mutation(internal.sessions.refold, { sessionId })).resolves.toBe(true);
    // While the refold runs, accepts store facts and leave folding to it.
    expect((await snapshot(t, "alice", sessionId)).foldedThrough).toBe(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await snapshot(t, "alice", sessionId);
    expect(after).toEqual(before);
    const turnsAfter = await t.run((ctx) => ctx.db.query("sessionTurns").collect());
    expect(turnsAfter.map(({ turnId, usage, outcome }) => ({ turnId, usage, outcome }))).toEqual(
      turnsBefore.map(({ turnId, usage, outcome }) => ({ turnId, usage, outcome })),
    );
  });

  test("a refold part-way does not roll the listing or Needs you back", async () => {
    vi.useFakeTimers();
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, turns: 80 });
    expect(events.length).toBeGreaterThan(300);
    for (let index = 0; index < events.length; index += 100) {
      await accept(t, runner, sessionId, events.slice(index, index + 100));
    }
    const listing = await t.run((ctx) => ctx.db.query("sessions").first());
    const open = await asUser(t, "alice").query(api.sessions.attention, {});
    await t.mutation(internal.sessions.refold, { sessionId });
    // One step only: the fold is part-way through history.
    await t.mutation(internal.sessions.catchUp, { sessionId });
    const midway = await snapshot(t, "alice", sessionId);
    expect(midway.foldedThrough).toBeGreaterThan(0);
    expect(midway.foldedThrough).toBeLessThan(events.length);
    expect(midway.catchingUp).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("sessions").first())).toEqual(listing);
    await expect(asUser(t, "alice").query(api.sessions.attention, {})).resolves.toEqual(open);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await snapshot(t, "alice", sessionId)).foldedThrough).toBe(events.length);
  });

  test("reads a stored fact this build no longer knows as unknown, in history and in a refold", async () => {
    vi.useFakeTimers();
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await drain(t, runner, sessionId, events);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessionEvents")
        .withIndex("by_session_sequence", (q) => q.eq("sessionId", sessionId).eq("sequence", 5))
        .unique();
      await ctx.db.patch(row!._id, { payload: JSON.stringify({ kind: "retired.kind" }) });
    });
    const page = await asUser(t, "alice").query(api.sessions.history, { sessionId });
    expect(page.events[4]).toMatchObject({ status: "unknown_kind", event: null });
    await t.mutation(internal.sessions.refold, { sessionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await snapshot(t, "alice", sessionId)).foldedThrough).toBe(events.length);
  });

  test("reads facts the migration stored as values rather than JSON text", async () => {
    vi.useFakeTimers();
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await drain(t, runner, sessionId, events);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("sessionEvents").collect()) {
        await ctx.db.patch(row._id, {
          payload: JSON.parse(row.payload as string),
          provenance: JSON.parse(row.provenance as string),
        });
      }
    });
    const page = await asUser(t, "alice").query(api.sessions.history, { sessionId });
    expect(page.events.every(({ status }) => status === "ok")).toBe(true);
    await expect(accept(t, runner, sessionId, events.slice(0, 2))).resolves.toMatchObject({
      duplicates: 2,
    });
    await t.mutation(internal.sessions.refold, { sessionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await snapshot(t, "alice", sessionId)).foldedThrough).toBe(events.length);
  });

  test("an accept behind a running catch-up stores its facts and the catch-up folds them", async () => {
    vi.useFakeTimers();
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, turns: 1 });
    await drain(t, runner, sessionId, events.slice(0, 5));
    await t.mutation(internal.sessions.refold, { sessionId });
    await drain(t, runner, sessionId, events.slice(5));
    expect((await snapshot(t, "alice", sessionId)).foldedThrough).toBe(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const { foldedThrough, state } = await snapshot(t, "alice", sessionId);
    expect(foldedThrough).toBe(events.length);
    expect(state.lastTurnOutcome).toBe("completed");
  });

  test("a refold reads a kind it stored unread with this build's codec", async () => {
    vi.useFakeTimers();
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await drain(t, runner, sessionId, events);
    // As if an older build had stored this retitle without knowing its kind.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessionEvents")
        .withIndex("by_session_sequence", (q) => q.eq("sessionId", sessionId).eq("sequence", 2))
        .unique();
      await ctx.db.patch(row!._id, { kindKnown: false });
    });
    await t.mutation(internal.sessions.refold, { sessionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = await t.run((ctx) =>
      ctx.db
        .query("sessionEvents")
        .withIndex("by_session_sequence", (q) => q.eq("sessionId", sessionId).eq("sequence", 2))
        .unique(),
    );
    expect(row).toMatchObject({ kindKnown: true, quarantine: null });
    expect((await snapshot(t, "alice", sessionId)).state.modelSelection).toMatchObject({
      modelId: "opus",
    });
  });

  test("keeps a long Session's state under its bound", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, turns: 60 });
    for (let index = 0; index < events.length; index += 100) {
      await accept(t, runner, sessionId, events.slice(index, index + 100));
    }
    const doc = await t.run((ctx) => ctx.db.query("sessionStates").first());
    expect(new TextEncoder().encode(doc!.state as string).length).toBeLessThanOrEqual(
      CLOUD_SESSION_STATE_MAX_BYTES,
    );
    expect((await snapshot(t, "alice", sessionId)).state.usage.requestCount).toBe(61);
  });
});

describe("sessions.command", () => {
  test("queues a command for the claimed runner, idempotent by id, with the engine's receipt mirrored", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events, engine } = await writeSession({ projectId });
    await drain(t, runner, sessionId, events);
    const commandId = randomUUID();
    const intent = JSON.stringify({ kind: "session.retitle", title: "Renamed" });
    const first = await asUser(t, "alice").mutation(api.sessions.command, {
      sessionId,
      commandId,
      intent,
    });
    expect(first).toEqual({
      commandId,
      status: "queued",
      receipt: null,
      runner: { id: runner, name: "runner-0", status: "online", kind: "mac" },
    });
    await expect(
      asUser(t, "alice").mutation(api.sessions.command, { sessionId, commandId, intent }),
    ).resolves.toEqual(first);
    await expect(
      asUser(t, "alice").mutation(api.sessions.command, {
        sessionId,
        commandId,
        intent: JSON.stringify({ kind: "session.retitle", title: "Other" }),
      }),
    ).rejects.toThrow(code("id_taken"));
    const job = await t.run((ctx) => ctx.db.query("runnerJobs").first());
    expect(job).toMatchObject({
      id: commandId,
      commandId,
      kind: "session.command",
      runnerId: runner,
      sessionId,
      createdBy: { kind: "person" },
      payload: { format: "volli.session-command/1" },
    });
    expect(JSON.parse((job!.payload as { intent: string }).intent)).toEqual({
      kind: "session.retitle",
      title: "Renamed",
    });

    // The runner runs it through its engine under the same id; the receipt folds back.
    await engine.submit({
      commandId,
      sessionId,
      intent: { kind: "session.retitle", title: "Renamed" },
      provenance: userProvenance,
    });
    const all = await engine.listEvents({ sessionId });
    await drain(t, runner, sessionId, all.slice(events.length));
    const settled = await t.run((ctx) => ctx.db.query("runnerJobs").first());
    expect(settled!.receipt).toMatchObject({ status: "completed", code: null });
    expect((await snapshot(t, "alice", sessionId)).session.title).toBe("Renamed");
  });

  test("refuses anyone but the owner, and an intent that is not a command", async () => {
    const { t, runner, projectId, ticketId } = await world();
    const { sessionId, events } = await writeSession({ projectId, ticketId });
    await drain(t, runner, sessionId, events);
    const intent = JSON.stringify({ kind: "session.archive" });
    await expect(
      asUser(t, "bob").mutation(api.sessions.command, {
        sessionId,
        commandId: randomUUID(),
        intent,
      }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      asUser(t, "carol").mutation(api.sessions.command, {
        sessionId,
        commandId: randomUUID(),
        intent,
      }),
    ).rejects.toThrow(code("not_found"));
    for (const bad of [
      '{"kind":"nope"}',
      "{",
      JSON.stringify({
        kind: "session.create",
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
      }),
    ]) {
      await expect(
        asUser(t, "alice").mutation(api.sessions.command, {
          sessionId,
          commandId: randomUUID(),
          intent: bad,
        }),
      ).rejects.toThrow(code("invalid_request"));
    }
    await expect(
      asUser(t, "alice").mutation(api.sessions.command, { sessionId, commandId: "x", intent }),
    ).rejects.toThrow(code("invalid_request"));
  });
});

describe("reads", () => {
  test("history windows by sequence cursor, renderer-safe, in order", async () => {
    const { t, runner, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, turns: 1 });
    await drain(t, runner, sessionId, events);
    const read = (args: Record<string, number>) =>
      asUser(t, "alice").query(api.sessions.history, { sessionId, ...args });
    const all = await read({});
    expect(all.hasMore).toBe(false);
    expect(all.events.map(({ sequence }) => sequence)).toEqual(
      events.map(({ sequence }) => sequence),
    );
    const after = await read({ afterSequence: 3, limit: 2 });
    expect(after.events.map(({ sequence }) => sequence)).toEqual([4, 5]);
    expect(after.hasMore).toBe(true);
    const before = await read({ beforeSequence: 6, limit: 2 });
    expect(before.events.map(({ sequence }) => sequence)).toEqual([4, 5]);
    expect((await read({ limit: 0 })).events).toEqual([]);
    expect((await read({ afterSequence: events.length })).events).toEqual([]);
    const refused: Record<string, number>[] = [
      { afterSequence: -1 },
      { afterSequence: 1.5 },
      { limit: -1 },
      { afterSequence: 1, beforeSequence: 4 },
    ];
    for (const bad of refused) {
      await expect(read(bad)).rejects.toThrow(code("invalid_request"));
    }
    for (const entry of all.events) {
      const parsed = parseRendererSessionEvent(JSON.parse(entry.event!), "history");
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.event.payload.kind === "attachment.opened") {
        expect(parsed.event.payload.attachment).not.toHaveProperty("native");
      }
    }
    // Immutable: a later read of the same window is the same window.
    expect(await read({ afterSequence: 3, limit: 2 })).toEqual(after);
  });

  test("lists what each viewer may see: shared ticket work for teammates, private chats for their owner", async () => {
    const { t, runner, projectId, ticketId } = await world();
    const shared = await writeSession({ projectId, ticketId });
    const adhoc = await writeSession({ projectId });
    await drain(t, runner, shared.sessionId, shared.events);
    await drain(t, runner, adhoc.sessionId, adhoc.events);
    const list = (user: string, extra: Record<string, unknown> = {}) =>
      asUser(t, user).query(api.sessions.list, {
        projectId,
        paginationOpts: { numItems: 10, cursor: null },
        ...extra,
      });
    expect((await list("alice")).page.map(({ id }) => id).toSorted()).toEqual(
      [shared.sessionId, adhoc.sessionId].toSorted(),
    );
    expect((await list("bob")).page.map(({ id }) => id)).toEqual([shared.sessionId]);
    expect((await list("alice", { ticketId })).page.map(({ id }) => id)).toEqual([
      shared.sessionId,
    ]);
    await expect(list("carol")).rejects.toThrow(code("not_a_member"));
    await expect(snapshot(t, "bob", adhoc.sessionId)).rejects.toThrow(code("not_found"));
    await expect(snapshot(t, "bob", shared.sessionId)).resolves.toMatchObject({
      session: { id: shared.sessionId },
    });
  });

  test("a Workspace that shares everything shows private chats to teammates", async () => {
    const { t, runner, projectId } = await world({ shareAll: true });
    const adhoc = await writeSession({ projectId });
    await drain(t, runner, adhoc.sessionId, adhoc.events);
    const page = await asUser(t, "bob").query(api.sessions.list, {
      projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map(({ id }) => id)).toEqual([adhoc.sessionId]);
  });

  test("attention: the owner's open items, raised and cleared by the facts", async () => {
    const { t, runner, projectId, ticketId } = await world();
    const { sessionId, events } = await writeSession({ projectId, ticketId });
    const raised = events.findIndex(({ payload }) => payload.kind === "interaction.opened");
    await drain(t, runner, sessionId, events.slice(0, raised + 1));
    const open = await asUser(t, "alice").query(api.sessions.attention, {});
    expect(open.map(({ source, sourceId }) => [source, sourceId]).toSorted()).toEqual([
      ["interaction", "interaction-0"],
      ["session_attention", "attention-0"],
    ]);
    expect(open[0]!.id).toMatch(new RegExp(`^s:${sessionId}:`));
    expect((await snapshot(t, "alice", sessionId)).session).toMatchObject({
      needsUser: true,
      attentionCount: 2,
    });
    // A teammate sees the shared Session, never its owner's attention.
    await expect(asUser(t, "bob").query(api.sessions.attention, {})).resolves.toEqual([]);
    await expect(asUser(t, "bob").query(api.sessions.attention, { sessionId })).resolves.toEqual(
      [],
    );
    await drain(t, runner, sessionId, events.slice(raised + 1));
    const after = await asUser(t, "alice").query(api.sessions.attention, { sessionId });
    expect(after).toEqual([
      expect.objectContaining({ source: "session_blocked", detail: "Need a key" }),
    ]);
  });
});
