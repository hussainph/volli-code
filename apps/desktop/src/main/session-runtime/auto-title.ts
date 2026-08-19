/**
 * Model-call Session titling (VC-81): the one hook both Session doors feed.
 *
 * The shipped heuristic names a Session instantly and stays the offline,
 * unconfigured and failed-call answer. Behind it, one utility completion asks
 * a model for a sharper title — six words maximum — and the heuristic is
 * replaced only when the stored title is still byte-identical to what the
 * heuristic wrote, so a person who renamed while the call was in flight wins
 * and the model answer is dropped.
 *
 * The call is deliberately not part of the chat: it runs through
 * `completeUtility`, which creates no Session, no attachment, no transcript
 * and no ledger entry.
 *
 * The model ladder itself is domain policy and lives in `@volli/shared`
 * ({@link resolveAutoTitleModel}); this file only reads the three rungs and
 * runs the winner. The order is the owner's, given in review on VC-81 and
 * recorded there: utility, then the model the chat already runs under, then
 * the Role's default — because a Role default is the expensive orchestration
 * tier, and reaching for it to write six words is the thing the utility slot
 * exists to avoid. Note that VC-81's scope bullets predate that clarification
 * and read as if the heuristic were the only fallback; the ticket comment is
 * the current word.
 *
 * A rung that resolves but cannot run reasoning "off" is refused rather than
 * clamped or substituted, and a Session nobody named a title for is never
 * answered with anything but the heuristic. Failures log and keep the
 * heuristic; this is not a mutation a person requested, so nothing toasts.
 */
import {
  AUTO_TITLE_SYSTEM_PROMPT,
  autoTitlePrompt,
  errorMessage,
  resolveAutoTitleModel,
  resolveDefaultModel,
  sanitizeAutoTitle,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelSelection,
  type UtilityCompletion,
} from "@volli/shared";

/**
 * The whole refinement's budget — the provider probe and the completion share
 * it. Nothing waits on this call: the heuristic title is already on screen, so
 * a provider that never answers should cost one abandoned request, not a
 * promise that is still pending when the app quits.
 */
export const AUTO_TITLE_TIMEOUT_MS = 20_000;

/** The Session facts one refine needs, read once from a projection. */
export interface AutoTitleSession {
  title: string | null;
  ticketId: string | null;
  /** The Session's own recorded model policy — the ladder's second rung. */
  model: ModelSelection | null;
}

export interface AutoTitlerOptions {
  readSession(sessionId: string): Promise<AutoTitleSession | null>;
  /**
   * The configured defaults, read once per refinement rather than once per
   * rung, so a Settings change mid-refinement cannot be half-applied — and so
   * one title costs one read.
   */
  readModelDefaults(): ModelAccessDefaults;
  inspectModelAccess(input: { signal: AbortSignal }): Promise<ModelAccessSnapshot>;
  completeUtility(input: UtilityCompletion): Promise<string>;
  retitle(sessionId: string, title: string): Promise<void>;
}

/**
 * One refinement request — the shape both doors send and every seam between
 * them passes along. Declared once here and imported by the CLI door, the IPC
 * contract and the renderer handler, so the triple never travels as three
 * structurally-identical inline types.
 */
export interface AutoTitleRequest {
  sessionId: string;
  /** The first user message the title is derived from. */
  firstMessage: string;
  /** The heuristic title the door wrote, the byte-identical guard's baseline. */
  heuristicTitle: string;
}

export interface AutoTitler {
  /**
   * Refine one Session's heuristic title behind a model call. Never rejects:
   * every failure is logged and leaves the heuristic standing.
   */
  refine(request: AutoTitleRequest): Promise<void>;
}

function logSkip(sessionId: string, detail: string): void {
  console.warn(`[volli] auto-title skipped for session ${sessionId}: ${detail}`);
}

export function createAutoTitler(options: AutoTitlerOptions): AutoTitler {
  async function refine(request: AutoTitleRequest): Promise<void> {
    let session: AutoTitleSession | null;
    try {
      session = await options.readSession(request.sessionId);
    } catch (failure) {
      logSkip(request.sessionId, `could not read the session (${errorMessage(failure)})`);
      return;
    }
    if (session === null) {
      logSkip(request.sessionId, "the session no longer exists");
      return;
    }
    // Zero calls for Sessions someone already named: a durable title that is
    // not the heuristic this door wrote is a person's or a CLI --title's.
    if (session.title !== null && session.title !== request.heuristicTitle) {
      return;
    }
    // The renderer normally races the heuristic in ahead of this call; a
    // still-untitled Session is titled with it here, so the guard below has
    // the baseline it compares against.
    if (session.title === null) {
      try {
        await options.retitle(request.sessionId, request.heuristicTitle);
      } catch (failure) {
        logSkip(request.sessionId, `the heuristic title did not stick (${errorMessage(failure)})`);
        return;
      }
    }
    const defaults = options.readModelDefaults();
    const chosen = resolveAutoTitleModel({
      utility: defaults.utility,
      session: session.model,
      roleDefault: resolveDefaultModel(defaults, session.ticketId === null ? "global" : "ticket"),
    });
    if (chosen === null) {
      return;
    }
    // One deadline for the probe and the call together.
    const signal = AbortSignal.timeout(AUTO_TITLE_TIMEOUT_MS);
    let access: ModelAccessSnapshot;
    try {
      access = await options.inspectModelAccess({ signal });
    } catch (failure) {
      logSkip(request.sessionId, `Model Access could not be read (${errorMessage(failure)})`);
      return;
    }
    const available = access.models.find(
      (candidate) =>
        candidate.providerId === chosen.providerId && candidate.modelId === chosen.modelId,
    );
    if (available === undefined || available.state !== "available") {
      logSkip(
        request.sessionId,
        `model ${chosen.providerId}/${chosen.modelId} is not currently available`,
      );
      return;
    }
    // The call always runs thinking off. Refused rather than clamped when the
    // catalog cannot do "off": pi-ai would silently climb to the next level.
    if (!available.reasoningLevels.includes("off")) {
      logSkip(
        request.sessionId,
        `model ${chosen.providerId}/${chosen.modelId} cannot run reasoning off`,
      );
      return;
    }
    let raw: string;
    try {
      raw = await options.completeUtility({
        model: { providerId: chosen.providerId, modelId: chosen.modelId, reasoningLevel: "off" },
        systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
        // Capped and delimited: a title is six words, and the opening decides
        // them. A pasted file behind the question is billed input that buys
        // nothing, and unbounded text is where instruction-shaped content hides.
        user: autoTitlePrompt(request.firstMessage),
        signal,
      });
    } catch (failure) {
      logSkip(request.sessionId, `the model call failed (${errorMessage(failure)})`);
      return;
    }
    const title = sanitizeAutoTitle(raw);
    if (title === null) {
      logSkip(request.sessionId, "the model answer held no title");
      return;
    }
    // The async gap guard: whatever the stored title is now, only the
    // byte-identical heuristic may be replaced. A person who renamed during
    // the call wins.
    try {
      const current = await options.readSession(request.sessionId);
      if (current === null) {
        logSkip(request.sessionId, "the session no longer exists");
        return;
      }
      if (current.title !== request.heuristicTitle) {
        return;
      }
      await options.retitle(request.sessionId, title);
    } catch (failure) {
      console.error(
        `[volli] auto-title for session ${request.sessionId} did not stick: ${errorMessage(failure)}`,
      );
    }
  }

  return { refine };
}
