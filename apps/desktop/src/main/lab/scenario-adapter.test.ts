/**
 * Every scenario, played through a real Session runtime.
 *
 * The claim these scenarios exist to make is that the state reaches the
 * renderer, so the assertions are all made against `SessionProjection` — the
 * exact value `session.snapshot` returns and the chat controller holds. Reading
 * the adapter's own observations back would only prove the fixture is the
 * fixture.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createNativeAdapterRegistry,
  createSessionEngine,
  createSessionRuntime,
  type SessionLocationResolver,
  type SessionRuntime,
} from "@volli/session-engine";
import {
  readInteractionPrompts,
  type SessionInteraction,
  type SessionProjection,
} from "@volli/shared";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { LAB_SCENARIOS, LAB_SCENARIO_ADAPTER_ID } from "../../lab-scenarios";
import { createLabScenarioAdapter } from "./scenario-adapter";

const venue = { id: "lab-machine", kind: "local" as const };

/** A host with nothing to materialize: preparing a location is resolving it. */
function fixedLocation(directory: string): SessionLocationResolver {
  const at = async () => ({ directory, venue });
  return { resolve: at, prepare: at };
}

function runtime(): SessionRuntime {
  let sequence = 0;
  let clock = 1_700_000_000_000;
  const next = (kind: string) => `${kind}-${++sequence}`;
  return createSessionRuntime({
    engine: createSessionEngine({
      ledger: createInMemorySessionLedger(),
      clock: { now: () => clock++ },
      ids: { next: (kind) => next(kind) },
    }),
    adapters: createNativeAdapterRegistry([
      createLabScenarioAdapter({ beatDelayMs: 0, now: () => clock }),
    ]),
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: fixedLocation("/lab/workspace"),
    clock: { now: () => clock++ },
    ids: { next },
  });
}

/** One played scenario, held exactly the way the chat controller holds it. */
interface PlayedScenario {
  host: SessionRuntime;
  sessionId: string;
  projection: SessionProjection;
  messages: readonly UIMessage[];
}

/** Runs one scenario end to end and returns what the renderer would hold. */
async function play(scenarioId: string): Promise<PlayedScenario> {
  const host = runtime();
  const created = await host.command({
    commandId: `create-${scenarioId}`,
    command: { kind: "session.create", projectId: "lab", ticketId: null, title: scenarioId },
  });
  await host.command({
    commandId: `attach-${scenarioId}`,
    sessionId: created.sessionId,
    command: {
      kind: "adapter.attach",
      adapterId: LAB_SCENARIO_ADAPTER_ID,
      profileId: scenarioId,
      continuity: "fresh",
    },
  });
  await settle();
  return read(host, created.sessionId);
}

async function read(host: SessionRuntime, sessionId: string): Promise<PlayedScenario> {
  const snapshot = await host.snapshot({ sessionId });
  // The renderer's own rule: transcript events are immutable snapshots, so a
  // message id keeps its position and shows its latest shape.
  const latest = new Map<string, UIMessage>();
  for (const frame of snapshot.frames) {
    if (frame.transcript) latest.set(frame.transcript.message.id, frame.transcript.message);
  }
  return { host, sessionId, projection: snapshot.projection, messages: [...latest.values()] };
}

/** Beats are queued behind the attach; a few macrotasks drain the whole script. */
async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function toolParts(messages: readonly UIMessage[]): DynamicToolUIPart[] {
  return messages.flatMap((message) =>
    message.parts.filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool"),
  );
}

function onlyInteraction(projection: SessionProjection): SessionInteraction {
  const [interaction] = projection.interactions.active;
  if (!interaction) throw new Error("scenario opened no interaction");
  return interaction;
}

