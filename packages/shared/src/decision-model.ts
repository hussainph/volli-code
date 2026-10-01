/**
 * Decision models (VC-478): the second model kind, beside the chat model.
 *
 * A decision model is a classifier. It reads a JSON **state** and answers named,
 * typed **questions** — one of N (`choice`), a level on a scale (`score`), or
 * yes/no (`bool`) — with probabilities and a confidence, and it generates no
 * text at all. That is what makes it cheap and fast where a chat model would
 * spend a whole turn on a one-word answer. pi-ai 0.99 provides the models
 * (TypeSafe's Jev and its peers, or any chat model served by a local
 * llama.cpp server); this module is Volli's vocabulary for them, and the only
 * place the product rules about them are stated.
 *
 * Pure and shared for the reason `model-access-policy.ts` is: main stores and
 * enforces these values, the renderer's Settings and the agent runtime's tool
 * read the same words, and a rule that existed in only one process would be
 * two policies wearing one name.
 *
 * ## The rules, each stated once below
 *
 * - **Nothing calls a model nobody configured.** The setting defaults to
 *   `none`, and `none` answers every caller with a {@link DecisionMiss}.
 * - **Cloud needs an opt-in, per purpose.** A cloud setting carries the
 *   purposes the person agreed to send off this Mac. A purpose the opt-in does
 *   not name is unavailable — so a purpose added by a later build (VC-28's
 *   `authority.judge`, VC-432's `model.select`) is never covered by an opt-in
 *   given before it existed.
 * - **Local means this Mac.** A local server is addressed by a loopback URL
 *   only; anything else would send the state off the machine while Settings
 *   said it stays.
 * - **Every caller has a deterministic fallback.** {@link DecisionCall} cannot
 *   be written without one, and the port answers with it whenever the model
 *   is unset, unreachable, slow, wrong-shaped or refused.
 * - **Every caller is named.** {@link DecisionPurpose} is a closed set, so
 *   enablement, timeouts, metrics and audit are per purpose.
 * - **No credential crosses here.** Nothing in this vocabulary has a field a
 *   key could occupy. Cloud credentials live in Pi's own `auth.json` and are
 *   entered by a person through Model Access sign-in.
 */

import { classifyWebAddress } from "./web-address-policy";

// ---- purposes ---------------------------------------------------------------

/**
 * Every caller of the decision port, by name.
 *
 * A closed set on purpose: a caller that is not on it cannot call. Adding one
 * is a row in {@link DECISION_PURPOSE_POLICY} — its label, what it sends, its
 * timeout and whether it needs an audit trail — and nothing else in the port
 * changes. VC-28 adds `authority.judge` (audited); VC-432 adds `model.select`.
 */
export const DECISION_PURPOSES = ["agent.classify", "model.select"] as const;
export type DecisionPurpose = (typeof DECISION_PURPOSES)[number];

/**
 * The purposes a cloud model's first opt-in covers. A purpose outside this set
 * is a feature a person switches on by itself (`model.select`, VC-432): choosing
 * a cloud decision model must not also start sending every new chat's first
 * message to it, so the opt-in dialog names only these and the feature's own
 * switch extends the opt-in once, when it is turned on.
 */
export const DECISION_BASE_PURPOSES: readonly DecisionPurpose[] = Object.freeze(["agent.classify"]);

export function isDecisionPurpose(value: unknown): value is DecisionPurpose {
  return typeof value === "string" && (DECISION_PURPOSES as readonly string[]).includes(value);
}

/** What one purpose is, sends and may wait for. */
export interface DecisionPurposePolicy {
  /** How Settings names the feature in the cloud opt-in. */
  label: string;
  /**
   * What this purpose sends to the model, said plainly: the clause the cloud
   * opt-in reads out so a person agrees to a concrete thing.
   */
  sends: string;
  /**
   * The longest a caller of this purpose may be kept waiting, queueing
   * included. Past it the caller gets its fallback. An authority judge waits
   * seconds; an agent's own tool call can afford longer.
   */
  timeoutMs: number;
  /**
   * Whether every decision of this purpose must leave a durable, attributed
   * fact (VC-28's authority verdicts will). The port refuses an audited purpose
   * it has nowhere to record — an unrecorded verdict is worse than none.
   * Routine agent calls are metered as usage and leave no per-call fact.
   */
  audit: boolean;
}

