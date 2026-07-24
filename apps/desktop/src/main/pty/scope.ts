import type Database from "better-sqlite3";
import {
  buildHarnessCommand,
  buildHarnessResumeCommand,
  composeAttachmentsSection,
  DEFAULT_HARNESS_ID,
  displayTicketId,
  errorMessage,
  harnessLabel,
  projectSessionEnv,
  ticketSessionEnv,
} from "@volli/shared";
import type { CreateTerminalSessionRequest, HarnessId } from "@volli/shared";
import { materializeAttachments } from "../attachment-materialize";
import { getProjectById } from "../db/projects-repo";
import {
  countProjectScratchSessions,
  countTicketSessions,
  getSession,
  getTicketSessionContext,
} from "../db/sessions-repo";

/** The db-resolved shape a PTY is spawned + persisted from (ticket or scratch). */
export interface SessionScope {
  projectId: string;
  ticketId: string | null;
  harnessId: HarnessId;
  /** Truthful initial launch: a harness command was written, or this is a bare shell. */
  launchKind: "agent" | "shell";
  /** App-owned layout intent supplied by the renderer. */
  placement: "tab" | "split";
  cwd: string;
  /** Extra env layered over the inherited environment (VOLLI_TICKET/VOLLI_ARTIFACTS_DIR, or just the artifacts dir). */
  env: Record<string, string>;
  title: string;
  /**
   * The MAIN-repo path whose `.volli/artifacts` to ensure before spawn (so an
   * agent can write artifacts the instant its shell is live), or `null` when the
   * project can't be resolved. Also the root-exists guard's stat target.
   */
  artifactsRoot: string | null;
  /**
   * The harness launch command line to feed the freshly-spawned shell (from a
   * ticket request's `kickoff`), or `null` for a bare shell OR any worktree
   * ticket session — those defer command composition to {@link
   * PtyManager.create}, because the orientation preamble the prompt opens with
   * needs the worktree identity `ensure` only resolves at boot. Written into
   * the PTY exactly once, only after the session is fully persisted, so a
   * failed persist never leaves a harness running.
   */
  launchCommand: string | null;
  /**
   * Present ONLY for a worktree-backed ticket session (`uses_worktree`). Carries
   * everything `create` needs to (a) materialize the worktree via `ensure`
   * before spawn, and (b) compose the launch command afterwards — the raw
   * `kickoff` (harness + prompt, prefixed with the orientation preamble), the
   * project's `setupCommand` (sentinel-gated after a FRESH create), and the
   * main `projectPath` for the preamble. `launchCommand` is `null` in this case.
   *
   * `resumeCommand` is the pre-built harness resume line for a RESUME launch
   * (issue #78): it needs no worktree identity (a resume carries no orientation
   * preamble), so it is composed up front in {@link resolveScope} and
   * simply written after `ensure` — through the same setup-sentinel gate when a
   * fresh worktree runs a setup command. Mutually exclusive with `kickoff`.
   */
  worktree: {
    ticketId: string;
    projectPath: string;
    setupCommand: string | null;
    kickoff: { harnessId: HarnessId; prompt: string } | null;
    resumeCommand: string | null;
  } | null;
  /**
   * Present ONLY for a RESUME launch (issue #78, CONCEPT #21): the ended agent
   * session this one picks up from. `previousSessionId` is recorded in the
   * `session_resumed` event; `harnessSessionId` is that session's best-known
   * resume seed, inherited by the new row so a follow-up interrupt/resume chain
   * keeps a valid seed until the harness re-`link`s a fresh one.
   */
  resume: { previousSessionId: string; harnessSessionId: string | null } | null;
}

/** A resolved scope, or the one failure: a ticket request naming a ticket that does not exist. */
export type ScopeResolution = { ok: true; scope: SessionScope } | { ok: false; error: string };

/**
 * Resolves a request to its session scope from the db: a ticket session
 * (VOLLI_TICKET env, MAIN-repo-root cwd, the ticket's harness, `Session N`
 * title) or a project-scoped scratch session (default harness, `Terminal N`).
 * The only failure is a ticket request naming a ticket that does not exist.
 */
