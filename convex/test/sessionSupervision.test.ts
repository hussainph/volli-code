/**
 * Session commands from agents (convex-test): the supervision scope an Agent
 * token is held to on `sessions.command`, its frozen tool-call operation ids,
 * the inline message body staged with a steer, and the claim-fenced read the
 * target's runner hydrates that body from.
 */
import { createHash, randomUUID } from "node:crypto";

import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";

import { canonicalJson, TRANSCRIPT_ARTIFACT_MEDIA_TYPE } from "@volli/session-engine";
import {
  AGENT_TOKEN_ISSUER,
  RUNNER_TOKEN_ISSUER,
  agentSubject,
  newId,
  type SessionId,
  type UserId,
} from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { enqueueJob } from "../functions/lib/jobs";
import { COMMAND_ARTIFACT_MEDIA_TYPE } from "../functions/lib/sessionCommands";
import { seedTestWorld } from "../functions/lib/testWorld";
import schema from "../functions/schema";
import { enrollPreview } from "./preview-fixtures";
import { wire, writeSession } from "./sessionFixtures";

const modules = import.meta.glob("../functions/**/*.ts");
const ISSUER = "https://issuer.test";

type T = ReturnType<typeof convexTest>;

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

const asUser = (t: T, name: string) => t.withIdentity({ subject: `user:${name}`, issuer: ISSUER });
const asRunner = (t: T, runnerId: string) =>
  t.withIdentity({ subject: `runner:${runnerId}`, issuer: RUNNER_TOKEN_ISSUER, gen: 1 });

async function claimed(
  t: T,
  runnerId: string,
  script: Parameters<typeof writeSession>[0],
): Promise<string> {
  const { sessionId, events } = await writeSession(script);
  await asRunner(t, runnerId).mutation(api.sessions.accept, {
    sessionId,
    generation: 1,
    events: events.map(wire),
  });
  return sessionId;
}

/**
 * Alice's project with a Board Session on runner 0, and on runner 1 a Ticket
 * Session with its subagent plus a second Ticket Session with its own
 * subagent; and a second project of hers with a Session of its own.
 */
async function world() {
  const t = convexTest(schema, modules);
  const alice = (await asUser(t, "alice").mutation(api.accounts.ensureViewer, {})).userId as UserId;
  // Alice owns every runner here, so her grant is what every accept rechecks.
  await enrollPreview(t, alice);
  const seeded = await t.run((ctx) => seedTestWorld(ctx, { ownerUserId: alice, runners: 2 }));
  const other = await t.run((ctx) => seedTestWorld(ctx, { ownerUserId: alice, runners: 1 }));
  const [local, remote] = seeded.runnerIds as [string, string];
  const { projectId, ticketId } = seeded;
  const board = await claimed(t, local, { projectId });
  const ticket = await claimed(t, remote, { projectId, ticketId });
  const child = await claimed(t, remote, { projectId, ticketId, parentSessionId: ticket });
  const sibling = await claimed(t, remote, { projectId, ticketId });
  const cousin = await claimed(t, remote, { projectId, ticketId, parentSessionId: sibling });
  const elsewhere = await claimed(t, other.runnerIds[0]!, { projectId: other.projectId });
  const runnerOf: Record<string, string> = {
    [board]: local,
    [ticket]: remote,
    [child]: remote,
    [sibling]: remote,
    [cousin]: remote,
  };
  const agent = (sessionId: string) =>
    t.withIdentity({
      issuer: AGENT_TOKEN_ISSUER,
      subject: agentSubject(sessionId as SessionId),
      own: alice,
      rnr: runnerOf[sessionId]!,
      gen: 1,
      tkt: null,
    });
  return {
    t,
    alice,
    projectId,
    local,
    remote,
    board,
    ticket,
    child,
    sibling,
    cousin,
    elsewhere,
    agent,
  };
}

/** The body a `session_send` carries, as the caller's door builds it. */
function steer(operationId: string, text = "Owner direction: rebase first.") {
  const artifact = canonicalJson({
    version: 1,
    threadId: operationId,
    branchId: operationId,
    attemptId: operationId,
    turnId: null,
    message: { id: `${operationId}:message`, role: "user", parts: [{ type: "text", text }] },
  });
  return { artifact, ...submitFor(artifact) };
}

function submitFor(artifact: string) {
  const id = `sha256:${createHash("sha256").update(artifact, "utf8").digest("hex")}`;
  return {
    digest: id,
    intent: JSON.stringify({
      kind: "message.submit",
      reference: { id, digest: id, mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE },
    }),
  };
}

