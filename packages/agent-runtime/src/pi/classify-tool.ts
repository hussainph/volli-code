/**
 * `classify`: the decision model as an agent's tool (VC-478).
 *
 * One call asks the Session's decision model typed questions about a JSON
 * state and returns, for each, an answer with probabilities and a confidence
 * — never text. That is the point of it: a yes/no or one-of-N decision an
 * agent would otherwise spend a reasoning turn on comes back in milliseconds
 * for a fraction of the tokens, which adds up when the same decision repeats
 * over many items, pages or loop iterations.
 *
 * Shaped for scripts as much as for a model reading the result. The input is
 * plain JSON with identifier question names (`answers.approved.value` reads
 * in a script), and the result is Pi 0.99's native `structuredContent` with a
 * declared `outputSchema`, beside a short text rendering for the model. Code
 * Mode (VC-471) can then loop over items and keep only what it needs.
 *
 * The tool has no side effect and holds no policy: the host's decision port
 * holds the bounds, picks the model, meters the call and answers every miss.
 * A miss — no model configured any more, a slow or failing model, a bound
 * broken — comes back as an error result telling the model to decide for
 * itself, which is the agent's deterministic fallback.
 */

import type { AgentTool, AgentToolResult, JsonValue } from "@earendil-works/pi-agent-core/node";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
  DECISION_LIMITS,
  type DecisionAnswer,
  type DecisionAnswered,
  type DecisionMiss,
  type DecisionMissReason,
  type RuntimeClassifyPort,
} from "@volli/shared";

/** The structured half of a classify result, for the activity row. JSON-safe. */
export interface ClassifyToolDetails {
  /** How many questions were asked, or null when the arguments named none. */
  questions: number | null;
  /** `answered`, or why there was no decision. */
  outcome: "answered" | DecisionMissReason;
  /** `provider/model` that answered, or null for a miss. */
  model: string | null;
  elapsedMs: number | null;
}

const instructions = Type.String({
  description: "The question, as an instruction: what to decide about the state.",
});

const choiceQuestion = Type.Object(
  {
    type: Type.Literal("choice"),
    instructions,
    criteria: Type.Object(
      {},
      {
        additionalProperties: Type.String(),
        description: `Option key to what the option means, ${DECISION_LIMITS.choicesMin} to ${DECISION_LIMITS.choicesMax} options. The answer is one key.`,
      },
    ),
  },
  { description: "Pick one of N options." },
);

const scoreQuestion = Type.Object(
  {
    type: Type.Literal("score"),
    instructions,
    criteria: Type.Array(Type.String(), {
      description: `The levels of the scale, lowest first, ${DECISION_LIMITS.scoreLevelsMin} to ${DECISION_LIMITS.scoreLevelsMax}. The answer is the expected level, 0-based.`,
    }),
  },
  { description: "Place the state on an ordered scale." },
);

const boolQuestion = Type.Object(
  {
    type: Type.Literal("bool"),
    instructions,
    criteria: Type.Object(
      {
        true: Type.String({ description: "What yes means." }),
        false: Type.String({ description: "What no means." }),
      },
      { description: "What each answer means." },
    ),
  },
  { description: "Answer yes or no." },
);

/** What the model may say. The host holds every bound again; this is the shape. */
export const CLASSIFY_PARAMETERS = Type.Object({
  state: Type.Object(
    {},
    {
      additionalProperties: true,
      description: `The JSON object the questions are about: only the facts they need, up to ${DECISION_LIMITS.stateMaxBytes / 1024} KiB as JSON. Never a credential or a secret.`,
    },
  ),
  questions: Type.Object(
    {},
    {
      additionalProperties: Type.Union([choiceQuestion, scoreQuestion, boolQuestion]),
      description: `Question name to question, 1 to ${DECISION_LIMITS.questionsMax}. Names are identifiers (letters, digits, _), so a script can read answers.<name>. Every question is answered against the same state.`,
    },
  ),
});

/** The answers as a script reads them, declared so Code Mode can type them. */
export const CLASSIFY_OUTPUT_SCHEMA: TSchema = Type.Object({
  answers: Type.Object(
    {},
    {
      additionalProperties: Type.Union([
        Type.Object({
          type: Type.Literal("choice"),
          choice: Type.String(),
          probabilities: Type.Object({}, { additionalProperties: Type.Number() }),
          confidence: Type.Number(),
        }),
        Type.Object({
          type: Type.Literal("score"),
          score: Type.Number(),
          level: Type.Number(),
          label: Type.String(),
          confidence: Type.Number(),
        }),
        Type.Object({
          type: Type.Literal("bool"),
          value: Type.Boolean(),
          probability: Type.Number(),
          confidence: Type.Number(),
        }),
      ]),
    },
  ),
  model: Type.Object({
    where: Type.Union([Type.Literal("local"), Type.Literal("cloud")]),
    providerId: Type.String(),
    modelId: Type.String(),
  }),
  elapsedMs: Type.Number(),
});

