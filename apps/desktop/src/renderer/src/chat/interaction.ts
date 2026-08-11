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
  SESSION_ESCALATION_STOP_ID,
  SESSION_REFUSAL_OPTION_IDS,
  type SessionEventPayload,
  type SessionInteraction,
  type SessionInteractionAnswer,
  type SessionInteractionOption,
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

// `continue` is an escalation's permitting side. What it permits is the turn and
// never the call — a non-overridable block refuses the call whichever option is
// chosen — but every rule below asks the narrower question of which side of the
// card an option sits on, and on that question it is the yes.
const ALLOW_OPTION_IDS = new Set(["once", "allow", "approve", "accept", "yes", "continue"]);
const STANDING_OPTION_IDS = new Set(["always", "always_allow", "alwaysallow", "remember"]);
/**
 * Wider than `SESSION_REFUSAL_OPTION_IDS`, and it must stay wider.
 *
 * An escalation's `stop` is the refusing side of the card: the verdict whose
 * words matter, the one the text box opens behind, and the one whose presence
 * saves the card from minting an out-of-band refusal beside two real options.
 * None of that makes it a refusal on the wire. `askChoice` tests the shared
 * refusal ids *before* it tests `stop`, so moving this id into that array would
 * resolve every "Stop the turn" to `refuse` and the turn would never stop.
 *
 * So the asymmetry is the point rather than an oversight: that set answers what
 * the runtime does with a decision, this one answers how the card is drawn and
 * answered, and only the second one has room for an id that is refusal-shaped
 * without being a refusal.
 */
const REJECT_OPTION_IDS = new Set([...SESSION_REFUSAL_OPTION_IDS, SESSION_ESCALATION_STOP_ID]);

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
 * follows what the harness accepts and what has been chosen — the answer itself
 * where `custom` was declared, a note beside a declared verdict, the redirection
 * everywhere else.
 *
 * The role changes what the field is *for*; it never gates
 * {@link canSubmitInteraction}. Requiring words before a refusal can land would
 * leave "no" unsayable, which is the deadlock this whole surface exists to
 * remove.
 */
export type InteractionFieldRole = "answer" | "note" | "redirection";

/**
 * How this question's words reach the harness — which is the whole of the
 * "none of these work" decision, and it is the harness's to make, not ours.
 *
 * Every question gets a box. What differs is where the words go:
 *
 * - `answer` — the prompt declared `custom`, so free text is an ordinary entry
 *   in *that question's own* answer array. The words are a real answer on the
 *   wire and travel with the rest of the submission.
 * - `note` — the prompt declares a refusal among its options, which makes it a
 *   permission; a permission reply carries a `message` beside the verdict, so
 *   the words ride the decision itself.
 * - `message` — nothing on the wire takes them. `answers` is an array of
 *   *selected labels* and has no custom field, so words here would claim a
 *   choice the prompt never offered and an adapter would drop them. They travel
 *   instead as what they are: the ask is refused, and the words are sent as the
 *   next message, so the agent acts on them immediately.
 *
 * The last one is why the affordance can be offered unconditionally. It used to
 * be gated on `custom || declares a refusal`, so a question that declared
 * neither had no way to redirect at all — the reader could only pick something
 * they had already decided was wrong.
 */
export type InteractionTextCarrier = "answer" | "note" | "message";

export function promptTextCarrier(prompt: SessionInteractionPrompt): InteractionTextCarrier {
  // A declared refusal is read *before* `custom`, because a prompt carrying both
  // is still a permission, and a permission reply has no free-text answer slot:
  // it takes a verdict and a `message` beside it. Reading that prompt as
  // `answer` promised the words a place in an answer array the reply never
  // sends, and the note went with them.
  if (prompt.options.some((option) => optionPolarity(option) === "reject")) return "note";
  if (prompt.custom) return "answer";
  return "message";
}

export function promptFieldRole(
  prompt: SessionInteractionPrompt,
  draft: InteractionDraft,
): InteractionFieldRole {
  const carrier = promptTextCarrier(prompt);
  if (carrier === "answer") return "answer";
  // Words that only a following message can carry are the redirection by
  // definition: there is no declared answer they could be a note on.
  if (carrier === "message") return "redirection";
  const { optionIds } = promptDraft(draft, prompt.id);
  const rejected = prompt.options.some(
    (option) => optionIds.includes(option.id) && optionPolarity(option) === "reject",
  );
  return rejected ? "redirection" : "note";
}