function steerArgs(operationId: string) {
  const { intent, artifact } = steer(operationId);
  return { intent, artifact };
}

const stopBy = (sessionId: string | null) =>
  JSON.stringify({
    kind: "session.stop",
    reason: "Superseded",
    by: sessionId === null ? { kind: "user" } : { kind: "session", sessionId },
  });

test("the backend's transcript media type is the artifact store's", () => {
  expect(COMMAND_ARTIFACT_MEDIA_TYPE).toBe(TRANSCRIPT_ARTIFACT_MEDIA_TYPE);
});

describe("an agent's steer into a Session on another runner", () => {
  test("queues under the frozen operation id, staging its body with the job, and the target's runner hydrates it", async () => {
    const w = await world();
    const operationId = `${w.board}:toolu_01`;
    const { artifact, intent, digest } = steer(operationId);
    const sent = await w.agent(w.board).mutation(api.sessions.command, {
      sessionId: w.ticket,
      commandId: operationId,
      intent,
      artifact,
    });
    expect(sent).toMatchObject({
      commandId: operationId,
      status: "queued",
      runner: { id: w.remote },
    });
    // A replay of the same tool call lands on the same job and the same body.
    await expect(
      w.agent(w.board).mutation(api.sessions.command, {
        sessionId: w.ticket,
        commandId: operationId,
        intent,
        artifact,
      }),
    ).resolves.toEqual(sent);

    const job = await w.t.run((ctx) =>
      ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", operationId))
        .unique(),
    );
    expect(job).toMatchObject({
      commandId: operationId,
      kind: "session.command",
      runnerId: w.remote,
      sessionId: w.ticket,
      createdBy: { kind: "agent", sessionId: w.board },
    });
    // The job carries the reference; the body is staged beside it, never in it.
    expect(JSON.stringify(job!.payload)).not.toContain("Owner direction");
    const staged = await w.t.run((ctx) =>
      ctx.db
        .query("transcriptArtifacts")
        .withIndex("by_session_digest", (q) => q.eq("sessionId", w.ticket).eq("digest", digest))
        .collect(),
    );
    expect(staged).toEqual([
      expect.objectContaining({
        body: artifact,
        mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
        firstSequence: null,
        uploadedBy: "client",
        expiresAt: null,
      }),
    ]);

    const read = (runnerId: string, args: { generation?: number; digest?: string } = {}) =>
      asRunner(w.t, runnerId).query(api.transcripts.commandArtifact, {
        sessionId: w.ticket,
        generation: args.generation ?? 1,
        digest: args.digest ?? digest,
      });
    await expect(read(w.remote)).resolves.toEqual({
      digest,
      mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
      body: artifact,
    });
    await expect(read(w.remote, { digest: `sha256:${"0".repeat(64)}` })).resolves.toBeNull();
    await expect(read(w.local)).rejects.toThrow(code("stale_claim"));
    await expect(read(w.remote, { generation: 2 })).rejects.toThrow(code("stale_claim"));
    await expect(read(w.remote, { digest: "nope" })).rejects.toThrow(code("invalid_argument"));
    await expect(
      w.agent(w.board).query(api.transcripts.commandArtifact, {
        sessionId: w.ticket,
        generation: 1,
        digest,
      }),
    ).rejects.toThrow(code("not_a_runner"));

    // The runner leases and completes the job by its derived id.
    const bootId = randomUUID();
    const leased = await asRunner(w.t, w.remote).mutation(api.runnerJobs.claim, { bootId });
    expect(leased.map(({ job: row }) => row.id)).toContain(operationId);
    await expect(
      asRunner(w.t, w.remote).mutation(api.runnerJobs.complete, {
        jobId: operationId,
        bootId,
        attempt: 1,
        outcome: { status: "done", result: null },
      }),
    ).resolves.toMatchObject({ ack: "recorded" });

    // A surviving claim is not continued permission after Workspace access
    // is lost. The common read must preserve the UI receiver's membership
    // fence too, even for the exact same owned Session, runner and generation.
    await w.t.run(async (ctx) => {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", w.projectId))
        .unique();
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", project!.workspaceId).eq("userId", w.alice),
        )
        .unique();
      await ctx.db.delete(member!._id);
    });
    await expect(read(w.remote)).rejects.toThrow(code("not_claimed"));
  });

  test("a Ticket Session steers and stops its own subagents only", async () => {
    const w = await world();
    const op = `${w.ticket}:toolu_02`;
    await expect(
      w.agent(w.ticket).mutation(api.sessions.command, {
        sessionId: w.child,
        commandId: op,
        ...steerArgs(op),
      }),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      w.agent(w.ticket).mutation(api.sessions.command, {
        sessionId: w.child,
        commandId: `${w.ticket}:toolu_03`,
        intent: stopBy(w.ticket),
      }),
    ).resolves.toMatchObject({ status: "queued" });
    for (const target of [w.cousin, w.sibling, w.board]) {
      const other = `${w.ticket}:toolu_${target}`;
      await expect(
        w.agent(w.ticket).mutation(api.sessions.command, {
          sessionId: target,
          commandId: other,
          ...steerArgs(other),
        }),
      ).rejects.toThrow(code("forbidden"));
    }
  });
});