describe("lab scenarios", () => {
  it("declares one native harness profile per scenario", () => {
    const adapter = createLabScenarioAdapter({ beatDelayMs: 0 });
    expect(adapter.manifest.profiles.map((profile) => profile.id)).toEqual(
      LAB_SCENARIOS.map((scenario) => scenario.id),
    );
    expect(adapter.manifest.profiles.every((profile) => profile.transport === "native")).toBe(true);
  });

  it("refuses a scenario that does not exist rather than attaching an empty stream", async () => {
    const adapter = createLabScenarioAdapter({ beatDelayMs: 0 });
    await expect(
      adapter.probe(
        { profileId: "not-a-scenario", directory: "/lab" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("puts a permission on the call it gates, and settles that row when answered", async () => {
    const played = await play("permission-tool");
    const interaction = onlyInteraction(played.projection);
    expect(interaction.kind).toBe("permission");
    expect(interaction.detail).toBe("rm -rf node_modules");
    expect(toolParts(played.messages).some((part) => part.state === "approval-requested")).toBe(
      true,
    );

    await played.host.command({
      commandId: "answer-permission",
      sessionId: played.sessionId,
      command: {
        kind: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { optionIds: ["once"], response: null },
      },
    });
    await settle();

    const after = await read(played.host, played.sessionId);
    expect(after.projection.interactions.active).toEqual([]);
    expect(after.projection.interactions.resolved).toHaveLength(1);
    expect(toolParts(after.messages).map((part) => part.state)).toContain("output-available");
  });

  it("refuses a message rather than accepting one it will never answer", async () => {
    const played = await play("permission-toolless");

    const result = await played.host.command({
      commandId: "submit-into-a-script",
      sessionId: played.sessionId,
      command: {
        kind: "message.submit",
        message: { id: "user-1", role: "user", parts: [{ type: "text", text: "carry on" }] },
        delivery: "queue",
      },
    });

    // A durable refusal, not a throw and not a silent `accepted`: the surface
    // reads this receipt to decide whether the words it was holding are gone.
    expect(result.receipt?.status).toBe("rejected");
    expect(result.receipt).toMatchObject({ code: "unsupported_command" });
  });

  it("opens a permission with no call to correlate to", async () => {
    const played = await play("permission-toolless");
    expect(onlyInteraction(played.projection).kind).toBe("permission");
    expect(toolParts(played.messages)).toEqual([]);
  });

  it("opens a single-prompt question of options only", async () => {
    const prompts = readInteractionPrompts(
      onlyInteraction((await play("question-single")).projection),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.multiple).toBe(false);
    expect(prompts[0]?.custom).toBe(false);
  });

  it("opens a question whose prompts each carry their own answer rules", async () => {
    const prompts = readInteractionPrompts(
      onlyInteraction((await play("question-multi")).projection),
    );
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts.some((prompt) => prompt.multiple)).toBe(true);
    expect(prompts.some((prompt) => prompt.custom)).toBe(true);
  });

  it("keeps a declared `reject` answer an answer", async () => {
    const interaction = onlyInteraction((await play("question-reject-option")).projection);
    const [prompt] = readInteractionPrompts(interaction);
    expect(prompt?.options.map((option) => option.label)).toContain("reject");
    // The refusal sentinel is the bare id. A harness's own value is encoded, so
    // choosing it can never be read as a no.
    expect(prompt?.options.every((option) => option.id !== "reject")).toBe(true);
  });

  it("raises each blocked state as the attention a blocker reads", async () => {
    const kinds = await Promise.all(
      (
        [
          "auth-required",
          "rate-limited-until",
          "rate-limited-open",
          "context-limit",
          "adapter-unrecoverable",
        ] as const
      ).map(async (id) => (await play(id)).projection.attention.primary),
    );
    expect(kinds.map((attention) => attention?.kind)).toEqual([
      "auth_required",
      "rate_limited",
      "rate_limited",
      "context_limit_reached",
      "adapter_unrecoverable",
    ]);
    const [, withTime, withoutTime] = kinds;
    expect(withTime?.kind === "rate_limited" ? withTime.retryAt : null).toBeGreaterThan(0);
    expect(withoutTime?.kind === "rate_limited" ? withoutTime.retryAt : "absent").toBeNull();
  });

  it("holds an interaction and an attention at once", async () => {
    const played = await play("interaction-over-attention");
    expect(played.projection.attention.primary?.kind).toBe("rate_limited");
    expect(played.projection.interactions.active).toHaveLength(1);
    // The plan the checklist projects from is in the transcript, so the surface
    // is genuinely choosing not to mount it rather than having nothing to show.
    expect(toolParts(played.messages).some((part) => part.toolName === "todowrite")).toBe(true);
  });
});
