/**
 * Answering an interaction — the pure half.
 *
 * Everything here is a function of a `SessionInteraction` and a draft, so what
 * a card can be answered with is testable without mounting one. The JSX in
 * `interaction-ui.tsx` owns only how it looks; these rules are what an app port
 * reuses when the surface moves out of the lab.
 *
 * Two invariants the whole module rests on:
 *
 *  1. **Prompts are read, never inferred.** `readInteractionPrompts` is total
 *     over stored records with and without `prompts`, so nothing here branches
 *     on their absence and a permission written before the field existed still
 *     projects as one prompt with three options.
 *  2. **Polarity is matched, never assumed.** `SessionInteractionOption` has no
 *     field saying "this one is the no", so the vocabulary below is checked
 *     against the ids a harness actually declared. An id we do not recognize is
 *     an ordinary answer, which is the reading that cannot turn a refusal into
 *     consent.
 */
import {
  readInteractionAnswers,
  readInteractionPrompts,
  type SessionEventPayload,
  type SessionInteraction,
  type SessionInteractionAnswer,
  type SessionInteractionPrompt,
  type SessionInteractionResolution,
} from "@volli/shared";

/* ---------------------------------------------------------------- polarity */

/**
 * What choosing an option means.
 *
 * `standing` is the one that is not simply a louder `allow`: it grants consent
 * for every future call of its kind, so it can never carry the same weight as
 * the one-time yes sitting beside it.
 */
export type InteractionOptionPolarity = "allow" | "standing" | "reject" | "answer";

const ALLOW_OPTION_IDS = new Set(["once", "allow", "approve", "accept", "yes"]);
const STANDING_OPTION_IDS = new Set(["always", "always_allow", "alwaysallow", "remember"]);
const REJECT_OPTION_IDS = new Set(["reject", "deny", "decline", "no", "cancel"]);

export function optionPolarity(option: { id: string }): InteractionOptionPolarity {
  const id = option.id.toLowerCase();
  if (STANDING_OPTION_IDS.has(id)) return "standing";
  if (ALLOW_OPTION_IDS.has(id)) return "allow";
  if (REJECT_OPTION_IDS.has(id)) return "reject";
  return "answer";
}

/* ------------------------------------------------------------------ draft */

/** One prompt's answer as it is being written. */
export interface InteractionPromptDraft {
  optionIds: readonly string[];
  response: string;
}

/** Keyed by prompt id, because that is the identity an answer is stamped with. */
export type InteractionDraft = Readonly<Record<string, InteractionPromptDraft>>;

const EMPTY_PROMPT_DRAFT: InteractionPromptDraft = { optionIds: [], response: "" };

/**
 * Nothing is preselected, and that is deliberate for a blocking card: a default
 * choice on a permission means one stray Enter grants it.
 */
export function emptyInteractionDraft(interaction: SessionInteraction): InteractionDraft {
  const draft: Record<string, InteractionPromptDraft> = {};
  for (const prompt of readInteractionPrompts(interaction)) draft[prompt.id] = EMPTY_PROMPT_DRAFT;
  return draft;
}

/** Total: a prompt with nothing written for it yet reads as empty, not missing. */
export function promptDraft(draft: InteractionDraft, promptId: string): InteractionPromptDraft {
  return draft[promptId] ?? EMPTY_PROMPT_DRAFT;
}

/**
 * A prompt declaring `multiple` accumulates its options and can drop one again;
 * one that does not is a radio, and a radio has no un-choosing — only another
 * option replaces it. Clicking the selected option again must not leave the card
 * unanswerable.
 */
export function selectOption(
  draft: InteractionDraft,
  prompt: SessionInteractionPrompt,
  optionId: string,
): InteractionDraft {
  const current = promptDraft(draft, prompt.id);
  const held = current.optionIds.includes(optionId);
  const optionIds = prompt.multiple
    ? held
      ? current.optionIds.filter((id) => id !== optionId)
      : [...current.optionIds, optionId]
    : [optionId];
  return { ...draft, [prompt.id]: { ...current, optionIds } };
}

export function setPromptResponse(
  draft: InteractionDraft,
  promptId: string,
  response: string,
): InteractionDraft {
  return { ...draft, [promptId]: { ...promptDraft(draft, promptId), response } };
}

/* -------------------------------------------------------------- the field */

