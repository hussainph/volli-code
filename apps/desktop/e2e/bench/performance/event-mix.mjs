/**
 * The VC-353 fixture's Session Event mix.
 *
 * The owner's real profile is 259,855 Session Events holding about 173 MB of a
 * 373 MB database — roughly 670 physical bytes per event. A fixture that wrote
 * a uniform cycle of tiny payloads would reproduce the row count and none of
 * the cost: the app pays for JSON it parses, rows that spill to overflow pages,
 * and the index and sidecar mass those rows drag with them. So the mix here is
 * explicit and weighted, and the weights say what an agent Session's durable
 * history actually is: mostly runtime observations, a third of them
 * tool-result-sized, wrapped in turn and run lifecycle pairs, with transcript
 * references, spend, interactions, attention and authority in the proportions a
 * long-running Session accumulates them.
 *
 * Every payload here is built in the production vocabulary and is written
 * through `assertSessionEvent`, so a kind or field this build cannot decode
 * fails at generation rather than at the first benchmark that reads it.
 *
 * ## Units, not events
 *
 * Several families are pairs — a turn starts and completes, an interaction
 * opens and resolves — and history that contained one half of each would be a
 * history no runtime can produce. A family therefore allocates in *units* and
 * declares how many events a unit costs; the allocator below keeps the event
 * total exact regardless.
 */

import { deterministicUuid, hashIndex, largestRemainder, proseBytes } from "./deterministic.mjs";

/** Body sizes, in bytes of generated prose, for the text-bearing families. */
const BODY_BYTES = Object.freeze({
  toolResult: 1_480,
  toolProgress: 360,
  runtimeStatus: 110,
  interactionPrompt: 420,
  interactionResponse: 60,
  attentionDetail: 180,
  authorityReason: 200,
  reasoningPath: 60,
  promptResource: 1_200,
  runtimeBrief: 900,
  commandNote: 180,
});

const TOOL_NAMES = ["read", "grep", "execute", "edit", "write"];
const DENIED_CAUSES = ["rule.write-outside-worktree", "rule.network-egress", "rule.secret-path"];
const OBSERVATION_STATES = ["working", "streaming", "idle", "awaiting-tool"];
/** Mirrors `REASONING_DROP_CAUSES`; a word outside it fails the write gate. */
const REASONING_CAUSES = ["prefix-mismatch", "model-mismatch", "unknown"];

/**
 * The weighted mix, in per-mille of allocated units.
 *
 * Weights are integers and their total is asserted at module load: a family
 * added without adjusting its neighbours is a mistake the fixture should refuse
 * to make quietly, because every published baseline is comparable only to runs
 * that generated the same distribution.
 */
