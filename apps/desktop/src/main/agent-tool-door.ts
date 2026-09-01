/**
 * The Agent Tool Surface's door into main (VC-162).
 *
 * `agent-dispatch/` answers the socket; this answers named tool calls from
 * inside the Agent Runtime. They are two doors onto one set of verbs, not two
 * implementations of them: both reach the same application handler, and the
 * Verb Registry's `VerbEntry.handler` binding is what says so.
 *
 * ## What this door has that the socket cannot have
 *
 * A caller it did not have to believe. The socket derives `user` versus
 * `session` from `VOLLI_SESSION` in the request environment, which any process
 * running as the user can set; it attributes its caller and cannot authenticate
 * one. Here the caller arrives as {@link RuntimeSessionIdentity}, closed over by
 * the adapter from the attachment the call came through. Nothing in the tool's
 * input names a Session, a project or an actor, and nothing could: the schema
 * has no field for it.
 *
 * That is the property VC-92 built the control tier around, and it is what makes
 * the caller's project a *bound* rather than a filter. A Session may start work
 * on Tickets in the project it belongs to. It cannot name a Ticket in another
 * project, because the resolution below is scoped to the one project the
 * attachment is in, before any display id is parsed.
 *
 * ## Refusals are text
 *
 * The socket has an error-code vocabulary that `volli help exit-codes` renders
 * and scripts branch on. A model has none of that: it reads the result. So a
 * refusal here is an ordinary tool result carrying a sentence the model can act
 * on — the line `web_fetch` already draws between a refusal (the policy working,
 * the model's move) and a host that could not answer at all (a failed call).
 */

import type Database from "better-sqlite3";
import {
  autoTitleFromKickoff,
  DEFAULT_KICKOFF_MESSAGE,
  displayTicketId,
  REASONING_LEVELS,
  shortSessionId,
  VERB_TOOLS,
} from "@volli/shared";
import type {
  Automation,
  AuthorityPolicy,
  Project,
  ReasoningLevel,
  RuntimeAskChoice,
  RuntimeAskRequest,
  RuntimeSessionIdentity,
  RuntimeVerbCall,
  RuntimeVerbResult,
  TicketEventActor,
  VerbToolKey,
} from "@volli/shared";

import { ticketForDisplayId } from "./agent-dispatch/resolution";
import { awaitTicketTool } from "./agent-await";
import type { SubscribeTicketWake } from "./agent-await";
import type { RunAutomationOutcome } from "./automations/run";
import { StructuredSessionsError } from "./session-runtime/sessions";
import type {
  TicketSessionDelegation,
  TicketSessionDelegationClaims,
} from "./session-runtime/delegation-policy";
import { sessionCreateCommandId } from "./session-runtime/sessions";
import { startSessionModelOverride, startSessionOperation } from "./session-runtime/start-session";
import type { StartSessionPorts } from "./session-runtime/start-session";
import {
  sendSessionMessageOperation,
  stopSessionOperation,
  SuperviseSessionError,
} from "./session-runtime/supervise-session";
import type { SuperviseSessionPorts } from "./session-runtime/supervise-session";

/**
 * The Automation half of this door (VC-134): what a project lists, and the one
 * Run door.
 *
 * Two methods and nothing else, because there is nothing else this verb may do.
 * `run` is `automations/run.ts` — the same door the command palette, the Ticket
 * rail and the board card reach — so single-flight, pin validation, composer
 * expansion, the fresh-Session rule and the `automation` Actor are all decided
 * there, once, for every caller. That is what makes a Run an agent started
 * indistinguishable in its record from one a person started by hand: it is not
 * a resemblance this door maintains, it is the same code.
 *
 * `list` exists only to turn a name into an id. An orchestrator knows an
 * Automation the way a person does — by what it is called — and has no id to
 * quote, so the name is resolved against the project's own listing (its
 * Automations plus every global one), and an unknown name is answered with the
 * names that do exist rather than with a second verb to go and look them up.
 */
export interface AutomationToolPort {
  /** Automations this project lists: its own plus every global one, in the app's order. */
  list(projectId: string): readonly Automation[];
  /** The one Run door. Its refusals are this door's refusals, unedited. */
  run(input: {
    commandId: string;
    automationId: string;
    ticketId: string;
  }): Promise<RunAutomationOutcome>;
}

