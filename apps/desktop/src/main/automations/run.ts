/**
 * The one Run door (VC-112, tracer VC-126): every surface that runs an
 * Automation by hand — the command palette today; column Triggers, schedules
 * and the CLI verb in later slices — lands here, so the contract has exactly
 * one implementation:
 *
 *  - **One Run, one fresh chat Session.** The door only ever MINTS through the
 *    Sessions facade; no wake path exists to reach from here, and that is
 *    structural, not discipline.
 *  - **The Instructions are the first message**, resolved through the chat
 *    composer's own grammar — the same `expandCommandInvocation` over the same
 *    loaded supply the `/` picker reads — templates spliced into the text,
 *    `/skill` references kept as typed with their bodies riding beside as
 *    typed resource parts, `@` refs passing through as the plain text they
 *    are. Nothing is appended: the Runtime Brief already carries the Ticket.
 *  - **The Run row stores the RESOLVED model and reasoning** the mint
 *    recorded, never the reference.
 *  - **A pin travels as a whole selection** through the facade's
 *    `modelOverride`, which validates it against Model Access and refuses
 *    through the existing `StructuredSessionsError` path — a pinned model
 *    that has become unavailable fails loudly, never silently falls back.
 *
 * The boot follows VC-16's optimistic-open doctrine rather than the CLI
 * door's blocking `start`: `create` answers in milliseconds with a durable,
 * addressable Session (which the palette adopts and shows), while the slow
 * half — worktree ensure, Agent Runtime boot, message delivery — runs
 * detached. A detached failure is not silent: a ticketed attach refusal lands
 * as durable Ticket Attention on the Session the caller is already looking
 * at, which is the existing failed-session surface VC-112 chose over a new one.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  errorMessage,
  expandCommandInvocation,
  type AutomationRun,
  type AutomationRunRefusalCode,
  type PromptResource,
  type PromptTemplate,
  type SkillReference,
} from "@volli/shared";

import { getAutomation, latestRunForTicket, recordAutomationRun } from "../db/automations-repo";
import { getTicket } from "../db/tickets-repo";
import { StructuredSessionsError, type Sessions } from "../session-runtime/sessions";

/** The composer's `/` supply for one project — templates and ruled skills, one read. */
export interface AutomationPromptSupply {
  templates: readonly PromptTemplate[];
  skills: readonly SkillReference[];
}

export interface AutomationRunnerDeps {
  db: Database.Database;
  /** The product Session facade — the same doors the renderer and CLI ride. */
  sessions: Pick<Sessions, "create" | "attach">;
  /**
   * The same supply `volli:prompt-templates` hands the composer's picker, so
   * run-time expansion and composer-time expansion read one list. Throws are
   * tolerated: an unreadable directory costs the expansion, never the Run —
   * the text then goes out exactly as typed, which is what the composer does
   * for a reference it cannot resolve.
   */
  promptSupply(projectId: string): Promise<AutomationPromptSupply>;
  /**
   * Deliver one user message to a live Session — the composer's own message
   * shape: one text part plus the resolved skill bodies as typed resource
   * parts. Runs on the detached half only, after a ready attach.
   */
  deliverInstructions(input: {
    sessionId: string;
    text: string;
    resources: readonly PromptResource[];
  }): Promise<void>;
  /**
   * What is happening in a Session right now, in the chat listing's honest
   * vocabulary, or `null` for a Session the engine cannot project. Drives the
   * single-flight guard from plumbing facts (open turn, open attachment) —
   * never from `session done`/`session blocked` declarations, which V1 is
   * forbidden to trust.
   */
  readSessionActivity(sessionId: string): Promise<"working" | "waiting" | "idle" | null>;
  now(): number;
  /** Fired after the Run row exists — the composition root broadcasts from it. */
  onRunStarted?(event: { run: AutomationRun; projectId: string }): void;
  /** Detached-half diagnostics; defaults to `console.error`. */
  log?(message: string): void;
}

export type RunAutomationOutcome =
  | { ok: true; run: AutomationRun; projectId: string }
  | { ok: false; code: AutomationRunRefusalCode; error: string };

export interface AutomationRunner {
  run(input: { automationId: string; ticketId: string }): Promise<RunAutomationOutcome>;
  /** The detached boots still in flight — exposed so tests can await them. */
  settled(): Promise<void>;
}

/** One refusal shape, so the IPC layer never has to parse a bare string. */
function refuse(code: AutomationRunRefusalCode, error: string): RunAutomationOutcome {
  return { ok: false, code, error };
}