export const EVENT_FAMILIES = Object.freeze(
  [
    {
      id: "observation.tool-result",
      weight: 150,
      eventCount: 1,
      build: (context) => [
        observed(context, "tool.result", {
          tool: TOOL_NAMES[context.pick(TOOL_NAMES.length)],
          callId: context.uuid("tool-call", context.unitKey),
          turnId: context.turnId,
          durationMs: 40 + context.pick(2_400),
          exitCode: 0,
          preview: context.body(BODY_BYTES.toolResult),
        }),
      ],
    },
    {
      id: "observation.tool-progress",
      weight: 130,
      eventCount: 1,
      build: (context) => [
        observed(context, "tool.progress", {
          tool: TOOL_NAMES[context.pick(TOOL_NAMES.length)],
          callId: context.uuid("tool-call", context.unitKey),
          turnId: context.turnId,
          chunk: context.body(BODY_BYTES.toolProgress),
        }),
      ],
    },
    {
      id: "observation.token-batch",
      weight: 210,
      eventCount: 1,
      build: (context) => [
        observed(context, "token.batch", {
          turnId: context.turnId,
          tokens: 12 + context.pick(48),
          index: context.unitIndex,
        }),
      ],
    },
    {
      id: "observation.runtime-status",
      weight: 60,
      eventCount: 1,
      build: (context) => [
        observed(context, "runtime.status", {
          state: OBSERVATION_STATES[context.pick(OBSERVATION_STATES.length)],
          queueDepth: context.pick(4),
          detail: context.body(BODY_BYTES.runtimeStatus),
        }),
      ],
    },
    {
      id: "transcript.turn",
      weight: 130,
      eventCount: 1,
      build: (context) => [
        {
          attachment: true,
          payload: {
            kind: "transcript.referenced",
            attachmentId: context.attachmentId,
            turnId: context.turnId,
            reference: context.transcriptReference(context.unitIndex),
          },
        },
      ],
    },
    {
      id: "usage.recorded",
      weight: 85,
      eventCount: 1,
      build: (context) => [
        {
          attachment: true,
          payload: {
            kind: "usage.recorded",
            attachmentId: context.attachmentId,
            turnId: context.turnId,
            attribution: { projectId: context.projectId, ticketId: context.ticketId },
            usage: {
              cause: "assistant",
              providerId: "openai-codex",
              modelId: "gpt-5.4",
              inputTokens: 4_096 + context.pick(28_000),
              outputTokens: 96 + context.pick(1_400),
              cacheReadTokens: context.pick(24_000),
              cacheWriteTokens: context.pick(2_048),
              costUsd: Number((context.pick(900) / 100_000).toFixed(5)),
              costBasis: "provider-reported",
            },
          },
        },
      ],
    },
    {
      id: "turn.cycle",
      weight: 90,
      eventCount: 2,
      build: (context) => [
        {
          attachment: true,
          payload: {
            kind: "turn.started",
            attachmentId: context.attachmentId,
            turnId: context.turnId,
          },
        },
        {
          attachment: true,
          payload: {
            kind: "turn.completed",
            attachmentId: context.attachmentId,
            turnId: context.turnId,
          },
        },
      ],
    },
    {
      id: "run.cycle",
      weight: 30,
      eventCount: 2,
      build: (context) => {
        const runId = context.uuid("run", context.unitKey);
        return [
          {
            attachment: true,
            payload: { kind: "run.started", attachmentId: context.attachmentId, runId },
          },
          {
            attachment: true,
            payload: { kind: "run.completed", attachmentId: context.attachmentId, runId },
          },
        ];
      },
    },
    {
      id: "interaction.cycle",
      weight: 25,
      eventCount: 2,
      build: (context) => {
        const interactionId = context.uuid("interaction", context.unitKey);
        const optionId = `${interactionId}:allow`;
        return [
          {
            attachment: true,
            payload: {
              kind: "interaction.opened",
              interaction: {
                id: interactionId,
                attachmentId: context.attachmentId,
                kind: "permission",
                title: "Allow this command?",
                detail: context.body(BODY_BYTES.interactionPrompt),
                options: [
                  { id: optionId, label: "Allow once", description: "Run this one command" },
                  { id: `${interactionId}:deny`, label: "Deny", description: null },
                ],
                multiple: false,
                native: { id: `${interactionId}:native`, detail: { source: "pi" } },
              },
            },
          },
          {
            attachment: true,
            payload: {
              kind: "interaction.resolved",
              attachmentId: context.attachmentId,
              interactionId,
              resolution: {
                optionIds: [optionId],
                response: context.body(BODY_BYTES.interactionResponse),
              },
            },
          },
        ];
      },
    },
    {
      id: "attention.cycle",
      weight: 20,
      eventCount: 2,
      build: (context) => {
        const attentionId = context.uuid("attention", context.unitKey);
        return [
          {
            attachment: true,
            payload: {
              kind: "attention.raised",
              attention: {
                id: attentionId,
                attachmentId: context.attachmentId,
                kind: "rate_limited",
                detail: context.body(BODY_BYTES.attentionDetail),
                diagnostic: { retryAfterSeconds: 30 + context.pick(120) },
                retryAt: context.occurredAt + 30_000,
              },
            },
          },
          { attachment: false, payload: { kind: "attention.cleared", attentionId } },
        ];
      },
    },
    {
      id: "authority.denied",
      weight: 20,
      eventCount: 1,
      build: (context) => [
        {
          attachment: true,
          payload: {
            kind: "authority.denied",
            attachmentId: context.attachmentId,
            turnId: context.turnId,
            tool: TOOL_NAMES[context.pick(TOOL_NAMES.length)],
            cause: DENIED_CAUSES[context.pick(DENIED_CAUSES.length)],
            reason: context.body(BODY_BYTES.authorityReason),
          },
        },
      ],
    },
    {
      id: "context.compacted",
      weight: 10,
      eventCount: 1,
      build: (context) => [
        {
          attachment: true,
          payload: {
            kind: "context.compacted",
            attachmentId: context.attachmentId,
            reason: "threshold",
            entryId: context.uuid("compaction-entry", context.unitKey),
            tokensBefore: 160_000 + context.pick(40_000),
            tokensAfter: 40_000 + context.pick(20_000),
          },
        },
      ],
    },
    {
      id: "context.reasoning_dropped",
      weight: 10,
      eventCount: 1,
      // One path per dropped block, because that is the relationship the host
      // writes: `paths` is the diagnostic coordinate of each thing `count`
      // counts. The paths never cross to the renderer — the scrub drops them —
      // so this family is also what keeps the fixture honest about a payload
      // that is bigger on disk than it is on screen.
      build: (context) => {
        const count = 1 + context.pick(2);
        return [
          {
            attachment: true,
            payload: {
              kind: "context.reasoning_dropped",
              attachmentId: context.attachmentId,
              turnId: context.turnId,
              count,
              causes: [REASONING_CAUSES[context.pick(REASONING_CAUSES.length)]],
              paths: Array.from({ length: count }, () => context.body(BODY_BYTES.reasoningPath)),
            },
          },
        ];
      },
    },
    {
      id: "turn.interrupted",
      weight: 10,
      eventCount: 1,
      build: (context) => [
        {
          attachment: true,
          payload: {
            kind: "turn.interrupted",
            attachmentId: context.attachmentId,
            turnId: context.turnId,
          },
        },
      ],
    },
    {
      id: "session.input",
      weight: 10,
      eventCount: 1,
      build: (context) => [
        {
          attachment: false,
          payload: {
            kind: "session.input.recorded",
            input:
              context.unitIndex % 2 === 0
                ? {
                    kind: "prompt-resources",
                    resources: [
                      {
                        name: "skills/benchmark-fixture",
                        text: context.body(BODY_BYTES.promptResource),
                      },
                    ],
                  }
                : { kind: "tool-surface", tools: context.toolIds },
          },
        },
      ],
    },
    {
      id: "session.retitled",
      weight: 6,
      eventCount: 1,
      build: (context) => [
        {
          attachment: false,
          payload: { kind: "session.retitled", title: `${context.sessionTitle} (revised)` },
        },
      ],
    },
    {
      id: "session.signaled",
      weight: 4,
      eventCount: 1,
      build: (context) => [
        {
          attachment: false,
          payload: {
            kind: "session.signaled",
            signal: context.unitIndex % 5 === 0 ? "blocked" : "done",
            reason: context.body(BODY_BYTES.commandNote),
          },
        },
      ],
    },
  ].map((family) => Object.freeze(family)),
);