/**
 * What the door reaches, resolved per call rather than captured.
 *
 * `projects` and `sessions` are functions because both change after this is
 * built: a project can be added while a Session runs, and the facade is
 * composed later in main's own startup order. Capturing either would freeze an
 * answer that is only true at boot.
 */
export interface AgentToolDoorOptions extends Omit<
  StartSessionPorts,
  "db" | "projects" | "sessions" | "actorTicketDisplay"
> {
  db: Database.Database;
  projects: () => readonly Project[];
  sessions: () => StartSessionPorts["sessions"] | null;
  actorTicketDisplay: StartSessionPorts["actorTicketDisplay"];
  /** Durable own-ticket claims for Ticket Role's birth grants (VC-183). */
  delegation: TicketSessionDelegationClaims;
  /**
   * The Automation host, read per call and `null` when the Session runtime
   * never came up this launch — the same absence the IPC transport reports.
   */
  automations: () => AutomationToolPort | null;
  /** The caller's project policy, read per call — `ticket.await` judges its wait when it starts. */
  authorityPolicy: (projectId: string) => AuthorityPolicy;
  /** The post-commit wake bus (`ticket-wake.ts`, VC-85 slice C) `ticket.await` parks on. */
  subscribeTicketWake: SubscribeTicketWake;
  /**
   * The supervision operations' ports (VC-86), resolved per call like the
   * Sessions facade: the runtime is composed after this door is. `null` reads
   * as "no structured runtime this launch" and each tool refuses in words.
   */
  supervise: () => SuperviseSessionPorts | null;
}

/** A refusal the model reads and can act on. Never a thrown error. */
function refusal(text: string): RuntimeVerbResult {
  return { text };
}

/**
 * The budget-ask capability one verb call rides in on (VC-204).
 *
 * Supplied by the attachment's own binding — the same parked-question machinery
 * the authority gate escalates through — and absent when the call arrived with
 * no way to put a question in front of a person, in which case a spent budget
 * refuses the way it always did. The door never chooses who answers: it states
 * the budget fact, and the binding owns the interaction.
 */
export type VerbBudgetAsk = (
  request: RuntimeAskRequest,
  signal: AbortSignal,
) => Promise<RuntimeAskChoice>;

/** The wire name the model called this verb by, read off the registry's own projection. */
function wireToolName(verb: VerbToolKey): string {
  return VERB_TOOLS.find((entry) => entry.key === verb)?.tool.name ?? verb;
}

/** One optional string field, trimmed, or a refusal naming the field. */
function optionalText(
  input: Readonly<Record<string, unknown>>,
  field: string,
): { ok: true; value: string | undefined } | { ok: false; text: string } {
  const raw = input[field];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, text: `\`${field}\` must be a non-empty string when given.` };
  }
  return { ok: true, value: raw };
}

