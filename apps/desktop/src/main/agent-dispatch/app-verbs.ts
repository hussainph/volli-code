/**
 * The verbs that answer about the APP rather than about the board: a native
 * notification, the harness-integration audit, the Model Access catalog, and
 * what a fresh Session's prompt costs.
 *
 * Three of the four are things only main can answer — it owns the harness
 * runtime, the Pi runtime, and the prompt composition — and each reports the
 * retryable APP_UNREACHABLE class when the runtime it needs never came up this
 * launch, rather than inventing an answer.
 */

import { promptBaseline } from "@volli/agent-runtime";
import {
  doctorSummary,
  errorMessage,
  REQUIRABLE_SESSION_ENV_TOOLS,
  resolveDefaultModel,
  runDoctorChecks,
} from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  DoctorObservation,
  ModelAccessSnapshot,
  Observed,
  Project,
  RequirableSessionEnvTool,
  SessionEnvRepair,
} from "@volli/shared";

import { listMaterializableLinks } from "../db/blobs-repo";
import { readWorkspaceEnvironment } from "../session-env";
import { readModelAccessDefaults } from "../session-runtime/model-access-preferences";
import { PI_TOOLS } from "../session-runtime/pi-adapter";
import { composeProjectBrief, composeTicketBrief } from "./briefs";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import { projectForCreate, ticketForDisplayId } from "./resolution";

/** See {@link AgentCommandServiceOptions.modelAccessTimeoutMs}. */
const MODEL_ACCESS_TIMEOUT_MS = 8_000;

/**
 * The bounded Model Access read (VC-61's direction, applied in this arm): the
 * inspect gets an abort signal AND is raced against the same timer, because
 * the signal only helps a probe that honors it — a hung OAuth refresh inside
 * pi-ai ignores both, and the race is what keeps it from hanging the verb.
 * `null` is the timeout verdict; a pre-timeout inspection failure still
 * rejects through the race so the caller can name it.
 */
async function boundedModelAccessSnapshot(
  inspect: (input: { signal: AbortSignal }) => Promise<ModelAccessSnapshot>,
  timeoutMs: number,
): Promise<ModelAccessSnapshot | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const inspection = inspect({ signal: controller.signal });
  // A probe that loses the race settles later (usually rejecting on the
  // abort); that late settlement is already answered and must not surface as
  // an unhandled rejection.
  inspection.catch(() => {});
  try {
    return await Promise.race([inspection, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One reported field, as {@link Observed}. A string is a measurement. `null` is
 * ALSO a measurement — the caller looked and found nothing there, which is what
 * `volli doctor` sends for an unset `ZDOTDIR` or a `volli` that resolves
 * nowhere. Anything else never became a measurement at all, and says so:
 * `undefined`, which the checks render as a warn naming what was not read
 * instead of as a confident absence with a remedy attached.
 *
 * Coercing the third case into `null` is the collapse the whole command exists
 * to avoid. `zdotDir: 123` would report "ZDOTDIR is unset — open a new
 * terminal", and `volliPath: {}` would report "`volli` resolves to nothing —
 * agents cannot reach the planner". Confident, plausible, wrong, in the one
 * place a wrong answer is worth less than none.
 *
 * A malformed VALUE does not fail the request, which is where this door's
 * validate-don't-coerce rule bends, deliberately: it means the `volli` that
 * called and the main that answered disagree about the wire, and that is one of
 * the conditions doctor exists to name (another install owns the link, a stale
 * shim on PATH). Refusing there would delete every correct check in the report
 * to punish one field, in the command whose whole worth is that it still works
 * when things are broken. The SHAPE remains a contract — see {@link
 * parseDoctorObservation}, which refuses an observation it cannot read at all.
 */
function observedText(value: unknown): Observed<string> {
  if (typeof value === "string") return value;
  return value === null ? null : undefined;
}

/**
 * The tools the caller says its workspace implies (VC-157). Unknown names and
 * malformed shapes are dropped rather than refused, for the same reason a
 * malformed observed value is: this is the command that must still work when
 * the `volli` that called and the main that answered disagree about the wire.
 * What is dropped costs a fault, never a report — an empty list means nothing
 * here can fail, which is the safe direction for a disagreement to fall.
 *
 * Filtered against the REQUIRABLE census, not the measured one, so `gh` is
 * dropped here as well as at the producer: "no project implies gh" holds for
 * a payload this main did not compute, including one from an older `volli`.
 */
function observedRequiredTools(value: unknown): readonly RequirableSessionEnvTool[] {
  if (!Array.isArray(value)) return [];
  return REQUIRABLE_SESSION_ENV_TOOLS.filter((tool) => value.includes(tool));
}

function parseDoctorObservation(request: AgentRequest): DoctorObservation | null {
  const pathEntries = request.args["pathEntries"];
  const resolved = request.args["resolved"];
  if (!Array.isArray(pathEntries) || !pathEntries.every((entry) => typeof entry === "string")) {
    return null;
  }
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) return null;
  return {
    pathEntries,
    sessionId: request.ctx.env.session ?? null,
    zdotDir: observedText(request.args["zdotDir"]),
    resolved: Object.fromEntries(
      Object.entries(resolved as Record<string, unknown>).map(([key, value]) => [
        key,
        observedText(value),
      ]),
    ),
    volliPath: observedText(request.args["volliPath"]),
    requiredTools: observedRequiredTools(request.args["requiredTools"]),
  };
}

/** `volli notify` — a native notification to the user. */
export async function notifyVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options } = context;
  const message = request.args["message"];
  const title = request.args["title"] ?? "Volli Code";
  if (
    typeof message !== "string" ||
    message.trim().length === 0 ||
    typeof title !== "string" ||
    title.trim().length === 0
  ) {
    return failure("INVALID_REQUEST", "notify requires a message and optional title.");
  }
  options.notify?.(title, message);
  return { v: 1, ok: true, data: { notified: true } };
}