/**
 * Whether the box stands open, or waits behind a control of its own.
 *
 * That a reader can always say "none of these work" is settled; *how much of
 * the card that costs before they want to* is not. The box is open wherever the
 * words are a way of answering — the prompt declares `custom`, so they are the
 * answer, or nothing but a following message can carry them, so the box is the
 * only escape the question has.
 *
 * A permission is the exception, and it is the commonest card in the app: three
 * declared verdicts are the whole of the ordinary case, so an empty box is the
 * tallest thing on screen in the one interaction nobody types into. It opens
 * the moment a refusal is chosen, which is the answer whose words matter.
 */
export function promptFieldOpen(
  prompt: SessionInteractionPrompt,
  draft: InteractionDraft,
): boolean {
  if (promptTextCarrier(prompt) !== "note") return true;
  return promptFieldRole(prompt, draft) === "redirection";
}

/**
 * Whether a redirection has superseded the options on this card.
 *
 * Saying "none of these work" and choosing one of them are contradictory, and
 * the contradiction resolves toward the words: {@link interactionSubmission}
 * refuses, and a refusal is the empty resolution. The card dims what the refusal
 * discards rather than leaving it live and silently throwing it away at submit.
 *
 * **Card-wide, because the refusal is.** A resolution carries one `answers`
 * array, so there is no partial resolution to send: words typed on the second
 * question of three discard the first and third as surely as their own. Asked
 * per prompt, this dimmed only the question in view, so a reader answered Q1 and
 * Q3, typed into Q2, and submitted an all-empty resolution while two ticked
 * answers still stood lit beside it.
 */
export function interactionRedirected(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): boolean {
  return redirectMessage(interaction, draft) !== null;
}

/**
 * Whether this question's own words are discarded too.
 *
 * A redirection is made of the responses only a message can carry, so those
 * travel; an answer or a note beside them goes with the refusal like every
 * selection on the card. Separate from {@link interactionRedirected} because the
 * box the redirection is being typed into must stay live — clearing it is how a
 * reader takes the card back.
 */