/** The model override halves, validated the way the socket door validates them. */
function readModelOverride(input: Readonly<Record<string, unknown>>):
  | { ok: true; model?: { providerId: string; modelId: string }; reasoning?: ReasoningLevel }
  | {
      ok: false;
      text: string;
    } {
  const rawModel = input.model;
  let model: { providerId: string; modelId: string } | undefined;
  if (rawModel !== undefined && rawModel !== null) {
    const candidate = rawModel as { providerId?: unknown; modelId?: unknown };
    if (typeof candidate.providerId !== "string" || typeof candidate.modelId !== "string") {
      return { ok: false, text: "`model` needs both `providerId` and `modelId` as strings." };
    }
    model = { providerId: candidate.providerId, modelId: candidate.modelId };
  }
  const rawReasoning = input.reasoning;
  let reasoning: ReasoningLevel | undefined;
  if (rawReasoning !== undefined && rawReasoning !== null) {
    if (!(REASONING_LEVELS as readonly unknown[]).includes(rawReasoning)) {
      return {
        ok: false,
        text: `\`reasoning\` must be one of: ${REASONING_LEVELS.join(", ")}.`,
      };
    }
    reasoning = rawReasoning as ReasoningLevel;
  }
  return {
    ok: true,
    ...(model === undefined ? {} : { model }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/**
 * The calling Session, as the actor a planner event records.
 *
 * Always `session`, and never `user`: something called a tool, and the one
 * thing this door knows for certain is which Session's attachment it came
 * through. The socket's "no env means the user did it" \u2014 the highest-trust
 * actor granted by absence of evidence \u2014 has no equivalent here, because there
 * is no absence to read.
 */
function callerActor(session: RuntimeSessionIdentity): TicketEventActor {
  return { kind: "session", sessionId: session.sessionId, ticketId: session.ticketId };
}

/**
 * A spent delegation allowance, judged by the caller's project posture (VC-204).
 *
 * `ask` parks the call in front of the person driving; their "once" is recorded
 * as one durable extension and this call re-claims under the widened allowance.
 * Everything else — a `refuse` posture, a call that arrived without an ask
 * capability, a declined or withdrawn question — lands on the same honest
 * refusal the cap has always spoken, so the model's next move never depends on
 * why the slot was not granted.
 */
async function delegationLimitOutcome(
  options: AgentToolDoorOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  budgetAsk: VerbBudgetAsk | undefined,
  signal: AbortSignal,
  allowed: number,
): Promise<{ granted: true } | { granted: false; text: string }> {
  const spent = `This Ticket Session has already started the ${allowed} Sessions its in-ticket delegation allows.`;
  const posture = options.authorityPolicy(session.projectId).budgets.delegationExceeded;
  if (posture !== "ask" || budgetAsk === undefined) return { granted: false, text: spent };
  let choice: RuntimeAskChoice;
  try {
    choice = await budgetAsk(
      {
        cause: "budget.delegation-children",
        tool: wireToolName(request.verb),
        toolCallId: request.toolCallId,
        // The door does not know the turn; the binding correlates the question
        // by tool call id, which is the identity that survives everywhere.
        turnId: null,
        reason: `${spent} Allowing this call starts one more delegated Session on its Ticket.`,
        trip: "budget",
        overridable: true,
      },
      signal,
    );
  } catch {
    // A question nobody was shown, or one withdrawn when the turn stopped
    // waiting. Either way no decision exists, so the refusal stands — the
    // state the call was already in.
    return { granted: false, text: spent };
  }
  if (choice !== "allow") {
    return {
      granted: false,
      text: `${spent} The person driving declined to extend that allowance for this call.`,
    };
  }
  options.delegation.recordExtension({
    parentSessionId: session.sessionId,
    toolCallId: request.toolCallId,
  });
  return { granted: true };
}

async function startSessionTool(
  options: AgentToolDoorOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  // Starting a Session is not withdrawable mid-flight: by the time an abort
  // could be read the Session either durably exists or never did, and a
  // half-honoured cancel would strand the very record the operation id
  // protects. The signal is read only while a spent budget waits on a person —
  // before anything durable begins.
  signal: AbortSignal,
  budgetAsk?: VerbBudgetAsk,
): Promise<RuntimeVerbResult> {
  const sessions = options.sessions();
  if (sessions === null) {
    return refusal("Volli's Session runtime is not available this launch, so nothing was started.");
  }
  const ticketArg = request.input.ticket;
  if (typeof ticketArg !== "string" || ticketArg.trim().length === 0) {
    return refusal("`ticket` must be a Ticket display id, for example VC-12.");
  }
  const message = optionalText(request.input, "message");
  if (!message.ok) return refusal(message.text);
  const title = optionalText(request.input, "title");
  if (!title.ok) return refusal(title.text);
  const override = readModelOverride(request.input);
  if (!override.ok) return refusal(override.text);

  // Scoped to the caller's own project BEFORE the display id is parsed. This is
  // the authority bound, not a convenience: a Session cannot name a Ticket
  // outside the project its attachment belongs to, because no other project is
  // ever a candidate.
  const project = options.projects().find(({ id }) => id === session.projectId);
  if (project === undefined) {
    return refusal("This Session's project is no longer registered, so nothing was started.");
  }
  const resolved = ticketForDisplayId(options.db, [project], ticketArg.trim());
  if (!resolved.ok) {
    const reason = resolved.response.ok ? "" : ` ${resolved.response.error.message}`;
    return refusal(
      `No Ticket ${ticketArg.trim()} in this project, so nothing was started.${reason}`,
    );
  }

  // Trusted caller identity plus the runtime's own call id, and never a fresh
  // random one. Every durable write in the start is keyed on this, so replaying
  // one tool call lands one Session, one kickoff and one `session_started`
  // rather than a second set of all three.
  const operationId = `${session.sessionId}:${request.toolCallId}`;
  const claimRef = { parentSessionId: session.sessionId, toolCallId: request.toolCallId };

  // Project Sessions retain the existing project-wide control bound. A Ticket
  // Session only reaches this handler because its frozen birth surface carried
  // a stored `session.start` grant, and that grant's scope is narrower than the
  // generic project lookup above: exactly its attached Ticket.
  let delegation: TicketSessionDelegation | undefined;
  if (session.role === "ticket") {
    if (resolved.ticket.id !== session.ticketId) {
      return refusal("This Ticket Session can only start Sessions on its own Ticket.");
    }
    let claimed = options.delegation.claimStart({
      ...claimRef,
      ticketId: session.ticketId,
      createCommandId: sessionCreateCommandId(operationId),
    });
    if (!claimed.ok && claimed.reason === "limit") {
      // The allowance ran out. Not necessarily the end (VC-204): the project's
      // budget posture decides whether that is a wall or a question, and a
      // person's "once" widens the allowance by exactly one before the same
      // claim is made again — the ledger stays the only judge of a slot.
      const outcome = await delegationLimitOutcome(
        options,
        session,
        request,
        budgetAsk,
        signal,
        claimed.allowed,
      );
      if (!outcome.granted) return refusal(outcome.text);
      claimed = options.delegation.claimStart({
        ...claimRef,
        ticketId: session.ticketId,
        createCommandId: sessionCreateCommandId(operationId),
      });
    }
    if (!claimed.ok) {
      return refusal(
        claimed.reason === "limit"
          ? `This Ticket Session has already started the ${claimed.allowed} Sessions its in-ticket delegation allows.`
          : "This Ticket Session was not granted in-ticket delegation when it started.",
      );
    }
    delegation = claimed.delegation;
  } else if (options.delegation.startGrantScope(session.sessionId) !== null) {
    // Born a Ticket Session, presenting as a ticketless one. Deleting a Ticket
    // sets `sessions.ticket_id` to NULL, and the frozen tool surface is replayed
    // rather than re-derived — so without this the Session would keep a
    // `session.start` it was granted under an own-ticket bound and be judged by
    // the project-wide one instead. The durable grant outlives the Ticket
    // precisely so this refusal can exist.
    return refusal(
      "This Session's start authority is scoped to its own Ticket, which is no longer attached, so nothing was started.",
    );
  }

  try {
    const started = await startSessionOperation(
      {
        db: options.db,
        projects: options.projects(),
        sessions,
        submitSessionMessage: options.submitSessionMessage,
        refineAutoTitle: options.refineAutoTitle,
        onMutation: options.onMutation,
        onSessionStarted: options.onSessionStarted,
        actorTicketDisplay: options.actorTicketDisplay,
        now: options.now,
      },
      {
        operationId,
        project: resolved.project,
        ticket: resolved.ticket,
        ...(message.value === undefined ? {} : { message: message.value }),
        ...(title.value === undefined ? {} : { title: title.value }),
        ...(() => {
          const built = startSessionModelOverride(override.model, override.reasoning);
          return built === undefined ? {} : { modelOverride: built };
        })(),
        ...(delegation === undefined ? {} : { delegation }),
        actor: callerActor(session),
      },
      { defaultKickoff: DEFAULT_KICKOFF_MESSAGE, autoTitle: autoTitleFromKickoff },
    );
    // The short public handle, exactly as the socket answers with: a full UUID
    // is not a thing any other Volli surface accepts back, so handing one to a
    // model would be handing it an id it cannot use.
    const handle = shortSessionId(started.sessionId);
    return {
      text: [
        `Started Session ${handle} on ${started.ticketDisplayId}, titled ${JSON.stringify(started.title)}.`,
        `Model: ${started.model.providerId}/${started.model.modelId} at reasoning ${started.model.reasoningLevel}.`,
        started.state === "ready"
          ? "It is attached and its kickoff turn has been submitted. It runs on its own from here and does not report back into this Session; use `volli session peek` to look in on it."
          : "It was created but its attachment needs recovery, so no kickoff was submitted. A person can retry it from the app.",
      ].join("\n"),
    };
  } catch (error) {
    // A failure before the Session's create command is durable must not burn a
    // fan-out slot. Once create exists, replay owns recovery and the claim stays
    // put — a later retry records the same child's birth grant rather than
    // starting another Session. The ledger reads that evidence off the claim it
    // stored, so this call does not restate how a create id is spelled.
    if (delegation !== undefined) options.delegation.releaseIfUnstarted(claimRef);
    // A refusal the facade named is still an answer about the request, so the
    // model gets its words. Anything else is a host that could not carry out
    // the start at all, and that fails the call.
    if (error instanceof StructuredSessionsError) {
      return refusal(`Volli refused to start the Session: ${error.message}`);
    }
    throw error;
  }
}

async function stopSessionTool(
  options: AgentToolDoorOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  // Not withdrawable mid-flight for the same reason a start is not: by the
  // time an abort could be read, the stop fact either durably exists or never
  // did, and a half-honoured cancel would strand the record.
  _signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const ports = options.supervise();
  if (ports === null) {
    return refusal("Volli's Session runtime is not available this launch, so nothing was stopped.");
  }
  const handle = requiredText(
    request.input,
    "session",
    "a short session id, as `volli session list` prints it.",
  );
  if (!handle.ok) return refusal(handle.text);
  const reason = optionalText(request.input, "reason");
  if (!reason.ok) return refusal(reason.text);
  try {
    const outcome = await stopSessionOperation(ports, {
      // The caller's identity plus the runtime's own call id (VC-162's
      // discipline): a replayed tool call finds its own stop already recorded
      // instead of writing a second one.
      operationId: `${session.sessionId}:${request.toolCallId}`,
      callerSessionId: session.sessionId,
      projectId: session.projectId,
      handle: handle.value,
      ...(reason.value === undefined ? {} : { reason: reason.value }),
    });
    const acts =
      outcome.interrupted && outcome.released
        ? "Its open turn was interrupted and its executor released."
        : outcome.released
          ? "Its executor was released; no turn was open."
          : "Nothing was live to interrupt or release.";
    return {
      text: [
        outcome.previouslyStopped
          ? `Session ${outcome.handle}${outcome.title === null ? "" : ` (${JSON.stringify(outcome.title)})`} was already recorded as stopped; retried its live executor.`
          : `Stopped Session ${outcome.handle}${outcome.title === null ? "" : ` (${JSON.stringify(outcome.title)})`}, recorded as stopped by this Session.`,
        acts,
        ...outcome.failures,
        "Its history stays openable, and a person can reattach it.",
      ].join(" "),
    };
  } catch (error) {
    if (error instanceof SuperviseSessionError) return refusal(error.message);
    throw error;
  }
}

async function sendSessionTool(
  options: AgentToolDoorOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  _signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const ports = options.supervise();
  if (ports === null) {
    return refusal("Volli's Session runtime is not available this launch, so nothing was sent.");
  }
  const handle = requiredText(
    request.input,
    "session",
    "a short session id, as `volli session list` prints it.",
  );
  if (!handle.ok) return refusal(handle.text);
  const message = requiredText(request.input, "message", "the steering text to deliver.");
  if (!message.ok) return refusal(message.text);
  try {
    const outcome = await sendSessionMessageOperation(ports, {
      operationId: `${session.sessionId}:${request.toolCallId}`,
      callerSessionId: session.sessionId,
      projectId: session.projectId,
      handle: handle.value,
      message: message.value,
    });
    return {
      text: [
        `Steering delivered into Session ${outcome.handle}${outcome.title === null ? "" : ` (${JSON.stringify(outcome.title)})`}, marked as coming from this Session.`,
        outcome.midTurn
          ? "A turn was open, so the model reads it mid-stream."
          : "No turn was open, so it opens one.",
        "Nothing reports back into this Session; use `volli session peek` to observe the effect.",
      ].join(" "),
    };
  } catch (error) {
    if (error instanceof SuperviseSessionError) return refusal(error.message);
    throw error;
  }
}

/**
 * One required string field, trimmed, or a refusal naming the field.
 *
 * Separate from {@link optionalText} rather than a flag on it: a required field
 * that is absent and one that is blank are the same mistake to the model, and
 * both have to be told in a sentence rather than by a schema error.
 */
function requiredText(
  input: Readonly<Record<string, unknown>>,
  field: string,
  hint: string,
): { ok: true; value: string } | { ok: false; text: string } {
  const raw = input[field];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, text: `\`${field}\` is required: ${hint}` };
  }
  return { ok: true, value: raw.trim() };
}

/**
 * One saved Automation, found the way a person finds one: by what it is called.
 *
 * Matched case-insensitively, and by id as well, so an id read out of a Run
 * record still works. Where a project's own Automation and a global one share a
 * name the project's own wins — which is the app's listing rule
 * (`listAutomationsForProject` orders the project's first), not a rule invented
 * here. A name that still matches two records is refused rather than guessed:
 * two Automations with one name do different work, and starting the wrong one
 * spends a model and writes a Session.
 */
function resolveAutomation(
  listed: readonly Automation[],
  named: string,
): { ok: true; automation: Automation } | { ok: false; text: string } {
  const wanted = named.toLowerCase();
  const matches = listed.filter(
    (automation) => automation.id === named || automation.name.trim().toLowerCase() === wanted,
  );
  if (matches.length === 0) {
    const names = listed.map((automation) => JSON.stringify(automation.name)).join(", ");
    return {
      ok: false,
      text:
        listed.length === 0
          ? `No Automation called ${JSON.stringify(named)} here, and this project lists none at all, so nothing was started. A person creates one in the app first.`
          : `No Automation called ${JSON.stringify(named)} in this project, so nothing was started. This project lists: ${names}.`,
    };
  }
  const own = matches.filter((automation) => automation.projectId !== null);
  const preferred = own.length > 0 ? own : matches;
  if (preferred.length > 1) {
    return {
      ok: false,
      text: `This project lists more than one Automation called ${JSON.stringify(named)}, so nothing was started rather than the wrong one. Ask a person which to run, or have the duplicate renamed.`,
    };
  }
  return { ok: true, automation: preferred[0]! };
}

/**
 * Start one Automation Run on one Ticket in the caller's project (VC-134).
 *
 * The door's whole job is resolution: a name and a display id become an
 * Automation id and a Ticket id in the project the ATTACHMENT belongs to, and
 * the Run door does the rest. Nothing about the Run is parameterised from here
 * — no Instructions, no model, no title, no actor — because anything an agent
 * could vary would be a way for its Run to differ from a person's.
 */
async function runAutomationTool(
  options: AgentToolDoorOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  // Unwithdrawable for the same reason a start is: by the time an abort could
  // be read, the Run either durably exists or never did.
  _signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const automations = options.automations();
  if (automations === null) {
    return refusal(
      "Volli's Automation runtime is not available this launch, so nothing was started.",
    );
  }
  const named = requiredText(
    request.input,
    "automation",
    "the name of a saved Automation, for example 'Nightly sweep'.",
  );
  if (!named.ok) return refusal(named.text);
  const ticketArg = requiredText(
    request.input,
    "ticket",
    "a Ticket display id, for example VC-12.",
  );
  if (!ticketArg.ok) return refusal(ticketArg.text);

  // The same bound `session.start` draws, and for the same reason: the caller's
  // project is the only project resolution ever sees, so neither the Ticket nor
  // the Automation can be named outside it.
  const project = options.projects().find(({ id }) => id === session.projectId);
  if (project === undefined) {
    return refusal("This Session's project is no longer registered, so nothing was started.");
  }
  const resolvedTicket = ticketForDisplayId(options.db, [project], ticketArg.value);
  if (!resolvedTicket.ok) {
    const reason = resolvedTicket.response.ok ? "" : ` ${resolvedTicket.response.error.message}`;
    return refusal(
      `No Ticket ${ticketArg.value} in this project, so nothing was started.${reason}`,
    );
  }
  const found = resolveAutomation(automations.list(project.id), named.value);
  if (!found.ok) return refusal(found.text);

  const outcome = await automations.run({
    // The caller's own identity plus the runtime's call id, never a fresh
    // random one: the Automation command ledger deduplicates on this, so a
    // replayed tool call lands one Run, one Session and one first message.
    commandId: `${session.sessionId}:${request.toolCallId}`,
    automationId: found.automation.id,
    ticketId: resolvedTicket.ticket.id,
  });
  if (!outcome.ok) {
    // The Run door's refusals are already sentences about this request — a Run
    // in flight, a pinned model gone unavailable, no default model at all — so
    // they pass through as the model's answer rather than being reclassified.
    return refusal(`Volli refused to start the Run: ${outcome.error}`);
  }
  const display = displayTicketId(
    resolvedTicket.project.ticketPrefix,
    resolvedTicket.ticket.ticketNumber,
  );
  const model = outcome.run.model;
  return {
    text: [
      `Started ${JSON.stringify(found.automation.name)} on ${display} as Session ${shortSessionId(outcome.run.sessionId)}.`,
      `Model: ${model.providerId}/${model.modelId} at reasoning ${model.reasoningLevel}.`,
      "The Run is recorded with the automation Actor, exactly as one a person starts by hand. It opened a fresh Session that runs on its own and does not report back into this one; use `volli session peek` to look in on it.",
    ].join("\n"),
  };
}

/**
 * The verb-to-handler binding for this door, total over what a bundle can hold.
 *
 * A `Record` over {@link VerbToolKey} rather than a switch with a default, so
 * the day a second verb takes a `tool` access mode this file stops compiling
 * until it has a handler. That is the same discipline `AGENT_VERB_TABLE` holds
 * for the socket, and the reason is the same: a declared verb with no binding
 * is a tool a Session is handed and then cannot call.
 */
type VerbToolHandlers = Record<
  VerbToolKey,
  (
    options: AgentToolDoorOptions,
    session: RuntimeSessionIdentity,
    request: RuntimeVerbCall,
    signal: AbortSignal,
    budgetAsk?: VerbBudgetAsk,
  ) => Promise<RuntimeVerbResult>
>;

// Declaration order follows the registry's, so the table reads as the tool
// array does.
const VERB_TOOL_HANDLERS: VerbToolHandlers = {
  "session.start": startSessionTool,
  "session.stop": stopSessionTool,
  "session.send": sendSessionTool,
  "ticket.await": (options, session, request, signal) =>
    awaitTicketTool(
      {
        db: options.db,
        projects: options.projects,
        authorityPolicy: options.authorityPolicy,
        subscribeTicketWake: options.subscribeTicketWake,
      },
      session,
      request,
      signal,
    ),
  "automation.run": runAutomationTool,
};

/**
 * The one closure the Pi adapter hands every attachment that holds a verb.
 *
 * Named so main can declare the binding before it can build it: the door is
 * composed from the Sessions facade, which is composed after the adapter that
 * calls the door.
 */
export type AgentToolDoor = (
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  signal: AbortSignal,
  budgetAsk?: VerbBudgetAsk,
) => Promise<RuntimeVerbResult>;

/** Build the one closure the Pi adapter hands every attachment that holds a verb. */
export function createAgentToolDoor(options: AgentToolDoorOptions): AgentToolDoor {
  return async (session, request, signal, budgetAsk) => {
    const handler = VERB_TOOL_HANDLERS[request.verb];
    if (handler === undefined) {
      // Unreachable through a resolved surface, and refused rather than
      // asserted: a tool array is built from the same registry this table is
      // total over, so arriving here means the two disagreed.
      return refusal(`${request.verb} is not a verb this build can run.`);
    }
    return handler(options, session, request, signal, budgetAsk);
  };
}
