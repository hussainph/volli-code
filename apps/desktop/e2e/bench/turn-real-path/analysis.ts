/**
 * VC-456's per-turn accounting and the ledger cross-check.
 *
 * The VC-119 half is VC-441's own `analyzeTurn` and `checkEventOrder`, run on
 * the envelopes the real path recorded and held to this script's counts. What
 * is new here is the other half: the same turn's Session ledger events, read
 * both live (when a subscriber received each frame) and back from SQLite, and
 * a check that the two views of the turn agree about what happened in what
 * order.
 */
import {
  analyzeTurn,
  summarize,
  type Distribution,
  type RecordedFixtureEvent,
  type TurnExpectations,
  type TurnSample,
} from "@volli/agent-runtime/bench/turn-to-completion";
import type { ObservabilityEvent } from "@volli/shared";

import {
  AUTHORITY_THINK_MS,
  type LedgerFrame,
  type RawTurn,
  type RecordedEnvelope,
} from "./harness";

/**
 * What one scripted turn must produce in VC-119 terms: VC-441's shape on the
 * real path. Three provider attempts (tool round, overflow error, final); one
 * tool round of two reads and a bash; one authority wait (the escalated read);
 * one overflow compaction, whose summary request goes through Pi's
 * `completeSimple` and so is not a provider attempt; one retry (the attempt
 * after the error); one `turn-queue` from the Session runtime.
 */
export const REAL_PATH_EXPECTED: TurnExpectations = {
  modelAttempts: 3,
  toolsByName: { read: 2, bash: 1 },
  authorityWaits: 1,
  compactions: 1,
  retries: 1,
  turnQueues: 1,
};

/** The facts both views record, each named once. */
export const CROSS_CHECK_FACTS = [
  "turn-start",
  "first-attempt",
  "authority-answer",
  "compaction",
  "final-attempt",
  "turn-end",
] as const;
export type CrossCheckFact = (typeof CROSS_CHECK_FACTS)[number];

export interface LedgerCrossCheck {
  /** Facts found on both sides. */
  paired: CrossCheckFact[];
  /** Facts missing from either side; a missing fact is never read as agreeing. */
  missing: CrossCheckFact[];
  /**
   * Pairs of paired facts that the two views put in opposite orders: VC-119's
   * sink emission order against the ledger's sequence.
   */
  orderInversions: number;
  /**
   * Named breaches of an order that holds by construction, measured on one
   * clock (the harness's `performance.now()`):
   *
   * - `turn-queue`, `compaction` and the terminal `turn` envelope are recorded
   *   before the durable fact they describe is written, so each must be
   *   recorded no later than the subscriber receives that fact.
   * - An authority wait cannot end before the question reached the person, so
   *   its envelope must be recorded no earlier than the `interaction.opened`
   *   frame arrived.
   */
  causalityViolations: string[];
  /** The live frames and the SQLite read-back list the same facts in the same order. */
  streamMatchesLedger: boolean;
}

interface LedgerSide {
  sequence: number;
  arrivedAt: number | null;
}

function envelopeOf(
  envelopes: readonly RecordedEnvelope[],
  predicate: (event: ObservabilityEvent) => boolean,
  which: "first" | "last" = "first",
): RecordedEnvelope | undefined {
  const sorted = envelopes.toSorted((left, right) => left.order - right.order);
  return which === "first"
    ? sorted.find((entry) => predicate(entry.event))
    : sorted.findLast((entry) => predicate(entry.event));
}

function hasWait(event: ObservabilityEvent): boolean {
  return event.kind === "authority" && event.waitDurationMs !== undefined;
}

/** The turn's window in the ledger: from its own `command.recorded` to its `turn.completed`. */
function ledgerWindow(
  commandId: string,
  ledger: RawTurn["ledger"],
): { accepted?: number; started?: number; completed?: number } {
  const accepted = ledger.find(
    (entry) => entry.kind === "command.recorded" && entry.commandId === commandId,
  )?.sequence;
  if (accepted === undefined) return {};
  const started = ledger.find(
    (entry) => entry.kind === "turn.started" && entry.sequence > accepted,
  )?.sequence;
  if (started === undefined) return { accepted };
  const completed = ledger.find(
    (entry) => entry.kind === "turn.completed" && entry.sequence > started,
  )?.sequence;
  return { accepted, started, ...(completed === undefined ? {} : { completed }) };
}