export const DECISION_PURPOSE_POLICY: Readonly<Record<DecisionPurpose, DecisionPurposePolicy>> =
  Object.freeze({
    "agent.classify": Object.freeze({
      label: "The agent classify tool",
      sends:
        "whatever an agent passes the classify tool: Session text, tool results and page content",
      timeoutMs: 30_000,
      audit: false,
    }),
    // A new Session waits on this one, so it gets seconds, not the tool's
    // half minute; past it the Session starts on its configured default.
    "model.select": Object.freeze({
      label: "Automatic model choice",
      sends:
        "the first message of a new chat, a delegated task or an Automation run, with the models you have set up",
      timeoutMs: 2_500,
      audit: false,
    }),
  });

// ---- the setting ------------------------------------------------------------

/** The local servers a decision model can run on. One today: llama.cpp's `llama-server`. */
export const DECISION_LOCAL_SERVERS = ["llama-cpp"] as const;
export type DecisionLocalServer = (typeof DECISION_LOCAL_SERVERS)[number];

/** Where `llama-server` listens unless told otherwise. */
export const DEFAULT_LOCAL_DECISION_URL = "http://127.0.0.1:8080";

/**
 * The person's agreement to send one or more purposes' data to a cloud
 * decision model. Recorded with the setting it covers, so a cloud setting
 * without one cannot exist, and changing the model asks again.
 */
export interface DecisionCloudOptIn {
  /** When the person agreed, epoch ms. */
  acceptedAt: number;
  /** The purposes whose data the person agreed to send. Never empty. */
  purposes: readonly DecisionPurpose[];
}

/**
 * Which decision model a scope uses.
 *
 * - `none` — no decision model. The default; every caller falls back.
 * - `local` — a server on this Mac. `modelId` is what the server is asked for
 *   (llama-server's router mode selects by it; a single-model server ignores it).
 * - `cloud` — a classifier from Pi's catalog, reached with the provider's own
 *   credential, and only for the purposes {@link DecisionCloudOptIn} names.
 */
export type DecisionModelSetting =
  | { kind: "none" }
  | { kind: "local"; server: DecisionLocalServer; baseUrl: string; modelId: string }
  | { kind: "cloud"; providerId: string; modelId: string; optIn: DecisionCloudOptIn };

export const NO_DECISION_MODEL: DecisionModelSetting = Object.freeze({ kind: "none" });

const MAX_IDENTIFIER_CHARS = 512;

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_CHARS &&
    value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why a local server URL cannot be used, or null when it can.
 *
 * Loopback only. "Local" is a promise that the state never leaves this Mac,
 * and a LAN address would break it while the setting still said local. A
 * hostname other than `localhost` is refused for the same reason: what it
 * resolves to is not this module's to know.
 */
export function localDecisionUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter a URL such as http://127.0.0.1:8080.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The server URL must start with http:// or https://.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "The server URL cannot carry a user name or password.";
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    (() => {
      const verdict = classifyWebAddress(host);
      return verdict.outcome === "refuse" && verdict.class === "loopback";
    })();
  return loopback ? null : "A local server must be on this Mac: use localhost, 127.0.0.1 or [::1].";
}

/** The URL as stored: no trailing slash, nothing after the origin and path. */
export function normalizeLocalDecisionUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

function parseOptIn(value: unknown): DecisionCloudOptIn | null {
  if (!isRecord(value)) return null;
  const acceptedAt = value["acceptedAt"];
  const purposes = value["purposes"];
  if (typeof acceptedAt !== "number" || !Number.isFinite(acceptedAt) || acceptedAt < 0) return null;
  if (!Array.isArray(purposes)) return null;
  // Order follows the vocabulary, not the record, so two opt-ins naming the
  // same purposes are the same value. An unknown purpose is a newer build's
  // word and is dropped, never honoured.
  const known = DECISION_PURPOSES.filter((purpose) => purposes.includes(purpose));
  return known.length === 0 ? null : { acceptedAt, purposes: known };
}

/**
 * A stored setting, re-read through this build's rules, or null when it is not
 * one.
 *
 * Only the fields a setting has survive: a stored row carrying anything else —
 * a key a confused writer put there — comes back without it. A cloud setting
 * whose opt-in is missing or covers nothing is not a setting (it would be a
 * cloud call nobody agreed to), and a local URL that is not loopback is not
 * either.
 */