export function resolveScope(
  db: Database.Database,
  request: CreateTerminalSessionRequest,
  attachmentsRootPath: string,
): ScopeResolution {
  // Presentation metadata is non-security-sensitive, but still normalize the
  // IPC value so an untyped caller cannot persist arbitrary vocabulary.
  const placement = request.placement === "split" ? "split" : "tab";
  if (request.ticket !== undefined) {
    const ctx = getTicketSessionContext(db, request.ticket.ticketId);
    if (ctx === undefined) return { ok: false, error: "Unknown ticket" };
    const displayId = displayTicketId(ctx.ticketPrefix, ctx.ticketNumber);
    const kickoff = request.ticket.kickoff;
    const resume = request.ticket.resume;
    const usesWorktree = ctx.usesWorktree;
    const title = `Session ${countTicketSessions(db, request.ticket.ticketId) + 1}`;
    // Resume launch (issue #78, CONCEPT #21): pick up an ENDED agent session
    // of this same ticket. Kickoff and resume are mutually exclusive — reject
    // both present outright rather than silently preferring one.
    if (resume !== undefined) {
      if (kickoff !== undefined) {
        return { ok: false, error: "A session cannot both start a kickoff and resume another" };
      }
      const prior = getSession(db, resume.sessionId);
      if (prior === undefined) return { ok: false, error: "Cannot resume an unknown session" };
      if (prior.ticketId !== request.ticket.ticketId) {
        return { ok: false, error: "Cannot resume a session that belongs to another ticket" };
      }
      if (prior.launchKind !== "agent") {
        return { ok: false, error: "Only an agent session can be resumed" };
      }
      if (prior.endedAt === null) {
        return { ok: false, error: "Cannot resume a session that is still live" };
      }
      // The resume line needs no worktree identity (no orientation preamble),
      // so it composes up front. A harness with no resume support yields null.
      const resumeCommand = buildHarnessResumeCommand(prior.harnessId, prior.harnessSessionId);
      if (resumeCommand === null) {
        return {
          ok: false,
          error: `The ${harnessLabel(prior.harnessId)} harness does not support resuming a session`,
        };
      }
      return {
        ok: true,
        scope: {
          projectId: ctx.projectId,
          ticketId: request.ticket.ticketId,
          harnessId: prior.harnessId,
          launchKind: "agent",
          placement,
          cwd: ctx.projectPath,
          env: ticketSessionEnv(ctx.projectPath, displayId),
          title,
          artifactsRoot: ctx.projectPath,
          // Non-worktree resumes launch the resume line directly; a worktree
          // resume defers the write to create() (post-`ensure`, setup-gated).
          launchCommand: usesWorktree ? null : resumeCommand,
          worktree: usesWorktree
            ? {
                ticketId: request.ticket.ticketId,
                projectPath: ctx.projectPath,
                setupCommand: ctx.setupCommand,
                kickoff: null,
                resumeCommand,
              }
            : null,
          resume: {
            previousSessionId: prior.id,
            harnessSessionId: prior.harnessSessionId,
          },
        },
      };
    }
    // A non-worktree kickoff builds its harness command up front and
    // launches it directly (unchanged). A worktree session defers this to
    // create() — the preamble needs the resolved identity — so its command
    // is null here and the raw kickoff rides on `worktree` instead.
    //
    // A worktree-opt-out ticket never runs `ensure`, so THIS is the one
    // place its attachments materialize (CONCEPT decision #19) — into the
    // PROJECT root, since that root IS the session's checkout. The composed
    // "## Attachments" section is appended after the ticket prompt. A
    // materialize failure (a stored attachment's bytes are missing) must
    // surface as the create-path error the caller toasts, not be swallowed.
    let launchCommand: string | null = null;
    if (!usesWorktree && kickoff !== undefined) {
      let prompt = kickoff.prompt;
      try {
        const materialized = materializeAttachments(
          db,
          attachmentsRootPath,
          request.ticket.ticketId,
          ctx.projectPath,
        );
        const attachmentsSection = composeAttachmentsSection(materialized);
        if (attachmentsSection.length > 0) prompt = `${prompt}\n\n${attachmentsSection}`;
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
      launchCommand = buildHarnessCommand(kickoff.harnessId, prompt);
    }
    return {
      ok: true,
      scope: {
        projectId: ctx.projectId,
        ticketId: request.ticket.ticketId,
        // An explicit kickoff choice wins; later sessions resume with the
        // ticket's persisted preference. Launch kind separately preserves
        // whether this session actually invoked that harness or opened a shell.
        harnessId: kickoff?.harnessId ?? ctx.preferredHarnessId,
        launchKind: kickoff === undefined ? "shell" : "agent",
        placement,
        // The MAIN repo root stands in as cwd here; a worktree session
        // overrides it with the `ensure`-resolved worktree path in create().
        // VOLLI_ARTIFACTS_DIR always points at the main .volli either way (#9).
        cwd: ctx.projectPath,
        env: ticketSessionEnv(ctx.projectPath, displayId),
        title,
        artifactsRoot: ctx.projectPath,
        launchCommand,
        worktree: usesWorktree
          ? {
              ticketId: request.ticket.ticketId,
              projectPath: ctx.projectPath,
              setupCommand: ctx.setupCommand,
              kickoff: kickoff ?? null,
              resumeCommand: null,
            }
          : null,
        resume: null,
      },
    };
  }
  // Scratch session: resolve the project's MAIN path so VOLLI_ARTIFACTS_DIR is
  // injected the same way a ticket session gets it (decision #9). A project
  // that can't be resolved still spawns (no artifacts env) rather than failing.
  const project = getProjectById(db, request.workspaceId);
  return {
    ok: true,
    scope: {
      projectId: request.workspaceId,
      ticketId: null,
      harnessId: DEFAULT_HARNESS_ID,
      launchKind: "shell",
      placement,
      cwd: request.cwd,
      env: project ? projectSessionEnv(project.path) : {},
      title: `Terminal ${countProjectScratchSessions(db, request.workspaceId) + 1}`,
      artifactsRoot: project?.path ?? null,
      // Scratch sessions never auto-launch a harness — just a bare shell.
      launchCommand: null,
      // Never worktree-backed — scratch sessions run in the renderer's cwd.
      worktree: null,
      // Scratch sessions are never a resume.
      resume: null,
    },
  };
}
