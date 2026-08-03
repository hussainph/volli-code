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
 * Whether this question has a box at all — and it only does where the words
 * actually reach the harness.
 *
 * Two shapes qualify. A prompt declaring `custom` accepts free text as an
 * answer, and the OpenCode adapter carries it as an entry in that question's
 * own answer array. A prompt declaring a refusal among its options is a
 * permission, whose reply carries a `message` beside the verdict, so the
 * redirection travels with the no.
 *
 * Nothing else gets one. A question refused out of band (see
 * {@link needsOwnRefusal}) sends `/question/{id}/reject`, which has no body —
 * a box there would take a sentence nobody would ever read. The correction to
 * a refused question is an ordinary message, and the composer comes back the
 * moment the card resolves.
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

/**
 * Whether refusing needs an affordance of the card's own.
 *
 * A permission declares its refusal — `reject` is an id we mint, so selecting
 * it is unambiguous. A question's option ids are the harness's own encoded
 * values, and none of them can mean "no": a question declaring an option
 * literally labelled `reject` would otherwise refuse itself when chosen. So a
 * refusal there is carried out of band, as a resolution that selects nothing
 * and says nothing, which no harness value can impersonate. The card offers it
 * as its own control rather than as a row in a list of answers.
 */
export function needsOwnRefusal(interaction: SessionInteraction): boolean {
  return readInteractionPrompts(interaction).every(
    (prompt) => !prompt.options.some((option) => optionPolarity(option) === "reject"),
  );
}

/**
 * The refusal, which is exactly the empty draft: nothing selected anywhere and
 * nothing typed. Written this way rather than as a literal so it stays one
 * answer per prompt, and so refusing can never send a selection the reader made
 * and then abandoned.
 */
export function refusalResolution(interaction: SessionInteraction): SessionInteractionResolution {
  return interactionResolution(interaction, emptyInteractionDraft(interaction));
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

/**
 * Where the reader is in a request that asked more than one thing.
 *
 * Stacked, three questions with their own options and their own answer rules
 * read as one undifferentiated pile — which is the shape the flat `options`
 * list used to force and the reason `prompts` exists at all. One at a time, with
 * a counter and a step either way, is what a reader can actually hold.
 *
 * **Movement is free.** Stepping never requires an answer and never advances on
 * one: a reader may skip the hard question, answer the last two and come back.
 * What is *not* free is submitting — OpenCode takes one `answers` array per
 * request, so the card is atomic and {@link canSubmitInteraction} still holds
 * the button until every question has been given something.
 *
 * Null for a single question, which must not grow chrome for a position it
 * cannot leave.
 */
export interface InteractionCarousel {
  /** Clamped, so a stale step from a card that shrank cannot land off the end. */
  index: number;
  count: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** Per question, in prompt order — what the counter dims and Submit waits on. */
  answered: readonly boolean[];
}

export function interactionCarousel(
  interaction: SessionInteraction,
  draft: InteractionDraft,
  index: number,
): InteractionCarousel | null {
  const prompts = readInteractionPrompts(interaction);
  if (prompts.length < 2) return null;
  const at = Math.min(Math.max(Math.trunc(index), 0), prompts.length - 1);
  return {
    index: at,
    count: prompts.length,
    hasPrevious: at > 0,
    hasNext: at < prompts.length - 1,
    answered: prompts.map((prompt) => isPromptAnswered(prompt, draft)),
  };
}

/* -------------------------------------------------------------- where it draws */

/**
 * The open interaction a gated call is waiting on.
 *
 * Matched on the id the harness put on both sides: OpenCode keys a permission
 * by its own request id, the adapter stamps that id onto the gated part's
 * `approval` and mints the interaction as `permission:<id>` with the same value
 * in `native.id`. So the correlation is the harness's own, never a guess from
 * adjacency or from there happening to be exactly one of each.
 */
export function interactionForApproval(
  interactions: readonly SessionInteraction[],
  approvalId: string | null,
): SessionInteraction | null {
  if (approvalId === null) return null;
  return interactions.find((interaction) => interaction.native.id === approvalId) ?? null;
}

/**
 * The interaction the foot of the transcript owns: the oldest one no row is
 * already showing.
 *
 * A harness can have several open at once — a subagent's permission while the
 * parent turn waits on its own — and two blocking cards in the composer's slot
 * are two things each claiming to be the one thing to do next. An interaction
 * with no native id can never correlate to a call, so it belongs here by
 * construction rather than by exclusion.
 */
export function footInteraction(
  interactions: readonly SessionInteraction[],
  gatedApprovalIds: ReadonlySet<string>,
): SessionInteraction | null {
  return (
    interactions.find(
      (interaction) =>
        interaction.native.id === null || !gatedApprovalIds.has(interaction.native.id),
    ) ?? null
  );
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
  const answers = readInteractionAnswers(interaction, resolution);
  const chosen = answers.flatMap((answer) => {
    const prompt = prompts.find((candidate) => candidate.id === answer.promptId);
    return (prompt?.options ?? interaction.options).filter((option) =>
      answer.optionIds.includes(option.id),
    );
  });
  const chose = (polarity: InteractionOptionPolarity) =>
    chosen.some((option) => optionPolarity(option) === polarity);
  // The out-of-band refusal, read back the same way the adapter routes it: a
  // resolution that selected nothing and said nothing is a no, not an empty
  // answer, and the transcript has to record which of those happened.
  const declined = answers.every(
    (answer) => answer.optionIds.length === 0 && (answer.response ?? "") === "",
  );
  // A refusal outranks everything else in the same resolution: what a reader
  // said no to is the fact the transcript owes them, even where they answered
  // three other questions in the same submit.
  const verdict =
    declined || chose("reject")
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
  parts: readonly unknown[];
}): InteractionResolutionMessage | null {
  const interactionId = stringField(message.metadata, "interactionId");
  if (interactionId === null) return null;
  for (const part of message.parts) {
    if (stringField(part, "type") !== "data-interaction-resolution") continue;
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