export function parseDecisionModelSetting(value: unknown): DecisionModelSetting | null {
  if (!isRecord(value)) return null;
  switch (value["kind"]) {
    case "none":
      return NO_DECISION_MODEL;
    case "local": {
      const baseUrl = value["baseUrl"];
      const modelId = value["modelId"];
      if (value["server"] !== "llama-cpp" || !isIdentifier(modelId)) return null;
      if (typeof baseUrl !== "string" || localDecisionUrlProblem(baseUrl) !== null) return null;
      return {
        kind: "local",
        server: "llama-cpp",
        baseUrl: normalizeLocalDecisionUrl(baseUrl),
        modelId,
      };
    }
    case "cloud": {
      const providerId = value["providerId"];
      const modelId = value["modelId"];
      const optIn = parseOptIn(value["optIn"]);
      if (!isIdentifier(providerId) || !isIdentifier(modelId) || optIn === null) return null;
      return { kind: "cloud", providerId, modelId, optIn };
    }
    default:
      return null;
  }
}

/**
 * The setting one project's Sessions use: the project's own override, or the
 * app-wide setting when it has none. `null` is "inherit"; a project that
 * stored `none` has turned decision models off for itself.
 */
export function resolveDecisionModelSetting(
  global: DecisionModelSetting,
  project: DecisionModelSetting | null,
): DecisionModelSetting {
  return project ?? global;
}

/**
 * A cloud setting with one purpose switched on or off. Turning a purpose on is
 * the person's act, so the opt-in is re-stamped (main re-stamps it again with
 * its own clock); turning one off keeps the rest, and refuses to leave an
 * opt-in that covers nothing, which would not be a setting at all.
 */
export function withDecisionPurpose(
  setting: Extract<DecisionModelSetting, { kind: "cloud" }>,
  purpose: DecisionPurpose,
  enabled: boolean,
  now: number,
): Extract<DecisionModelSetting, { kind: "cloud" }> | null {
  const next = DECISION_PURPOSES.filter((candidate) =>
    candidate === purpose ? enabled : setting.optIn.purposes.includes(candidate),
  );
  if (next.length === 0) return null;
  return {
    ...setting,
    optIn: { acceptedAt: enabled ? now : setting.optIn.acceptedAt, purposes: next },
  };
}

/** What a cloud model's opt-in says, read out before a person agrees to it. */
export function decisionCloudDisclosure(
  modelLabel: string,
  purposes: readonly DecisionPurpose[] = DECISION_BASE_PURPOSES,
): string {
  const clauses = purposes.map((purpose) => DECISION_PURPOSE_POLICY[purpose].sends);
  return `${modelLabel} runs off this Mac. Using it sends ${clauses.join("; and ")}.`;
}

/**
 * One cloud classifier Settings may offer, from Pi's catalog.
 *
 * Its own list, never a row in the chat catalog: a chat picker that offered a
 * classifier would start a Session no turn can run on (VC-469 filters them
 * out of the chat side, and this is where they went).
 */
export interface DecisionModelCatalogEntry {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  /**
   * `available` when the provider has a credential, `needs-setup` when a
   * person still has to sign in to it under Model Access — the one recovery
   * a cloud model has, and never one an agent can perform.
   */
  state: "available" | "needs-setup";
  /** Catalog price per million input tokens, USD; 0 for a free model. */
  inputUsdPerMillion: number;
  contextWindow: number;
}

// ---- where a call goes ------------------------------------------------------

/** The model one call reaches, resolved from a setting for one purpose. */
export type DecisionTarget =
  | { where: "local"; server: DecisionLocalServer; baseUrl: string; modelId: string }
  | { where: "cloud"; providerId: string; modelId: string };

/** Why a decision was not made, or not believed. Every one of them means "use your fallback". */
export type DecisionMissReason =
  /** No decision model is configured for this scope. */
  | "unset"
  /** A cloud model is configured, but the person did not agree to send this purpose's data. */
  | "not-opted-in"
  /** The configured model cannot be reached as configured: no credential, gone from the catalog. */
  | "needs-setup"
  /** This purpose must leave an audit fact and nothing is wired to record one. */
  | "unaudited"
  /** The request broke a bound or was not well formed. */
  | "invalid-request"
  /** The model did not answer within the purpose's time, queueing included. */
  | "timeout"
  /** The caller withdrew the call. */
  | "aborted"
  /** The model or its server answered with an error, or could not be reached. */
  | "provider-error"
  /** The model answered, but not with an answer to every question asked. */
  | "malformed-answer";