/**
 * What the one text box is for right now.
 *
 * One box, not two: a second always-on field would read as a composer inside a
 * card, which is exactly what suppressing the composer was for. Its role
 * follows the current choice — a note beside a declared answer, the redirection
 * beside a refusal, the answer itself where the harness declared `custom` and
 * nothing is selected.
 *
 * The role changes what the field is *for*; it never gates {@link canSubmitInteraction}.
 * Requiring words before a refusal can land would leave "no" unsayable, which is
 * the deadlock this whole surface exists to remove.
 */
export type InteractionFieldRole = "answer" | "note" | "redirection";

/**
 * Whether this question has a box at all.
 *
 * A prompt the harness accepts free text for always does. So does one that can
 * be refused, because a refusal with no direction leaves the agent to guess
 * what to do instead — that is the steer the old card spelled as a third
 * button. A plain multiple choice that can only be answered gets none, so a
 * three-question survey is three lists rather than three boxes nobody fills.
 */
export function promptTakesText(prompt: SessionInteractionPrompt): boolean {
  return prompt.custom || prompt.options.some((option) => optionPolarity(option) === "reject");
}

export function promptFieldRole(
  prompt: SessionInteractionPrompt,
  draft: InteractionDraft,
): InteractionFieldRole {
  const { optionIds } = promptDraft(draft, prompt.id);
  if (optionIds.length === 0) return prompt.custom ? "answer" : "note";
  const rejected = prompt.options.some(
    (option) => optionIds.includes(option.id) && optionPolarity(option) === "reject",
  );
  return rejected ? "redirection" : "note";
}

/* ----------------------------------------------------------------- submit */

/**
 * A prompt is answered by a declared option, or — where the harness accepts one
 * — by free text alone.
 */
export function isPromptAnswered(
  prompt: SessionInteractionPrompt,
  draft: InteractionDraft,
): boolean {
  const answer = promptDraft(draft, prompt.id);
  if (answer.optionIds.length > 0) return true;
  return prompt.custom && answer.response.trim().length > 0;
}

/**
 * Submit is atomic: OpenCode takes one `answers` array per request, so a
 * half-filled card has nothing to send and the button stays inert until every
 * question has been given something.
 */
export function canSubmitInteraction(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): boolean {
  return readInteractionPrompts(interaction).every((prompt) => isPromptAnswered(prompt, draft));
}

export function interactionAnswers(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): SessionInteractionAnswer[] {
  return readInteractionPrompts(interaction).map((prompt) => {
    const answer = promptDraft(draft, prompt.id);
    const response = answer.response.trim();
    return {
      promptId: prompt.id,
      optionIds: [...answer.optionIds],
      response: response.length > 0 ? response : null,
    };
  });
}

/**
 * The answers, plus the flat pair every stored resolution still carries.
 *
 * The flat `optionIds` are the union in prompt order, which is exactly what the
 * OpenCode adapter decodes back into `answers: string[][]` — the option ids
 * encode their own question index, so flattening is lossless rather than a
 * lossy convenience. `answers` rides along for the readers that understand it.
 */
export function interactionResolution(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): SessionInteractionResolution {
  const answers = interactionAnswers(interaction, draft);
  const responses = answers.flatMap((answer) => (answer.response ? [answer.response] : []));
  return {
    optionIds: answers.flatMap((answer) => [...answer.optionIds]),
    // Joined rather than labelled: a card must not put words in the reader's
    // message that the reader did not type.
    response: responses.length > 0 ? responses.join("\n\n") : null,
    answers,
  };
}

/* -------------------------------------------------------------- questions */

/** One question to draw, with the label a card would otherwise say twice removed. */
export interface InteractionQuestion {
  prompt: SessionInteractionPrompt;
  /** Null when the headline already says it. */
  label: string | null;
}

export function interactionQuestions(
  interaction: SessionInteraction,
): readonly InteractionQuestion[] {
  const prompts = readInteractionPrompts(interaction);
  return prompts.map((prompt) => ({
    prompt,
    label: prompts.length === 1 && prompt.label === interaction.title ? null : prompt.label,
  }));
}

/* ---------------------------------------------------------------- receipt */

/**
 * The one line a resolved interaction leaves in scrollback.
 *
 * Built from the interaction *and* its resolution, because a resolution carries
 * option ids and only the interaction knows what those ids were called. The
 * transcript quotes the harness's own words back rather than inventing a
 * summary of them.
 */