export function crossCheckLedger(input: {
  commandId: string;
  envelopes: readonly RecordedEnvelope[];
  frames: readonly LedgerFrame[];
  ledger: RawTurn["ledger"];
}): LedgerCrossCheck {
  const arrival = new Map(input.frames.map((frame) => [frame.sequence, frame.arrivedAt]));
  const side = (sequence: number | undefined): LedgerSide | undefined =>
    sequence === undefined ? undefined : { sequence, arrivedAt: arrival.get(sequence) ?? null };
  const { started, completed } = ledgerWindow(input.commandId, input.ledger);
  const inTurn = input.ledger.filter(
    (entry) =>
      started !== undefined &&
      completed !== undefined &&
      entry.sequence > started &&
      entry.sequence < completed,
  );
  const usage = inTurn.filter((entry) => entry.kind === "usage.recorded");
  const opened = inTurn.find((entry) => entry.kind === "interaction.opened");
  const ledgerFacts: Record<CrossCheckFact, LedgerSide | undefined> = {
    "turn-start": side(started),
    "first-attempt": side(usage[0]?.sequence),
    "authority-answer": side(
      inTurn.find((entry) => entry.kind === "interaction.resolved")?.sequence,
    ),
    compaction: side(inTurn.find((entry) => entry.kind === "context.compacted")?.sequence),
    "final-attempt": side(usage.at(-1)?.sequence),
    "turn-end": side(completed),
  };
  const envelopeFacts: Record<CrossCheckFact, RecordedEnvelope | undefined> = {
    "turn-start": envelopeOf(input.envelopes, (event) => event.kind === "turn-queue"),
    "first-attempt": envelopeOf(input.envelopes, (event) => event.kind === "provider-attempt"),
    "authority-answer": envelopeOf(input.envelopes, hasWait),
    compaction: envelopeOf(input.envelopes, (event) => event.kind === "compaction"),
    "final-attempt": envelopeOf(
      input.envelopes,
      (event) => event.kind === "provider-attempt",
      "last",
    ),
    "turn-end": envelopeOf(
      input.envelopes,
      (event) => event.kind === "turn" && event.outcome !== "interrupted",
    ),
  };
  const paired = CROSS_CHECK_FACTS.filter(
    (fact) => ledgerFacts[fact] !== undefined && envelopeFacts[fact] !== undefined,
  );
  const missing = CROSS_CHECK_FACTS.filter((fact) => !paired.includes(fact));

  let orderInversions = 0;
  for (const [index, left] of paired.entries()) {
    for (const right of paired.slice(index + 1)) {
      const byEnvelope = Math.sign(envelopeFacts[left]!.order - envelopeFacts[right]!.order);
      const byLedger = Math.sign(ledgerFacts[left]!.sequence - ledgerFacts[right]!.sequence);
      if (byEnvelope !== byLedger) orderInversions += 1;
    }
  }

  const causalityViolations: string[] = [];
  for (const fact of ["turn-start", "compaction", "turn-end"] as const) {
    const envelope = envelopeFacts[fact];
    const arrivedAt = ledgerFacts[fact]?.arrivedAt;
    if (envelope === undefined || arrivedAt === undefined || arrivedAt === null) continue;
    if (envelope.recordedAt > arrivedAt)
      causalityViolations.push(`${fact}: envelope after its durable fact`);
  }
  const authority = envelopeFacts["authority-answer"];
  const openedAt = opened === undefined ? undefined : arrival.get(opened.sequence);
  if (authority !== undefined && openedAt !== undefined && authority.recordedAt < openedAt) {
    causalityViolations.push("authority-answer: wait ended before the question arrived");
  }

  const bySequence = new Map(input.ledger.map((entry) => [entry.sequence, entry.kind]));
  const frameSequences = input.frames.map((frame) => frame.sequence);
  const first = frameSequences[0];
  const last = frameSequences.at(-1);
  const streamMatchesLedger =
    first !== undefined &&
    last !== undefined &&
    frameSequences.length === last - first + 1 &&
    frameSequences.every((sequence, index) => sequence === first + index) &&
    input.frames.every((frame) => bySequence.get(frame.sequence) === frame.kind);

  return { paired, missing, orderInversions, causalityViolations, streamMatchesLedger };
}