/** `volli doctor` — what the harness integration is actually doing here. */
export async function doctorVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options } = context;
  if (!options.doctorFacts) {
    return failure("APP_UNREACHABLE", "The harness runtime is not available this launch.");
  }
  // The caller reports what it sees from inside the environment under
  // test; main supplies only what it alone knows. Keeping those apart is
  // the point — an observation main reconstructed would be exactly the
  // kind of plausible, wrong answer this command exists to catch.
  const observation = parseDoctorObservation(request);
  if (observation === null) {
    return failure("INVALID_REQUEST", "doctor requires the caller's observed environment.");
  }
  let pathRepair: SessionEnvRepair | undefined;
  if (request.args["fix"] === true && options.doctorRepair) {
    try {
      pathRepair = await options.doctorRepair();
    } catch (error) {
      return failure("MUTATION_FAILED", `Repair failed: ${errorMessage(error)}`);
    }
  }
  const checks = runDoctorChecks(observation, await options.doctorFacts());
  return {
    v: 1,
    ok: true,
    data: {
      checks,
      summary: doctorSummary(checks),
      ...(pathRepair === undefined ? {} : { pathRepair }),
    },
  };
}

/** `volli model list` — signed-in providers, model ids, reasoning levels. */
export async function modelListVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options } = context;
  // Same structural stance as `session.start`: the only transport is the
  // app-owned socket, the Pi runtime lives in Electron main, and a launch
  // whose runtime never came up reports the retryable class.
  const inspect = options.inspectModelAccess;
  if (!inspect) {
    return failure("APP_UNREACHABLE", "The Model Access runtime is not available this launch.");
  }
  let snapshot: ModelAccessSnapshot | null;
  try {
    snapshot = await boundedModelAccessSnapshot(
      inspect,
      options.modelAccessTimeoutMs ?? MODEL_ACCESS_TIMEOUT_MS,
    );
  } catch (error) {
    return failure("MUTATION_FAILED", errorMessage(error));
  }
  if (snapshot === null) {
    return failure(
      "TIMEOUT",
      "Model Access did not answer in time (a provider probe may be hung). Retry, or check provider sign-in in the app.",
    );
  }
  // The signed-in slice is the default view: the full registered catalog
  // is ~1,200 rows, and dumping it into an agent's context window is the
  // failure mode this verb exists to prevent. `--all` is the explicit
  // opt-in, and the rollup count keeps the omission honest.
  const all = request.args["all"] === true;
  const shownProviders = all
    ? snapshot.providers
    : snapshot.providers.filter((provider) => provider.state === "available");
  const providers = shownProviders.map((provider) => {
    const catalog = snapshot.models.filter((model) => model.providerId === provider.id);
    const models = catalog
      .filter((model) => all || model.state === "available")
      .map((model) => ({
        // The copyable string: `session start --model` takes it verbatim
        // (the parser splits on the FIRST slash, so gateway model ids
        // containing one survive the round trip).
        model: `${model.providerId}/${model.modelId}`,
        label: model.label,
        state: model.state,
        reasoning: model.reasoningLevels,
      }));
    return {
      id: provider.id,
      label: provider.label,
      state: provider.state,
      models,
      // Models the filter withheld inside this shown provider get the
      // same honesty counter `omittedProviders` gives the provider list.
      omittedModels: catalog.length - models.length,
    };
  });
  // The app default is reported even when it names a model the filtered
  // view no longer shows — what `session start` will do without an
  // override is a fact about the app, not about this view.
  //
  // Which default: the Ticket one (VC-53), because `volli session start`
  // starts a Ticket Session. A profile that configured only the project
  // default sees that one, since an unset ticket default resolves to it.
  const selection = resolveDefaultModel(readModelAccessDefaults(options.db), "ticket");
  return {
    v: 1,
    ok: true,
    data: {
      observedAt: snapshot.observedAt,
      default: selection
        ? {
            model: `${selection.providerId}/${selection.modelId}`,
            reasoning: selection.reasoningLevel,
          }
        : null,
      providers,
      omittedProviders: snapshot.providers.length - shownProviders.length,
    },
  };
}