export function createAutomationRunner(deps: AutomationRunnerDeps): AutomationRunner {
  const log = deps.log ?? ((message: string) => console.error(message));
  /**
   * The boot-window latch, per Ticket. The durable half of the single-flight
   * guard (the latest Run's Session activity) cannot see a Run whose first
   * turn has not opened yet — create has answered but the detached attach and
   * delivery are still in flight — so the Ticket stays latched until that
   * settles, however it settles. In-memory on purpose: a relaunch that killed
   * the boot also released the work.
   */
  const inFlight = new Map<string, Promise<void>>();

  async function activityGuard(ticketId: string): Promise<RunAutomationOutcome | null> {
    const latest = latestRunForTicket(deps.db, ticketId);
    if (latest === undefined) return null;
    const activity = await deps.readSessionActivity(latest.sessionId);
    if (activity === "working" || activity === "waiting") {
      return refuse(
        "RUN_IN_FLIGHT",
        activity === "waiting"
          ? "A Run on this Ticket is waiting on a person. Answer it or interrupt it before starting another."
          : "A Run is already working on this Ticket. Interrupt it before starting another.",
      );
    }
    return null;
  }

  return {
    async run(input) {
      const automation = getAutomation(deps.db, input.automationId);
      if (automation === undefined) {
        return refuse("AUTOMATION_NOT_FOUND", "No Automation by that id exists.");
      }
      const ticket = getTicket(deps.db, input.ticketId);
      if (ticket === undefined) {
        return refuse("TICKET_NOT_FOUND", "The requested Ticket was not found.");
      }
      // Ownership decides where an Automation is listed, and therefore what it
      // may be run on: a project Automation on another project's Ticket is a
      // listing no surface shows, so a request naming it is malformed.
      if (automation.projectId !== null && automation.projectId !== ticket.projectId) {
        return refuse(
          "AUTOMATION_NOT_IN_PROJECT",
          "This Automation belongs to another project and cannot run on this Ticket.",
        );
      }
      // At most one Run in flight per Ticket. The latch is taken BEFORE the
      // first await so two palette presses cannot interleave past the check,
      // and released on every refusal path below; only a successful create
      // hands it to the detached boot.
      if (inFlight.has(ticket.id)) {
        return refuse("RUN_IN_FLIGHT", "A Run is already starting on this Ticket.");
      }
      let releaseLatch!: () => void;
      inFlight.set(
        ticket.id,
        new Promise<void>((resolve) => {
          releaseLatch = resolve;
        }),
      );
      let handedToBoot = false;
      try {
        const refusal = await activityGuard(ticket.id);
        if (refusal !== null) return refusal;

        // The composer's own resolution, at send time — never at save time, so
        // Instructions follow today's templates and skills exactly as a
        // person's re-sent draft would.
        let supply: AutomationPromptSupply = { templates: [], skills: [] };
        try {
          supply = await deps.promptSupply(ticket.projectId);
        } catch (error) {
          log(`[volli] automation run could not read the prompt supply: ${errorMessage(error)}`);
        }
        const expanded = expandCommandInvocation(
          automation.instructions,
          supply.templates,
          supply.skills,
        );

        let created: Awaited<ReturnType<Sessions["create"]>>;
        try {
          created = await deps.sessions.create({
            operationId: randomUUID(),
            projectId: ticket.projectId,
            ticketId: ticket.id,
            // The Automation's name IS the Session's name: a person chose it,
            // so it is protected like any explicit title and never refined.
            title: automation.name,
            actor: { kind: "automation" },
            // A pin travels whole — both halves or neither — and is validated
            // by the facade against Model Access; inherit passes nothing and
            // resolves through the project rung, then the global record.
            ...(automation.runtime === null
              ? {}
              : {
                  modelOverride: {
                    model: {
                      providerId: automation.runtime.providerId,
                      modelId: automation.runtime.modelId,
                    },
                    reasoningLevel: automation.runtime.reasoningLevel,
                  },
                }),
          });
        } catch (error) {
          // The facade's refusals keep their names — the existing error path,
          // not a new surface. Everything else is the one generic failure.
          if (error instanceof StructuredSessionsError) {
            if (error.code === "DEFAULT_MODEL_REQUIRED") {
              return refuse("MODEL_REQUIRED", error.message);
            }
            if (error.code === "MODEL_UNAVAILABLE") {
              return refuse("MODEL_UNAVAILABLE", error.message);
            }
            return refuse("RUN_FAILED", error.message);
          }
          return refuse("RUN_FAILED", errorMessage(error));
        }

        // The record, before the slow half: the Session exists durably, so the
        // Run that produced it must too — resolved model, never the reference.
        const run = recordAutomationRun(
          deps.db,
          {
            automationId: automation.id,
            ticketId: ticket.id,
            sessionId: created.sessionId,
            model: created.model,
          },
          deps.now(),
        );
        deps.onRunStarted?.({ run, projectId: ticket.projectId });

        // The detached half, exactly VC-16's: attach, then deliver on ready. A
        // needs-recovery attach holds the Instructions for the Session's own
        // Retry surface; a thrown attach is already durable Ticket Attention.
        handedToBoot = true;
        void (async () => {
          try {
            const attached = await deps.sessions.attach({
              operationId: randomUUID(),
              sessionId: created.sessionId,
            });
            if (attached.state !== "ready") return;
            await deps.deliverInstructions({
              sessionId: created.sessionId,
              text: expanded.text,
              resources: expanded.resources,
            });
          } catch (error) {
            log(
              `[volli] automation run ${run.id} could not deliver its Instructions: ${errorMessage(error)}`,
            );
          } finally {
            releaseLatch();
            inFlight.delete(ticket.id);
          }
        })();

        return { ok: true, run, projectId: ticket.projectId };
      } finally {
        if (!handedToBoot) {
          releaseLatch();
          inFlight.delete(ticket.id);
        }
      }
    },

    async settled() {
      await Promise.all(inFlight.values());
    },
  };
}
