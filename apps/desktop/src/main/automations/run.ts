/**
 * The one Automation Run door (VC-112, tracer VC-126).
 *
 * The durable Automation engine accepts a complete Run plan first, including
 * the composer's resolved Instructions and stable Session/message operation
 * ids. This host then performs the slow Session work. A process can die between
 * any two calls without losing Instructions or stranding an unaddressable
 * Session: recovery replays the same Session-create operation and the same
 * message command, while the engine's command receipts collapse retries.
 */
import { randomUUID } from "node:crypto";
import {
  errorMessage,
  expandCommandInvocation,
  isAutomationRuntimePin,
  type Automation,
  type AutomationCommandReceipt,
  type AutomationRun,
  type AutomationRunRefusalCode,
  type PromptResource,
  type PromptTemplate,
  type SkillReference,
} from "@volli/shared";

import type { AutomationEngine, AutomationRunDelivery, AutomationRunPlan } from "./engine";
import { StructuredSessionsError, type Sessions } from "../session-runtime/sessions";

/** The composer's `/` supply for one project — templates and ruled skills, one read. */
export interface AutomationPromptSupply {
  templates: readonly PromptTemplate[];
  skills: readonly SkillReference[];
}

export interface AutomationRunTicket {
  id: string;
  projectId: string;
}

/** What the Session runtime answers after attempting the persistent message intent. */
export type InstructionDeliveryResult = void | {
  receipt?: { status: "accepted" | "completed" | "rejected" | "unreconciled" } | null;
};

export interface AutomationRunnerDeps {
  /** The transport-neutral command/event/projection core. */
  engine: AutomationEngine;
  /** Projection reads belong to the host, never to IPC. */
  findAutomation(automationId: string): Automation | undefined;
  findTicket(ticketId: string): AutomationRunTicket | undefined;
  listRunsForTicket(ticketId: string): readonly AutomationRun[];
  /** The product Session facade — the only door that can mint a fresh Session. */
  sessions: Pick<Sessions, "create" | "attach">;
  /** The same supply `volli:prompt-templates` hands the composer's picker. */
  promptSupply(projectId: string): Promise<AutomationPromptSupply>;
  /**
   * Delivers a persisted first-message intent through the Session runtime. The
   * message command id and UI message id are stored with the Run; callers must
   * use them unchanged so a crash/retry cannot duplicate the turn.
   */
  deliverInstructions(input: {
    sessionId: string;
    commandId: string;
    messageId: string;
    text: string;
    resources: readonly PromptResource[];
  }): Promise<InstructionDeliveryResult>;
  /** Honest Session activity, or null when its projection cannot be read. */
  readSessionActivity(
    sessionId: string,
  ): Promise<"working" | "waiting" | "idle" | "stopped" | null>;
  /** Fired after the complete Run projection exists. */
  onRunStarted?(event: { run: AutomationRun; projectId: string }): void;
  /** Detached-half diagnostics; defaults to `console.error`. */
  log?(message: string): void;
}

export type RunAutomationOutcome =
  | { ok: true; run: AutomationRun; projectId: string; receipt: AutomationCommandReceipt }
  | AutomationRunRefusal;

export interface AutomationRunRefusal {
  ok: false;
  code: AutomationRunRefusalCode;
  error: string;
  receipt?: AutomationCommandReceipt;
}

export interface AutomationRunner {
  run(input: {
    commandId: string;
    automationId: string;
    ticketId: string;
  }): Promise<RunAutomationOutcome>;
  /** Resume a persistent first-message intent after any successful Session attach. */
  resumeDeliveryForSession(sessionId: string): Promise<void>;
  /** Recover accepted Run plans that died before their Session/Run projection committed. */
  recover(): Promise<void>;
  /** Detached boots and recovery work still in flight — exposed so tests can await them. */
  settled(): Promise<void>;
}

/** One refusal shape, so the IPC layer never has to parse a bare string. */
function refuse(code: AutomationRunRefusalCode, error: string): AutomationRunRefusal {
  return { ok: false, code, error };
}

function runRefusalCode(value: string | undefined): AutomationRunRefusalCode | null {
  switch (value) {
    case "AUTOMATION_NOT_FOUND":
    case "AUTOMATION_NOT_IN_PROJECT":
    case "TICKET_NOT_FOUND":
    case "RUN_IN_FLIGHT":
    case "MODEL_REQUIRED":
    case "MODEL_UNAVAILABLE":
    case "RUN_FAILED":
      return value;
    default:
      return null;
  }
}