/** `volli prompt baseline` — what a fresh Session's prompt costs, per section. */
export async function promptBaselineVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession } = context;
  // The diagnostic must price what a real start composes, and the index
  // port is how a real start composes it — no port, no honest number.
  if (!options.skillsIndex) {
    return failure("APP_UNREACHABLE", "The session runtime is not available this launch.");
  }
  const ticketArg = request.args["ticket"];
  let role: "ticket" | "project";
  let project: Project;
  let workspacePath: string;
  let brief: string;
  if (ticketArg !== undefined) {
    const resolved = ticketForDisplayId(options.db, projects, ticketArg);
    if (!resolved.ok) return resolved.response;
    role = "ticket";
    project = resolved.project;
    // The directory a fresh attach would run in: the stamped worktree
    // when the ticket has one, the main checkout when it never will.
    workspacePath = resolved.ticket.worktreePath ?? project.path;
    brief = composeTicketBrief({
      project,
      ticket: resolved.ticket,
      attachments: listMaterializableLinks(options.db, null, resolved.ticket.id),
    });
  } else {
    const resolved = projectForCreate(options.db, projects, envSession, request);
    if (!resolved.ok) return resolved.response;
    role = "project";
    project = resolved.project;
    workspacePath = project.path;
    brief = composeProjectBrief({ project });
  }
  // A start with no named skills carries the index alone — the fresh-
  // session baseline this command exists to price. `null` is a real
  // measurement: a prompt with no resources section at all.
  const index = await options.skillsIndex(project.id);
  // No `workspacePath`: it is not a prompt byte any more (VC-164), so it
  // cannot change what the prompt costs. The measured environment is back
  // — not as a prompt layer, but because a workspace with absent
  // dependencies really is sent an extra ~60 tokens as a Turn Reminder on
  // the first message, and a breakdown that skipped them would under-price
  // that Session by exactly the bytes it moved out of the prompt.
  // Measured here the way a real attach measures it (VC-156).
  const baseline = promptBaseline({
    role,
    tools: { tools: [...PI_TOOLS.tools] },
    ...(index === null ? {} : { promptResources: [index] }),
    brief: { text: brief },
    workspaceEnvironment: readWorkspaceEnvironment(workspacePath),
  });
  return {
    v: 1,
    ok: true,
    data: {
      project: { name: project.name, prefix: project.ticketPrefix },
      role,
      workspace: workspacePath,
      ...baseline,
      // Named rather than guessed: these are serialized provider-side and
      // no count Volli invents for them would be a measurement.
      excluded: "tool definitions, the user's first message, and provider overhead",
    },
  };
}