/**
 * A decision that was not made. `unavailable` is configuration — nothing was
 * sent. `error` is a call that was attempted, or refused before it was.
 */
export interface DecisionMiss {
  status: "unavailable" | "error";
  reason: DecisionMissReason;
  /** One sentence for a person or a model. Never provider response text, never a credential. */
  message: string;
}

const UNAVAILABLE_REASONS: ReadonlySet<DecisionMissReason> = new Set([
  "unset",
  "not-opted-in",
  "needs-setup",
  "unaudited",
]);

/** A miss, with its status derived from the reason so the two cannot disagree. */
export function decisionMiss(reason: DecisionMissReason, message: string): DecisionMiss {
  return { status: UNAVAILABLE_REASONS.has(reason) ? "unavailable" : "error", reason, message };
}

/**
 * Where one purpose's calls go under one setting, or the miss that says why
 * they go nowhere. The one place `none` and a missing opt-in become misses.
 */
export function decisionTargetFor(
  setting: DecisionModelSetting,
  purpose: DecisionPurpose,
): { ok: true; target: DecisionTarget } | { ok: false; miss: DecisionMiss } {
  switch (setting.kind) {
    case "none":
      return {
        ok: false,
        miss: decisionMiss("unset", "No decision model is configured (Settings → Models)."),
      };
    case "local":
      return {
        ok: true,
        target: {
          where: "local",
          server: setting.server,
          baseUrl: setting.baseUrl,
          modelId: setting.modelId,
        },
      };
    case "cloud":
      if (!setting.optIn.purposes.includes(purpose)) {
        return {
          ok: false,
          miss: decisionMiss(
            "not-opted-in",
            `The cloud decision model is not enabled for ${DECISION_PURPOSE_POLICY[purpose].label.toLowerCase()}.`,
          ),
        };
      }
      return {
        ok: true,
        target: { where: "cloud", providerId: setting.providerId, modelId: setting.modelId },
      };
  }
}

/**
 * Whether a Session born under this setting is offered the `classify` tool:
 * a decision model is configured and, if it is in the cloud, opted into for
 * the tool's purpose. The one statement of the rule; the desktop asks it at
 * Session birth.
 *
 * Decided once, at birth, and frozen into the Session's tool surface: a
 * setting changed later reaches the next Session, never this one. A cloud
 * model nobody opted into for the tool offers no tool at all. Whether its
 * provider is signed in is NOT part of the rule — a key added later should
 * reach the Session that was waiting for it, and until then each call
 * answers "needs setup", which the agent recovers from by deciding itself.
 */
export function offersClassifyTool(setting: DecisionModelSetting): boolean {
  return decisionTargetFor(setting, "agent.classify").ok;
}

// ---- questions and answers --------------------------------------------------

/** A JSON value a decision state may hold. */
export type DecisionJson =
  | null
  | boolean
  | number
  | string
  | readonly DecisionJson[]
  | { readonly [key: string]: DecisionJson };

/** The state a decision is about: always a JSON object at the top. */
export type DecisionState = { readonly [key: string]: DecisionJson };

/** One of N: the answer is the key of the criterion that fits best. */
export interface DecisionChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option key to what the option means. */
  criteria: Readonly<Record<string, string>>;
}

/** A level on an ordered scale: the answer is the expected level, 0-based. */
export interface DecisionScoreQuestion {
  type: "score";
  instructions: string;
  /** The levels, lowest first. */
  criteria: readonly string[];
}

/** Yes or no. */
export interface DecisionBoolQuestion {
  type: "bool";
  instructions: string;
  criteria: { readonly true: string; readonly false: string };
}

export type DecisionQuestion =
  | DecisionChoiceQuestion
  | DecisionScoreQuestion
  | DecisionBoolQuestion;

/** What a decision is asked: the state, and the questions by name. */
export interface DecisionRequest {
  state: DecisionState;
  questions: Readonly<Record<string, DecisionQuestion>>;
}