export function createAutomationRunner(deps: AutomationRunnerDeps): AutomationRunner {
  const log = deps.log ?? ((message: string) => console.error(message));
  /**
   * A local fast-path latch keeps two clicks in one host from interleaving
   * before SQLite's accepted-command projection sees the first. The ledger is
   * the durable cross-restart/cross-host guard; this map only covers the tiny
   * optimistic-open window.
   */
  const inFlight = new Map<string, Promise<void>>();

  async function activityGuard(ticketId: string): Promise<RunAutomationOutcome | null> {
    // Never inspect only the newest Run. An older Session can be resumed after
    // a newer Run has gone idle; every Run-owned Session must be quiet before a
    // Ticket gets another Run. An unreadable projection fails closed rather
    // than accidentally admitting a second live worker.
    const runs = deps.listRunsForTicket(ticketId);
    for (const run of runs) {
      // "stopped" admits a new Run exactly as "idle" does: a supervisor ending
      // an earlier Run's work is the opposite of that work still being live.
      let activity: "working" | "waiting" | "idle" | "stopped" | null;
      try {
        activity = await deps.readSessionActivity(run.sessionId);
      } catch (error) {
        return refuse(
          "RUN_IN_FLIGHT",
          `Could not verify an earlier Run on this Ticket: ${errorMessage(error)}`,
        );
      }
      if (activity === null) {
        return refuse(
          "RUN_IN_FLIGHT",
          "Could not verify an earlier Run on this Ticket. Recover or inspect it before starting another.",
        );
      }
      if (activity === "working" || activity === "waiting") {
        return refuse(
          "RUN_IN_FLIGHT",
          activity === "waiting"
            ? "A Run on this Ticket is waiting on a person. Answer it or interrupt it before starting another."
            : "A Run is already working on this Ticket. Interrupt it before starting another.",
        );
      }
    }
    return null;
  }

  async function deliver(delivery: AutomationRunDelivery): Promise<void> {
    try {
      const result = await deps.deliverInstructions({
        sessionId: delivery.sessionId,
        commandId: delivery.messageCommandId,
        messageId: delivery.messageId,
        text: delivery.text,
        resources: delivery.resources,
      });
      // Legacy test/host seams return void; a real Session runtime names a
      // receipt. Only an accepted/completed receipt proves the intent reached
      // the Session, so a rejected/unreconciled one remains pending for its
      // existing recovery path rather than being falsely marked delivered.
      if (
        result !== undefined &&
        (result.receipt === undefined ||
          result.receipt === null ||
          (result.receipt.status !== "accepted" && result.receipt.status !== "completed"))
      ) {
        const status =
          result.receipt === undefined || result.receipt === null
            ? "missing"
            : result.receipt.status;
        log(
          `[volli] automation Run ${delivery.runId} first-message receipt is ${status}; retaining its delivery intent`,
        );
        return;
      }
      await deps.engine.markDeliveryDelivered({ runId: delivery.runId });
    } catch (error) {
      // Do not clear the intent. The same durable Session command id means the
      // next ready attach reconciles/replays safely after a crash or recovery.
      log(
        `[volli] automation Run ${delivery.runId} could not deliver its Instructions: ${errorMessage(error)}`,
      );
    }
  }

  async function resumeDeliveryForSession(sessionId: string): Promise<void> {
    const deliveries = await deps.engine.pendingDeliveriesForSession(sessionId);
    for (const delivery of deliveries) await deliver(delivery);
  }

  async function boot(run: AutomationRun): Promise<void> {
    try {
      const attached = await deps.sessions.attach({
        operationId: randomUUID(),
        sessionId: run.sessionId,
      });
      if (attached.state !== "ready") return;
      await resumeDeliveryForSession(run.sessionId);
    } catch (error) {
      log(`[volli] automation Run ${run.id} could not attach its Session: ${errorMessage(error)}`);
    }
  }

  async function hasPendingDelivery(run: AutomationRun): Promise<boolean> {
    return (await deps.engine.pendingDeliveriesForSession(run.sessionId)).length > 0;
  }

  async function executePlan(plan: AutomationRunPlan): Promise<RunAutomationOutcome> {
    let created: Awaited<ReturnType<Sessions["create"]>>;
    try {
      created = await deps.sessions.create({
        operationId: plan.sessionOperationId,
        projectId: plan.projectId,
        ticketId: plan.ticketId,
        title: plan.automationName,
        actor: { kind: "automation" },
        ...(plan.runtime === null
          ? {}
          : {
              modelOverride: {
                model: {
                  providerId: plan.runtime.providerId,
                  modelId: plan.runtime.modelId,
                },
                reasoningLevel: plan.runtime.reasoningLevel,
              },
            }),
      });
    } catch (error) {
      const mapped = mapSessionStartFailure(error);
      const rejected = await deps.engine.rejectRun({
        commandId: plan.commandId,
        code: mapped.code,
        error: mapped.error,
      });
      return { ...mapped, receipt: rejected.receipt };
    }

    const completed = await deps.engine.completeRun({
      commandId: plan.commandId,
      sessionId: created.sessionId,
      model: created.model,
    });
    if (!completed.ok) return refuse("RUN_FAILED", completed.error);
    if (!completed.replayed) {
      deps.onRunStarted?.({ run: completed.value, projectId: plan.projectId });
    }
    return {
      ok: true,
      run: completed.value,
      projectId: plan.projectId,
      receipt: completed.receipt,
    };
  }

  async function replayExistingPlan(
    input: { commandId: string; automationId: string; ticketId: string },
    plan: AutomationRunPlan,
  ): Promise<RunAutomationOutcome> {
    if (plan.automationId !== input.automationId || plan.ticketId !== input.ticketId) {
      return refuse(
        "RUN_FAILED",
        "This command id was already accepted for a different Automation Run.",
      );
    }
    const priorBoot = inFlight.get(plan.ticketId);
    if (priorBoot !== undefined) {
      // A second delivery of the same command while its first attach is still
      // booting is a transport retry, not a competing Run. Wait for that
      // bounded boot window, then replay its receipt below.
      await priorBoot;
    }
    let releaseLatch!: () => void;
    const latch = new Promise<void>((resolve) => {
      releaseLatch = resolve;
    });
    inFlight.set(plan.ticketId, latch);
    let bootOwnsLatch = false;
    try {
      const replay = await deps.engine.replayRun(input.commandId);
      if (replay === null) {
        return refuse(
          "RUN_FAILED",
          "This Automation Run command is no longer available for replay.",
        );
      }
      if (!replay.ok) {
        return {
          ...refuse(runRefusalCode(replay.code) ?? "RUN_FAILED", replay.error),
          receipt: replay.receipt,
        };
      }
      const outcome: RunAutomationOutcome =
        replay.value.run === null
          ? await executePlan(replay.value.plan)
          : {
              ok: true,
              run: replay.value.run,
              projectId: replay.value.plan.projectId,
              receipt: replay.receipt,
            };
      if (!outcome.ok) return outcome;
      if (!(await hasPendingDelivery(outcome.run))) return outcome;
      bootOwnsLatch = true;
      void boot(outcome.run).finally(() => {
        releaseLatch();
        if (inFlight.get(plan.ticketId) === latch) inFlight.delete(plan.ticketId);
      });
      return outcome;
    } finally {
      if (!bootOwnsLatch) {
        releaseLatch();
        if (inFlight.get(plan.ticketId) === latch) inFlight.delete(plan.ticketId);
      }
    }
  }

  return {
    async run(input) {
      let persistedPlan: AutomationRunPlan | null;
      try {
        persistedPlan = await deps.engine.runPlan(input.commandId);
      } catch (error) {
        return refuse("RUN_FAILED", errorMessage(error));
      }
      if (persistedPlan !== null) return replayExistingPlan(input, persistedPlan);

      const automation = deps.findAutomation(input.automationId);
      if (automation === undefined) {
        return refuse("AUTOMATION_NOT_FOUND", "No Automation by that id exists.");
      }
      if (automation.runtime !== null && !isAutomationRuntimePin(automation.runtime)) {
        return refuse(
          "RUN_FAILED",
          "This Automation's saved Runtime is invalid. Edit it and choose a valid model-and-reasoning pair before running.",
        );
      }
      const ticket = deps.findTicket(input.ticketId);
      if (ticket === undefined)
        return refuse("TICKET_NOT_FOUND", "The requested Ticket was not found.");
      if (automation.projectId !== null && automation.projectId !== ticket.projectId) {
        return refuse(
          "AUTOMATION_NOT_IN_PROJECT",
          "This Automation belongs to another project and cannot run on this Ticket.",
        );
      }
      if (inFlight.has(ticket.id)) {
        return refuse("RUN_IN_FLIGHT", "A Run is already starting on this Ticket.");
      }
      let releaseLatch!: () => void;
      const latch = new Promise<void>((resolve) => {
        releaseLatch = resolve;
      });
      inFlight.set(ticket.id, latch);
      let bootOwnsLatch = false;
      try {
        const active = await activityGuard(ticket.id);
        if (active !== null) return active;

        let supply: AutomationPromptSupply = { templates: [], skills: [] };
        try {
          supply = await deps.promptSupply(ticket.projectId);
        } catch (error) {
          // Composer behavior: an unreadable supply leaves the literal text in
          // place instead of changing the saved Instructions or refusing work.
          log(`[volli] automation Run could not read the prompt supply: ${errorMessage(error)}`);
        }
        const expanded = expandCommandInvocation(
          automation.instructions,
          supply.templates,
          supply.skills,
        );
        const accepted = await deps.engine.acceptRun({
          commandId: input.commandId,
          automation: {
            id: automation.id,
            name: automation.name,
            runtime: automation.runtime,
          },
          projectId: ticket.projectId,
          ticketId: ticket.id,
          text: expanded.text,
          resources: expanded.resources,
        });
        if (!accepted.ok) {
          return {
            ...refuse(runRefusalCode(accepted.code) ?? "RUN_IN_FLIGHT", accepted.error),
            receipt: accepted.receipt,
          };
        }

        const outcome = await executePlan(accepted.value);
        if (!outcome.ok) return outcome;
        if (!(await hasPendingDelivery(outcome.run))) return outcome;
        bootOwnsLatch = true;
        void boot(outcome.run).finally(() => {
          releaseLatch();
          if (inFlight.get(ticket.id) === latch) inFlight.delete(ticket.id);
        });
        return outcome;
      } finally {
        if (!bootOwnsLatch) {
          releaseLatch();
          if (inFlight.get(ticket.id) === latch) inFlight.delete(ticket.id);
        }
      }
    },

    resumeDeliveryForSession,

    async recover() {
      const attachedInPlanRecovery = new Set<string>();
      const plans = await deps.engine.recoverableRunPlans();
      for (const plan of plans) {
        const outcome = await executePlan(plan);
        if (!outcome.ok) {
          log(`[volli] automation Run ${plan.runId} could not recover: ${outcome.error}`);
          continue;
        }
        // The intent was committed before the original caller got success;
        // booting after recovery merely resumes its pending attach/delivery.
        attachedInPlanRecovery.add(outcome.run.sessionId);
        await boot(outcome.run);
      }

      // A crash after the Run projection commits leaves no recoverable plan —
      // it leaves this delivery intent. Resume each one through a fresh attach
      // attempt, exactly as the Session's existing Retry path does. The fixed
      // message command id reconciles if the prior process reached dispatch.
      const pending = await deps.engine.pendingDeliveries();
      for (const sessionId of new Set(pending.map((delivery) => delivery.sessionId))) {
        if (attachedInPlanRecovery.has(sessionId)) continue;
        try {
          const attached = await deps.sessions.attach({ operationId: randomUUID(), sessionId });
          if (attached.state === "ready") await resumeDeliveryForSession(sessionId);
        } catch (error) {
          log(
            `[volli] automation delivery for Session ${sessionId} could not recover: ${errorMessage(error)}`,
          );
        }
      }
    },

    async settled() {
      await Promise.all(inFlight.values());
    },
  };
}

function mapSessionStartFailure(error: unknown): AutomationRunRefusal {
  if (error instanceof StructuredSessionsError) {
    if (error.code === "DEFAULT_MODEL_REQUIRED") return refuse("MODEL_REQUIRED", error.message);
    if (error.code === "MODEL_UNAVAILABLE") return refuse("MODEL_UNAVAILABLE", error.message);
    return refuse("RUN_FAILED", error.message);
  }
  return refuse("RUN_FAILED", errorMessage(error));
}