/**
 * When to reach for it, and when not — the one claim a schema cannot state.
 * Frozen into every Session born with the tool, so it says only what stays
 * true whichever decision model the person configures later.
 */
export const CLASSIFY_DESCRIPTION = [
  "Ask the configured decision model typed questions about a JSON state and get back answers with probabilities and a confidence, never text.",
  "A question is a choice (one option key of several), a score (a level on a scale, lowest first) or a bool (yes or no). Confidence runs from 0 (a guess) to 1 (certain).",
  "Use it for decisions that repeat: labelling or triaging many items, checking which state a page or element is in, filtering inside a loop or a script. It is much faster and cheaper than reasoning each one out yourself.",
  "Do not use it for anything that needs open-ended reasoning, arithmetic, several steps or written output: it cannot explain an answer.",
  "Pass only the facts the questions need. If it reports no decision, decide yourself.",
].join(" ");

/** Two places, trailing zeros dropped: 0.97, 0.6, 1. */
function round(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** One answer, one line: the verdict first, the numbers after. */
export function answerLine(name: string, answer: DecisionAnswer): string {
  switch (answer.type) {
    case "bool":
      return `${name}: ${answer.value ? "yes" : "no"} (p(yes)=${round(answer.probability)}, confidence ${round(answer.confidence)})`;
    case "choice": {
      // The three likeliest, so a near-tie is visible without the whole list.
      const ranked = Object.entries(answer.probabilities)
        .toSorted(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([key, probability]) => `${key} ${round(probability)}`)
        .join(", ");
      return `${name}: ${answer.choice} (${ranked}; confidence ${round(answer.confidence)})`;
    }
    case "score":
      return `${name}: level ${answer.level} "${answer.label}" (score ${round(answer.score)}, confidence ${round(answer.confidence)})`;
  }
}

function answeredText(answered: DecisionAnswered): string {
  return [
    ...Object.entries(answered.answers).map(([name, answer]) => answerLine(name, answer)),
    `Decided by ${answered.model.providerId}/${answered.model.modelId} in ${Math.round(answered.elapsedMs)} ms.`,
  ].join("\n");
}

function missText(miss: DecisionMiss): string {
  return [
    `No decision was made: ${miss.message}`,
    miss.reason === "invalid-request"
      ? "Fix the request and call classify again, or decide yourself."
      : "Decide this yourself, or continue without it.",
  ].join("\n");
}

/**
 * A decision's plain-data shapes as Pi's JSON type. They are JSON by
 * construction — strings, finite numbers, booleans, nested records — and the
 * interfaces only lack the index signature Pi's type asks for.
 */
function json(value: object): JsonValue {
  return value as unknown as JsonValue;
}

function countQuestions(questions: unknown): number | null {
  return typeof questions === "object" && questions !== null && !Array.isArray(questions)
    ? Object.keys(questions).length
    : null;
}

/** Build `classify`, bound to the Session's decision port. */
export function createClassifyTool(
  port: RuntimeClassifyPort,
  attachmentSignal?: AbortSignal,
): AgentTool<typeof CLASSIFY_PARAMETERS, ClassifyToolDetails> {
  return {
    name: "classify",
    label: "classify",
    description: CLASSIFY_DESCRIPTION,
    parameters: CLASSIFY_PARAMETERS,
    // Never sent to a provider: Pi declares name, description and parameters.
    outputSchema: CLASSIFY_OUTPUT_SCHEMA,
    async execute(_toolCallId, params, callSignal): Promise<AgentToolResult<ClassifyToolDetails>> {
      const withdrawn = new AbortController();
      const abandon = (): void => withdrawn.abort();
      const live = [attachmentSignal, callSignal].filter((one) => one !== undefined);
      for (const one of live) {
        if (one.aborted) abandon();
        else one.addEventListener("abort", abandon, { once: true });
      }
      const questions = countQuestions(params.questions);
      try {
        const outcome = await port.classify({
          state: params.state,
          questions: params.questions,
          signal: withdrawn.signal,
        });
        if (outcome.kind === "miss") {
          const { miss } = outcome;
          return {
            content: [{ type: "text", text: missText(miss) }],
            structuredContent: json({ miss }),
            isError: true,
            details: { questions, outcome: miss.reason, model: null, elapsedMs: null },
          };
        }
        const { answered } = outcome;
        return {
          content: [{ type: "text", text: answeredText(answered) }],
          structuredContent: json({
            answers: answered.answers,
            model: answered.model,
            elapsedMs: answered.elapsedMs,
          }),
          details: {
            questions,
            outcome: "answered",
            model: `${answered.model.providerId}/${answered.model.modelId}`,
            elapsedMs: answered.elapsedMs,
          },
        };
      } finally {
        for (const one of live) one.removeEventListener("abort", abandon);
      }
    },
  };
}