export function promptResponseSuperseded(
  interaction: SessionInteraction,
  prompt: SessionInteractionPrompt,
  draft: InteractionDraft,
): boolean {
  return interactionRedirected(interaction, draft) && promptTextCarrier(prompt) !== "message";
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
 * Submit is atomic: a resolution carries one `answers` array, so a
 * half-filled card has nothing to send and the button stays inert until every
 * question has been given something.
 *
 * No questions is not "all of them answered". `every` says yes to the empty
 * list, and empty is reachable — a record whose questions never arrived declares
 * `prompts: []`, which `readInteractionPrompts` returns verbatim — so the button
 * went live on a card with nothing on it and sent an empty resolution, which is
 * the shape a refusal is defined by. The exit from a card with nothing to answer
 * is the refusal itself, said deliberately.
 */
export function canSubmitInteraction(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): boolean {
  const prompts = readInteractionPrompts(interaction);
  return prompts.length > 0 && prompts.every((prompt) => isPromptAnswered(prompt, draft));
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
 *
 * Stated as "no question declared one" rather than "every question lacks one",
 * so the answer for a card with no questions at all is reached rather than
 * inherited from `every`'s empty case: nothing declared a refusal, so the card
 * has to mint it — and on a card that can submit nothing, that control is the
 * only exit there is.
 */
export function needsOwnRefusal(interaction: SessionInteraction): boolean {
  return !readInteractionPrompts(interaction).some((prompt) =>
    prompt.options.some((option) => optionPolarity(option) === "reject"),
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

/* ------------------------------------------------------------ what is sent */

/**
 * One press of the card's primary control, as two separate acts.
 *
 * They are separate on purpose. `message` is never folded into `resolution`:
 * the resolution is what the harness's own reply endpoint takes, and a
 * redirection that could not travel on it is an ordinary message sent after it
 * — not a field smuggled into a refusal that is defined by being empty.
 */
export interface InteractionSubmission {
  resolution: SessionInteractionResolution;
  /** Null when the words travelled on the resolution, or when there were none. */
  message: string | null;
}

/**
 * The words no reply endpoint can carry, in prompt order.
 *
 * Joined rather than labelled, the same way {@link interactionResolution} joins
 * responses: a card must not put words in the reader's message that the reader
 * did not type.
 */
export function redirectMessage(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): string | null {
  const said = readInteractionPrompts(interaction).flatMap((prompt) => {
    if (promptTextCarrier(prompt) !== "message") return [];
    const text = promptDraft(draft, prompt.id).response.trim();
    return text.length > 0 ? [text] : [];
  });
  return said.length > 0 ? said.join("\n\n") : null;
}

/**
 * Refusing, with whatever redirection was typed beside it.
 *
 * The resolution is still {@link refusalResolution} and nothing else, so the
 * property that matters holds: a no selects nothing and says nothing, and no
 * harness value can impersonate it. The words leave separately.
 */
export function refusalSubmission(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): InteractionSubmission {
  return {
    resolution: refusalResolution(interaction),
    message: redirectMessage(interaction, draft),
  };
}

/**
 * What the primary control sends, or null while it has nothing to send.
 *
 * A redirection outranks the answers beside it, which is the same precedence a
 * refusal already has when read back: what the reader said no to is the fact the
 * transcript owes them. So typed words that only a message can carry refuse the
 * ask and travel after it, and the selections they contradict go with the
 * refusal rather than beside it.
 */
export function interactionSubmission(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): InteractionSubmission | null {
  const redirect = redirectMessage(interaction, draft);
  if (redirect !== null) return { resolution: refusalResolution(interaction), message: redirect };
  if (!canSubmitInteraction(interaction, draft)) return null;
  return { resolution: interactionResolution(interaction, draft), message: null };
}

/**
 * Whether choosing this option is the whole decision, so the card can send it
 * on the click instead of asking for it twice.
 *
 * Answering a permission is the most frequent gesture in the app and it used to
 * cost one click. A radio plus a generic confirm doubles it on every turn, and
 * the confirm adds nothing: there is one question, and the option says what it
 * does.
 *
 * Scoped to the case where the click really is the whole answer — one question,
 * one choice, no free text riding along, nothing already typed — and to an
 * option whose polarity we recognize. A harness question's option ids are its
 * own encoded values and mean nothing to us, so those still wait for Submit.
 *
 * `standing` and `reject` are excluded deliberately. A standing grant consents
 * to every future call of its kind and must never be the cheapest thing on the
 * card; a refusal is the verdict whose words matter, and sending it on the
 * click takes the box away before it can be typed in.
 */
export function optionSubmitsOnSelect(
  interaction: SessionInteraction,
  prompt: SessionInteractionPrompt,
  option: SessionInteractionOption,
  draft: InteractionDraft,
): boolean {
  if (readInteractionPrompts(interaction).length !== 1) return false;
  if (prompt.multiple || prompt.custom) return false;
  if (promptDraft(draft, prompt.id).response.trim().length > 0) return false;
  return optionPolarity(option) === "allow";
}

/**
 * What the primary control says it will do.
 *
 * Three states, and none of them is a sentence:
 *
 * - **Nothing to send.** A request with several questions has a counter saying
 *   what is left; one question has nothing else on the card that could, so the
 *   control names the act it is waiting for rather than sitting inert under a
 *   word for a press that cannot happen.
 * - **Words that only a message can carry.** They refuse the ask and travel
 *   after it, so the press is a send.
 * - **A declared verdict.** It names itself: "Allow always" says what the press
 *   does and "Submit" does not. A question's labels are answers rather than
 *   verdicts — the ids are the harness's own encoded values — so those keep the
 *   neutral word, and so does a request that asked more than one thing.
 */
export function interactionSubmitLabel(
  interaction: SessionInteraction,
  draft: InteractionDraft,
): string {
  const prompts = readInteractionPrompts(interaction);
  /* v8 ignore next -- a length-1 array's index 0 is never undefined; the fallback is for the wider element type. */
  const only = prompts.length === 1 ? (prompts[0] ?? null) : null;
  const submission = interactionSubmission(interaction, draft);
  if (submission === null) {
    if (only === null) return "Submit";
    return only.options.length > 0 ? "Choose" : "Answer";
  }
  if (submission.message !== null) return "Send";
  if (only === null) return "Submit";
  const chosen = only.options.filter((option) =>
    promptDraft(draft, only.id).optionIds.includes(option.id),
  );
  const verdict = chosen.length === 1 ? chosen[0] : undefined;
  return verdict && optionPolarity(verdict) !== "answer" ? verdict.label : "Submit";
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
 * The flat `optionIds` are the union in prompt order, which is exactly what an
 * adapter decodes back into per-question answers — the option ids
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
 * What is *not* free is submitting — a resolution carries one `answers` array,
 * so the card is atomic and {@link canSubmitInteraction} still holds
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
 * Matched on the id the harness put on both sides: a harness keys a permission
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
  // Each answer's ids are read against its *own* question's options, which is
  // the whole of why `answers` is carried: filtering one flat union against one
  // prompt's list keeps the first question's labels and silently drops every
  // other question's. The interaction's flat options are the fallback, and only
  // for a resolution stored before `answers` existed — its ids belong to no
  // prompt this record can name.
  const chosen =
    answers.length > 0
      ? answers.flatMap((answer) => {
          const declared =
            prompts.find((candidate) => candidate.id === answer.promptId)?.options ?? [];
          return answer.optionIds.flatMap((id) => {
            const option =
              declared.find((candidate) => candidate.id === id) ??
              interaction.options.find((candidate) => candidate.id === id);
            return option ? [option] : [];
          });
        })
      : // No answers to read against at all — a record whose questions never
        // arrived, or one an adapter answered none of. The flat ids are what is
        // left of the decision, and naming them from the interaction's own
        // options is the fallback each answer already has.
        resolution.optionIds.flatMap((id) => {
          const option = interaction.options.find((candidate) => candidate.id === id);
          return option ? [option] : [];
        });
  const chose = (polarity: InteractionOptionPolarity) =>
    chosen.some((option) => optionPolarity(option) === polarity);
  // The out-of-band refusal, read back the same way the adapter routes it: a
  // resolution that selected nothing and said nothing is a no, not an empty
  // answer, and the transcript has to record which of those happened.
  //
  // Read off the resolution first, which is total, and only then per answer.
  // `answers.every` alone says yes to the empty list, and empty is reachable and
  // stored intact: an adapter that answered no prompts writes `answers: []`, and
  // a record whose questions never arrived projects none to synthesize one
  // against. A decision that plainly selected something then read back as "You
  // rejected" — the one reading a transcript must never invent.
  const declined =
    resolution.optionIds.length === 0 &&
    (resolution.response ?? "") === "" &&
    answers.every((answer) => answer.optionIds.length === 0 && (answer.response ?? "") === "");
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
 *
 * **`answers` is read, not re-derived.** The runtime writes the whole
 * resolution to the artifact, so the per-question answers are already there.
 * Decoding only the flat pair threw them away and left the receipt to
 * `readInteractionAnswers`'s fallback, which stamps the flattened union onto
 * the first prompt — so a two-question request rendered as one question's
 * labels and every later answer vanished from the transcript.
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
    const answers = readStoredAnswers(data?.answers);
    const resolution: SessionInteractionResolution = {
      optionIds: optionIds.filter((id): id is string => typeof id === "string"),
      response: typeof data?.response === "string" ? data.response : null,
    };
    return { interactionId, resolution: answers ? { ...resolution, answers } : resolution };
  }
  return null;
}

/**
 * The per-question answers a stored resolution carries, or undefined where it
 * carries none we can read.
 *
 * Undefined rather than an empty array on purpose: that is the value
 * `readInteractionAnswers` treats as "not written with answers", so a record
 * from before the field existed keeps its flat reading instead of projecting as
 * an interaction that was answered with nothing — which is how a refusal reads.
 */
function readStoredAnswers(value: unknown): readonly SessionInteractionAnswer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const answers = value.flatMap((entry) => {
    const promptId = stringField(entry, "promptId");
    if (promptId === null || !isRecord(entry) || !Array.isArray(entry.optionIds)) return [];
    return [
      {
        promptId,
        optionIds: entry.optionIds.filter((id): id is string => typeof id === "string"),
        response: typeof entry.response === "string" ? entry.response : null,
      },
    ];
  });
  return answers.length > 0 ? answers : undefined;
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  /* v8 ignore next -- the sole call site already narrowed `value` to a record via `stringField`'s own match. */
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