export interface RealTurnSample extends TurnSample {
  /** Submit → this command's durable `command.recorded` reaching the subscriber. */
  submitToAcceptedMs: number | null;
  /** `command.recorded` → `turn.started`, both as the subscriber received them. */
  acceptedToTurnStartMs: number | null;
  /** Submit → `turn.started` as the subscriber received it. */
  submitToTurnStartFrameMs: number | null;
  /** `turn.started` → `turn.completed`, both as the subscriber received them. */
  turnStartToCompletionMs: number | null;
  /** Submit → `command()` resolving, which the default settle holds to the turn's end. */
  submitToResolvedMs: number | null;
  /** The `turn-queue` envelope → its durable `turn.started` frame: one fact's write-and-publish. */
  turnStartDurableLagMs: number | null;
  /** Authority wait beyond the stand-in's fixed think time. */
  authorityBeyondThinkMs: number | null;
  /** Wait start → the `interaction.opened` frame reaching the stand-in person. */
  questionDeliveryMs: number | null;
  /** The stand-in's `interaction.resolve` command, sent → resolved. */
  answerCommandMs: number | null;
  artifactWriteCount: number;
  artifactWriteTotalMs: number;
  artifactWriteDurationsMs: number[];
  artifactReadCount: number;
  artifactReadTotalMs: number;
  ledgerTransactionCount: number;
  /** The transactions' work plus their BEGIN and COMMIT: the ledger's time on the loop. */
  ledgerServiceTotalMs: number;
  ledgerWaitDurationsMs: number[];
  crossCheck: LedgerCrossCheck;
  /** The durable kinds from `command.recorded` to `turn.completed`, joined. */
  ledgerShape: string;
  /** The turn's own accounting is complete and its harness integrity held. */
  complete: boolean;
}

const round = (value: number): number => Number(value.toFixed(3));
const gap = (from: number | undefined | null, to: number | undefined | null): number | null =>
  from === undefined || from === null || to === undefined || to === null ? null : round(to - from);

export function analyzeRealTurn(raw: RawTurn, sampleId: string): RealTurnSample {
  const events: RecordedFixtureEvent[] = raw.envelopes.map(({ event, recordedAt, order }) => ({
    event,
    recordedAt,
    order,
  }));
  const turnQueue = envelopeOf(raw.envelopes, (event) => event.kind === "turn-queue");
  const base = analyzeTurn({
    sampleId,
    concurrency: raw.concurrency,
    wave: raw.wave,
    submittedAt: raw.submittedAt,
    turnStartedAt: turnQueue?.recordedAt ?? null,
    events,
    localTimerLatenessMs: raw.timers,
    expected: REAL_PATH_EXPECTED,
  });
  const { accepted, started, completed } = ledgerWindow(raw.commandId, raw.ledger);
  const arrival = new Map(raw.frames.map((frame) => [frame.sequence, frame.arrivedAt]));
  const at = (sequence: number | undefined): number | undefined =>
    sequence === undefined ? undefined : arrival.get(sequence);
  const acceptedAt = at(accepted);
  const startedAt = at(started);
  const completedAt = at(completed);

  const authority = envelopeOf(raw.envelopes, hasWait);
  const answer = raw.answers.length === 1 ? raw.answers[0] : undefined;
  const waitMs = base.authorityWaitMs;
  const waitStartedAt =
    authority === undefined || waitMs === null ? undefined : authority.recordedAt - waitMs;

  const writes = raw.artifactCalls.filter((call) => call.op === "write");
  const reads = raw.artifactCalls.filter((call) => call.op === "read");
  const crossCheck = crossCheckLedger(raw);
  const shape = raw.ledger
    .filter(
      (entry) =>
        accepted !== undefined &&
        completed !== undefined &&
        entry.sequence >= accepted &&
        entry.sequence <= completed,
    )
    .map((entry) => entry.kind)
    .join(">");
  const complete =
    !base.gapIncludesMissingSpans &&
    base.toolRoundCount === 1 &&
    crossCheck.missing.length === 0 &&
    raw.receiptStatus === "accepted" &&
    answer?.status === "accepted" &&
    acceptedAt !== undefined &&
    startedAt !== undefined &&
    completedAt !== undefined;

  return {
    ...base,
    submitToAcceptedMs: gap(raw.submittedAt, acceptedAt),
    acceptedToTurnStartMs: gap(acceptedAt, startedAt),
    submitToTurnStartFrameMs: gap(raw.submittedAt, startedAt),
    turnStartToCompletionMs: gap(startedAt, completedAt),
    submitToResolvedMs: gap(raw.submittedAt, raw.resolvedAt),
    turnStartDurableLagMs: gap(turnQueue?.recordedAt, startedAt),
    authorityBeyondThinkMs: waitMs === null ? null : round(waitMs - AUTHORITY_THINK_MS),
    questionDeliveryMs: gap(waitStartedAt, answer?.seenAt),
    answerCommandMs: gap(answer?.sentAt, answer?.resolvedAt),
    artifactWriteCount: writes.length,
    artifactWriteTotalMs: round(writes.reduce((sum, call) => sum + call.durationMs, 0)),
    artifactWriteDurationsMs: writes.map((call) => round(call.durationMs)),
    artifactReadCount: reads.length,
    artifactReadTotalMs: round(reads.reduce((sum, call) => sum + call.durationMs, 0)),
    ledgerTransactionCount: raw.ledgerTransactions.length,
    ledgerServiceTotalMs: round(
      raw.ledgerTransactions.reduce((sum, transaction) => sum + transaction.serviceMs, 0) +
        raw.ledgerBoundaryMs,
    ),
    ledgerWaitDurationsMs: raw.ledgerTransactions.map((transaction) => round(transaction.waitMs)),
    crossCheck,
    ledgerShape: shape,
    complete,
  };
}

