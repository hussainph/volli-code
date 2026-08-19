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
 * and no ledger entry. The model ladder is the policy stated by the owner
 * (VC-81): the explicit utility default, then the Session's own recorded
 * model, then the Role's default — never a model nobody configured. A rung
 * that resolves but cannot run reasoning "off" is refused rather than
 * clamped or substituted, and a Session nobody named a title for is never
 * answered with anything but the heuristic. Failures log and keep the
 * heuristic; this is not a mutation a person requested, so nothing toasts.
 */
import {
  AUTO_TITLE_SYSTEM_PROMPT,
  errorMessage,
  sanitizeAutoTitle,
  type ModelAccessSnapshot,
  type ModelSelection,
  type UtilityCompletion,
} from "@volli/shared";

/** The Session facts one refine needs, read once from a projection. */
export interface AutoTitleSession {
  title: string | null;
  ticketId: string | null;
  /** The Session's own recorded model policy — the ladder's second rung. */
  model: ModelSelection | null;
}

export type AutoTitleRole = "ticket" | "project";

export interface AutoTitlerOptions {
  readSession(sessionId: string): Promise<AutoTitleSession | null>;
  /**
   * Rung one: the explicit cost-efficient default. Explicit only — this rung
   * must not inherit the global default, or it would shadow the Session's own
   * model on every profile that never set a utility model.
   */
  readUtilityDefault(): ModelSelection | null;
  /**
   * Rung three: the Role's already-resolved default (`ticket ?? global` for a
   * Ticket Session, `global` for a project chat).
   */
  readRoleDefault(role: AutoTitleRole): ModelSelection | null;
  inspectModelAccess(): Promise<ModelAccessSnapshot>;
  completeUtility(input: UtilityCompletion): Promise<string>;
  retitle(sessionId: string, title: string): Promise<void>;
}

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
    const chosen =
      options.readUtilityDefault() ??
      session.model ??
      options.readRoleDefault(session.ticketId === null ? "project" : "ticket");
    if (chosen === null) {
      return;
    }
    let access: ModelAccessSnapshot;
    try {
      access = await options.inspectModelAccess();
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
        user: request.firstMessage,
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