/**
 * Every answer carries `confidence` in [0, 1] — how far the distribution is
 * from uniform, TypeSafe's `(n * peak - 1) / (n - 1)` — so a caller holds one
 * threshold whatever the question type.
 */
export interface DecisionChoiceAnswer {
  type: "choice";
  choice: string;
  /** Probability per option key. */
  probabilities: Readonly<Record<string, number>>;
  confidence: number;
}

export interface DecisionScoreAnswer {
  type: "score";
  /** The expected level, a real number in [0, levels - 1]. */
  score: number;
  /** The level nearest {@link score}, and its criterion. */
  level: number;
  label: string;
  confidence: number;
}

export interface DecisionBoolAnswer {
  type: "bool";
  /** Whether `true` is the likelier answer: `probability >= 0.5`. */
  value: boolean;
  /** The probability of `true`. */
  probability: number;
  confidence: number;
}

export type DecisionAnswer = DecisionChoiceAnswer | DecisionScoreAnswer | DecisionBoolAnswer;

/**
 * Every bound a request is held to, before anything is sent.
 *
 * Sized to the models: Jev reads 32k tokens, so 32 KiB of JSON state leaves
 * room for the questions; llama-cpp-classify labels at most 62 options and 10
 * levels, and a choice over more than 32 options is a search, not a decision.
 */
export const DECISION_LIMITS = Object.freeze({
  /** UTF-8 bytes of the state as JSON. */
  stateMaxBytes: 32 * 1024,
  /** Nesting depth of the state. */
  stateMaxDepth: 32,
  questionsMax: 16,
  /** Question names are identifiers, so a script reads `answers.approved`. */
  questionIdMaxChars: 64,
  choicesMin: 2,
  choicesMax: 32,
  choiceKeyMaxChars: 64,
  scoreLevelsMin: 2,
  scoreLevelsMax: 10,
  instructionsMaxChars: 2_000,
  criterionMaxChars: 500,
});

/** Calls in flight at once, per purpose; the rest queue inside their own timeout. */
export const DECISION_MAX_CONCURRENT = 4;

const QUESTION_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names an object key cannot safely be: assigning `__proto__` replaces a
 * prototype instead of adding a question, and the other two read as members
 * of every object. A question or option by one of these names is refused
 * rather than silently dropped from the request.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** A value held to its bounds, or the first bound it broke, in one sentence. */
export type DecisionCheck<T> = { ok: true; value: T } | { ok: false; problem: string };

function textProblem(value: unknown, what: string, max: number): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return `${what} must be text.`;
  return value.length > max ? `${what} is over ${max} characters.` : null;
}

/** Walks the state once: JSON only, finite numbers, bounded depth. */
function jsonProblem(value: unknown, depth: number): string | null {
  if (depth > DECISION_LIMITS.stateMaxDepth) {
    return `The state is nested more than ${DECISION_LIMITS.stateMaxDepth} levels deep.`;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : "The state holds a number JSON cannot carry.";
  }
  const children = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : null;
  if (children === null) return "The state must be plain JSON.";
  for (const child of children) {
    const problem = jsonProblem(child, depth + 1);
    if (problem !== null) return problem;
  }
  return null;
}

function checkState(value: unknown): DecisionCheck<DecisionState> {
  if (!isRecord(value)) return { ok: false, problem: "The state must be a JSON object." };
  const problem = jsonProblem(value, 1);
  if (problem !== null) return { ok: false, problem };
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > DECISION_LIMITS.stateMaxBytes) {
    return {
      ok: false,
      problem: `The state is ${bytes} bytes as JSON; the limit is ${DECISION_LIMITS.stateMaxBytes}.`,
    };
  }
  return { ok: true, value: value as DecisionState };
}

