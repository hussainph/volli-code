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
  automationRunRequestIdentity,
  automationRunTargetId,
  errorMessage,
  expandCommandInvocation,
  isAutomationRuntimePin,
  sameAutomationRunRequestIdentity,
  unboundRunProblem,
  UNBOUND_RUN_LABEL,
  type Automation,
  type AutomationCommandReceipt,
  type AutomationRun,
  type AutomationRunAttendance,
  type AutomationRunRefusalCode,
  type AutomationRunTarget,
  type CommandReceipt,
  type ModelSelection,
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

/**
 * WHERE a Run is aimed — VC-112's scope axis, and the thing the Trigger
 * decides. Not to be confused with {@link AutomationRunTarget}, which is what
 * SUPPLIES the Instructions (a record, or an Unbound Run's own text).
 *
 * A Ticket scope opens a Ticket Session; a Project scope opens a Project
 * Session, which is what a schedule Trigger does (VC-130). Modelled as a union
 * here and stored as a nullable `ticketId` on the plan, because that nullable
 * IS the Role in the Session layer already (`session-runtime/sessions.ts`) and
 * a second spelling of one fact would be a second policy.
 */
type RunScope = { kind: "ticket"; ticketId: string } | { kind: "project"; projectId: string };

/** A scope resolved against live host facts: where it runs, and what it competes with. */
interface ResolvedRunScope {
  projectId: string;
  ticketId: string | null;
  /** The optimistic-open latch key — one live Run per Ticket, or per schedule. */
  latchKey: string;
  /** The Runs whose Sessions must be quiet before another starts here. */
  priorRuns: readonly AutomationRun[];
}

/** What the Session runtime answers after attempting the persistent message intent. */
export type InstructionDeliveryResult = {
  receipt?: {
    status: "accepted" | "completed" | "rejected" | "unreconciled";
    code?: string;
    detail?: string | null;
  } | null;
};