describe("the supervision scope", () => {
  test("a subagent supervises nothing", async () => {
    const w = await world();
    await expect(
      w.agent(w.child).mutation(api.sessions.command, {
        sessionId: w.ticket,
        commandId: newId("command"),
        intent: stopBy(w.child),
      }),
    ).rejects.toThrow(code("forbidden"));
  });

  test("a Session commands itself only with a signal", async () => {
    const w = await world();
    await expect(
      w.agent(w.board).mutation(api.sessions.command, {
        sessionId: w.board,
        commandId: `${w.board}:toolu_done`,
        intent: JSON.stringify({ kind: "session.signal", signal: "done", reason: null }),
      }),
    ).resolves.toMatchObject({ status: "queued" });
    const op = `${w.board}:toolu_self`;
    await expect(
      w.agent(w.board).mutation(api.sessions.command, {
        sessionId: w.board,
        commandId: op,
        ...steerArgs(op),
      }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      w.agent(w.board).mutation(api.sessions.command, {
        sessionId: w.board,
        commandId: newId("command"),
        intent: JSON.stringify({ kind: "session.retitle", title: "Mine" }),
      }),
    ).rejects.toThrow(code("forbidden"));
  });

  test("toward another Session an agent only steers or stops, within its project", async () => {
    const w = await world();
    for (const intent of [
      JSON.stringify({ kind: "session.signal", signal: "done", reason: null }),
      JSON.stringify({ kind: "session.retitle", title: "Renamed" }),
      JSON.stringify({ kind: "session.archive" }),
    ]) {
      await expect(
        w.agent(w.board).mutation(api.sessions.command, {
          sessionId: w.ticket,
          commandId: newId("command"),
          intent,
        }),
      ).rejects.toThrow(code("forbidden"));
    }
    await expect(
      w.agent(w.board).mutation(api.sessions.command, {
        sessionId: w.elsewhere,
        commandId: newId("command"),
        intent: stopBy(w.board),
      }),
    ).rejects.toThrow(code("forbidden"));
  });

  test("a stop is attributed to who asked: the calling Session, or the person", async () => {
    const w = await world();
    for (const by of [null, w.ticket]) {
      await expect(
        w.agent(w.board).mutation(api.sessions.command, {
          sessionId: w.ticket,
          commandId: newId("command"),
          intent: stopBy(by),
        }),
      ).rejects.toThrow(code("invalid_request"));
    }
    const op = `${w.board}:toolu_stop`;
    await w.agent(w.board).mutation(api.sessions.command, {
      sessionId: w.ticket,
      commandId: op,
      intent: stopBy(w.board),
    });
    const job = await w.t.run((ctx) =>
      ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", op))
        .unique(),
    );
    expect(JSON.parse((job!.payload as { intent: string }).intent)).toMatchObject({
      by: { kind: "session", sessionId: w.board },
    });

    await expect(
      asUser(w.t, "alice").mutation(api.sessions.command, {
        sessionId: w.ticket,
        commandId: newId("command"),
        intent: stopBy(w.board),
      }),
    ).rejects.toThrow(code("invalid_request"));
    await expect(
      asUser(w.t, "alice").mutation(api.sessions.command, {
        sessionId: w.ticket,
        commandId: newId("command"),
        intent: stopBy(null),
      }),
    ).resolves.toMatchObject({ status: "queued" });
  });
});

describe("command ids", () => {
  test("an agent's derived id is its own Session's operation id; a person's stays a UUID", async () => {
    const w = await world();
    for (const commandId of [
      `${w.ticket}:toolu_04`,
      `${w.board}:`,
      `${w.board}:${"x".repeat(600)}`,
      "toolu_05",
    ]) {
      await expect(
        w.agent(w.board).mutation(api.sessions.command, {
          sessionId: w.ticket,
          commandId,
          intent: stopBy(w.board),
        }),
      ).rejects.toThrow(code("invalid_request"));
    }
    await expect(
      asUser(w.t, "alice").mutation(api.sessions.command, {
        sessionId: w.ticket,
        commandId: `${w.board}:toolu_06`,
        intent: stopBy(null),
      }),
    ).rejects.toThrow(code("invalid_request"));
  });

  test("the inbox takes a derived id only as a session.command's own command id", async () => {
    const w = await world();
    const base = {
      runnerId: w.remote,
      projectId: w.projectId,
      sessionId: w.ticket,
      createdBy: { kind: "person" as const, userId: w.alice },
      onBehalfOf: w.alice,
    };
    const derived = `${w.board}:toolu_07`;
    await expect(
      w.t.run((ctx) =>
        enqueueJob(ctx, {
          ...base,
          id: newId("job"),
          kind: "session.command",
          commandId: derived,
          payload: {
            format: "volli.session-command/1",
            intent: JSON.stringify({ kind: "session.archive" }),
          },
        }),
      ),
    ).rejects.toThrow(code("invalid_job"));
    await expect(
      w.t.run((ctx) =>
        enqueueJob(ctx, {
          ...base,
          kind: "session.release",
          commandId: derived,
          payload: {} as never,
        }),
      ),
    ).rejects.toThrow(code("invalid_job"));
    await expect(
      w.t.run((ctx) =>
        enqueueJob(ctx, {
          ...base,
          id: derived,
          kind: "session.release",
          payload: {} as never,
        }),
      ),
    ).rejects.toThrow(code("invalid_job"));
  });
});

describe("the inline body", () => {
  test("is bound to its intent and refused otherwise", async () => {
    const w = await world();
    const op = `${w.board}:toolu_08`;
    const send = (args: { intent: string; artifact?: string }) =>
      w.agent(w.board).mutation(api.sessions.command, {
        sessionId: w.ticket,
        commandId: op,
        intent: args.intent,
        ...(args.artifact === undefined ? {} : { artifact: args.artifact }),
      });
    const body = (message: Record<string, unknown>, raw?: (value: object) => string) => {
      const value = {
        version: 1,
        threadId: op,
        branchId: op,
        attemptId: op,
        turnId: null,
        message: { id: `${op}:message`, role: "user", ...message },
      };
      const artifact = (raw ?? canonicalJson)(value);
      return { artifact, ...submitFor(artifact) };
    };
    const good = steer(op);
    const refusals: { intent: string; artifact?: string }[] = [
      // No body at all.
      { intent: good.intent },
      // A body that is not the reference's.
      { intent: good.intent, artifact: steer(op, "Something else").artifact },
      // Not the transcript media type.
      {
        artifact: good.artifact,
        intent: good.intent.replace(TRANSCRIPT_ARTIFACT_MEDIA_TYPE, "application/json"),
      },
      // Matching digest, but not canonical JSON.
      body({ parts: [{ type: "text", text: "hi" }] }, (value) => JSON.stringify(value)),
      // Not a user message, not this command's message, not text.
      body({ role: "assistant", parts: [{ type: "text", text: "hi" }] }),
      body({ id: "other:message", parts: [{ type: "text", text: "hi" }] }),
      body({ parts: [{ type: "file", url: "file:///etc/passwd", mediaType: "text/plain" }] }),
      body({ parts: [] }),
      // Over the inline bound.
      body({ parts: [{ type: "text", text: "x".repeat(64 * 1024) }] }),
      // A body on a command that sends no message.
      { intent: stopBy(w.board), artifact: good.artifact },
    ];
    for (const refusal of refusals) {
      await expect(send(refusal)).rejects.toThrow(code("invalid_request"));
    }
    await expect(send({ intent: good.intent, artifact: good.artifact })).resolves.toMatchObject({
      status: "queued",
    });
    const rows = await w.t.run((ctx) => ctx.db.query("transcriptArtifacts").collect());
    expect(rows.map((row) => row.digest)).toEqual([good.digest]);
  });

  test("a person may carry one too, and their send stays a person's", async () => {
    const w = await world();
    const commandId = newId("command");
    const { artifact, intent } = steer(commandId);
    await expect(
      asUser(w.t, "alice").mutation(api.sessions.command, {
        sessionId: w.ticket,
        commandId,
        intent,
        artifact,
      }),
    ).resolves.toMatchObject({ status: "queued" });
    // A person's message without a body keeps today's shape.
    await expect(
      asUser(w.t, "alice").mutation(api.sessions.command, {
        sessionId: w.ticket,
        commandId: newId("command"),
        intent: submitFor(steer(newId("command")).artifact).intent,
      }),
    ).resolves.toMatchObject({ status: "queued" });
  });
});
