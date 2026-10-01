/**
 * A network-free classifier provider, and a network-free llama-server, for
 * the decision tests (VC-478).
 *
 * The cloud half is a real Pi provider built with `createProvider({
 * classifiers })` and registered on a real `Models` collection, so a test
 * exercises Pi's own auth resolution and dispatch — only the wire is scripted.
 * The local half is a `fetch` that answers the three llama-server endpoints
 * `llama-cpp-classify` uses, so the real Pi API turns its log-probabilities
 * into answers.
 */

import {
  createModels,
  createProvider,
  type ClassifierContext,
  type ClassifierOptions,
  type ClassifierResult,
  type Models,
} from "@earendil-works/pi-ai";

/** The key the fixture provider resolves. A test proves it never surfaces. */
export const FIXTURE_SECRET = "sk-fixture-SECRET-do-not-echo";

export const FIXTURE_PROVIDER = "fixture";
export const FIXTURE_MODEL = "jev-fixture";

export type FixtureAnswer = (
  context: ClassifierContext,
  options: ClassifierOptions | undefined,
) => Partial<ClassifierResult> | Promise<Partial<ClassifierResult>>;

/** Answers each question the way a confident, correct Jev would for the shared fixtures. */
export const confidentAnswer: FixtureAnswer = (context) => ({
  answers: Object.fromEntries(
    Object.entries(context.questions).map(([id, question]) => {
      if (question.type === "bool") return [id, { type: "bool", probability: 0.92 }];
      if (question.type === "score") {
        return [id, { type: "score", score: question.criteria.length - 1.2, confidence: 0.7 }];
      }
      const keys = Object.keys(question.criteria);
      const probabilities = Object.fromEntries(
        keys.map((key, index) => [key, index === 0 ? 0.85 : 0.15 / (keys.length - 1)]),
      );
      return [id, { type: "choice", choice: keys[0], probabilities, confidence: 0.8 }];
    }),
  ),
  usage: {
    input: 420,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 420,
    cost: { input: 0.0000176, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000176 },
  },
});

export interface FixtureModelsOptions {
  answer?: FixtureAnswer;
  /** Whether the provider resolves a credential. Default true. */
  signedIn?: boolean;
  /** Every request the fixture saw, with the key it was handed. */
  seen?: Array<{ context: ClassifierContext; apiKey: string | undefined }>;
}

/** A `Models` collection holding one scripted classifier provider. */
export function fixtureModels(options: FixtureModelsOptions = {}): Models {
  const answer = options.answer ?? confidentAnswer;
  const models = createModels();
  models.setProvider(
    createProvider({
      id: FIXTURE_PROVIDER,
      name: "Fixture Cloud",
      auth: {
        apiKey: {
          name: "Fixture key",
          resolve: async () =>
            options.signedIn === false ? undefined : { auth: { apiKey: FIXTURE_SECRET } },
        },
      },
      models: [
        {
          type: "classifier",
          id: FIXTURE_MODEL,
          name: "Jev Fixture",
          api: "fixture-classify",
          provider: FIXTURE_PROVIDER,
          baseUrl: "https://fixture.invalid/v1",
          input: ["text"],
          cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
        },
      ],
      classifiers: {
        "fixture-classify": {
          classify: async (model, context, requestOptions) => {
            options.seen?.push({ context, apiKey: requestOptions?.apiKey });
            const partial = await answer(context, requestOptions);
            return {
              api: model.api,
              provider: model.provider,
              model: model.id,
              answers: {},
              stopReason: "stop",
              timestamp: 0,
              ...partial,
            };
          },
        },
      },
    }),
  );
  return models;
}

const LABEL_IDS = new Map<string, number>(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "Yes", "No"].map(
    (label, index) => [label, 100 + index],
  ),
);

/**
 * A `fetch` that is a llama-server, as far as `llama-cpp-classify` can tell:
 * single-token labels, a chat template, and next-token log-probabilities that
 * give `Yes` the probability `yes` and favour `A` and level `2` otherwise.
 * Every path it was asked for lands in `seen`.
 */
export function fakeLlamaServer(yes: number, seen: string[]): typeof globalThis.fetch {
  const handlers: Record<string, (body: Record<string, unknown>) => unknown> = {
    "/tokenize": (body) => {
      const content = String(body["content"]);
      return { tokens: content === "\n" ? [1] : [1, LABEL_IDS.get(content.slice(1))] };
    },
    "/apply-template": (body) => ({
      prompt: (body["messages"] as Array<{ content: string }>)
        .map((message) => message.content)
        .join("\n"),
    }),
    "/completion": (body) => {
      const bool = String(body["prompt"]).endsWith("Answer Yes or No.");
      const top = [...LABEL_IDS].map(([label, id]) => ({
        id,
        logprob: bool
          ? label === "Yes"
            ? Math.log(yes)
            : Math.log(1 - yes)
          : label === "A" || label === "2"
            ? -0.2
            : -4,
      }));
      return { completion_probabilities: [{ top_logprobs: top }] };
    },
  };
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(handlers[path]!(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