export interface AutomationRunnerDeps {
  /** The transport-neutral command/event/projection core. */
  engine: AutomationEngine;
  /** Projection reads belong to the host, never to IPC. */
  findAutomation(automationId: string): Automation | undefined;
  findTicket(ticketId: string): AutomationRunTicket | undefined;
  /** Whether a Project scope names a project this host actually has. */
  findProject(projectId: string): boolean;
  listRunsForTicket(ticketId: string): readonly AutomationRun[];
  /**
   * One Automation's Runs in one project — the single-flight subject for a Run
   * that names no Ticket. A schedule cannot ask "is this Ticket busy", so it
   * asks whether an earlier Run of itself is still working here.
   */
  listProjectRunsForAutomation(input: {
    automationId: string;
    projectId: string;
  }): readonly AutomationRun[];
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
  /**
   * Records a post-attach first-message failure as Session Attention. The Run
   * owns the policy decision; the hosted runtime owns the durable write.
   */
  reportInstructionDeliveryFailure(input: {
    sessionId: string;
    commandId: string;
    detail: string;
  }): Promise<void>;
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

/**
 * One Run request, whatever asked for it — the rail, the palette, the board's
 * armed window, the agent's verb.
 *
 * `target` is the union so an Unbound Run (VC-129) travels the same door as a
 * bound one: one Run, one Session, one Run row, and the only difference is
 * whether a record supplied the Instructions. `modelOverride` is this
 * invocation's Runtime and is never stored on anything but the Run's own
 * resolved model.
 */
export interface AutomationRunRequest {
  commandId: string;
  target: AutomationRunTarget;
  ticketId: string;
  modelOverride: ModelSelection | null;
  /**
   * Whether a person was at the door that asked (VC-133).
   *
   * **Set by the door, never carried on the wire.** The renderer's IPC payload
   * has no such field: `automations/ipc.ts` fills in `attended` for its hand-Run
   * controls, and main's pending-arrival coordinator fills in `attended` for an
   * armed column's Deliberate move. The agent verb (`agent-tool-door.ts`) fills
   * in `unattended`, because its caller is a Session that has gone on to its own
   * work.
   *
   * Keeping it off the wire is what makes it trustworthy: a fact the renderer
   * declared about itself would be a claim, and this one decides whether a
   * person is interrupted.
   */
  attendance: AutomationRunAttendance;
}

/**
 * One Run request aimed at a PROJECT rather than a Ticket (VC-130).
 *
 * A separate shape from {@link AutomationRunRequest} because the two differ in
 * what they can even name: this one has no Ticket to run on and no
 * per-invocation override, since nobody is standing there to choose one — it is
 * the timer's door and the "Run now" behind a Skipped occurrence. Both meet
 * again immediately inside, as one Run path.
 */
export interface AutomationProjectRunRequest {
  commandId: string;
  automationId: string;
  projectId: string;
  /**
   * Whether a person was at the door that asked (VC-133).
   *
   * This door has both answers, which is exactly why attendance cannot be
   * derived from the Trigger of the Automation being run: the schedule timer
   * (`main/index.ts`) arrives here `unattended`, and "Run now" on a Skipped
   * occurrence arrives here `attended` — same Automation, same schedule, same
   * Project Session, and a person standing at one of them.
   */
  attendance: AutomationRunAttendance;
}

/**
 * Both doors, once they are inside: what supplies the Instructions, and where
 * the Run is aimed. Every rule below — replay identity, the single-flight
 * latch, the accepted plan — is written against this one shape, so the Ticket
 * door and the Project door cannot drift into two recovery stories.
 */
interface InternalRunRequest {
  commandId: string;
  target: AutomationRunTarget;
  scope: RunScope;
  modelOverride: ModelSelection | null;
  attendance: AutomationRunAttendance;
}

export interface AutomationRunner {
  run(input: AutomationRunRequest): Promise<RunAutomationOutcome>;
  /**
   * Runs an Automation against a PROJECT rather than a Ticket (VC-130): the
   * schedule's own door, and the one behind "Run now" on a Skipped occurrence.
   * It opens a Project Session, because `ticketId === null` is that Role.
   */
  runForProject(input: AutomationProjectRunRequest): Promise<RunAutomationOutcome>;
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

/**
 * Why an attach was not ready, in words, from the receipt it answered with.
 *
 * A rejected attach carries the diagnosis a person needs — an unpreparable
 * worktree names the path and git's reason — and that sentence is the reason
 * this Run has no first turn. The other statuses have no such sentence, so they
 * are named as what they are rather than dressed up as one.
 */
function attachRefusal(receipt: CommandReceipt | null): string {
  if (receipt === null) return "the attach reported no receipt";
  if (receipt.status === "rejected") return receipt.detail ?? receipt.code;
  return `the attach is ${receipt.status}`;
}

interface InstructionDeliveryFailure {
  status: "missing" | "rejected" | "unreconciled";
  detail: string;
}

/** The failure state and sentence a non-successful first-message result carries. */
function instructionDeliveryFailure(
  result: InstructionDeliveryResult,
): InstructionDeliveryFailure | null {
  const receipt = result.receipt;
  if (receipt === undefined || receipt === null) {
    return {
      status: "missing",
      detail: "The Automation Run's first message reported no delivery receipt.",
    };
  }
  if (receipt.status === "accepted" || receipt.status === "completed") return null;
  const reason = receipt.detail ?? receipt.code;
  return {
    status: receipt.status,
    detail:
      receipt.status === "rejected"
        ? `The Automation Run's first message was rejected${reason ? `: ${reason}` : "."}`
        : `The Automation Run's first-message delivery could not be reconciled${reason ? `: ${reason}` : "."}`,
  };
}

/**
 * The optimistic-open latch a Run belongs to, minted from the scope it names.
 *
 * One key derivation for both the fresh path and the replay path: a retry has
 * only the stored PLAN to go on, so if the two spelled the key differently a
 * replay would take a second latch and the guard would be a guard over nothing.
 * A Ticket is one live Run whichever Automation started it (VC-112); a Run that
 * names no Ticket is one live Run per schedule per project.
 */
function runLatchKey(scope: {
  ticketId: string | null;
  projectId: string;
  automationId: string | null;
}): string {
  return scope.ticketId === null
    ? `project\u0000${scope.projectId}\u0000${scope.automationId ?? "unbound"}`
    : `ticket\u0000${scope.ticketId}`;
}

function runRefusalCode(value: string | undefined): AutomationRunRefusalCode | null {
  switch (value) {
    case "AUTOMATION_NOT_FOUND":
    case "AUTOMATION_NOT_IN_PROJECT":
    case "TICKET_NOT_FOUND":
    case "PROJECT_NOT_FOUND":
    case "RUN_IN_FLIGHT":
    case "MODEL_REQUIRED":
    case "MODEL_UNAVAILABLE":
    case "INSTRUCTIONS_REQUIRED":
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

  async function activityGuard(
    runs: readonly AutomationRun[],
    /** What the earlier Run was about, so the sentence names the real subject. */
    subject: string,
  ): Promise<RunAutomationOutcome | null> {
    // Never inspect only the newest Run. An older Session can be resumed after
    // a newer Run has gone idle; every Run-owned Session must be quiet before a
    // Ticket gets another Run. An unreadable projection fails closed rather
    // than accidentally admitting a second live worker.
    for (const run of runs) {
      // "stopped" admits a new Run exactly as "idle" does: a supervisor ending
      // an earlier Run's work is the opposite of that work still being live.
      let activity: "working" | "waiting" | "idle" | "stopped" | null;
      try {
        activity = await deps.readSessionActivity(run.sessionId);
      } catch (error) {
        return refuse(
          "RUN_IN_FLIGHT",
          `Could not verify an earlier Run ${subject}: ${errorMessage(error)}`,
        );
      }
      if (activity === null) {
        return refuse(
          "RUN_IN_FLIGHT",
          `Could not verify an earlier Run ${subject}. Recover or inspect it before starting another.`,
        );
      }
      if (activity === "working" || activity === "waiting") {
        return refuse(
          "RUN_IN_FLIGHT",
          activity === "waiting"
            ? `A Run ${subject} is waiting on a person. Answer it or interrupt it before starting another.`
            : `A Run is already working ${subject}. Interrupt it before starting another.`,
        );
      }
    }
    return null;
  }

  async function reportDeliveryFailure(
    delivery: AutomationRunDelivery,
    detail: string,
  ): Promise<void> {
    try {
      await deps.reportInstructionDeliveryFailure({
        sessionId: delivery.sessionId,
        commandId: delivery.messageCommandId,
        detail,
      });
    } catch (error) {
      log(
        `[volli] automation Run ${delivery.runId} could not record its first-message failure: ${errorMessage(error)}`,
      );
    }
  }

  async function deliver(delivery: AutomationRunDelivery): Promise<void> {
    let result: InstructionDeliveryResult;
    try {
      result = await deps.deliverInstructions({
        sessionId: delivery.sessionId,
        commandId: delivery.messageCommandId,
        messageId: delivery.messageId,
        text: delivery.text,
        resources: delivery.resources,
      });
    } catch (error) {
      // Do not clear the intent. The same durable Session command id means the
      // next ready attach reconciles/replays safely after a crash or recovery.
      const detail = `The Automation Run's first message could not be delivered: ${errorMessage(error)}`;
      await reportDeliveryFailure(delivery, detail);
      log(
        `[volli] automation Run ${delivery.runId} could not deliver its Instructions: ${errorMessage(error)}`,
      );
      return;
    }

    // Only an accepted/completed receipt proves the intent reached the
    // Session, so a missing/rejected/unreconciled one remains pending for its
    // existing recovery path rather than being falsely marked delivered.
    const failure = instructionDeliveryFailure(result);
    if (failure !== null) {
      await reportDeliveryFailure(delivery, failure.detail);
      log(
        `[volli] automation Run ${delivery.runId} first-message receipt is ${failure.status}; retaining its delivery intent`,
      );
      return;
    }

    try {
      await deps.engine.markDeliveryDelivered({ runId: delivery.runId });
    } catch (error) {
      // The turn itself succeeded. Keep the intent recoverable, but do not turn
      // a bookkeeping failure after delivery into a false Session Attention.
      log(
        `[volli] automation Run ${delivery.runId} could not mark its Instructions delivered: ${errorMessage(error)}`,
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
      if (attached.state !== "ready") {
        // VC-220. This early return used to be wordless, and it is the whole of
        // what the owner saw: a Run mints its Session, the attach is refused,
        // and the only thing that would have delivered the Instructions gives
        // up in silence — while the door has already answered `ok` and the Run
        // row already links to a Session with nothing in it.
        //
        // The delivery intent is deliberately left pending: the attach is what
        // failed, so the next ready attach (the Session's own Retry, or the
        // next launch's recovery sweep) still owes this turn under the same
        // durable ids. What may not be left is the SILENCE — so the refusal is
        // said here, and the Session itself carries the failure Attention that
        // makes it `error` for VC-133's notification rule
        // (`session-runtime.ts`'s `#failAttach`).
        log(
          `[volli] automation Run ${run.id} could not attach its Session: ${attachRefusal(attached.receipt)}`,
        );
        return;
      }
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
        // An Unbound Run has no record to take a name from, so its Session
        // wears the one name that IS true of it — the same words its Run row
        // prints, rather than a second spelling of "nothing named this".
        title: plan.automationName ?? UNBOUND_RUN_LABEL,
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
                // VC-112: "a pinned model that has since become unavailable
                // does not silently fall back — let the Session fail through
                // the existing error path rather than building a second
                // failure surface." So this Run's Runtime is RECORDED as
                // asked and the attach is what refuses it (VC-133).
                //
                // A door-time refusal would have been the second failure
                // surface: no Session, no Run row, nothing on the Automations
                // page, and — for the two doors with nobody behind them, the
                // schedule timer and the agent verb — a returned error string
                // that no person is on the other end of. Recorded, the same
                // fact becomes a Session in `error` with the failing model in
                // its history, which is what the dot reads, what the Run row
                // links to, and what makes VC-133's "lands in `error` and is
                // covered by the same rule" true rather than aspirational.
                //
                // It is also what the INHERITED path already did: a configured
                // default that has gone stale is not inspected at mint either.
                // Pin and inherit are meant to be interchangeable answers to
                // one question, so they may not fail in two different places.
                whenUnavailable: "record" as const,
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
    input: InternalRunRequest,
    plan: AutomationRunPlan,
  ): Promise<RunAutomationOutcome> {
    // The WHOLE intent, not just the record and the Ticket. A command id is
    // durable intent, so the only two honest answers to a second request under
    // one are "the same Run" (replay its receipt below) and "a different Run"
    // (refuse here). Comparing the Automation alone cannot tell them apart any
    // more: every Unbound Run names none, so a retry carrying edited
    // Instructions — or the same Instructions on another model — would replay
    // the first Run's Session and silently discard what was actually asked for.
    // The scope is compared as the plan actually stores it: a Ticket Run by its
    // Ticket, a Project Run by the absence of one plus the project it named.
    const sameScope =
      input.scope.kind === "ticket"
        ? plan.ticketId === input.scope.ticketId
        : plan.ticketId === null && plan.projectId === input.scope.projectId;
    if (
      plan.automationId !== automationRunTargetId(input.target) ||
      !sameScope ||
      !sameAutomationRunRequestIdentity(plan.request, automationRunRequestIdentity(input))
    ) {
      return refuse(
        "RUN_FAILED",
        "This command id was already accepted for a different Automation Run.",
      );
    }
    const latchKey = runLatchKey(plan);
    const priorBoot = inFlight.get(latchKey);
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
    inFlight.set(latchKey, latch);
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
        if (inFlight.get(latchKey) === latch) inFlight.delete(latchKey);
      });
      return outcome;
    } finally {
      if (!bootOwnsLatch) {
        releaseLatch();
        if (inFlight.get(latchKey) === latch) inFlight.delete(latchKey);
      }
    }
  }

  /**
   * A scope resolved against live host facts, or the refusal that stops it.
   *
   * The two arms answer the same four questions — which project, which Ticket
   * (if any), what this Run competes with, and whether the Automation is
   * allowed here — so they are resolved in one place rather than duplicated
   * down two nearly identical run paths.
   */
  function resolveScope(
    automation: Automation | null,
    scope: RunScope,
  ): ResolvedRunScope | AutomationRunRefusal {
    if (scope.kind === "ticket") {
      const ticket = deps.findTicket(scope.ticketId);
      if (ticket === undefined)
        return refuse("TICKET_NOT_FOUND", "The requested Ticket was not found.");
      if (
        automation !== null &&
        automation.projectId !== null &&
        automation.projectId !== ticket.projectId
      ) {
        return refuse(
          "AUTOMATION_NOT_IN_PROJECT",
          "This Automation belongs to another project and cannot run on this Ticket.",
        );
      }
      return {
        projectId: ticket.projectId,
        ticketId: ticket.id,
        latchKey: runLatchKey({
          ticketId: ticket.id,
          projectId: ticket.projectId,
          automationId: automation?.id ?? null,
        }),
        priorRuns: deps.listRunsForTicket(ticket.id),
      };
    }
    if (!deps.findProject(scope.projectId)) {
      return refuse("PROJECT_NOT_FOUND", "The requested project was not found.");
    }
    if (
      automation !== null &&
      automation.projectId !== null &&
      automation.projectId !== scope.projectId
    ) {
      return refuse(
        "AUTOMATION_NOT_IN_PROJECT",
        "This Automation belongs to another project and cannot run in this one.",
      );
    }
    return {
      projectId: scope.projectId,
      ticketId: null,
      latchKey: runLatchKey({
        ticketId: null,
        projectId: scope.projectId,
        automationId: automation?.id ?? null,
      }),
      priorRuns:
        automation === null
          ? []
          : deps.listProjectRunsForAutomation({
              automationId: automation.id,
              projectId: scope.projectId,
            }),
    };
  }

  /**
   * The one Run path, whichever scope it is aimed at. Both doors below are this
   * function with a different scope: the accept/execute/boot sequence, its
   * crash windows and its idempotency are one implementation, because two would
   * be two recovery stories.
   */
  async function startRun(input: InternalRunRequest): Promise<RunAutomationOutcome> {
    let persistedPlan: AutomationRunPlan | null;
    try {
      persistedPlan = await deps.engine.runPlan(input.commandId);
    } catch (error) {
      return refuse("RUN_FAILED", errorMessage(error));
    }
    if (persistedPlan !== null) return replayExistingPlan(input, persistedPlan);

    // What this Run will send, and where it came from. An Unbound Run has no
    // record to read: it carries its own Instructions, saves nothing beyond
    // the Run, and therefore skips every check that is about a record.
    let automation: Automation | null = null;
    let instructions: string;
    if (input.target.kind === "automation") {
      const found = deps.findAutomation(input.target.automationId);
      if (found === undefined) {
        return refuse("AUTOMATION_NOT_FOUND", "No Automation by that id exists.");
      }
      // Refused even when this invocation overrides the Runtime. The override
      // would indeed replace the corrupt value, but a record whose stored
      // Runtime cannot be read is a record to repair on the page rather than
      // one to keep running around — and a rescue that only worked from the
      // surfaces offering an override would be a second, quieter policy.
      if (found.runtime !== null && !isAutomationRuntimePin(found.runtime)) {
        return refuse(
          "RUN_FAILED",
          "This Automation's saved Runtime is invalid. Edit it and choose a valid model-and-reasoning pair before running.",
        );
      }
      automation = found;
      instructions = found.instructions;
    } else {
      // The shared rule the dialog's disabled Run button already applies — one
      // policy, checked again here because a door is not a form.
      const problem = unboundRunProblem(input.target.instructions);
      if (problem !== null) return refuse("INSTRUCTIONS_REQUIRED", problem);
      instructions = input.target.instructions;
    }
    const resolved = resolveScope(automation, input.scope);
    if ("ok" in resolved) return resolved;
    const subject = resolved.ticketId === null ? "for this Automation" : "on this Ticket";
    if (inFlight.has(resolved.latchKey)) {
      return refuse("RUN_IN_FLIGHT", `A Run is already starting ${subject}.`);
    }
    let releaseLatch!: () => void;
    const latch = new Promise<void>((resolve) => {
      releaseLatch = resolve;
    });
    inFlight.set(resolved.latchKey, latch);
    let bootOwnsLatch = false;
    try {
      const active = await activityGuard(resolved.priorRuns, subject);
      if (active !== null) return active;

      let supply: AutomationPromptSupply = { templates: [], skills: [] };
      try {
        supply = await deps.promptSupply(resolved.projectId);
      } catch (error) {
        // Composer behavior: an unreadable supply leaves the literal text in
        // place instead of changing the saved Instructions or refusing work.
        log(`[volli] automation Run could not read the prompt supply: ${errorMessage(error)}`);
      }
      const expanded = expandCommandInvocation(instructions, supply.templates, supply.skills);
      const accepted = await deps.engine.acceptRun({
        commandId: input.commandId,
        automation: automation === null ? null : { id: automation.id, name: automation.name },
        // The per-invocation override wins for THIS Run and is stored nowhere:
        // VC-112 puts the override on the deliberate surfaces precisely so a
        // person can spend one Run differently without editing the record.
        // Without one, the Automation's own Runtime rides (a whole pin, or
        // `null` to inherit through project and global preferences).
        runtime:
          input.modelOverride ??
          (automation !== null && isAutomationRuntimePin(automation.runtime)
            ? automation.runtime
            : null),
        // Recorded with the plan, because the plan is what a recovery replays
        // and the door that knew this will not exist then (VC-133).
        attendance: input.attendance,
        // Beside the RESOLVED Runtime above, what was actually asked for —
        // the durable half of this command id's identity, which no later
        // retry may quietly differ from.
        request: automationRunRequestIdentity(input),
        projectId: resolved.projectId,
        ticketId: resolved.ticketId,
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
        if (inFlight.get(resolved.latchKey) === latch) inFlight.delete(resolved.latchKey);
      });
      return outcome;
    } finally {
      if (!bootOwnsLatch) {
        releaseLatch();
        if (inFlight.get(resolved.latchKey) === latch) inFlight.delete(resolved.latchKey);
      }
    }
  }

  return {
    run(input) {
      return startRun({
        commandId: input.commandId,
        target: input.target,
        scope: { kind: "ticket", ticketId: input.ticketId },
        modelOverride: input.modelOverride,
        attendance: input.attendance,
      });
    },

    runForProject(input) {
      return startRun({
        commandId: input.commandId,
        target: { kind: "automation", automationId: input.automationId },
        scope: { kind: "project", projectId: input.projectId },
        // Nobody is standing at this door to choose a model: a schedule fires
        // unattended, and "Run now" on a Skipped occurrence is the same work
        // the schedule would have done. The record's own Runtime rides.
        modelOverride: null,
        // Attendance, by contrast, is NOT the same for those two — one of them
        // has a person in front of it — so it comes from the caller rather than
        // being assumed here. See `AutomationProjectRunRequest.attendance`.
        attendance: input.attendance,
      });
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

/**
 * A Session start that failed, as a Run refusal.
 *
 * `MODEL_UNAVAILABLE` is no longer something THIS host asks for — `executePlan`
 * records its Runtime rather than having it validated — but the arm stays for
 * two live reasons. {@link Sessions} is a port, so an implementation that
 * refuses anyway must still produce a sentence rather than a `RUN_FAILED`
 * shrug; and the code remains durable vocabulary, because a Run rejected under
 * it by an earlier build is still in the ledger and its command id may still
 * be replayed (`runRefusalCode` reads that stored code back).
 */
function mapSessionStartFailure(error: unknown): AutomationRunRefusal {
  if (error instanceof StructuredSessionsError) {
    if (error.code === "DEFAULT_MODEL_REQUIRED") return refuse("MODEL_REQUIRED", error.message);
    if (error.code === "MODEL_UNAVAILABLE") return refuse("MODEL_UNAVAILABLE", error.message);
    return refuse("RUN_FAILED", error.message);
  }
  return refuse("RUN_FAILED", errorMessage(error));
}