export interface InteractionReceipt {
  verdict: "allowed" | "standing" | "rejected" | "answered";
  /** `You allowed`, `You rejected`, … */
  lead: string;
  subject: string;
  /** `once`, `always`, or the labels chosen. Null when the lead says it all. */
  trailer: string | null;
}

const RECEIPT_LEADS: Record<InteractionReceipt["verdict"], string> = {
  allowed: "You allowed",
  standing: "You allowed",
  rejected: "You rejected",
  answered: "You answered",
};

export function describeInteractionResolution(
  interaction: SessionInteraction,
  resolution: SessionInteractionResolution,
): InteractionReceipt {
  const prompts = readInteractionPrompts(interaction);
  const chosen = readInteractionAnswers(interaction, resolution).flatMap((answer) => {
    const prompt = prompts.find((candidate) => candidate.id === answer.promptId);
    return (prompt?.options ?? interaction.options).filter((option) =>
      answer.optionIds.includes(option.id),
    );
  });
  const chose = (polarity: InteractionOptionPolarity) =>
    chosen.some((option) => optionPolarity(option) === polarity);
  // A refusal outranks everything else in the same resolution: what a reader
  // said no to is the fact the transcript owes them, even where they answered
  // three other questions in the same submit.
  const verdict = chose("reject")
    ? "rejected"
    : chose("standing")
      ? "standing"
      : chose("allow")
        ? "allowed"
        : "answered";
  return {
    verdict,
    lead: RECEIPT_LEADS[verdict],
    subject: interaction.title,
    trailer: receiptTrailer(verdict, chosen),
  };
}

function receiptTrailer(
  verdict: InteractionReceipt["verdict"],
  chosen: readonly { label: string }[],
): string | null {
  if (verdict === "allowed") return "once";
  if (verdict === "standing") return "always";
  if (verdict === "rejected") return null;
  const labels = chosen.map((option) => option.label).filter((label) => label.length > 0);
  return labels.length > 0 ? labels.join(", ") : null;
}

/**
 * Every interaction this Session has ever opened, by id.
 *
 * A resolution says which option ids were sent and nothing about what they were
 * called, so a receipt needs the interaction back. `projection.interactions`
 * holds only the open ones — the durable log is where an answered one still
 * exists, and reading it is what lets the receipt quote the harness's own words
 * instead of printing an opaque id.
 */
export function indexOpenedInteractions(
  frames: readonly { event: { payload: SessionEventPayload } }[],
): ReadonlyMap<string, SessionInteraction> {
  const byId = new Map<string, SessionInteraction>();
  for (const frame of frames) {
    const { payload } = frame.event;
    if (payload.kind === "interaction.opened")
      byId.set(payload.interaction.id, payload.interaction);
  }
  return byId;
}

/** A durable answer, at the transcript position where it was given. */
export interface InteractionResolutionMessage {
  interactionId: string;
  resolution: SessionInteractionResolution;
}

/**
 * Whether a transcript message is an answer rather than a line of conversation.
 *
 * Resolving an interaction commits a `user` message whose only part is the
 * resolution, stamped with the interaction it answers. That message is the
 * receipt substrate: it is durable, and it already sits at the point in the
 * conversation where the decision was taken, which is where a receipt belongs.
 *
 * Read structurally and defensively — this crosses the RPC edge as JSON, and a
 * shape we do not recognize reads as "not a resolution" rather than throwing
 * inside a render.
 */
export function readInteractionResolutionMessage(message: {
  metadata?: unknown;
  parts: readonly { type: string }[];
}): InteractionResolutionMessage | null {
  const interactionId = stringField(message.metadata, "interactionId");
  if (interactionId === null) return null;
  for (const part of message.parts) {
    if (part.type !== "data-interaction-resolution") continue;
    const data = objectField(part, "data");
    const optionIds = data?.optionIds;
    if (!Array.isArray(optionIds)) continue;
    return {
      interactionId,
      resolution: {
        optionIds: optionIds.filter((id): id is string => typeof id === "string"),
        response: typeof data?.response === "string" ? data.response : null,
      },
    };
  }
  return null;
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  const nested = isRecord(value) ? value[key] : undefined;
  return isRecord(nested) ? nested : null;
}

function stringField(value: unknown, key: string): string | null {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" && field.length > 0 ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