function checkQuestion(id: string, value: unknown): DecisionCheck<DecisionQuestion> {
  if (!isRecord(value)) return { ok: false, problem: `Question ${id} must be an object.` };
  const instructions = value["instructions"];
  const problem = textProblem(
    instructions,
    `Question ${id}'s instructions`,
    DECISION_LIMITS.instructionsMaxChars,
  );
  if (problem !== null) return { ok: false, problem };
  const criteria = value["criteria"];
  const criterion = (text: unknown, what: string): string | null =>
    textProblem(text, what, DECISION_LIMITS.criterionMaxChars);
  switch (value["type"]) {
    case "choice": {
      if (!isRecord(criteria)) {
        return { ok: false, problem: `Question ${id} needs criteria: option key to meaning.` };
      }
      const keys = Object.keys(criteria);
      if (keys.length < DECISION_LIMITS.choicesMin || keys.length > DECISION_LIMITS.choicesMax) {
        return {
          ok: false,
          problem: `Question ${id} needs ${DECISION_LIMITS.choicesMin} to ${DECISION_LIMITS.choicesMax} options, not ${keys.length}.`,
        };
      }
      for (const key of keys) {
        if (RESERVED_KEYS.has(key)) {
          return { ok: false, problem: `Question ${id} cannot have an option named ${key}.` };
        }
        if (key.trim().length === 0 || key.length > DECISION_LIMITS.choiceKeyMaxChars) {
          return {
            ok: false,
            problem: `Question ${id} has an option key that is empty or over ${DECISION_LIMITS.choiceKeyMaxChars} characters.`,
          };
        }
        const keyProblem = criterion(criteria[key], `Question ${id}'s option ${key}`);
        if (keyProblem !== null) return { ok: false, problem: keyProblem };
      }
      return {
        ok: true,
        value: {
          type: "choice",
          instructions: instructions as string,
          criteria: criteria as Record<string, string>,
        },
      };
    }
    case "score": {
      if (
        !Array.isArray(criteria) ||
        criteria.length < DECISION_LIMITS.scoreLevelsMin ||
        criteria.length > DECISION_LIMITS.scoreLevelsMax
      ) {
        return {
          ok: false,
          problem: `Question ${id} needs ${DECISION_LIMITS.scoreLevelsMin} to ${DECISION_LIMITS.scoreLevelsMax} levels, lowest first.`,
        };
      }
      for (const [index, level] of criteria.entries()) {
        const levelProblem = criterion(level, `Question ${id}'s level ${index}`);
        if (levelProblem !== null) return { ok: false, problem: levelProblem };
      }
      return {
        ok: true,
        value: {
          type: "score",
          instructions: instructions as string,
          criteria: criteria as string[],
        },
      };
    }
    case "bool": {
      if (!isRecord(criteria)) {
        return { ok: false, problem: `Question ${id} needs criteria with true and false.` };
      }
      for (const side of ["true", "false"] as const) {
        const sideProblem = criterion(criteria[side], `Question ${id}'s ${side} criterion`);
        if (sideProblem !== null) return { ok: false, problem: sideProblem };
      }
      return {
        ok: true,
        value: {
          type: "bool",
          instructions: instructions as string,
          criteria: { true: criteria["true"] as string, false: criteria["false"] as string },
        },
      };
    }
    default:
      return { ok: false, problem: `Question ${id}'s type must be choice, score or bool.` };
  }
}

/**
 * A request held to {@link DECISION_LIMITS}, or the first bound it breaks.
 *
 * Takes `unknown` because its callers do not all hold typed values — a tool
 * call's arguments and a script's are JSON from a model. What comes back is
 * rebuilt from the fields a request has, so nothing else a caller attached
 * (a key, a URL) rides along to the model.
 */