/** The mix is declared in per-mille and must stay that way. */
export const FAMILY_WEIGHT_TOTAL = 1_000;

const declaredWeight = EVENT_FAMILIES.reduce((sum, family) => sum + family.weight, 0);
if (declaredWeight !== FAMILY_WEIGHT_TOTAL) {
  throw new Error(`Session Event mix weights total ${declaredWeight}, expected 1000`);
}

/** The long chat's own shape: over half its history is transcript turns. */
export const LONG_CHAT_TRANSCRIPT_SHARE = 0.55;

function observed(context, name, native) {
  return {
    attachment: true,
    observation: name,
    payload: { kind: "adapter.observed", attachmentId: context.attachmentId, name, native },
  };
}

/**
 * Split one Session's weighted middle into exact per-family unit counts.
 *
 * The event total is exact by construction: families are allocated in whole
 * units (so no pair is ever half-written), and whatever single events are left
 * over go to the single-event filler family. That keeps `session_events` row
 * counts on the numbers the ticket pins while the *distribution* stays the
 * declared one.
 */
export function allocateFamilyUnits(events) {
  if (!Number.isInteger(events) || events < 0) throw new Error("events must be a whole number");
  const counts = EVENT_FAMILIES.map(() => 0);
  if (events === 0) return counts;
  const fillerIndex = EVENT_FAMILIES.findIndex((family) => family.eventCount === 1);
  const shares = largestRemainder(
    events,
    EVENT_FAMILIES.map((family) => family.weight),
  );
  let placed = 0;
  for (const [index, family] of EVENT_FAMILIES.entries()) {
    const units = Math.floor(shares[index] / family.eventCount);
    counts[index] = units;
    placed += units * family.eventCount;
  }
  // Whole units first, then the remainder as filler: a two-event family may
  // only ever hold an even number of the events it was given.
  counts[fillerIndex] += events - placed;
  return counts;
}