/** The per-arm aggregate; every distribution uses individual turns as samples. */
export function summarizeTurns(samples: readonly RealTurnSample[]): Record<string, unknown> {
  const pick = (read: (sample: RealTurnSample) => number | null) => summarize(samples.map(read));
  const timers = (kind: string) =>
    summarize(
      samples.flatMap((sample) =>
        sample.localTimerLateness.flatMap((entry) =>
          entry.kind === kind ? [entry.latenessMs] : [],
        ),
      ),
      { allowNegative: true },
    );
  const shapes = new Map<string, number>();
  for (const sample of samples)
    shapes.set(sample.ledgerShape, (shapes.get(sample.ledgerShape) ?? 0) + 1);
  return {
    turnSampleCount: samples.length,
    completeTurnCount: samples.filter(({ complete }) => complete).length,
    submitToAcceptedMs: pick((sample) => sample.submitToAcceptedMs),
    queuedMs: pick((sample) => sample.submissionToTurnStartMs),
    submitToTurnStartFrameMs: pick((sample) => sample.submitToTurnStartFrameMs),
    acceptedToTurnStartMs: pick((sample) => sample.acceptedToTurnStartMs),
    turnStartDurableLagMs: pick((sample) => sample.turnStartDurableLagMs),
    runtimeTurnMs: pick((sample) => sample.runtimeTurnMs),
    turnStartToCompletionMs: pick((sample) => sample.turnStartToCompletionMs),
    firstMessageToCompletionMs: pick((sample) => sample.firstMessageToCompletionMs),
    submitToResolvedMs: pick((sample) => sample.submitToResolvedMs),
    providerAttemptDurationMs: summarize(
      samples.flatMap((sample) => sample.attempts.map(({ durationMs }) => durationMs)),
    ),
    ttftMs: summarize(samples.flatMap((sample) => sample.attempts.map(({ ttftMs }) => ttftMs))),
    providerPerTurnMs: pick((sample) => sample.providerDurationMs),
    toolsByName: Object.fromEntries(
      Object.keys(REAL_PATH_EXPECTED.toolsByName).map((toolId) => [
        toolId,
        summarize(samples.map((sample) => sample.toolsByName[toolId]?.durationMs ?? null)),
      ]),
    ),
    authorityWaitMs: pick((sample) => sample.authorityWaitMs),
    authorityBeyondThinkMs: pick((sample) => sample.authorityBeyondThinkMs),
    questionDeliveryMs: pick((sample) => sample.questionDeliveryMs),
    answerCommandMs: pick((sample) => sample.answerCommandMs),
    compactionDurationMs: pick((sample) => sample.compactionDurationMs),
    unaccountedGapMs: pick((sample) => sample.unaccountedGapMs),
    firstMessageUnaccountedGapMs: pick((sample) => sample.firstMessageUnaccountedGapMs),
    artifactWritesPerTurn: pick((sample) => sample.artifactWriteCount),
    artifactWriteMs: summarize(samples.flatMap((sample) => sample.artifactWriteDurationsMs)),
    artifactWriteTotalPerTurnMs: pick((sample) => sample.artifactWriteTotalMs),
    artifactReadsPerTurn: pick((sample) => sample.artifactReadCount),
    artifactReadTotalPerTurnMs: pick((sample) => sample.artifactReadTotalMs),
    ledgerTransactionsPerTurn: pick((sample) => sample.ledgerTransactionCount),
    ledgerServicePerTurnMs: pick((sample) => sample.ledgerServiceTotalMs),
    ledgerTransactionWaitMs: summarize(samples.flatMap((sample) => sample.ledgerWaitDurationsMs)),
    timerLatenessMs: {
      ttft: timers("ttft"),
      completion: timers("completion"),
      authority: timers("authority"),
    },
    vc119OrderViolations: samples.reduce((sum, sample) => sum + sample.eventOrderViolations, 0),
    crossCheck: {
      turnsWithAllFactsPaired: samples.filter(({ crossCheck }) => crossCheck.missing.length === 0)
        .length,
      orderInversions: samples.reduce((sum, sample) => sum + sample.crossCheck.orderInversions, 0),
      causalityViolations: samples.reduce(
        (sum, sample) => sum + sample.crossCheck.causalityViolations.length,
        0,
      ),
      streamMismatches: samples.filter(({ crossCheck }) => !crossCheck.streamMatchesLedger).length,
    },
    ledgerShapes: [...shapes.entries()].map(([shape, turns]) => ({ shape, turns })),
  };
}

export type { Distribution };