export function checkDecisionRequest(input: unknown): DecisionCheck<DecisionRequest> {
  if (!isRecord(input)) return { ok: false, problem: "A decision request must be an object." };
  const state = checkState(input["state"]);
  if (!state.ok) return state;
  const questions = input["questions"];
  if (!isRecord(questions)) {
    return { ok: false, problem: "questions must be an object: question name to question." };
  }
  const ids = Object.keys(questions);
  if (ids.length === 0 || ids.length > DECISION_LIMITS.questionsMax) {
    return {
      ok: false,
      problem: `Ask between 1 and ${DECISION_LIMITS.questionsMax} questions, not ${ids.length}.`,
    };
  }
  const checked: Array<[string, DecisionQuestion]> = [];
  for (const id of ids) {
    if (
      !QUESTION_ID.test(id) ||
      id.length > DECISION_LIMITS.questionIdMaxChars ||
      RESERVED_KEYS.has(id)
    ) {
      return {
        ok: false,
        problem: `Question name ${JSON.stringify(id.slice(0, 80))} must be an identifier: letters, digits and _, up to ${DECISION_LIMITS.questionIdMaxChars} characters.`,
      };
    }
    const question = checkQuestion(id, questions[id]);
    if (!question.ok) return question;
    checked.push([id, question.value]);
  }
  return { ok: true, value: { state: state.value, questions: Object.fromEntries(checked) } };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  if (!isRecord(raw) || raw["type"] !== question.type) return null;
  switch (question.type) {
    case "bool": {
      const probability = raw["probability"];
      if (!isProbability(probability)) return null;
      return {
        type: "bool",
        value: probability >= 0.5,
        probability,
        confidence: Math.abs(2 * probability - 1),
      };
    }
    case "choice": {
      const choice = raw["choice"];
      const probabilities = raw["probabilities"];
      const confidence = raw["confidence"];
      if (typeof choice !== "string" || !Object.hasOwn(question.criteria, choice)) return null;
      if (!isRecord(probabilities) || !isProbability(confidence)) return null;
      const keys = Object.keys(question.criteria);
      const read: Record<string, number> = {};
      for (const key of keys) {
        const probability = probabilities[key] ?? 0;
        if (!isProbability(probability)) return null;
        read[key] = probability;
      }
      return { type: "choice", choice, probabilities: read, confidence };
    }
    case "score": {
      const score = raw["score"];
      const confidence = raw["confidence"];
      const top = question.criteria.length - 1;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > top) {
        return null;
      }
      if (!isProbability(confidence)) return null;
      const level = Math.round(score);
      return { type: "score", score, level, label: question.criteria[level]!, confidence };
    }
  }
}

/**
 * A model's answers, held to the questions they answer, or null when any
 * question went unanswered or was answered in the wrong shape.
 *
 * All or nothing: a caller that asked three questions and got two has not got
 * a decision, it has got a guess about which part to trust. Bool answers gain
 * `value` and `confidence`, and score answers their nearest level, so every
 * answer can be thresholded and read the same way.
 */
export function readDecisionAnswers(
  questions: Readonly<Record<string, DecisionQuestion>>,
  raw: unknown,
): Record<string, DecisionAnswer> | null {
  if (!isRecord(raw)) return null;
  const answers: Array<[string, DecisionAnswer]> = [];
  for (const [id, question] of Object.entries(questions)) {
    const answer = readAnswer(question, Object.hasOwn(raw, id) ? raw[id] : undefined);
    if (answer === null) return null;
    answers.push([id, answer]);
  }
  return Object.fromEntries(answers);
}

// ---- the port ---------------------------------------------------------------

/** Which model answered, for the caller's record and the person's. */
export interface DecisionModelRef {
  where: "local" | "cloud";
  providerId: string;
  modelId: string;
}

/** A decision that was made. */
export interface DecisionAnswered {
  answers: Readonly<Record<string, DecisionAnswer>>;
  model: DecisionModelRef;
  /** Wall time from the call to the answer, queueing included. */
  elapsedMs: number;
}

/**
 * One call to the decision port.
 *
 * `fallback` is required, and that is the contract: a caller cannot ask for a
 * decision without saying what it does when there is none. It must be
 * deterministic and must not wait on anything — it is what runs when the model
 * is unset, unreachable, slow or wrong. `use` turns the answers into the
 * caller's value; if it throws (an answer the caller cannot act on), the port
 * answers with the fallback instead, as for a malformed answer.
 */
export interface DecisionCall<T> {
  purpose: DecisionPurpose;
  /** The Session the decision is for, which its usage is billed to. */
  sessionId?: string | null;
  /**
   * The project whose setting applies. Absent, the Session's project is used;
   * with neither, the app-wide setting.
   */
  projectId?: string | null;
  state: unknown;
  questions: unknown;
  use(answered: DecisionAnswered): T;
  fallback(miss: DecisionMiss): T;
  signal?: AbortSignal;
}

/**
 * The host decision service, as every caller holds it.
 *
 * Never rejects for a decision that was not made — every such outcome is the
 * caller's own `fallback` — and never waits past the purpose's timeout. It
 * rejects only when `fallback` itself throws, which is a caller bug.
 */
export interface DecisionPort {
  decide<T>(call: DecisionCall<T>): Promise<T>;
}