/** How many events a unit allocation holds, for assertions and manifests. */
export function eventsInUnits(counts) {
  return counts.reduce((sum, units, index) => sum + units * EVENT_FAMILIES[index].eventCount, 0);
}

/**
 * The unit order for one Session: the allocation expanded to family indices and
 * shuffled by a seed scoped to that Session, so two Sessions of the same length
 * do not write byte-identical histories.
 */
export function orderFamilyUnits(counts, seed) {
  const units = [];
  for (const [index, count] of counts.entries()) {
    for (let unit = 0; unit < count; unit += 1) units.push(index);
  }
  // A plain shuffle would be enough for variety, but a seeded rotation-and-swap
  // keeps lifecycle pairs from clustering at one end of long histories.
  const ordered = [...units];
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const target = hashIndex(`${seed}:${index}`, index + 1);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  }
  return ordered;
}

/* --------------------------------------------------------- structural events */

/** The Session's own birth fact — always sequence 1. */
export function sessionCreatedPayload(session) {
  return { kind: "session.created", session };
}

export function modelSelectedPayload() {
  return {
    kind: "model.selected",
    selection: { providerId: "openai-codex", modelId: "gpt-5.4", reasoningLevel: "medium" },
    tier: "ticket",
  };
}

/** The attach-time runtime brief, the largest single structural payload. */
export function runtimeBriefPayload(context) {
  return {
    kind: "session.input.recorded",
    input: { kind: "runtime-brief", text: context.body(BODY_BYTES.runtimeBrief) },
  };
}

export function attachmentOpenedPayload({ attachment }) {
  return { kind: "attachment.opened", attachment };
}

export function attachmentClosedPayload(attachmentId) {
  return { kind: "attachment.closed", attachmentId, outcome: "completed" };
}

/**
 * A durable Authority Snapshot for the fixture's attachments (VC-44 shape).
 *
 * The tool list is the production vocabulary the caller hands in, not a literal
 * copied into this file: a retired tool name should change the fixture the day
 * it changes the product, rather than the day somebody notices.
 */
export function authoritySnapshot(toolIds) {
  return {
    mode: "auto",
    location: "worktree",
    enforcement: "enforce",
    judgmentMode: "ask",
    tools: [...toolIds],
    rulePackId: "vc-353-benchmark",
    rulePackHash: deterministicUuid("rule-pack", "vc-353-benchmark").replaceAll("-", ""),
    classifierModel: null,
    fallback: { consecutiveDenials: 3, sessionDenials: 12 },
  };
}

const COMMAND_INTENTS = ["message.submit", "executor.start", "interaction.resolve", "model.select"];

/**
 * One durable Session Command, in the intent mix a chat Session produces: most
 * commands are message submissions, the rest are executor and model control.
 */
export function commandIntent(context) {
  const intent = COMMAND_INTENTS[context.pick(COMMAND_INTENTS.length)];
  if (intent === "message.submit") {
    return { kind: "message.submit", reference: context.transcriptReference(context.unitIndex) };
  }
  if (intent === "executor.start") {
    return { kind: "executor.start", adapterId: context.adapterId, continuity: "fresh" };
  }
  if (intent === "interaction.resolve") {
    const interactionId = context.uuid("interaction", context.unitKey);
    return {
      kind: "interaction.resolve",
      attachmentId: context.attachmentId,
      interactionId,
      resolution: { optionIds: [`${interactionId}:allow`], response: null },
      reference: context.transcriptReference(context.unitIndex),
    };
  }
  return {
    kind: "model.select",
    selection: { providerId: "openai-codex", modelId: "gpt-5.4", reasoningLevel: "medium" },
    tier: "ticket",
  };
}

/** The receipt shape the ledger's own append gate checks an event against. */
export function commandReceipt({ id, commandId, sequence, recordedAt, sessionId, intentKind }) {
  return {
    id,
    commandId,
    sequence,
    recordedAt,
    status: "accepted",
    acceptedAt: recordedAt,
    result: { kind: receiptResultKind(intentKind), sessionId },
  };
}

function receiptResultKind(intentKind) {
  switch (intentKind) {
    case "message.submit": {
      return "message.submitted";
    }
    case "executor.start": {
      return "executor.start.requested";
    }
    case "interaction.resolve": {
      return "interaction.resolved";
    }
    default: {
      return "model.selected";
    }
  }
}

export { BODY_BYTES, proseBytes };
