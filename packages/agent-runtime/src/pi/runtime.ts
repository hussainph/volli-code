/** The singular, Node-hostable Agent Runtime backed by Pi core. */

import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentMessage,
  type AgentOptions,
  type Branch,
  type CompactionSettings,
  type HarnessEvent,
  type CustomEntry,
  type Entry,
  type JsonValue,
  type MessageEntry,
  type Session,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  Agent,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import {
  getSupportedThinkingLevels,
  type AssistantMessage,
  type CredentialStore,
  type Models,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  appendPromptResources,
  COMPACTION_REASONS,
  COST_BASES,
  DEFAULT_COMPACTION_POLICY,
  errorMessage,
  isActivityKind,
  isMcpToolId,
  isPromptResource,
  NOOP_OBSERVABILITY_SINK,
  ObservabilityReducer,
  promptResourceBlock,
  readPromptResourceBlocks,
  SESSION_USAGE_CAUSES,
  UtilityCompletionError,
  type AgentRuntime,
  type AuthoritySnapshot,
  type CapabilityPolicy,
  type RuntimeShellPort,
  type CompactionObservation,
  type CompactionPolicy,
  type CompactionWorkReason,
  type CompactionRequestOutcome,
  type DeliveryOutcome,
  type ModelAccessSnapshot,
  type ObservabilitySink,
  type PromptResource,
  type ProviderReasoningDroppedObservation,
  type ReasoningDropCause,
  type RuntimeAttachmentHandle,
  type RuntimeContextCarry,
  type RuntimeActivityObservation,
  type RuntimeActivityValue,
  type RuntimeFailure,
  type RuntimeImageInput,
  type SettledMessageObservation,
  type AttentionObservation,
  type RuntimeSessionIdentity,
  type SessionRuntimeSpec,
  type TurnObservation,
  type UsageObservation,
  type UtilityCompletion,
  type UtilityCompletionResult,
} from "@volli/shared";
import { resolveCapabilityPolicy } from "../authority/capability";
import { authorityVerdict } from "../authority/gate";
import { composeFirstUserMessage, composeSystemPrompt } from "../prompt";
import { mapPiActivity } from "./activity";
import {
  compactionDue,
  compactionPathForModel,
  compactSession,
  contextMessages,
  contextWindowOf,
  conversationPath,
  estimatedContextTokens,
  type CompactionOutcome,
  type ConversationReader,
} from "./compaction";
import { createContextTokenProjector } from "./token-counting";
import { conversationIsEmpty, systemHead, withSystemHead } from "./transcript-context";
import {
  ANTHROPIC_COMPACT_BETA,
  nativeCompactionAvailable,
  providerCompactionFromDetails,
  projectOpenAICompaction,
  projectAnthropicCompaction,
  readProviderCompaction,
  type NativeRequestObservation,
} from "./provider-compaction";
import { AuthorityEscalation } from "./escalation";
import { piExecutionEnv } from "./execution-env";
import { ScopedExecutionEnv } from "./scoped-execution-env";
import {
  hostGitReadables,
  NO_HOST_GIT,
  readHostGitSettings,
  type HostGitSettings,
} from "./host-git";
import {
  inspectPiModelAccess,
  type InspectPiModelAccessInput,
  type PiModelAccessSource,
  type UsageLimitsSource,
} from "./model-access";
import type { RefreshableCatalogs } from "./model-catalog";
import { piOwnedModelAccess } from "./models";
import {
  instrumentStreamFn,
  providerErrorClassForStatus,
  recordObservationToSink,
  teeObservationsToSink,
} from "./observability";
import { failureResetsAt } from "./quota-reset";
import { headerUsageUpdate } from "./usage-limits/passive";
import { UsageLimitsHolder } from "./usage-limits/holder";
import { UsageProbeSchedule, type UsageProbeFetch } from "./usage-limits/probe";
import { OrderedObservationDelivery } from "./ordered-observation-delivery";
import { piContext, type Context } from "./pi-context";
import { providerImageGuard, withProviderSafeImages } from "./provider-images";
import { providerReasoningDropped, withoutReasoning } from "./reasoning";
import { migrateLegacySidecar } from "./sidecar-migration";
import { MAIN_BRANCH, SIDECAR_IDENTITY, type SidecarIdentity } from "./sidecar-storage";
import { createSessionTools } from "./tools";
import {
  savedOutputDirectoriesIn,
  ToolOutputLedger,
  ToolOutputStore,
  toolOutputDirectoryFor,
} from "./tool-output";
import { applyToolDispatch } from "./tool-dispatch";
import {
  assistantUsage,
  attentionReasonFor,
  classifyAssistantMessage,
  isTransientTransportFailure,
  isUnreachedAuthFailure,
  recoveryRefFor,
  retryHintMs,
  sanitizeDiagnostic,
  sessionUsageFrom,
} from "./transcript";
import { ALWAYS_ONLINE, type ConnectivityPort } from "./connectivity";
import {
  DEFAULT_STREAM_SUPERVISION,
  superviseStreams,
  type StreamSupervisionTiming,
} from "./stream-supervision";
import {
  autoRetryDelayMs,
  planTransportRetry,
  TRANSPORT_NOTICE_AFTER_ATTEMPTS,
} from "./transport-retry";

/**
 * The detail a transport notice carries while the machine has no network. A
 * noun phrase under the chat's "Reconnecting" row, and nothing more.
 */
const OFFLINE_NOTICE = "Waiting for network";
const OPENCODE_GO_PROVIDER = "opencode-go";
const OPENCODE_SESSION_HEADER = "x-opencode-session";

/**
 * Add OpenCode Go's required routing identity to every physical provider request.
 *
 * Pi already forwards `sessionId`, but its built-in affinity formats emit other
 * header names. Caller headers are the one path all three Go adapters merge
 * last, so the same opaque sidecar id reaches completions, responses and
 * messages without changing unrelated providers.
 */
function withOpenCodeGoSessionHeader(
  inner: AgentOptions["streamFn"],
  sessionId: string,
): AgentOptions["streamFn"] {
  return (model, context, options) => {
    if (model.provider !== OPENCODE_GO_PROVIDER) return inner(model, context, options);
    return inner(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        [OPENCODE_SESSION_HEADER]: sessionId,
      },
    });
  };
}

/**
 * Volli's compaction vocabulary, checked against the executor's own.
 *
 * `@volli/shared` depends on nothing and so spells Pi's compaction reasons out
 * rather than importing them; this is the one file that can see both, and the
 * `satisfies` is what makes a word Volli uses that Pi does not a compile error
 * rather than a divergence nobody notices. The list is also what validates a
 * persisted marker on recovery.
 *
 * Pi 0.85.0 deleted the named `CompactionReason` type. The three words did not
 * change — they are still `manual`, `threshold` and `overflow` — but they now
 * exist only as an inline union inside the harness event payloads, so the type
 * has to be recovered from one of those rather than imported by name. Doing it
 * this way rather than restating the union keeps the check honest: it still
 * fails to compile if Pi ever drops or renames one of the three.
 *
 * The check is one-directional now, and deliberately. Volli names a fourth
 * reason — `checkpoint`, a provider-native checkpoint this Session can no
 * longer use — that Pi has no producer for and no word for, so the assertion
 * is that each of PI's reasons is still one of VOLLI's rather than that the
 * two lists are equal.
 */
type PiCompactionReason = Extract<HarnessEvent, { type: "compaction_start" }>["reason"];
const PI_COMPACTION_REASONS = [
  "manual",
  "threshold",
  "overflow",
] as const satisfies readonly PiCompactionReason[];
const COMPACTION_WORK_REASON_VALUES: readonly CompactionWorkReason[] = PI_COMPACTION_REASONS;

export interface PiRuntimeHostOptions {
  /** Directory that owns every attachment's Pi JSONL recovery sidecar. */
  sessionDataDir: string;
  /**
   * The Pi model collection this host runs on.
   *
   * Injected by deterministic tests that script the provider call, and injected
   * in the product too since in-app sign-in arrived: main builds the pair with
   * {@link piOwnedModelAccess} and hands the same collection to the runtime and
   * to the login service, so a credential written by one is a credential the
   * other is already holding the store for. Omitted, this builds its own.
   */
  models?: Models;
  /**
   * The credential store behind {@link PiRuntimeHostOptions.models}, when the
   * caller has one. Only Model Access reads it, and only to ask which providers
   * this profile stored something for. A scripted `models` normally comes with
   * no store, which reads as "cannot tell" rather than as an empty profile.
   */
  credentials?: CredentialStore;
  /**
   * Completion of local catalog restoration for an injected collection.
   * Main passes this with the `piOwnedModelAccess` pair; scripted collections
   * omit it because they have no persisted catalog.
   */
  catalogReady?: Promise<void>;
  /** Credential-independent public catalogs attached to the injected collection. */
  catalogs?: RefreshableCatalogs;
  /** Host clock for runtime observations; injectable for deterministic tests. */
  now?: () => number;
  /**
   * The filesystem and shell capability one Session's tools are given.
   *
   * Injectable so deterministic Node runtime tests can script it, and so a
   * host can add what only it knows — main exports the Session's identity,
   * its CLI's bin dir and its concurrency budget. For a Scoped Session the
   * factory is handed the resolved policy and must build `ScopedExecutionEnv`
   * from it; see {@link ExecutionEnvFactory}.
   *
   * Called with the Session's own identity beside the workspace, so a host can
   * export who is running — main maps it to `VOLLI_SESSION`/`VOLLI_TICKET` via
   * `piExecutionEnv`'s `identity` option (VC-51). The default factory sets
   * neither: only a host knows a Ticket's display id.
   */
  executionEnvFactory?: ExecutionEnvFactory;
  /**
   * The host's own private state, on the denylist of every Session
   * this runtime attaches (VC-45): main passes its `userData`, which holds the
   * database, `mcp-credentials.json`, backups, and every Session's sidecar and
   * saved output. The runtime adds {@link sessionDataDir} itself, so one
   * Session's saved output stays unreadable to another even for a host that
   * names nothing.
   */
  hostPrivateRoots?: readonly string[];
  /**
   * The host's own credential files, in the credential tier of every Session's
   * denylist (VC-45): main passes `mcp-credentials.json`. Inside
   * {@link hostPrivateRoots} already, and named again so no grant and no
   * person's "yes" to a private read reaches them.
   */
  hostCredentialPaths?: readonly string[];
  /**
   * Paths inside {@link hostPrivateRoots} the host exposes to its Sessions on
   * purpose, read-only: the directory the `volli` shim lives in, so a Scoped
   * Session's shell can still run the CLI it is told to use.
   */
  hostExposedPaths?: readonly string[];
  /**
   * The wait before an auto-retried attempt, by zero-based attempt number.
   * Injectable so deterministic tests need not spend the real backoff.
   */
  retryBackoffMs?: (attempt: number) => number;
  /**
   * Whether the machine has a network, and when it woke (VC-443). A transient
   * failure while offline waits for the network instead of spending the online
   * retry budget, and a wake cuts any provider request that stays silent past
   * it. Main implements it over Electron's `net` and `powerMonitor`; absent,
   * the host is {@link ALWAYS_ONLINE} and nothing ever wakes.
   */
  connectivity?: ConnectivityPort;
  /**
   * How long a provider request may stay silent before it is cut and retried,
   * and how long one open across a sleep has to speak after the wake.
   * Injectable so deterministic tests need not wait nine minutes; see
   * `stream-supervision.ts` for why the product values are what they are.
   */
  streamSupervision?: StreamSupervisionTiming;
  /**
   * The compaction policy every attachment is run under, read at the moment it
   * is needed rather than captured at attach.
   *
   * A callback because a Session outlives a settings change, and the next
   * compaction should happen under the policy configured now — a switch flipped
   * in Settings that only took effect on the Sessions started after it would be
   * a switch that does not work.
   *
   * Absent, this runs {@link DEFAULT_COMPACTION_POLICY}: automatic compaction
   * on, which is the behaviour of every caller that has never heard of this
   * option.
   */
  compactionPolicy?: () => CompactionPolicy;
  /**
   * Where metadata-only observability events go. A side channel, never a
   * participant: the runtime reduces its own observations and provider
   * attempts to bounded events and hands them here without awaiting, and a
   * sink that throws costs a run nothing but the lost measurement. Absent
   * means disabled — the no-op sink, not an `undefined` check per call.
   */
  observability?: ObservabilitySink;
  /**
   * The subscription usage read (VC-263): where each account's windows are
   * held, and the fetch its on-demand probe uses. Opt-in, and the fetch is
   * required rather than defaulted: this runtime does not choose its own
   * transport to a provider endpoint, and a test hands in a fetch that never
   * reaches the network while main hands in the platform one. The holder is
   * optional — a fresh one per runtime is right when the host has no opinion.
   * Absent means the read is off, which is also the safe failure mode for a
   * host that forgot: a page with no bars rather than a page probing
   * endpoints nobody asked about.
   */
  usageLimits?: {
    holder?: UsageLimitsHolder;
    fetch: UsageProbeFetch;
  };
  /**
   * Whether a Session's frozen, host-authored parallel-read marks may take
   * effect (VC-454). Developer-only for now, and off unless a host says
   * otherwise: absent, every Session dispatches its tool batches one call at a
   * time whatever its record holds, which makes this the kill switch for
   * Sessions already born with marks. On, a Session runs Pi's parallel mode
   * only if its own MCP definitions carry the mark — see `tool-dispatch.ts`.
   */
  parallelMcpReads?: boolean;
}

/**
 * What a Scoped Session's environment is built from (VC-45): the attachment's
 * resolved capability policy — the same object the authority gate judges calls
 * against — and the scratch directory its commands are handed as `TMPDIR`,
 * which the runtime created inside the policy's writable roots and removes when
 * the attachment closes.
 */
export interface ScopedContainment {
  policy: CapabilityPolicy;
  scratchDirectory: string;
  /** The host's git settings a contained git is handed; their files are among the policy's grants. */
  git: HostGitSettings;
}

/**
 * Builds the filesystem and shell capability one Session's tools are given.
 *
 * `containment` is present exactly when the Session's policy says `scoped`, and
 * a factory handed one MUST build walls from it — `ScopedExecutionEnv` is the
 * one that does — because the gate has already been told the Session is
 * contained and stops offering overrides the walls would refuse.
 */
export type ExecutionEnvFactory = (
  workspacePath: string,
  identity: RuntimeSessionIdentity,
  containment?: ScopedContainment,
) => Promise<ExecutionEnv>;

/**
 * A Scoped Session's background shell port: the host's own, with every start
 * wrapped in the walls the `execute` tool's commands run behind (VC-45).
 *
 * The background shell host spawns its own children, so the walls travel to it
 * as a `contain` hook rather than as an environment. A factory that answered a
 * Scoped Session with something other than `ScopedExecutionEnv` has no walls to
 * offer, and its shells are refused rather than started uncontained.
 */
function containedShellPort(port: RuntimeShellPort, env: ExecutionEnv): RuntimeShellPort {
  const contain =
    env instanceof ScopedExecutionEnv
      ? (command: string, cwd: string) => env.containLaunch(command, cwd)
      : async (): Promise<never> => {
          throw new Error(
            "This Scoped Session's execution environment cannot wrap a background shell in its walls, so none was started.",
          );
        };
  // No `dispose`: the runtime never calls it. The host disposes its own port,
  // the one this wraps, when the attachment ends.
  return {
    start: (input) => port.start({ ...input, contain }),
    output: (input) => port.output(input),
    kill: (input) => port.kill(input),
  };
}

/** Everything {@link attachSession} needs, with the default already chosen. */
interface PiRuntimeHost {
  sessionDataDir: string;
  /** One bound across every attachment's saved tool output (VC-469). */
  toolOutputLedger: ToolOutputLedger;
  parallelMcpReads: boolean;
  models: Models;
  credentials: CredentialStore | null;
  catalogReady: Promise<void>;
  catalogs?: RefreshableCatalogs;
  now: () => number;
  executionEnvFactory: ExecutionEnvFactory;
  hostPrivateRoots: readonly string[];
  hostCredentialPaths: readonly string[];
  hostExposedPaths: readonly string[];
  retryBackoffMs: (attempt: number) => number;
  connectivity: ConnectivityPort;
  streamSupervision: StreamSupervisionTiming;
  compactionPolicy: () => CompactionPolicy;
  observability: ObservabilitySink;
  /**
   * One holder and one schedule per runtime: a hold the endpoint imposed
   * outlives the inspection. Absent when the host did not opt in.
   */
  usageLimits?: UsageLimitsSource;
}

/**
 * The collection and its store, or the pair this process owns.
 *
 * Written as one branch on `models` rather than two independent `??` defaults
 * on purpose: falling back per field would build a real {@link
 * PiFileCredentialStore} — pointed at the developer's own `auth.json` — the
 * moment a test scripted a collection without one, and a unit test that reads a
 * person's credentials is a unit test that has already gone wrong.
 */
function resolveModelAccess(options: PiRuntimeHostOptions): PiModelAccessSource {
  const models = options.models;
  if (models === undefined) return piOwnedModelAccess();
  return {
    models,
    credentials: options.credentials ?? null,
    catalogReady: options.catalogReady,
    catalogs: options.catalogs,
  };
}

/**
 * Build the one structured executor port. The models are resolved once rather
 * than per attachment: the credential store behind them serializes this
 * process's writes to Pi's `auth.json`, and a fresh store per attach would not.
 *
 * Every Session it attaches dispatches a model-issued tool batch sequentially,
 * unless {@link PiRuntimeHostOptions.parallelMcpReads} is on AND that Session's
 * own frozen MCP definitions carry host-authored parallel-read marks.
 */
export function createPiAgentRuntime(options: PiRuntimeHostOptions): AgentRuntime {
  const access = resolveModelAccess(options);
  const host: PiRuntimeHost = {
    sessionDataDir: options.sessionDataDir,
    toolOutputLedger: new ToolOutputLedger({ dataDirectory: options.sessionDataDir }),
    parallelMcpReads: options.parallelMcpReads === true,
    models: access.models,
    credentials: access.credentials,
    catalogReady: access.catalogReady ?? Promise.resolve(),
    ...(access.catalogs === undefined ? {} : { catalogs: access.catalogs }),
    now: options.now ?? Date.now,
    // Wrapped rather than passed by reference: `piExecutionEnv`'s second
    // parameter is its options bag, and handing it the identity positionally
    // would silently misread it.
    // The default Scoped factory knows no host: it names no unix socket and no
    // Session identity, so the bundled `volli` CLI is unavailable inside it.
    // The desktop injects its own factory, which supplies both.
    executionEnvFactory:
      options.executionEnvFactory ??
      ((workspacePath, _identity, containment) =>
        containment === undefined
          ? piExecutionEnv(workspacePath)
          : ScopedExecutionEnv.create(workspacePath, {
              policy: containment.policy,
              scratchDirectory: containment.scratchDirectory,
              git: containment.git,
            })),
    hostPrivateRoots: options.hostPrivateRoots ?? [],
    hostCredentialPaths: options.hostCredentialPaths ?? [],
    hostExposedPaths: options.hostExposedPaths ?? [],
    retryBackoffMs: options.retryBackoffMs ?? autoRetryDelayMs,
    connectivity: options.connectivity ?? ALWAYS_ONLINE,
    streamSupervision: options.streamSupervision ?? DEFAULT_STREAM_SUPERVISION,
    compactionPolicy: options.compactionPolicy ?? (() => DEFAULT_COMPACTION_POLICY),
    observability: options.observability ?? NOOP_OBSERVABILITY_SINK,
    ...(options.usageLimits === undefined
      ? {}
      : {
          usageLimits: {
            holder: options.usageLimits.holder ?? new UsageLimitsHolder(),
            schedule: new UsageProbeSchedule(),
            fetch: options.usageLimits.fetch,
          },
        }),
  };
  const inspectionSource = (): PiModelAccessSource => ({
    models: host.models,
    credentials: host.credentials,
    catalogReady: host.catalogReady,
    catalogs: host.catalogs,
    usageLimits: host.usageLimits,
  });
  /**
   * The UNBOUNDED inspection already in flight, per kind of answer, shared by
   * every caller that asks while it runs.
   *
   * A Session start, an automation's model list and several renderer mounts can
   * all land in the same tick, and each would otherwise run the whole provider
   * sweep beside the others — the same saving {@link UsageProbeSchedule.coalesce}
   * makes for one usage read. A refresh never rides an ordinary inspection: a
   * person pressed Refresh, and the answer must be the providers' now, not one
   * already going.
   *
   * Only a caller that passed NO signal shares, and a caller that passed one
   * neither joins a shared sweep nor becomes one. A signal here is a deadline
   * its owner chose — the CLI's `model list` bounds its read, the auto-titler
   * bounds its background call — and the callers have no deadline in common:
   * sharing would either reject everyone the moment the first one gave up, or
   * leave the others' cancellation with nothing to cancel. The hot path this
   * exists for is the signal-less one (every renderer mount and Session start
   * asks without a bound), and cancellation keeps reaching the probes exactly
   * as it did before, because a bounded caller still runs an inspection of its
   * own.
   *
   * Nothing holds a settled answer. The slot empties with the promise, so the
   * next inspection asks the providers afresh — which is what an external
   * credential change (no TTL can notice one) and the surface's own Refresh
   * both require.
   */
  const inspections = new Map<"ordinary" | "refresh", Promise<ModelAccessSnapshot>>();
  const inspectModelAccess = (
    input: InspectPiModelAccessInput = {},
  ): Promise<ModelAccessSnapshot> => {
    if (input.signal !== undefined) {
      return inspectPiModelAccess(inspectionSource(), host.now, input);
    }
    const kind = input.refresh === true ? "refresh" : "ordinary";
    const inFlight = inspections.get(kind);
    if (inFlight !== undefined) return inFlight;
    const run = inspectPiModelAccess(inspectionSource(), host.now, input).then(
      (snapshot) => {
        inspections.delete(kind);
        return snapshot;
      },
      (failure: unknown) => {
        inspections.delete(kind);
        throw failure;
      },
    );
    inspections.set(kind, run);
    return run;
  };
  return {
    inspectModelAccess,
    startSession: async (spec) => {
      await host.catalogReady;
      return attachSession(host, spec);
    },
    completeUtility: async (input) => {
      await host.catalogReady;
      return runUtilityCompletion(host, input);
    },
  };
}

/**
 * One utility completion on an explicit model, read back as text and a bill.
 *
 * The executor half of the port — the caller resolved and validated the
 * model; this runs it and refuses rather than substitutes. A model this
 * collection does not hold throws, a failed stop reason throws, and an
 * answer with no text throws: the caller keeps its heuristic title and logs,
 * which is the whole of the contract on this side.
 *
 * The usage travels back with the text because nothing else here will carry
 * it. A utility call creates no Session, no attachment and no transcript row,
 * so a runtime that reported only the text would make this the one kind of
 * model spend a Session could never account for.
 */
async function runUtilityCompletion(
  host: PiRuntimeHost,
  input: UtilityCompletion,
): Promise<UtilityCompletionResult> {
  const model = host.models.getModel(input.model.providerId, input.model.modelId);
  if (model === undefined) {
    // Nothing was sent, so nothing was billed. Null rather than an empty
    // measurement: the difference between "no request was made" and "a request
    // was made and cost nothing" is the whole discipline of this module.
    throw new UtilityCompletionError(
      `Model ${input.model.providerId}/${input.model.modelId} is not in this runtime's catalog.`,
      null,
    );
  }
  const message = await host.models.completeSimple(
    model,
    { systemPrompt: input.systemPrompt, messages: [queuedUserMessage(input.user)] },
    {
      // The same translation Pi's own agent makes for a Session at "off"
      // (agent.js: thinkingLevel === "off" → reasoning omitted): SimpleStreamOptions
      // has no "off" value, and omitting the option IS the off-path, not a
      // default-level request. Every other level passes through verbatim.
      ...(input.model.reasoningLevel === "off" ? {} : { reasoning: input.model.reasoningLevel }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      // OpenCode Go requires one opaque routing identity on every physical
      // provider request. A utility completion has no attachment or sidecar
      // whose id can supply it, and it makes exactly one request, so mint one
      // identity for this standalone conversation. Keep unrelated providers'
      // options byte-for-byte unchanged.
      ...(model.provider === OPENCODE_GO_PROVIDER
        ? { headers: { [OPENCODE_SESSION_HEADER]: randomUUID() } }
        : {}),
    },
  );
  // Read BEFORE either refusal below. The provider billed for the prompt it
  // accepted, not for whether Volli could use the answer — so a reply that
  // stopped short and a reply that was all reasoning are both real spend, and
  // extracting usage after the throw would lose exactly the calls a caller can
  // least afford to be silently charged for.
  const usage = sessionUsageFrom(
    message.usage,
    { provider: message.provider, model: message.model, api: message.api },
    "utility",
  );
  if (hasFailedStopReason(message)) {
    throw new UtilityCompletionError(
      sanitizeDiagnostic(message.errorMessage ?? "The utility completion failed."),
      usage,
    );
  }
  // Agent message tokens only. `thinking` blocks are dropped here rather than
  // filtered downstream, because a caller that runs a model at a reasoning
  // level it did not want (titling does, on every model that cannot be turned
  // off) must never see the thinking at all — a reasoning span is not an
  // answer, and the shape of one varies per provider.
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    // A model that answered only with a reasoning span still ran. The caller
    // keeps its fallback and still owes the bill.
    throw new UtilityCompletionError("The utility completion returned no text.", usage);
  }
  return { text: trimmed, usage };
}

/** Pi messages are persisted as JSON; omit optional properties Pi represents as undefined. */
function durableMessage(message: AgentMessage): AgentMessage {
  return JSON.parse(JSON.stringify(message)) as AgentMessage;
}

/**
 * The user message Pi is handed.
 *
 * Plain text stays a plain string rather than a one-element block array: that
 * is the shape every existing Session's sidecar already holds, and Pi's own
 * `contentText` treats the two identically, so widening only when there is
 * genuinely an image to carry keeps existing transcripts byte-identical.
 *
 * Images ride alongside the text as `ImageContent`, which is the only form a
 * model can actually look at (VC-50). They persist into Pi's recovery sidecar
 * with the message, which is exactly why attaching is bounded by a per-image
 * ceiling AND a per-session budget upstream.
 *
 * The shapes below are read back by {@link isPersistedUserContent}, which has
 * to recognize every one of them: the two functions are one decision written
 * twice, and the first time they disagreed every later branch read threw
 * (VC-155). Change one, change the other — `persistObservation`'s assert is
 * what catches you if you don't, at the write rather than a month later.
 */
function queuedUserMessage(text: string, images: readonly RuntimeImageInput[] = []): UserMessage {
  if (images.length === 0) {
    return { role: "user", content: text, timestamp: Date.now() };
  }
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
    timestamp: Date.now(),
  };
}

/** Text blocks from a user message, for legacy resource recovery and deduplication. */
function userMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  const content = (message as UserMessage).content;
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
}

/**
 * Re-establish exact activated resources immediately after a compaction
 * summary, before its retained tail. Keeping the tail last is required by
 * overflow retry, which continues from the user/tool message the failed reply
 * was answering.
 *
 * Two callers, and they must agree byte for byte. A live compaction hands
 * this the tail Pi chose and persists the result INSIDE the compaction entry,
 * so the restored message is part of what every later attach reads back. A
 * resume runs it over the whole recovered context, where a tail written that
 * way already holds every block and nothing is inserted; only an entry
 * persisted before VC-242 still earns the insert. Recomputing it on every
 * attach used to be the only path, and it could disagree with the live array
 * that produced the reasoning after it — a resource activated before the
 * summary and again after it was restored live and not on resume — which is
 * a prefix edit under a provider that binds reasoning to its prefix.
 */
function restoreCompactedResources(
  messages: readonly AgentMessage[],
  resources: readonly PromptResource[],
): AgentMessage[] {
  const missing = resources.filter((resource) => {
    const block = promptResourceBlock(resource);
    return !messages.some((message) => userMessageText(message).includes(block));
  });
  if (missing.length === 0) return [...messages];

  const restored = queuedUserMessage(
    appendPromptResources(
      "The following named skill resources were activated earlier and are restored verbatim after context compaction.",
      missing,
    ),
  );
  // Every caller holds a compacted context, whose summary is first. `+ 1`
  // naturally falls back to zero for a legacy context missing that role.
  const insertion = messages.findIndex((message) => message.role === "compactionSummary") + 1;
  return [...messages.slice(0, insertion), restored, ...messages.slice(insertion)];
}

const FAILED_ASSISTANT_STOP_REASONS = [
  "aborted",
  "error",
  "deferred",
] as const satisfies readonly AssistantMessage["stopReason"][];

function hasFailedStopReason(message: AssistantMessage): boolean {
  return FAILED_ASSISTANT_STOP_REASONS.some((reason) => reason === message.stopReason);
}

function recoverableMessage(entry: MessageEntry): boolean {
  const message = entry.message;
  if (message.role !== "assistant") return true;
  return !hasFailedStopReason(message as AssistantMessage);
}

const VOLLI_OBSERVATION_MARKER = "volli.observation.v1";

/**
 * The custom entry type for a fact about the context itself, as distinct from
 * an observation about the Session.
 *
 * Its own type rather than a new observation kind, because the observation
 * marker's reader quarantines and counts every entry of its type it cannot
 * validate, and a context fact is not a lost transcript fact — it is an
 * instruction to the replay. One kind so far: the frozen on-disk value
 * `reasoning-dropped`, meaning Volli elided reasoning from replay. It is written
 * at the moment {@link withoutReasoning} is applied to the whole live array —
 * by a refused turn's recovery, or by an attach that withheld a reply from
 * the middle of history — so a later attach applies the same edit to
 * everything before it and reproduces the array the reasoning after it was
 * bound to. Without it a resume would put the dropped blocks back and be
 * refused on its first turn, every time; or, for the withheld reply, strip
 * everything again on every attach and throw away reasoning that was validly
 * bound to the stripped replay.
 */
const VOLLI_CONTEXT_MARKER = "volli.context.v1";

/**
 * The room a request leaves for the reply it is about to ask for.
 *
 * Not the compaction reserve and not a second spelling of it: this one is
 * subtracted from a single request's own output ceiling, where the reserve is
 * the threshold a Session compacts at. They are separated because they answer
 * to different pressures — the ceiling wants to be tight, the threshold wants
 * to be early — and one number serving both was how a 1M-window Session ended
 * up compacting 16,384 tokens from the end of its window.
 */
const OUTPUT_CEILING_HEADROOM_TOKENS = 4_096;

/**
 * The smallest output ceiling this runtime will impose on itself. Below it the
 * estimate stops being a safety margin and starts being the failure — see
 * `outputCeiling`.
 */
const MIN_OUTPUT_CEILING_TOKENS = 4_096;

/**
 * How much of a model's window a Session keeps free of conversation.
 *
 * Volli configures no per-model reserve — those were retired with the policy
 * that carried them (VC-155) and nothing here brings them back: there is no
 * setting, no ladder of numbers, and no question a person is asked. What this
 * does is stop treating the executor's ONE fixed number as if it described
 * every window. Pi defaults its reserve to 16,384 tokens, which is a sensible
 * allowance on a 200k model and a rounding error on a 1M one: a Session that
 * waits until 983,616 tokens are spent has left itself less than one dense
 * tool result of room, and a single unmeasured round can carry it past the
 * window before the next check. So the threshold is the LARGER of the
 * executor's own reserve and a share of the window — the executor's number
 * where the executor's number is the bigger claim, and a proportional one
 * where it is not.
 *
 * Deliberately not applied to Pi's summary generation, which keeps the smaller
 * reserve: that number bounds how long a summary may be, and a 1M-window model
 * has no reason to write an 80,000-token one.
 */
const THRESHOLD_HEADROOM_SHARE = 0.1;

function thresholdHeadroom(reserveTokens: number, contextWindow: number): number {
  return Math.max(reserveTokens, Math.ceil(contextWindow * THRESHOLD_HEADROOM_SHARE));
}

interface ReasoningElisionMarker {
  kind: "reasoning-dropped";
}

function isReasoningElisionMarker(entry: Entry): boolean {
  return (
    entry.type === "custom" &&
    entry.customType === VOLLI_CONTEXT_MARKER &&
    isRecord(entry.data) &&
    entry.data["kind"] === "reasoning-dropped"
  );
}

/**
 * The durable branch with every reasoning elision this Session made applied.
 *
 * Every message entry ahead of the newest `reasoning-dropped` marker loses its
 * reasoning, exactly as the live array did when the marker was written;
 * everything after it is what the model has produced since and is kept whole.
 * A compaction entry's retained tail is not touched here because
 * {@link contextMessages} strips it on every read regardless.
 */
function withDroppedReasoning(entries: readonly Entry[]): Entry[] {
  const droppedBefore = entries.findLastIndex(isReasoningElisionMarker);
  if (droppedBefore < 0) return [...entries];
  return entries.map((entry, index) =>
    index < droppedBefore && entry.type === "message"
      ? { ...entry, message: withoutReasoning(entry.message) }
      : entry,
  );
}

/**
 * Whether a recorded reasoning elision already sits after every one of `entryIds`.
 *
 * The question an attach that withholds a reply asks before stripping the
 * replay: if a `reasoning-dropped` marker is newer than everything withheld,
 * {@link withDroppedReasoning} has already made the edit the withholding
 * required, and whatever reasoning was produced after that marker was bound to
 * the stripped replay and may be kept. An id no entry on the branch carries
 * counts as withheld from before the beginning, which any marker covers.
 */
function reasoningElisionRecordedAfter(
  entries: readonly Entry[],
  entryIds: ReadonlySet<string>,
): boolean {
  const newestDrop = entries.findLastIndex(isReasoningElisionMarker);
  const newestWithheld = entries.findLastIndex((entry) => entryIds.has(entry.id));
  return newestDrop > newestWithheld;
}

/**
 * The context marker a fresh attachment writes when it continues an earlier
 * one's conversation (VC-457). Its entries are that conversation from the
 * newest PORTABLE compaction on (see {@link carriedConversation}), reasoning
 * dropped and bounded in size — so the marker is the whole of what the new
 * sidecar needs and the old one is never read again. A carry of a carry holds
 * the earlier marker's entries expanded, never the marker itself, so repeated
 * reattaches flatten rather than nest.
 */
interface ContextCarriedMarker {
  kind: "context-carried";
  fromAttachmentId: string;
  entries: JsonValue;
}

const CARRIED_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "message",
  "compaction",
  "branch_summary",
]);

/**
 * Every saved-output path the MCP results in `entries` recorded, carried
 * conversations included (VC-469). A result's `details.output` is Volli's own
 * record of where its whole text went; anything else is ignored, and what is
 * found is checked again against the data directory before it grants a read.
 */
function savedOutputPathsIn(entries: readonly Entry[]): unknown[] {
  return entries.flatMap((entry): unknown[] => {
    // A carried conversation holds messages and summaries, never another
    // marker: a chain is flattened as it is carried, so one level is all there is.
    if (entry.type === "custom") return savedOutputPathsIn(carriedEntriesOf(entry) ?? []);
    if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
    if (!isMcpToolId(entry.message.toolName)) return [];
    // `details` is JSON on a recorded result, and an MCP result's is an object.
    const output = (entry.message.details as Record<string, unknown> | undefined)?.["output"];
    return [isRecord(output) ? output["fullOutputPath"] : undefined];
  });
}

/** The entries a `context-carried` marker holds, or undefined for any other entry. */
function carriedEntriesOf(entry: CustomEntry): readonly Entry[] | undefined {
  if (entry.customType !== VOLLI_CONTEXT_MARKER) return undefined;
  const data = entry.data;
  if (!isRecord(data) || data["kind"] !== "context-carried") return undefined;
  const entries = data["entries"];
  // A marker that no longer validates carries nothing rather than failing the
  // Session: the conversation it held is lost to the model, which is what a
  // fresh attachment was anyway, and never worse.
  if (!Array.isArray(entries)) return [];
  return (entries as readonly unknown[]).filter(
    (candidate): candidate is Entry =>
      isRecord(candidate) &&
      typeof candidate["type"] === "string" &&
      CARRIED_ENTRY_TYPES.has(candidate["type"]) &&
      typeof candidate["id"] === "string",
  );
}

/**
 * The most a carry copies into a new sidecar, in serialized characters.
 *
 * Far above any provider's context window (a million-token window is roughly
 * four million characters of prose only for the densest text, and a live
 * request compacts long before it), so a conversation that fits a model is
 * carried whole. What it bounds is the pathological case: an uncompacted
 * transcript heavy with tool output or images, re-copied on every reattach.
 * Past it the OLDEST turns are left out, at a user-turn boundary, and the
 * model is told so.
 */
export const CONTEXT_CARRY_MAX_CHARS = 1_500_000;

/**
 * The share of the ATTACHING model's context window a carry may fill, as
 * that model estimates it.
 *
 * The character bound above protects the sidecar; this one protects the first
 * turn. A carry sized for the model that wrote it can be far past what the
 * model now attaching accepts (a 1M-window Session resumed on a 128k one), and
 * the proactive compaction that would otherwise rescue it summarises over the
 * oversized history itself — so a carry that does not fit is a first turn
 * that may never be sendable. Half the window leaves the other half for the
 * system prompt, the tool schemas, the new message and the reply, and keeps
 * the carried conversation under the compaction threshold so the Session
 * compacts normally from there.
 */
export const CONTEXT_CARRY_WINDOW_SHARE = 0.5;

/** How a carry is priced against the attaching model; absent when its window is unknown. */
interface CarryTokenBudget {
  tokens: number;
  tokensOf: (entry: Entry) => number;
}

/**
 * An earlier attachment's conversation, read the way that attachment would
 * have replayed it, ready to be carried into a fresh one.
 *
 * The same three reads a resume makes — acceptance markers become user
 * messages, a settled reply history disagrees about is withheld, recorded
 * reasoning drops are applied. Then four things only a carry needs:
 *
 * - **Cut at the newest PORTABLE compaction**, not the newest compaction. A
 *   provider-native checkpoint is opaque state bound to one model and route;
 *   when the new attachment cannot replay it, `compactionPathForModel` drops it
 *   and rebuilds from the history it replaced — which a resume still has on
 *   disk, and a carry must therefore still hold. A prose summary is portable to
 *   any model, so everything before one is safely left behind.
 * - **Reasoning dropped** from all of it: a fresh attachment is a new request
 *   chain, and "every thinking block before some point" is the one removal
 *   every provider accepts.
 * - **Bounded**, oldest turns first, by {@link CONTEXT_CARRY_MAX_CHARS} and by
 *   {@link CONTEXT_CARRY_WINDOW_SHARE} of the attaching model's window, so the
 *   first turn after a reattach is one that model can accept.
 * - **No orphaned tool results.** A withheld reply takes its tool calls with
 *   it, and a result whose call is not in the carried history is one no
 *   provider accepts.
 */
function carriedConversation(
  entries: readonly Entry[],
  budget: CarryTokenBudget | undefined,
): Entry[] {
  const markers = entries
    .filter((entry): entry is CustomEntry => entry.type === "custom")
    .map(recoveredObservation)
    .filter((marker): marker is NonNullable<typeof marker> => marker !== null);
  const settledMarkers = new Map<string, number>();
  for (const marker of markers) {
    if (marker.kind !== "message-settled") continue;
    settledMarkers.set(
      marker.message.entryId,
      (settledMarkers.get(marker.message.entryId) ?? 0) + 1,
    );
  }
  const settled = new Set(
    entries.flatMap((entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      classifyAssistantMessage(entry.id, entry.message as AssistantMessage).kind === "settled"
        ? [entry.id]
        : [],
    ),
  );
  const withheld = new Set([
    ...[...settled].filter((entryId) => settledMarkers.get(entryId) !== 1),
    ...[...settledMarkers.keys()].filter((entryId) => !settled.has(entryId)),
  ]);
  const reader: ConversationReader = {
    acceptedMessage: (entry) => {
      const marker = recoveredObservation(entry);
      return marker !== null &&
        marker.kind === "command-accepted" &&
        marker.operation === "message.submit"
        ? marker.message
        : undefined;
    },
    replayable: (entry) => recoverableMessage(entry) && !withheld.has(entry.id),
    carriedEntries: carriedEntriesOf,
  };
  const path = conversationPath(withDroppedReasoning(entries), reader);
  const portable = path.findLastIndex(
    (entry) =>
      entry.type === "compaction" && readProviderCompaction(entry.details).kind === "absent",
  );
  const carried: Entry[] = [];
  for (const entry of portable < 0 ? path : path.slice(portable)) {
    carried.push(
      entry.type === "message"
        ? Object.assign({}, entry, { message: withoutReasoning(entry.message) })
        : entry,
    );
  }
  return withoutOrphanedToolResults(boundedCarry(carried, budget));
}

/** The attaching model's share for a carry, priced as that model estimates it. */
function carryTokenBudget(
  model: Parameters<typeof estimatedContextTokens>[1],
): CarryTokenBudget | undefined {
  const window = contextWindowOf(model);
  if (window === undefined) return undefined;
  return {
    tokens: Math.floor(window * CONTEXT_CARRY_WINDOW_SHARE),
    tokensOf: (entry) => estimatedContextTokens(contextMessages([entry]), model),
  };
}

/**
 * The oldest turns left out until the carry fits both bounds — the sidecar's
 * characters and the attaching model's window — cut where a user turn begins.
 */
function boundedCarry(entries: readonly Entry[], budget: CarryTokenBudget | undefined): Entry[] {
  const chars = entries.map((entry) => JSON.stringify(entry).length);
  const tokens = entries.map((entry) => budget?.tokensOf(entry) ?? 0);
  let totalChars = chars.reduce((sum, size) => sum + size, 0);
  let totalTokens = tokens.reduce((sum, size) => sum + size, 0);
  const over = (): boolean =>
    totalChars > CONTEXT_CARRY_MAX_CHARS || (budget !== undefined && totalTokens > budget.tokens);
  if (!over()) return [...entries];
  let start = 0;
  while (start < entries.length && over()) {
    totalChars -= chars[start]!;
    totalTokens -= tokens[start]!;
    start += 1;
  }
  // Begin a whole turn: a user message (or a summary, which stands in for
  // turns), so no reply or tool result is carried without what prompted it.
  while (start < entries.length && !beginsTurn(entries[start]!)) start += 1;
  const omitted = start;
  const note: Entry = {
    type: "message",
    id: `volli-carry-omitted-${omitted}`,
    parentId: null,
    seq: 0,
    timestamp: 0,
    message: {
      role: "user",
      content: `[Volli: the ${omitted} oldest entries of this Session's earlier conversation were too large to carry into this attachment and were left out. The Session's transcript in the app still has them; this notice is from Volli, not your user.]`,
      timestamp: 0,
    },
  };
  return [note, ...entries.slice(start)];
}

function beginsTurn(entry: Entry): boolean {
  return entry.type === "compaction" || (entry.type === "message" && entry.message.role === "user");
}

/** Tool results whose call is carried; the rest would be refused by every provider. */
function withoutOrphanedToolResults(entries: readonly Entry[]): Entry[] {
  const calls = new Set<string>();
  const collect = (message: AgentMessage): void => {
    if (message.role !== "assistant") return;
    for (const block of (message as AssistantMessage).content) {
      if (block.type === "toolCall") calls.add(block.id);
    }
  };
  for (const entry of entries) {
    if (entry.type === "message") collect(entry.message);
    if (entry.type === "compaction") entry.retainedTail.forEach(collect);
  }
  return entries.filter(
    (entry) =>
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      calls.has((entry.message as ToolResultMessage).toolCallId),
  );
}

/**
 * The observations a restart can be told about again.
 *
 * {@link CompactionObservation} joins them, and the case for it is not that the
 * runtime would forget: the compaction entry is already durable in the sidecar,
 * and the elision rule reads it back whether or not a marker exists. It is that
 * the *Session Event* is derived from observations and from nothing else. A
 * compaction seen only live is a ledger that goes quiet exactly where its
 * transcript stops — history that ends mid-conversation with nothing saying
 * why, which is the hole this marker fills.
 */
type RecoverableObservation =
  | TurnObservation
  | CompactionObservation
  | ProviderReasoningDroppedObservation
  | SettledMessageObservation
  | UsageObservation
  | RuntimeActivityObservation
  | AttentionObservation;

interface AcceptedMessageCommandMarker {
  kind: "command-accepted";
  commandId: string;
  operation: "message.submit";
  delivery: "prompt" | "queue" | "steer";
  turnId: string;
  message: UserMessage;
  /** Typed identity for message resources; absent on markers written before VC-181. */
  resources?: readonly PromptResource[];
}

interface AcceptedRetryCommandMarker {
  kind: "command-accepted";
  commandId: string;
  operation: "executor.retry";
  delivery: "retry";
  turnId: string;
}

type AcceptedCommandMarker = AcceptedMessageCommandMarker | AcceptedRetryCommandMarker;

type RecoverableMarker = RecoverableObservation | AcceptedCommandMarker;

/**
 * One marker read back, or nothing when there is nothing here to read.
 *
 * Nothing covers two cases on purpose, and the second is the whole point.
 * A custom entry somebody else wrote is not ours; and a marker of OURS that no
 * longer validates is quarantined — skipped, not thrown on.
 *
 * **Why an unreadable marker must not be fatal.** This function runs over every
 * custom entry on the branch, and the branch is re-read at the head of every
 * single message ({@link compactBeforeTurn}). So a throw here is not one bad
 * read: it is a Session that reports a failed threshold compaction after every
 * message its user sends, never compacts again, and can never be reopened —
 * permanently, because the marker is durable. That is the VC-155 failure, and
 * enumerating the shapes that caused it fixes those instances while leaving the
 * mechanism: the NEXT writer bug mints another class of bricked Session.
 * Quarantine fixes the mechanism. What it costs is one ledger fact — an
 * activity that will not be replayed into the transcript, an attention state
 * not restored — against a Session that works.
 *
 * **Except a command marker, which stays fatal.** Dropping one does not cost a
 * fact about what the Session showed; it changes what the Session DID. An
 * accepted `message.submit` that recovery cannot see is a message never
 * delivered as far as the conversation is concerned and an unreceipted command
 * as far as `reconcile` is concerned, so the caller sends it again — a
 * duplicate turn nobody asked for, from a Session that looks healthy. Losing
 * that quietly is worse than refusing to open, so it is refused. A marker too
 * corrupt to name its own kind cannot be proven to be one of these, and is
 * quarantined with the rest rather than bricking a Session on the input we
 * understand least.
 *
 * Skips are counted and surfaced by the caller — see `unreadableMarkerCount`.
 */
function recoveredObservation(
  entry: CustomEntry,
): (RecoverableMarker & { occurredAt: number; recoveryCursor: string }) | null {
  if (entry.customType !== VOLLI_OBSERVATION_MARKER) return null;
  const data = entry.data;
  if (!isRecoverableObservation(data)) {
    if (isRecord(data) && data["kind"] === "command-accepted") {
      throw new Error("Pi recovery marker is malformed.");
    }
    return null;
  }
  return {
    ...(data as unknown as RecoverableMarker),
    occurredAt: entry.timestamp,
    recoveryCursor: entry.id,
  };
}

function isRecoverableObservation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "turn":
      return (
        isOneOf(value["state"], ["started", "completed", "interrupted"]) &&
        typeof value["turnId"] === "string"
      );
    case "message-settled":
      return typeof value["turnId"] === "string" && isSettledMessage(value["message"]);
    case "provider-reasoning-dropped":
      return (
        typeof value["turnId"] === "string" &&
        typeof value["count"] === "number" &&
        wholeNumber(value["count"]) &&
        value["count"] > 0 &&
        Array.isArray(value["causes"]) &&
        value["causes"].length > 0 &&
        value["causes"].every((cause) =>
          isOneOf(cause, ["prefix-mismatch", "model-mismatch", "unknown"]),
        ) &&
        Array.isArray(value["paths"]) &&
        value["paths"].every((path) => typeof path === "string")
      );
    case "usage":
      return (
        typeof value["entryId"] === "string" &&
        (value["turnId"] === null || typeof value["turnId"] === "string") &&
        isSessionUsage(value["usage"])
      );
    case "compaction":
      // Whole numbers, because the durable ledger reads them as integers and a
      // marker this accepted but the ledger refused would be a Session that
      // recovers and then cannot be read. The two arms take different reason
      // lists for the same reason: `checkpoint` says nothing was compacted, so
      // a compacted marker carrying it is one the ledger would refuse.
      return value["state"] === "compacted"
        ? isOneOf(value["reason"], COMPACTION_WORK_REASON_VALUES) &&
            typeof value["entryId"] === "string" &&
            wholeNumber(value["tokensBefore"]) &&
            wholeNumber(value["tokensAfter"])
        : value["state"] === "failed" &&
            isOneOf(value["reason"], COMPACTION_REASONS) &&
            typeof value["message"] === "string";
    case "activity":
      return (
        typeof value["turnId"] === "string" &&
        typeof value["activityId"] === "string" &&
        isOneOf(value["state"], ["completed", "failed"]) &&
        isActivityDescriptor(value["descriptor"]) &&
        isRuntimeValue(value["input"]) &&
        isRuntimeValue(value["output"]) &&
        (value["error"] === undefined || typeof value["error"] === "string")
      );
    case "attention":
      return (
        isOneOf(value["state"], ["raised", "cleared"]) &&
        isOneOf(value["reason"], [
          "auth",
          "configuration",
          "context",
          "runtime-failure",
          "partial-turn",
          "transport",
        ]) &&
        typeof value["message"] === "string" &&
        (value["resetsAt"] === undefined || wholeNumber(value["resetsAt"]))
      );
    case "command-accepted":
      if (typeof value["commandId"] !== "string" || typeof value["turnId"] !== "string") {
        return false;
      }
      if (value["operation"] === "executor.retry") {
        return value["delivery"] === "retry" && value["message"] === undefined;
      }
      return (
        value["operation"] === "message.submit" &&
        isOneOf(value["delivery"], ["prompt", "queue", "steer"]) &&
        isPersistedUserMessage(value["message"]) &&
        (value["resources"] === undefined ||
          (Array.isArray(value["resources"]) && value["resources"].every(isPromptResource)))
      );
    default:
      return false;
  }
}

/**
 * The durable usage shape, checked with the ledger's own strictness.
 *
 * Whole token counts and a finite cost, because the Session Event codec reads
 * them that way: a marker this accepted and the ledger refused would be a
 * Session that recovers and then cannot be read — the VC-155 shape, re-laid
 * one field at a time. `null` is accepted everywhere a number is, and only
 * `null`: absent is what an unmetered field honestly says, and `undefined`
 * would not survive the JSON round trip this validator guards.
 */
function isSessionUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const tokens = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  return (
    isOneOf(value["cause"], SESSION_USAGE_CAUSES) &&
    typeof value["providerId"] === "string" &&
    typeof value["modelId"] === "string" &&
    tokens.every((key) => value[key] === null || wholeNumber(value[key])) &&
    (value["costUsd"] === null ||
      (typeof value["costUsd"] === "number" && Number.isFinite(value["costUsd"]))) &&
    isOneOf(value["costBasis"], COST_BASES)
  );
}

function isPersistedUserMessage(value: unknown): value is UserMessage {
  return (
    isRecord(value) &&
    value["role"] === "user" &&
    isPersistedUserContent(value["content"]) &&
    typeof value["timestamp"] === "number" &&
    Number.isFinite(value["timestamp"])
  );
}

/**
 * Both shapes {@link queuedUserMessage} writes: the plain string every
 * text-only message persists as, and the block array an attached image widens
 * it to (VC-50). The array arm accepts exactly the two block types that
 * function produces — this validator's job is to recognize the runtime's own
 * writes, and the first shape it refused (an image message) poisoned every
 * later branch read with "Pi recovery marker is malformed" (VC-155).
 */
function isPersistedUserContent(value: unknown): value is UserMessage["content"] {
  if (typeof value === "string") return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((block: unknown) => {
    if (!isRecord(block)) return false;
    if (block["type"] === "text") return typeof block["text"] === "string";
    if (block["type"] === "image") {
      return typeof block["data"] === "string" && typeof block["mimeType"] === "string";
    }
    return false;
  });
}

function assertUniqueAcceptedCommands(markers: readonly RecoverableMarker[]): void {
  const commands = new Set<string>();
  const turns = new Set<string>();
  for (const marker of markers) {
    if (marker.kind !== "command-accepted") continue;
    if (commands.has(marker.commandId) || turns.has(marker.turnId)) {
      throw new Error("Pi recovery delivery markers conflict.");
    }
    commands.add(marker.commandId);
    turns.add(marker.turnId);
  }
}

function isSettledMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value["entryId"] !== "string" ||
    value["role"] !== "assistant" ||
    typeof value["text"] !== "string" ||
    (value["reasoning"] !== undefined && typeof value["reasoning"] !== "string")
  ) {
    return false;
  }
  const model = value["model"];
  if (
    model !== undefined &&
    (!isRecord(model) ||
      typeof model["providerId"] !== "string" ||
      typeof model["modelId"] !== "string")
  ) {
    return false;
  }
  const usage = value["usage"];
  return (
    usage === undefined ||
    (isRecord(usage) &&
      optionalFiniteNumber(usage["inputTokens"]) &&
      optionalFiniteNumber(usage["outputTokens"]) &&
      // Optional twice over: newly written markers carry the cache split, and
      // markers persisted before it existed simply do not — both recover.
      optionalFiniteNumber(usage["cacheReadTokens"]) &&
      optionalFiniteNumber(usage["cacheWriteTokens"]) &&
      optionalFiniteNumber(usage["costUsd"]))
  );
}

function isActivityDescriptor(value: unknown): boolean {
  if (!isRecord(value) || !isActivityKind(value["kind"])) return false;
  if (typeof value["nativeToolName"] !== "string" || !isRecord(value["subject"])) return false;
  const subject = value["subject"];
  if (!nullableString(subject["label"]) || !nullableString(subject["path"])) return false;
  const lineRange = subject["lineRange"];
  if (
    lineRange !== null &&
    (!isRecord(lineRange) ||
      !Number.isInteger(lineRange["start"]) ||
      !Number.isInteger(lineRange["end"]))
  ) {
    return false;
  }
  const outcome = value["outcome"];
  if (outcome !== null) {
    if (!isRecord(outcome)) return false;
    for (const key of [
      "exitCode",
      "matchCount",
      "fileCount",
      "lineCount",
      "bytes",
      "addedLines",
      "removedLines",
    ]) {
      if (!nullableFiniteNumber(outcome[key])) return false;
    }
    if (!nullableString(outcome["diff"]) || !nullableString(outcome["summary"])) return false;
  }
  return nullableFiniteNumber(value["startedAt"]) && nullableFiniteNumber(value["endedAt"]);
}

function isRuntimeValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  // JSONL parsing cannot produce NaN or infinities; retain the check for callers
  // constructing an in-memory entry through a future repository implementation.
  /* v8 ignore next */
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isRuntimeValue);
  return isRecord(value) && Object.values(value).every(isRuntimeValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<const T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function nullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function wholeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

async function assertOwnedRecoveryPath(root: string, candidate: string): Promise<void> {
  const [ownedRoot, ownedCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const pathFromRoot = relative(ownedRoot, ownedCandidate);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("Pi recovery sidecar is outside the runtime-owned session directory.");
  }
}

/**
 * Read the conversation an earlier attachment's sidecar holds (VC-457).
 *
 * The same guards a resume applies before it touches a sidecar — listed under
 * the workspace it ran in, owned by this runtime's data directory, identity
 * naming THIS Session and the attachment that wrote it — because a carry is a
 * read of another file into this Session's context, and "cannot tell whose
 * this is" must never resolve to "then it is yours". Opened, read, and closed:
 * the earlier sidecar is never written.
 */
async function readCarriedConversation(
  sidecars: JsonlSessionRepo,
  sessionDataDir: string,
  carry: RuntimeContextCarry,
  expected: SidecarIdentity,
  budget: CarryTokenBudget | undefined,
  context: Context,
): Promise<Entry[]> {
  // No legacy-sidecar migration here, unlike a resume: a closed attachment's
  // sidecar was migrated by the attach that last opened it, or predates this
  // build's whole Pi line and is not worth reopening a conversation from.
  const candidates = (await sidecars.list({ cwd: carry.workspacePath }, context)).filter(
    (candidate) => candidate.id === carry.sessionId,
  );
  const candidate = candidates.length === 1 ? candidates[0]! : undefined;
  if (candidate === undefined || resolve(candidate.path) !== resolve(carry.sessionFilePath)) {
    throw new Error("the earlier attachment's Pi sidecar is not where its record says.");
  }
  await assertOwnedRecoveryPath(sessionDataDir, candidate.path);
  const opened = await sidecars.open(candidate, context);
  try {
    await assertSidecarIdentity(opened, expected, context);
    const branch = await sidecarBranch(opened, context);
    return carriedConversation(await branch.findEntries({ order: "oldestFirst" }, context), budget);
  } finally {
    await opened.close(piContext()).catch(
      /* v8 ignore next -- closing a sidecar we only read is best effort. */
      () => undefined,
    );
  }
}

/**
 * The sidecar identity now lives in the shared sidecar-storage contract.
 *
 * Until Pi 0.85.0 this was the JSONL session's `metadata` field. The replacement
 * is a session value, which is durable but readable only after `open`; a refused
 * sidecar is therefore closed after the identity check fails.
 */
/** Bind a freshly created sidecar to this attachment, once. */
async function writeSidecarIdentity(
  sidecar: Session,
  identity: SidecarIdentity,
  context: Context,
): Promise<void> {
  await sidecar.setValue(SIDECAR_IDENTITY, identity, context);
}

/**
 * Refuse a sidecar this attachment does not own.
 *
 * A sidecar written before this runtime moved the identity off Pi's metadata
 * bag carries no value at all. That reads as a mismatch and is refused, which
 * is the fail-closed direction: the alternative is admitting any sidecar whose
 * binding cannot be read, and "cannot tell whose this is" must never resolve to
 * "then it is yours".
 */
async function assertSidecarIdentity(
  sidecar: Session,
  expected: SidecarIdentity,
  context: Context,
): Promise<void> {
  const stored = await sidecar.getValue(SIDECAR_IDENTITY, context);
  if (
    stored?.value.volliSessionId !== expected.volliSessionId ||
    stored.value.volliThreadId !== expected.volliThreadId ||
    stored.value.volliAttachmentId !== expected.volliAttachmentId
  ) {
    throw new Error("Pi recovery sidecar identity does not match this attachment.");
  }
}

/**
 * The one branch this runtime reads and writes, created if this sidecar has
 * none yet.
 *
 * `Session.findEntriesOnBranch` and `Session.appendMessage` were conveniences
 * over the current branch until 0.85.0 moved both onto an explicit `Branch`
 * handle. Naming the branch here rather than at each call site keeps the
 * choice in one place — and the choice is still the one VC-242 made: the
 * BRANCH, never the flat file, because the elision rule takes the last
 * compaction on the path rather than the last one written.
 *
 * Creating it is this runtime's job now, and that is new. 0.85.0 makes no
 * branch at `create`: branches are made by the lane machinery inside
 * `AgentHarness`, which Volli does not use — it drives the lower-level `Agent`
 * (see this module's header). So a freshly created sidecar has no branch at
 * all until something makes one, and this is that something.
 *
 * The anchor is what makes it safe on a sidecar that already holds history:
 * a branch created at `null` on a file with entries would be an empty path
 * beside a full file, and the replay would read a Session that had never said
 * anything. Anchoring at the newest entry adopts what is there instead. On a
 * new sidecar there is no newest entry and the anchor is `null`, which is the
 * same thing said about nothing.
 */
async function sidecarBranch(sidecar: Session, context: Context): Promise<Branch> {
  const existing = await sidecar.branch(MAIN_BRANCH, context);
  if (existing !== undefined) return existing;
  const [newest] = await sidecar.findEntries({ order: "desc", limit: 1 }, context);
  return sidecar.createBranch(MAIN_BRANCH, newest?.id ?? null, context);
}

function mergeProviderReasoningDrop(
  current: ProviderReasoningDroppedObservation | undefined,
  next: ProviderReasoningDroppedObservation,
): ProviderReasoningDroppedObservation {
  if (current === undefined) return next;
  return {
    kind: "provider-reasoning-dropped",
    turnId: next.turnId,
    count: current.count + next.count,
    causes: [...new Set<ReasoningDropCause>([...current.causes, ...next.causes])],
    paths: [...new Set([...current.paths, ...next.paths])],
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function rejectUnavailableModel(
  spec: SessionRuntimeSpec,
  observe: SessionRuntimeSpec["observer"],
): Promise<never> {
  const message = `Model ${spec.model.providerId}/${spec.model.modelId} is not available.`;
  await observe({
    kind: "attachment",
    state: "failed",
    failure: { reason: "configuration", message },
  });
  throw new Error(message);
}

async function rejectCancelledAttachment(observe: SessionRuntimeSpec["observer"]): Promise<never> {
  const message = "Runtime attachment was cancelled before it started.";
  await observe({
    kind: "attachment",
    state: "failed",
    failure: { reason: "aborted", message },
  });
  throw new Error(message);
}

async function attachSession(
  host: PiRuntimeHost,
  spec: SessionRuntimeSpec,
): Promise<RuntimeAttachmentHandle> {
  // The side channel exists before the first observation can, so even an
  // attachment refused at the door reports its bounded failure through the
  // tee. The run id is opaque and process-local on purpose — correlation
  // without exporting Session identity.
  const runId = randomUUID();
  const observabilityReducer = new ObservabilityReducer(host.now);
  const observe = teeObservationsToSink(
    spec.observer,
    observabilityReducer,
    host.observability,
    runId,
  );
  // A permitted authority decision is a metrics denominator, not durable
  // Session history. It therefore goes through the reducer's passive path and
  // never awaits the Session observer or changes whether Pi can run the call.
  const recordObservability = (observation: Parameters<SessionRuntimeSpec["observer"]>[0]) =>
    recordObservationToSink(observabilityReducer, host.observability, runId, observation);
  if (isAborted(spec.signal)) {
    return rejectCancelledAttachment(observe);
  }

  const models = host.models;
  const model = models.getModel(spec.model.providerId, spec.model.modelId);
  if (model === undefined) {
    return rejectUnavailableModel(spec, observe);
  }
  // Compaction preflight and provider output-ceiling checks see the same
  // settled prefix in succession. Keep their pure estimates attachment-local
  // so neither re-tokenizes immutable messages and tool metadata.
  const contextTokenProjector = createContextTokenProjector();

  const sidecarEnv = new NodeExecutionEnv({ cwd: host.sessionDataDir });
  let sidecarPath: string | undefined;
  let toolEnv: ExecutionEnv | undefined;
  /** A Scoped Session's `TMPDIR`, created at attach and removed on every close path. */
  let scratchDirectory: string | undefined;
  const removeScratch = async (): Promise<void> => {
    const directory = scratchDirectory;
    scratchDirectory = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  };
  let unsubscribe: (() => void) | undefined;
  let stopWatchingResume: (() => void) | undefined;
  let abortListener: (() => void) | undefined;
  let createdSidecar = false;

  try {
    /**
     * Opening the sidecar is not cancellable, on purpose.
     *
     * Pi 0.85.0 threads a context through every repository call, so this is
     * the first version where the attachment's signal COULD reach them, and it
     * deliberately does not. Two reasons, and the second is the one that
     * decides it:
     *
     * - Nothing here waits on anything slow. Creating or opening a sidecar is
     *   a handful of local file operations; there is no long poll for a
     *   cancellation to shorten.
     * - A cancelled `create` throws a transport-shaped file error from inside
     *   Pi, which this runtime would surface as a failed attachment. But a
     *   Session whose caller cancelled did not FAIL, and the difference is
     *   what a person sees. The attach already checks the signal at its own
     *   checkpoints and answers a cancellation with a closed attachment, and
     *   the failure path below deletes a sidecar it created before rethrowing.
     *   Letting the signal in would replace that clean answer with a file
     *   error, and would do it only in the window between two checks.
     */
    const attachContext = piContext();
    const sidecars = new JsonlSessionRepo({
      fileSystem: sidecarEnv,
      sessionsRoot: host.sessionDataDir,
    });
    const expectedIdentity = {
      volliSessionId: spec.identity.sessionId,
      volliThreadId: spec.identity.rootThreadId,
      volliAttachmentId: spec.identity.attachmentId,
    };
    const inputRecovery = spec.recovery;
    const sidecar =
      inputRecovery === undefined
        ? await (async () => {
            const created = await sidecars.create({ cwd: spec.workspacePath }, attachContext);
            await writeSidecarIdentity(created, expectedIdentity, attachContext);
            return created;
          })()
        : await (async () => {
            const listed = async () =>
              (await sidecars.list({ cwd: spec.workspacePath }, attachContext)).filter(
                (candidate) => candidate.id === inputRecovery.sessionId,
              );
            let candidates = await listed();
            if (candidates.length === 0) {
              // A sidecar written before the Pi 0.85.0 bump is not reported as
              // broken — it is not reported at all, because 0.85.0's header
              // parser does not recognise 0.84.3's header and an unparseable
              // file is silently skipped by `list`. So "no candidate" is the
              // only symptom an upgraded Session has, and this is where it is
              // answered: migrate the file the recovery ref names, then ask
              // again. See `sidecar-migration.ts` for what changed and why the
              // conversation itself is carried across untouched.
              //
              // The ownership check runs FIRST and unconditionally. A recovery
              // ref names a path, and this is a write — so a path outside the
              // runtime's own session directory must be refused before it is
              // opened, not after.
              await assertOwnedRecoveryPath(host.sessionDataDir, inputRecovery.sessionFilePath);
              await migrateLegacySidecar(inputRecovery.sessionFilePath);
              candidates = await listed();
            }
            if (candidates.length !== 1) {
              throw new Error("Pi recovery sidecar was not found uniquely for this workspace.");
            }
            const candidate = candidates[0]!;
            if (resolve(candidate.path) !== resolve(inputRecovery.sessionFilePath)) {
              throw new Error("Pi recovery sidecar path does not match the owned session.");
            }
            await assertOwnedRecoveryPath(host.sessionDataDir, candidate.path);
            // The identity check now happens on the far side of `open`, because
            // Pi 0.85.0 deleted the opaque `metadata` bag it used to live in
            // (see {@link writeSidecarIdentity}) and a session value can only be
            // read from an open session. The two checks ahead of it are
            // unchanged and still run first, so a sidecar outside this host's
            // data directory is still refused without being opened at all.
            const opened = await sidecars.open(candidate, attachContext);
            try {
              await assertSidecarIdentity(opened, expectedIdentity, attachContext);
            } catch (error) {
              await opened.close(piContext()).catch(
                /* v8 ignore next -- closing a sidecar we are already refusing is best effort. */
                () => undefined,
              );
              throw error;
            }
            return opened;
          })();
    createdSidecar = inputRecovery === undefined;
    const sidecarMetadata = sidecar.metadata;
    sidecarPath = sidecarMetadata.path;
    // Resolved once and shared: the handle is the branch's identity, not a
    // read, and every append and scan below goes through this one.
    const mainBranch = await sidecarBranch(sidecar, attachContext);
    const recovery = recoveryRefFor(sidecarMetadata.id, sidecarPath);
    // A fresh attachment that continues an earlier one's conversation
    // (VC-457): the earlier sidecar is read once, and what the model last saw
    // there is written into this one as a single context marker before
    // anything else, so every later read of THIS sidecar — this attach's
    // replay, a compaction, a resume after a relaunch — finds it in place. A
    // carry that cannot be read is not a failed attach: the Session opens
    // without it, as it always did, and says so below.
    let carryFailure: string | undefined =
      inputRecovery === undefined && spec.carry === undefined ? spec.carryUnreadable : undefined;
    let carried = false;
    if (inputRecovery === undefined && spec.carry !== undefined) {
      try {
        const entries = await readCarriedConversation(
          sidecars,
          host.sessionDataDir,
          spec.carry,
          { ...expectedIdentity, volliAttachmentId: spec.carry.attachmentId },
          carryTokenBudget(model),
          attachContext,
        );
        if (entries.length > 0) {
          await mainBranch.appendCustomEntry(
            VOLLI_CONTEXT_MARKER,
            {
              kind: "context-carried",
              fromAttachmentId: spec.carry.attachmentId,
              entries: JSON.parse(JSON.stringify(entries)) as JsonValue,
            } satisfies ContextCarriedMarker,
            attachContext,
          );
          carried = true;
        }
      } catch (error) {
        carryFailure = errorMessage(error);
      }
    }
    // The BRANCH, not the file. Today these are the same entries — this runtime
    // writes one lane and never forks — but they stop being the same the moment
    // anything does, and what reads this now is the elision rule, which takes
    // the LAST compaction in the array it is handed. Off a flat file read that
    // is last-written; only off the branch is it last-on-this-path. Asking the
    // same question the live path asks (`conversationBranch`) is what keeps a
    // future sibling branch from quietly resurrecting elided history — the one
    // failure this ticket exists to prevent.
    const recoveredEntries =
      inputRecovery !== undefined || carried
        ? await mainBranch.findEntries({ order: "oldestFirst" }, attachContext)
        : [];
    const customEntries = recoveredEntries.filter(
      (entry): entry is CustomEntry => entry.type === "custom",
    );
    const recoveredMarkers = customEntries
      .map(recoveredObservation)
      .filter(
        (observation): observation is NonNullable<ReturnType<typeof recoveredObservation>> =>
          observation !== null,
      );
    /**
     * Markers of ours that {@link recoveredObservation} quarantined.
     *
     * Counted here rather than plumbed out of the reader, because the reader is
     * the sync hot path every branch read runs through and has nowhere to
     * report to. Every entry of our own custom type that did not come back as a
     * marker was skipped, which is the same arithmetic without the plumbing.
     */
    const unreadableMarkerCount =
      customEntries.filter((entry) => entry.customType === VOLLI_OBSERVATION_MARKER).length -
      recoveredMarkers.length;

    // Latest activation wins by durable branch order. New command markers carry
    // typed resources; parsing the already-delivered text is the compatibility
    // path for older markers and direct runtime messages.
    const activeMessageResources = new Map<string, PromptResource>();
    const markersByCursor = new Map(
      recoveredMarkers.map((marker) => [marker.recoveryCursor, marker] as const),
    );
    const rememberResources = (resources: readonly PromptResource[]): void => {
      for (const resource of resources) activeMessageResources.set(resource.name, resource);
    };
    for (const entry of recoveredEntries) {
      if (entry.type === "message" && entry.message.role === "user") {
        rememberResources(readPromptResourceBlocks(userMessageText(entry.message)));
        continue;
      }
      if (entry.type !== "custom") continue;
      const carriedEntries = carriedEntriesOf(entry);
      if (carriedEntries !== undefined) {
        for (const carriedEntry of carriedEntries) {
          if (carriedEntry.type === "message" && carriedEntry.message.role === "user") {
            rememberResources(readPromptResourceBlocks(userMessageText(carriedEntry.message)));
          }
        }
        continue;
      }
      const marker = markersByCursor.get(entry.id);
      if (marker?.kind !== "command-accepted" || marker.operation !== "message.submit") {
        continue;
      }
      rememberResources(
        marker.resources ?? readPromptResourceBlocks(userMessageText(marker.message)),
      );
    }

    const recoveredObservations = recoveredMarkers.filter(
      (
        marker,
      ): marker is RecoverableObservation & {
        occurredAt: number;
        recoveryCursor: string;
      } => marker.kind !== "command-accepted",
    );
    assertUniqueAcceptedCommands(recoveredMarkers);
    const messageMarkerCounts = new Map<string, number>();
    for (const observation of recoveredObservations) {
      if (observation.kind !== "message-settled") continue;
      messageMarkerCounts.set(
        observation.message.entryId,
        (messageMarkerCounts.get(observation.message.entryId) ?? 0) + 1,
      );
    }
    const settledAssistantEntryIds = new Set(
      recoveredEntries.flatMap((entry) => {
        if (entry.type !== "message" || entry.message.role !== "assistant") return [];
        return classifyAssistantMessage(entry.id, entry.message as AssistantMessage).kind ===
          "settled"
          ? [entry.id]
          : [];
      }),
    );
    const disagreedSettledEntryIds = new Set([
      ...[...settledAssistantEntryIds].filter((entryId) => messageMarkerCounts.get(entryId) !== 1),
      ...[...messageMarkerCounts.keys()].filter(
        (entryId) => !settledAssistantEntryIds.has(entryId),
      ),
    ]);
    /**
     * Whether this attach withholds a reply no recorded reasoning drop has
     * answered yet.
     *
     * The disagreement is a fact of the sidecar and recurs on every attach;
     * the drop it earns must not. The first attach to withhold strips the
     * whole replay and records that it did; every later one finds the record
     * newer than the withheld reply and lets {@link withDroppedReasoning} make
     * the same edit, keeping the reasoning produced since.
     */
    const withholdingUnrecorded =
      disagreedSettledEntryIds.size > 0 &&
      !reasoningElisionRecordedAfter(recoveredEntries, disagreedSettledEntryIds);
    /** The durable record that every reasoning block before this point was dropped. */
    const recordReasoningElision = async (): Promise<void> => {
      await mainBranch.appendCustomEntry(
        VOLLI_CONTEXT_MARKER,
        { kind: "reasoning-dropped" } satisfies ReasoningElisionMarker,
        piContext(),
      );
    };
    /**
     * How this sidecar's entries are read back as a conversation.
     *
     * Both halves matter and neither is Pi's business: a user message accepted
     * through a durable command marker never became a message entry, and an
     * assistant reply this attachment already judged unrecoverable must not be
     * offered back to the model as if it had been said.
     */
    const conversationReader: ConversationReader = {
      acceptedMessage: (entry) => {
        const marker = recoveredObservation(entry);
        return marker !== null &&
          marker.kind === "command-accepted" &&
          marker.operation === "message.submit"
          ? marker.message
          : undefined;
      },
      replayable: (entry) => recoverableMessage(entry) && !disagreedSettledEntryIds.has(entry.id),
      carriedEntries: carriedEntriesOf,
    };
    /**
     * The elided context, not the whole history — this is the landmine.
     *
     * Rebuilding the live message array by replaying every entry is correct only
     * for a Session that has never compacted. Once a `CompactionEntry` exists,
     * a replay that did not know about it would hand Pi the entire
     * pre-compaction history back and silently undo the compaction on the first
     * restart, with nothing anywhere saying so. {@link contextMessages} is Pi's
     * own elision rule and is the only way messages are derived here.
     */
    //
    // The route, not the catalog, decides whether a durable native checkpoint
    // may be replayed: a Session whose credential is now an OAuth subscription
    // or points at another endpoint would otherwise send opaque state to a
    // backend that never minted it. Resolved once here and again on model
    // selection, which is when a Session's route is re-decided anyway.
    const nativeRoute = await nativeCompactionAvailable(model, models, spec.signal);
    const replayable = compactionPathForModel(
      conversationPath(withDroppedReasoning(recoveredEntries), conversationReader),
      model,
      nativeRoute,
    );
    const recoveredPath = replayable.path;
    const recoveredCompaction = recoveredPath.findLast((entry) => entry.type === "compaction");
    let nativeCompactionState =
      recoveredCompaction?.type === "compaction"
        ? providerCompactionFromDetails(recoveredCompaction.details)
        : undefined;
    const recoveredContext = contextMessages(recoveredPath);
    // A reply withheld from the middle of history invalidates every reasoning
    // block after it under a provider that chains them, and the attach knows it
    // did that. Dropping the reasoning from the whole replay is the doc's
    // "every thinking block before some point" removal, which is always valid,
    // where leaving the later blocks in would be a first turn refused (VC-242).
    // Once only: an attach that finds the drop already on record has had it
    // applied by `withDroppedReasoning` above, and keeps what came after.
    const replayableContext = withholdingUnrecorded
      ? recoveredContext.map(withoutReasoning)
      : recoveredContext;
    const recoveredMessages = recoveredEntries.some((entry) => entry.type === "compaction")
      ? restoreCompactedResources(replayableContext, [...activeMessageResources.values()])
      : replayableContext;
    const activeAttentionReasons = new Set<AttentionObservation["reason"]>();
    const openTurnIds = new Set<string>();
    for (const observation of recoveredObservations) {
      if (observation.kind === "turn") {
        if (observation.state === "started") openTurnIds.add(observation.turnId);
        else openTurnIds.delete(observation.turnId);
      }
      if (observation.kind !== "attention") continue;
      if (observation.state === "raised") activeAttentionReasons.add(observation.reason);
      else activeAttentionReasons.delete(observation.reason);
    }
    const persistObservation = async <T extends RecoverableMarker>(observation: T): Promise<T> => {
      const durable = JSON.parse(JSON.stringify(observation)) as T;
      // Refused at the write, not discovered at the read — with the same
      // predicate recovery applies, so writer and validator cannot drift. A
      // marker recovery would reject is worthless the moment it is written
      // (VC-155).
      //
      // This is an assert, not a handled case: nothing this runtime constructs
      // can trip it, which is what `fallbackStateOf` and `usageOf` are for, and
      // it exists to catch the write that stops being true of that sentence. It
      // is not silent if it ever does fire. Pi awaits its event listeners from
      // inside `runWithLifecycle`'s executor, so a throw here is caught by
      // `handleRunFailure` and re-emitted as an errored assistant message,
      // which this runtime classifies into a `RuntimeFailure` and surfaces as a
      // failed turn carrying this sentence.
      /* v8 ignore next 3 -- an assert: no write this runtime constructs can reach it. */
      if (!isRecoverableObservation(durable)) {
        throw new Error("Pi observation marker would not survive recovery; refusing to write it.");
      }
      // `durable` is the JSON round trip two lines up, so it holds nothing but
      // JSON — which is the whole of what Pi 0.85.0 tightened `CustomEntry.data`
      // from `unknown` to `JsonValue` to require. The cast states that, and the
      // round trip is what makes it true rather than hopeful.
      const markerId = await mainBranch.appendCustomEntry(
        VOLLI_OBSERVATION_MARKER,
        durable as unknown as JsonValue,
        piContext(),
      );
      const marker = await sidecar.getEntry(markerId, piContext());
      /* v8 ignore next -- appendCustomEntry promises the entry it just returned. */
      if (marker?.type !== "custom") throw new Error("Pi recovery marker was not persisted.");
      return {
        ...durable,
        occurredAt: marker.timestamp,
        recoveryCursor: marker.id,
      };
    };
    if (disagreedSettledEntryIds.size > 0) {
      // The fact about the replay, then the notice about it. Either order is
      // safe across a crash between them: an attach that finds no record
      // strips the replay again, and one that finds a record without a notice
      // raises the notice again.
      if (withholdingUnrecorded) await recordReasoningElision();
      await persistObservation({
        kind: "attention",
        state: "raised",
        reason: "partial-turn",
        message:
          "Pi recovery history disagreed about a settled assistant message; the incomplete turn was withheld.",
      });
      activeAttentionReasons.add("partial-turn");
    }
    // Said once, at the only moment there is anything to say it about. The
    // Session is fine — that is the point of quarantining these — but a marker
    // this attachment could not read is a fact its transcript is now missing,
    // and dropping that without a word is the swallowed error this codebase
    // does not allow itself.
    if (unreadableMarkerCount > 0) {
      await persistObservation({
        kind: "attention",
        state: "raised",
        reason: "runtime-failure",
        message: `Skipped ${unreadableMarkerCount} unreadable Pi recovery ${unreadableMarkerCount === 1 ? "marker" : "markers"}; this Session's history may be missing activity or attention it once recorded.`,
      });
      activeAttentionReasons.add("runtime-failure");
    }
    // Durable like the recovery notices above, and ALSO told live once the
    // attachment has started: a fresh attachment is never reconciled from its
    // own sidecar, so a marker alone would reach no one until a relaunch.
    let carryAttention: AttentionObservation | undefined;
    if (carryFailure !== undefined) {
      carryAttention = await persistObservation({
        kind: "attention",
        state: "raised",
        reason: "runtime-failure",
        message: `This attachment could not carry the Session's earlier conversation forward, so the model starts without it: ${carryFailure}`,
      });
      activeAttentionReasons.add("runtime-failure");
    }
    for (const recoveredTurnId of openTurnIds) {
      await persistObservation({
        kind: "attention",
        state: "raised",
        reason: "partial-turn",
        message: "A recovered Pi turn ended before its completion marker was committed.",
      });
      activeAttentionReasons.add("partial-turn");
      await persistObservation({ kind: "turn", state: "interrupted", turnId: recoveredTurnId });
    }
    // A notice that the last process was reconnecting describes a wait no
    // process is running any more. Retired here rather than left for the next
    // turn to clear, so a relaunched Session does not claim to be reconnecting
    // while it sits idle.
    if (activeAttentionReasons.delete("transport")) {
      await persistObservation({
        kind: "attention",
        state: "cleared",
        reason: "transport",
        message: "Runtime recovered.",
      });
    }
    // An unreadable checkpoint is a recovered Session, not an unattachable one:
    // the history it replaced is still on disk and is what {@link contextMessages}
    // just rebuilt from. Said out loud rather than recovered in silence: the
    // person's context just grew back to what it was before a compaction they
    // watched happen, and the next turn may compact again for a threshold they
    // did not see fill. Said ONCE — the fact recurs on every attach because the
    // damaged entry is still on disk, and a notice that reappeared on every
    // restart would be noise about one event.
    if (
      replayable.discarded.length > 0 &&
      !recoveredObservations.some(
        (observation) =>
          observation.kind === "compaction" &&
          observation.state === "failed" &&
          observation.reason === "checkpoint",
      )
    ) {
      for (const reason of new Set(replayable.discarded)) {
        await persistObservation({
          kind: "compaction",
          state: "failed",
          reason: "checkpoint",
          message: sanitizeDiagnostic(reason),
        });
      }
    }
    // Long tool results are cut for the model and saved whole beside this
    // attachment's sidecar (VC-469), under the runtime-wide bound. The gate
    // below lets the Session read them, and every other saved-output directory
    // its own history names: an earlier attachment's results reach this one
    // through a carry, after a relaunch as much as on the first attach, and
    // through every link of a chain of carries.
    const toolOutput = new ToolOutputStore({
      directory: toolOutputDirectoryFor(sidecarMetadata.path),
      namedDirectories: savedOutputDirectoriesIn(
        savedOutputPathsIn(recoveredEntries),
        host.sessionDataDir,
      ),
      dataDirectory: host.sessionDataDir,
      ledger: host.toolOutputLedger,
      workspacePath: spec.workspacePath,
    });
    // The capability axis (VC-45), resolved once for this attachment: the
    // denylist's two tiers — the host's credential files in the credential
    // tier; its own data and every Session's saved output in the private one,
    // with this Session's own carved back — and the writable roots.
    // The gate below judges calls against exactly this object, and a Scoped
    // Session's walls are compiled from it, so the two give one answer.
    const scoped = spec.capability?.containment === "scoped";
    // A contained git is handed the user's excludes, attributes, identity and
    // signing settings (VC-45 review, S3); their files must be readable inside.
    const git = scoped ? await readHostGitSettings(spec.workspacePath) : NO_HOST_GIT;
    if (scoped) {
      scratchDirectory = await realpath(await mkdtemp(join(tmpdir(), "volli-scoped-")));
    }
    const capability = resolveCapabilityPolicy({
      workspacePath: spec.workspacePath,
      writableRoots: spec.capability?.writableRoots ?? [],
      runtimeRoots: scratchDirectory === undefined ? [] : [scratchDirectory],
      privateRoots: [...host.hostPrivateRoots, host.sessionDataDir],
      credentialPaths: host.hostCredentialPaths,
      grants: [
        ...toolOutput.readableDirectories,
        ...host.hostExposedPaths,
        ...hostGitReadables(git),
      ],
      sandboxCarveOuts: scoped,
    });
    // No preflight before the tools are built: an attachment that hands Pi its
    // own environment cannot fail for want of `sandbox-exec`, and a Scoped
    // environment is fail-closed at its own `exec`.
    toolEnv = await host.executionEnvFactory(
      spec.workspacePath,
      spec.identity,
      scratchDirectory === undefined ? undefined : { policy: capability, scratchDirectory, git },
    );
    const ownedToolEnv = toolEnv;

    // The whole Agent Tool Surface, from the one list that names it.
    //
    // Each non-coding tool is offered only to a Session with the port that
    // answers it, for the reason the gate below is built only for a Session with
    // a policy: a tool that is absent cannot be called, where one wired to
    // nothing would be called and then fail, and the model would learn that from
    // the failure. A Session handed no web boundary is handed no way to ask for
    // one — the absent port is what makes the network unreachable from here, not
    // a refusal the model would have to be told about after reaching for it. Web
    // search is independent of web fetch, not paired with it: a search discloses
    // the query to a third party and a read does not, so a Session may be given
    // either, both or neither, and is offered exactly what it was given.
    //
    // Assembled behind `sessionToolBindings` rather than pushed one by one
    // here, and the Snapshot's list is `sessionToolIds` over those same
    // bindings: the array Pi resolves against and the list the Snapshot records
    // cannot disagree, which is what let the pack drop its rule about tool
    // identity (VC-3).
    // Selected per Session from its own frozen record (VC-454). Sequential
    // dispatch hands the array back untouched; a Session whose MCP definitions
    // carry host-authored parallel-read marks — honoured only when this
    // runtime was built to — gets every other tool marked sequential. Names
    // and schemas, the provider-visible half, never change.
    const { tools, toolExecution } = applyToolDispatch(
      createSessionTools(
        scoped && spec.shell !== undefined
          ? { ...spec, shell: containedShellPort(spec.shell, ownedToolEnv) }
          : spec,
        ownedToolEnv,
        toolOutput,
      ),
      spec.tools.mcp ?? [],
      host.parallelMcpReads,
    );
    // Composed here, once per attachment: the array is half of the Session's
    // Cache Prefix (VC-164), and a provider that orders tools ahead of the
    // system prompt throws the prompt away too when it changes. Reattachment
    // must therefore receive the same bindings, order and schemas that Session
    // start froze. Pinned off provider requests through the desktop reattach
    // seam, where a host-side recomposition would actually show up.

    let turnId = randomUUID();
    let failure: RuntimeFailure | undefined;
    let closed = false;
    let cancelled = false;
    /**
     * Whether this runtime ended the turn on purpose, cleared when the next one
     * starts.
     *
     * Tracked rather than read back off Pi, because Pi does not reliably say so.
     * `agent.abort()` makes it discard the pending tool batch and re-enter its
     * loop; the provider call that re-entry makes fails on the aborted signal,
     * and the lazy stream behind it reports that as `stopReason: "error"`
     * carrying the AbortSignal's own text rather than as an abort. Believing
     * that label raises an unrecoverable Attention, which tells someone who just
     * pressed stop that their Session broke.
     */
    let interrupting = false;
    /**
     * The transport attempts this turn has already spent, and whether the turn
     * is mid-recovery.
     *
     * The budget belongs to the turn, not to the attachment: a turn that starts
     * for its own reason — a new message, a manual Retry — gets a whole one,
     * while a turn resumed in place carries on spending the same one, so a
     * connection that will never hold cannot be chased forever.
     *
     * Spent only while ONLINE: a turn waiting for the network to come back is
     * not failing, and waits as long as it has to (VC-443). `autoRetryWaitedMs`
     * is the backoff the turn has scheduled, which is what the budget in
     * `transport-retry.ts` is measured in.
     */
    let autoRetryAttempts = 0;
    let autoRetryWaitedMs = 0;
    let autoRetryPending = false;
    /**
     * The detail of the transport notice this attachment has raised, while it
     * stands. Re-raised only when the detail changes, so a provider failing the
     * same way twenty times writes one fact rather than twenty.
     */
    let transportNotice: string | undefined;
    let resumingTurn = false;
    /**
     * Whether this turn has already spent its one overflow recovery.
     *
     * Pi keeps a flag of this name in its own lane state for the same reason: a
     * turn that overflows, compacts, retries and overflows again has learned
     * that compacting is not what is wrong with it, and a second attempt would
     * summarize a summary and refuse again. One per turn, reset where the
     * transport budget is — a turn that starts for its own reason gets a whole
     * one, and a turn resumed in place carries on spending the same one.
     */
    let overflowRecoveryUsed = false;
    /**
     * Whether this turn has already dropped the conversation's reasoning.
     *
     * The same shape as the overflow budget, for the same reason: a turn the
     * provider refuses for its earlier reasoning is sent again without any,
     * once. A second refusal is not about the reasoning — there is none left
     * to drop — and is the person's to look at. Reset where the other per-turn
     * budgets are.
     */
    let reasoningRecoveryUsed = false;
    /**
     * Every provider transformation reported during this Turn, held until the
     * Turn ends so one durable notice can carry the complete count and causes.
     */
    let pendingReasoningDrop: ProviderReasoningDroppedObservation | undefined;
    /**
     * Whether something already owns the live context, and what to wait for.
     *
     * A compaction does not extend `agent.state.messages`, it REPLACES it, so
     * it is exclusive with anything that reads or extends the same array. The
     * `isStreaming` checks around it are not enough on their own: each is a
     * check-then-act with a multi-second provider call in the middle, and a
     * turn that starts inside that gap is one the returning summary would
     * overwrite — dropping a delivered message and its reply from the context
     * while both stay on screen and in the ledger, which is the worst shape a
     * bug can have here because nothing surfaces it.
     *
     * Two halves because the two callers need different answers. A delivery
     * WAITS: refusing someone's message because maintenance is running would
     * be a worse answer than taking a moment longer to accept it. An explicit
     * compaction REFUSES, which is the answer {@link RuntimeAttachmentHandle}
     * already documents for a context that is not free — so it needs the fact
     * synchronously, before it awaits anything.
     *
     * The overflow path is deliberately outside this. It runs inside its own
     * run's `agent_end`, where `isStreaming` is still set, so every other path
     * has already been turned away by the check it does first.
     */
    let contextRewrite: Promise<void> = Promise.resolve();
    let rewritingContext = false;
    /**
     * Set only while a backoff or a network wait is being waited out; see
     * {@link interruptTurn}.
     */
    let cancelBackoff: (() => void) | undefined;
    /**
     * Set only while a BACKOFF is being waited out: a wake ends it early, since
     * the timer that was running across the sleep says nothing about the
     * network now. A network wait is not woken this way — it ends when the
     * port says the network is back, not when the lid opens.
     */
    let wakeBackoff: (() => void) | undefined;
    type PendingMessageDelivery = {
      commandId: string | null;
      operation: "message.submit";
      delivery: AcceptedMessageCommandMarker["delivery"];
      message: UserMessage;
      resources: readonly PromptResource[];
    };
    type PendingRetryDelivery = {
      commandId: string | null;
      operation: "executor.retry";
      delivery: "retry";
    };
    type PendingDelivery = PendingMessageDelivery | PendingRetryDelivery;
    let pendingRunDelivery: PendingDelivery | undefined;
    /**
     * The gate one `settle: "opened"` submit waits on, and whether the turn it
     * was waiting for actually opened (VC-324).
     *
     * At most one exists at a time, because only an IDLE attachment takes this
     * path and the submit that took it holds the attachment until Pi is
     * streaming. `opened` is set where the `{kind:"turn", state:"started"}`
     * observation has already been committed and the Command marked accepted,
     * so a caller released by it is released on a durable fact rather than on a
     * callback having fired.
     */
    let turnOpening: { opened: boolean; release: () => void } | undefined;
    // The latest run released at its opening boundary. Close awaits its
    // cleanup after Pi becomes idle so no detached observer work outlives the
    // attachment that owned it.
    let detachedRunSettled: Promise<void> = Promise.resolve();
    const reportTurnOpened = (): void => {
      const opening = turnOpening;
      if (opening === undefined) return;
      turnOpening = undefined;
      opening.opened = true;
      opening.release();
    };
    /**
     * A detached run reports through its own durable observations. Once the
     * opening Command boundary has read any failure it owns, failures from the
     * rest of that run are consumed at run end — never retained for an
     * unrelated later Command.
     */
    const pendingQueuedDeliveries = new Map<AgentMessage, PendingMessageDelivery>();
    const acceptedUserMessages = new WeakSet<UserMessage>();
    const persistAcceptedDelivery = async (
      delivery: PendingDelivery | undefined,
      acceptedTurnId: string,
    ): Promise<boolean> => {
      if (delivery?.operation === "message.submit") rememberResources(delivery.resources);
      if (!delivery?.commandId) return false;
      if (delivery.operation === "message.submit") {
        await persistObservation({
          kind: "command-accepted",
          commandId: delivery.commandId,
          operation: delivery.operation,
          delivery: delivery.delivery,
          turnId: acceptedTurnId,
          message: durableMessage(delivery.message) as UserMessage,
          // Always present on new markers, including `[]`, so recovery can
          // distinguish typed absence from a user-authored delimiter lookalike.
          resources: delivery.resources,
        });
      } else {
        await persistObservation({
          kind: "command-accepted",
          commandId: delivery.commandId,
          operation: delivery.operation,
          delivery: delivery.delivery,
          turnId: acceptedTurnId,
        });
      }
      return true;
    };
    const activityByToolCallId = new Map<
      string,
      { input: RuntimeActivityValue; startedAt: number }
    >();

    const observationDelivery = new OrderedObservationDelivery(observe);
    const commitObservation = (observation: Parameters<SessionRuntimeSpec["observer"]>[0]) =>
      observationDelivery.deliver(observation);
    /** An observer failure from the run this command boundary still owns. */
    const consumeRunFailure = (): unknown => observationDelivery.consumeFailure();

    // Assigned the statement after `new Agent` and read only from inside a Pi
    // callback, which cannot fire before a run starts. Declared here because the
    // callback would otherwise have to close over the `const` still being
    // constructed, and a definite-assignment `let` says that plainly instead of
    // resting on how a temporal dead zone happens to resolve inside a closure.
    let interruptTurn!: () => void;

    /**
     * The gate, built only for a Session that was handed a policy to enforce.
     *
     * The Snapshot is read once here rather than off the spec per call, because
     * a Snapshot is pinned for the life of the attachment by its own definition
     * — the facts its rules read stay live, the policy does not.
     */
    const gateToolCalls = (
      authority: AuthoritySnapshot,
    ): NonNullable<AgentOptions["beforeToolCall"]> => {
      const escalation = new AuthorityEscalation({
        fallback: authority.fallback,
        priorDenials: spec.priorAuthorityDenials,
        ask: spec.ask,
        signal: spec.signal,
        now: host.now,
      });
      return async ({ toolCall, args }, signal) => {
        const verdict = authorityVerdict({
          tool: toolCall.name,
          args,
          authority,
          workspacePath: spec.workspacePath,
          capability,
          contained: scoped,
        });
        // Pi's own per-call signal is passed on rather than dropped: a question
        // this parks on has to lose to a cancelled run, and Pi re-reads that
        // signal the instant this callback returns.
        const disposition = await escalation.resolve({
          verdict,
          tool: toolCall.name,
          toolCallId: toolCall.id,
          turnId,
          signal,
        });
        const waitDurationMs = escalation.consumeWaitDuration(toolCall.id);
        if (disposition.outcome === "allow") {
          recordObservability({
            kind: "authority",
            state: "allowed",
            turnId,
            toolCallId: toolCall.id,
            ...(waitDurationMs === undefined ? {} : { waitDurationMs }),
          });
          return undefined;
        }
        // Recorded before refused, through the same ordered queue as every other
        // observation: a refusal that overtook the turn it belongs to would be
        // filed against the wrong turn, and one that raced the activity stream
        // would print out of order. `commitObservation` resolves at the consumer
        // boundary and never rejects — a ledger that cannot be written is not a
        // reason to let the call through, and the failure it holds is consumed at
        // the next command boundary like any other.
        if (disposition.record) {
          await commitObservation({
            kind: "authority",
            state: "denied",
            turnId,
            toolCallId: toolCall.id,
            ...(waitDurationMs === undefined ? {} : { waitDurationMs }),
            tool: toolCall.name,
            cause: disposition.cause,
            reason: disposition.reason,
          });
        }
        if (disposition.interrupt) interruptTurn();
        return { block: true, reason: disposition.reason };
      };
    };

    /**
     * The output ceiling this request may honestly ask for.
     *
     * Pi's simple adapter clamps `max_tokens` against the context using its own
     * chars/4 estimate, which understates dense code and JSON badly enough that
     * a request can reserve more output than the window has left. A model-aware
     * ceiling replaces it; the adapter is free to clamp further.
     *
     * **It is floored, and the floor is the point.** The occupancy half of this
     * subtraction is an ESTIMATE, and a deliberately conservative one — an
     * opaque provider checkpoint has no local token count at all. An estimate
     * that reads high must not be able to hand the model a one-token answer:
     * that turns "we may be near the window" into a Session that produces
     * nothing, silently, with no error to recover from. Below the floor this
     * stops shrinking and lets the provider be the one to say no — which is a
     * refusal overflow recovery already knows how to answer.
     */
    const outputCeiling = (
      requestModel: Parameters<StreamFn>[0],
      context: Parameters<StreamFn>[1],
    ): number | undefined => {
      const window = contextWindowOf(requestModel);
      if (window === undefined) return undefined;
      const floor = Math.min(requestModel.maxTokens, MIN_OUTPUT_CEILING_TOKENS);
      // The whole normalized transcript, prefix included: since Pi 0.86 the
      // system prompt and tool declarations ARE messages (the leading system
      // one), and the projector prices them there rather than off fields the
      // context no longer has.
      const occupied = contextTokenProjector(context.messages, requestModel);
      return Math.max(
        floor,
        Math.min(requestModel.maxTokens, window - occupied - OUTPUT_CEILING_HEADROOM_TOKENS),
      );
    };

    const streamWithCompaction: StreamFn = (requestModel, context, options) => {
      const maxTokens = outputCeiling(requestModel, context);
      return models.streamSimple(requestModel, context, {
        ...options,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(nativeCompactionState?.kind === "anthropic-messages"
          ? {
              headers: {
                ...options?.headers,
                "anthropic-beta": [requestModel.headers?.["anthropic-beta"], ANTHROPIC_COMPACT_BETA]
                  .filter(Boolean)
                  .join(","),
              },
            }
          : {}),
      });
    };
    // A provider request that goes silent — most often a socket that died
    // while the machine slept — is cut and failed as a transient transport
    // failure, so it rides the same `continue` retry a dropped socket does
    // rather than hanging the turn for half an hour (VC-443).
    const streamSupervisor = superviseStreams(streamWithCompaction, host.streamSupervision);

    // The prompt and the declarations, as the one leading system message Pi's
    // transcript now carries them in (0.86). Built here rather than left to
    // the `Agent`, which seeds one only when the array it is handed does not
    // already start with a system message: a sidecar whose first replayable
    // entry is a tool-change system message Pi emitted ahead of the first
    // prompt would otherwise be taken for a transcript that already has its
    // prompt, and the composed one would never be sent. The same object is put
    // back at the head of every array this runtime rebuilds from the sidecar
    // (compaction, model switch), so the prefix is the same bytes on every
    // request of the attachment and the projector's memo hits on it.
    const head = systemHead(
      composeSystemPrompt({
        role: spec.identity.role,
        tools: spec.tools,
        promptResources: spec.promptResources,
      }),
      tools,
    );

    const agent = new Agent({
      initialState: {
        model,
        thinkingLevel: spec.model.reasoningLevel,
        tools,
        messages: withSystemHead(head, recoveredMessages),
      },
      onPayload: (payload) => {
        if (nativeCompactionState === undefined) return undefined;
        if (typeof payload !== "object" || payload === null)
          throw new Error("Native compaction payload is malformed.");
        const projected =
          nativeCompactionState.kind === "openai-responses"
            ? projectOpenAICompaction(payload as { input?: unknown }, nativeCompactionState)
            : projectAnthropicCompaction(payload as { messages?: unknown }, nativeCompactionState);
        if (projected === undefined)
          throw new Error("Native compaction checkpoint is missing from the request.");
        return projected;
      },
      // Every image made legal for the request's model before it is sent
      // (`provider-images.ts`); the attempt clock starts after, on the stream.
      // Outside the supervisor, so resize time never counts as provider silence.
      streamFn: withOpenCodeGoSessionHeader(
        instrumentStreamFn(withProviderSafeImages(streamSupervisor.streamFn, providerImageGuard), {
          sink: host.observability,
          runId,
          now: host.now,
          ...(host.usageLimits === undefined
            ? {}
            : {
                // The passive half of the usage read: whatever windows this
                // response's headers stated fold straight into the holder the
                // next inspection reads. A sink that throws costs the capture.
                usageLimits: {
                  record: (providerId, update) => {
                    host.usageLimits?.holder.apply(providerId, update);
                  },
                },
              }),
        }),
        sidecarMetadata.id,
      ),
      sessionId: sidecarMetadata.id,
      toolExecution,
      // Pi's harness converter, not the `Agent`'s default, and the difference is
      // exactly one message role. The default keeps `user`, `assistant` and
      // `toolResult` and DROPS everything else — including the
      // `compactionSummary` message a compacted context begins with. Left on the
      // default, compaction would appear to work: history would shrink, the
      // window would clear, and the summary that was supposed to replace it
      // would never reach the model. This converter frames it as the user
      // message Pi's own harness sends. Every role Volli already produces
      // converts identically under both.
      convertToLlm,
      // `terminate` is left unset on purpose: Pi only ends the run early when
      // every finalized result in the batch asks for it, which is not what one
      // refused call means. A `stop` answer ends the turn by aborting instead,
      // which needs no agreement from the rest of the batch — at the cost of the
      // reason it carries, which Pi drops on that one path because it re-reads
      // its cancellation before it reads the block.
      //
      // The key is absent, not set to a callback that always allows: a Session
      // with no Snapshot runs Pi's own default path, and the gate, the fallback
      // thresholds and `ask` are then unreachable rather than quietly permissive.
      ...(spec.authority === undefined ? {} : { beforeToolCall: gateToolCalls(spec.authority) }),
    });
    // Interrupting, closing and cancelling the attachment all arrive here, which
    // is why one flag answers for all three downstream.
    interruptTurn = () => {
      interrupting = true;
      cancelBackoff?.();
      agent.abort();
    };
    agent.steeringMode = "one-at-a-time";
    agent.followUpMode = "one-at-a-time";
    // The machine woke: a request open across the sleep is probably talking to
    // a socket the server dropped, and a backoff timer that ran across it says
    // nothing about the network now. Both are re-decided rather than waited out.
    stopWatchingResume = host.connectivity.onResume(() => {
      streamSupervisor.wake();
      wakeBackoff?.();
    });

    /**
     * A wait the turn can be taken out of, rather than one it has to sit through.
     *
     * Both waits begin after an await (the notice they follow is written
     * first), and a Stop that lands there finds no wait to cancel yet — so each
     * re-reads `interrupting` before it starts, rather than sitting out a wait
     * nobody is left to want.
     */
    const waitBeforeRetry = async (ms: number): Promise<void> => {
      if (interrupting) return;
      await new Promise<void>((wake) => {
        const timer = setTimeout(wake, ms);
        cancelBackoff = () => {
          clearTimeout(timer);
          wake();
        };
        wakeBackoff = cancelBackoff;
      });
      cancelBackoff = undefined;
      wakeBackoff = undefined;
    };

    /**
     * Wait for the host to report a network, for as long as that takes.
     *
     * Ended early by the same Stop a backoff is, and by the run's own signal.
     * Answers whether the network actually came back: a wait that ended any
     * other way is either a Stop — which the caller re-reads `interrupting`
     * for — or a port that broke its contract, which is not a network and is
     * charged to the online budget rather than retried for free.
     */
    const waitForNetwork = async (runSignal: AbortSignal): Promise<boolean> => {
      if (interrupting) return false;
      const waiting = new AbortController();
      const stop = (): void => waiting.abort();
      cancelBackoff = stop;
      runSignal.addEventListener("abort", stop, { once: true });
      try {
        await host.connectivity.waitUntilOnline(waiting.signal);
        return true;
      } catch {
        return false;
      } finally {
        runSignal.removeEventListener("abort", stop);
        cancelBackoff = undefined;
      }
    };

    /**
     * Say, in the chat, that the runtime is reconnecting on its own.
     *
     * An Attention of the `transport` reason, which the ledger reads as
     * `transport_retrying`: a waiting row, not an error — no notification, no
     * red dot — cleared by the first sign the provider is answering again.
     * Durable like every other Attention, because a notice raised and then
     * orphaned by a crash would otherwise be one nothing could ever clear; the
     * next attach retires it.
     */
    const raiseTransportNotice = async (detail: string): Promise<void> => {
      if (transportNotice === detail) return;
      transportNotice = detail;
      activeAttentionReasons.add("transport");
      await commitObservation(
        await persistObservation({
          kind: "attention",
          state: "raised",
          reason: "transport",
          message: detail,
        }),
      );
    };

    const clearTransportNotice = async (): Promise<void> => {
      if (transportNotice === undefined) return;
      transportNotice = undefined;
      activeAttentionReasons.delete("transport");
      await commitObservation(
        await persistObservation({
          kind: "attention",
          state: "cleared",
          reason: "transport",
          message: "Runtime recovered.",
        }),
      );
    };

    /**
     * Wait out a transport failure, and say whether the turn should resume.
     *
     * Offline, the wait is for the network and costs nothing: a laptop closed
     * for three hours comes back to a turn that simply carries on (VC-443).
     * Online, it is the bounded backoff in `transport-retry.ts` — the provider
     * is reachable and failing, and that is worth a person's attention once the
     * budget is spent. A backoff that ends to find the network gone waits for
     * it too, rather than spending the retry on a request that cannot leave.
     *
     * `eligible` is false for a failure only an absent network can excuse — a
     * credential refresh that never reached its server — which is waited out
     * offline and handed to the person online.
     */
    const recoverFromTransport = async (
      failed: RuntimeFailure,
      signal: AbortSignal,
      eligible: boolean,
    ): Promise<boolean> => {
      if (!host.connectivity.isOnline()) {
        await raiseTransportNotice(OFFLINE_NOTICE);
        if ((await waitForNetwork(signal)) || interrupting) return true;
      }
      if (!eligible) return false;
      const plan = planTransportRetry(
        { attempts: autoRetryAttempts, waitedMs: autoRetryWaitedMs },
        host.retryBackoffMs(autoRetryAttempts),
        retryHintMs(failed.message),
      );
      if (plan.kind === "give-up") return false;
      autoRetryAttempts += 1;
      autoRetryWaitedMs += plan.delayMs;
      if (autoRetryAttempts >= TRANSPORT_NOTICE_AFTER_ATTEMPTS) {
        await raiseTransportNotice(failed.message);
      }
      await waitBeforeRetry(plan.delayMs);
      if (!interrupting && !host.connectivity.isOnline()) {
        await raiseTransportNotice(OFFLINE_NOTICE);
        await waitForNetwork(signal);
      }
      return true;
    };

    /**
     * Run the failed attempt again without re-delivering anything the user said:
     * the assistant message Pi settled as a failure is dropped, and the run
     * continues from the user or tool-result message it answered.
     */
    const retryFailedTurn = async (commandId: string | null): Promise<DeliveryOutcome> => {
      const messages = [...agent.state.messages];
      const tail = messages.at(-1);
      if (tail?.role === "assistant" && hasFailedStopReason(tail as AssistantMessage)) {
        messages.pop();
        agent.state.messages = messages;
      } else if (tail?.role !== "user" && tail?.role !== "toolResult") {
        return {
          kind: "rejected",
          reason: "retry-unavailable",
          message: "There is no failed Pi turn to retry.",
        };
      }
      pendingRunDelivery = {
        commandId,
        operation: "executor.retry" as const,
        delivery: "retry" as const,
      };
      await agent.continue();
      return { kind: "delivered", delivery: "retry" };
    };

    /**
     * Resume a turn its own runtime recovered, from the command boundary the
     * failed run was started at.
     *
     * Not from the callback that decided to retry: Pi is still finishing that run
     * while its `agent_end` listeners are awaited, and it refuses to begin a
     * second one until they settle.
     *
     * The rejection arm of the retry cannot be reached from here. A turn lands
     * in this loop two ways and both leave a tail the retry accepts: a spent
     * transport leaves the failed assistant message it drops, and an overflow
     * recovery leaves the compacted context, which ends where the failed reply
     * began — the user message, or the tool results it was answering.
     */
    const drainAutoRetries = async (): Promise<void> => {
      while (autoRetryPending) {
        autoRetryPending = false;
        resumingTurn = true;
        await retryFailedTurn(null);
      }
    };

    /**
     * Pi polls its steering queue just before it emits `agent_end`. A command
     * can land after that poll but before its awaited `agent_end` observers
     * settle; it was accepted into Pi's queue, yet no live loop remains to
     * consume it. Once the run is truly idle, continue it until that narrow
     * closing-window queue is empty. Normal queue/steer delivery is still
     * owned by Pi's loop; this only closes the poll-to-idle gap.
     */
    const canDrainLateQueuedMessages = (): boolean =>
      !closed && !cancelled && !interrupting && failure === undefined && agent.hasQueuedMessages();

    const drainLateQueuedMessages = async (): Promise<void> => {
      while (canDrainLateQueuedMessages()) {
        await agent.continue();
        await drainAutoRetries();
      }
    };

    const settleRun = async (): Promise<void> => {
      await drainAutoRetries();
      await drainLateQueuedMessages();
    };

    /**
     * The rule this Session compacts under right now, from the policy configured
     * right now.
     *
     * Read per call for {@link summarizationModel}'s reason: a Session outlives
     * a settings change. The policy lands on Pi's own `CompactionSettings`
     * rather than beside it — the global switch IS `enabled`, which
     * `shouldCompact` reads — not a second condition wrapped around Pi's rule.
     * The reserve is always the executor's own default: per-model reserve
     * budgets were retired with the policy that carried them (VC-155). What
     * the THRESHOLD uses is that default widened by {@link thresholdHeadroom}
     * on a large window — derived, never configured. These settings are also
     * what Pi's summary generation is run under, and it keeps the unwidened
     * number: the reserve bounds how long a summary may be.
     *
     * **What switching automatic compaction off does to the overflow path:
     * nothing.** `enabled` is read by `shouldCompact` and by nothing else in
     * 0.84.1 — `prepareCompaction` and `compact` never consult it — so the only
     * caller it reaches is {@link compactBeforeTurn}, through `compactionDue`.
     * That is the behaviour this runtime wants and it is deliberate, not
     * inherited: off means "do not interrupt me to make room", and a Session
     * whose provider has already refused the turn is not being interrupted, it
     * is being rescued from a dead end. A test pins it, so a future Pi that
     * taught `prepareCompaction` about `enabled` would fail loudly here rather
     * than quietly stop recovering overflowed Sessions.
     */
    const compactionSettings = (): CompactionSettings => ({
      ...DEFAULT_COMPACTION_SETTINGS,
      enabled: host.compactionPolicy().autoCompaction,
    });

    /**
     * The durable branch, read as a conversation. Costs the whole history.
     *
     * Read under the same reasoning drops as the attach-time replay, so a
     * context rebuilt from this path — a compaction's — is rebuilt from what
     * the model was actually sent rather than from what the sidecar remembers
     * it once holding.
     */
    const conversationBranch = async (): Promise<Entry[]> =>
      conversationPath(
        withDroppedReasoning(await mainBranch.findEntries({ order: "oldestFirst" }, piContext())),
        conversationReader,
      );

    /**
     * Own the live context for the whole of `operation` — see {@link
     * contextRewrite}.
     *
     * Both halves are set before the first await and cleared after the last
     * one, so a caller that asks either question between them gets the same
     * answer. The promise swallows the failure it publishes: a waiter is
     * waiting to find the context settled, not to inherit why it is.
     */
    const rewritingTheContext = async <T>(operation: () => Promise<T>): Promise<T> => {
      rewritingContext = true;
      const running = operation();
      contextRewrite = running.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await running;
      } finally {
        rewritingContext = false;
      }
    };

    /**
     * Summarize this Session's history and say so, whichever way it goes.
     *
     * One mechanism for every reason a context is compacted — the threshold,
     * the overflow, and the person who typed `/compact` — so three producers
     * cannot drift into three behaviours or three event shapes. What differs
     * between them is only when they are called and what they do with the
     * answer, which is why the answer is Pi's own outcome rather than a
     * boolean: two callers only need to know whether the context changed, and
     * the one with a person waiting on it needs to know which way it did not.
     *
     * The failure is reported rather than swallowed and reported rather than
     * raised as an Attention. Nothing is blocked by it — the message that paid
     * for the attempt is delivered on the context that was already there — but
     * the next turn may well be refused for context length, and a refusal with
     * no record of the summary that was tried first reads as arbitrary.
     */
    /**
     * What a native compaction's own HTTP calls contribute to instrumentation.
     *
     * Native compaction is the one model call this runtime makes that does not
     * go through `streamSimple`, and a request that skips that seam skips both
     * things the seam does: the passive Usage Window read off the response's
     * rate-limit headers, and the attempt envelope every other provider request
     * emits. Neither absence is visible — a Usage Window would simply read stale
     * after a compaction, and the spend would appear in the ledger with no
     * request behind it — which is exactly why they are worth closing.
     *
     * The header mapping is the same product-owned function `instrumentStreamFn`
     * uses, not a second copy of it. Token counts are deliberately NOT here:
     * compaction spend is recorded as its own `usage.recorded` fact against the
     * compaction entry, and repeating it on the envelope would double it in any
     * surface that reads both.
     */
    const observeNativeRequest = (observation: NativeRequestObservation): void => {
      const requestModel = agent.state.model;
      try {
        const update = headerUsageUpdate(requestModel.provider, observation.headers, host.now());
        if (update !== null) host.usageLimits?.holder.apply(requestModel.provider, update);
      } catch {
        // A lost capture, never a lost compaction.
      }
      try {
        host.observability.record({
          kind: "provider-attempt",
          providerId: requestModel.provider,
          modelId: requestModel.id,
          api: requestModel.api,
          stopReason: observation.status < 400 ? "stop" : "error",
          ...(observation.status < 400
            ? {}
            : { providerErrorClass: providerErrorClassForStatus(observation.status) }),
          durationMs: observation.durationMs,
          runId,
        });
      } catch {
        // A sink that throws costs the measurement, never the compaction.
      }
    };

    const compactContext = async (input: {
      // Only the three reasons a compaction is ATTEMPTED for; `checkpoint`
      // reports a compaction that stopped being usable and runs no work.
      reason: CompactionWorkReason;
      path: readonly Entry[];
      signal: AbortSignal | undefined;
      /** What to keep, in the requester's words. Only a person supplies these. */
      instructions?: string;
    }): Promise<CompactionOutcome> => {
      const { reason, path, signal, instructions } = input;
      // Compaction has no turn of its own, so `working` cannot explain the
      // multi-second summary to the person waiting for it. This transient pair
      // does — without becoming recovery history that could revive a spinner
      // after the attachment that started it has gone away.
      await commitObservation({ kind: "compaction-progress", state: "started", reason });
      const finishProgress = () =>
        commitObservation({ kind: "compaction-progress", state: "finished", reason });
      try {
        const outcome = await compactSession({
          sidecar,
          path,
          models,
          // Compaction is part of this chat's continuity, so its summary is
          // generated by the model currently selected in the chat pane.
          model: agent.state.model,
          settings: compactionSettings(),
          systemPrompt: agent.state.systemPrompt,
          tools: agent.state.tools,
          onNativeRequest: observeNativeRequest,
          // VC-349 follow-up: the summarizer is a provider request like any
          // other, so it carries the same stable Go routing identity the live
          // turn sends. Without this, /compact on an opencode chat 400s.
          sessionId: sidecarMetadata.id,
          // The resources this Session had activated ride INSIDE the durable
          // entry, ahead of the kept turns, rather than being inserted into
          // the live array once the entry is written. What the model is sent
          // after this compaction is then exactly what a later attach reads
          // back from the entry, which a provider that binds each reasoning
          // block to everything before it requires (VC-242).
          retainedTail: (tail) =>
            restoreCompactedResources(tail, [...activeMessageResources.values()]),
          ...(signal === undefined ? {} : { signal }),
          ...(instructions === undefined ? {} : { customInstructions: instructions }),
        });
        // Pi found nothing to compact — an empty history, or one already ending
        // in a summary. No compaction happened, so no compaction is recorded:
        // there is no summary, no elided context and no spend to file, and a
        // `CompactionObservation` saying otherwise would be a fact about work
        // that did not occur. The live marker still has to leave, because it
        // has no durable outcome that can dismiss it.
        //
        // Reporting it is the caller's job, and only one caller has anybody to
        // report to (VC-141): the attachment's `compact` below turns this arm
        // into a `nothing-to-compact` refusal, which reaches the person who
        // typed `/compact` as a receipt, a durable `command.receipt.recorded`
        // Session Event, and one neutral toast. Threshold and overflow stay
        // silent here exactly as before — nobody is waiting on those.
        if (outcome.kind === "skipped") {
          await finishProgress();
          return outcome;
        }
        if (outcome.kind === "compacted") {
          // The elided context, from the same rule the replay path applies.
          //
          // Replacing this array is safe only because every caller has made it
          // so, and none of them by the `isStreaming` check alone: that check is
          // separated from this line by a provider call, and what it answered
          // before is not what it would answer now. The threshold path holds
          // {@link contextRewrite} across both, the manual path holds it and
          // refuses rather than waits, and the overflow path runs inside its own
          // run's `agent_end`, where every other caller has already been turned
          // away. Take that away and a turn started mid-summary is one this line
          // overwrites — its message and its reply gone from the model's context
          // while both remain in the ledger and on screen.
          //
          // Already whole: the summary, the restored resources and the kept
          // turns without their reasoning, all read off the entry just written
          // — behind the head, which the entry never holds.
          agent.state.messages = withSystemHead(head, outcome.messages);
          nativeCompactionState = providerCompactionFromDetails(outcome.entry.details);
        }
        // Recorded before the compaction fact, so a crash between the two
        // loses the summary rather than the bill: the summary is recoverable
        // from Pi's own entry, and spend that went unrecorded is not.
        if (outcome.usage != null) {
          await commitObservation(
            await persistObservation({
              kind: "usage",
              // Named after the compaction entry, which is what makes a
              // replayed compaction land on the bill it already has.
              entryId: outcome.kind === "compacted" ? outcome.entry.id : randomUUID(),
              // Compaction has no turn of its own. Inventing one here would
              // put maintenance spend inside a conversation unit it is not in.
              turnId: null,
              usage: outcome.usage,
            }),
          );
        }
        await commitObservation(
          await persistObservation(
            outcome.kind === "compacted"
              ? {
                  kind: "compaction",
                  state: "compacted",
                  reason,
                  entryId: outcome.entry.id,
                  // Floored where a provider's arithmetic becomes a durable
                  // count, for the reason a context window is: the ledger holds
                  // whole tokens, and a fractional one would recover and then
                  // fail to decode.
                  tokensBefore: Math.floor(outcome.entry.tokensBefore),
                  tokensAfter: estimatedContextTokens(agent.state.messages, agent.state.model),
                }
              : { kind: "compaction", state: "failed", reason, message: outcome.message },
          ),
        );
        // A compacted or failed observation is the durable terminal fact. The
        // Session runtime removes the transient marker as it records that fact,
        // so sending a second finish signal would race the boundary it draws.
        return outcome;
      } catch (error) {
        // Reachable only above that commit — once the durable outcome lands
        // nothing else here can throw — so the marker is always still open and
        // needs an explicit finish before the failure propagates.
        await finishProgress();
        throw error;
      }
    };

    /**
     * Make room before a request, using the last provider measurement plus the
     * unmeasured suffix (including an incoming user message or tool results).
     * The idle path holds the context rewrite lock; the tool-loop path runs at
     * Pi's prepareNextTurn boundary, where no provider request is in flight.
     * Maintenance failures are durable notices, not rejected user messages.
     */
    const compactBeforeTurn = async (
      additional: readonly AgentMessage[] = [],
      signal: AbortSignal | undefined = spec.signal,
    ): Promise<boolean> => {
      // Asked first because it is free. A model whose catalog reports no usable
      // window can never trip the threshold, and the branch read below costs the
      // whole history — there is no reason to pay it for an answer already known.
      const contextWindow = contextWindowOf(agent.state.model);
      if (contextWindow === undefined) return false;
      try {
        const settings = compactionSettings();
        if (!settings.enabled) return false;
        const thresholdSettings = {
          ...settings,
          reserveTokens: thresholdHeadroom(settings.reserveTokens, contextWindow),
        };
        // The live array already leads with the system message that carries
        // the prompt and tools; handing the projector the prompt as well would
        // count it twice. (Tools would not — the estimator prices each
        // declaration once over the transcript — but there is nothing to add.)
        const occupied = contextTokenProjector(
          [...agent.state.messages, ...additional],
          agent.state.model,
        );
        if (!compactionDue(occupied, contextWindow, thresholdSettings)) return false;
        const path = await conversationBranch();
        const outcome = await compactContext({ reason: "threshold", path, signal });
        return outcome.kind === "compacted";
      } catch (error) {
        // Reported through the channel a refused summary already uses. If THIS
        // throws the sidecar itself is unwritable, which is not a maintenance
        // failure to absorb — it is the attachment's own durability gone, and it
        // belongs to the caller that can still say so.
        await commitObservation(
          await persistObservation({
            kind: "compaction",
            state: "failed",
            reason: "threshold",
            message: sanitizeDiagnostic(errorMessage(error)),
          }),
        );
        return false;
      }
    };

    // Pi 0.85 provides a safe replacement boundary BETWEEN tool rounds. The
    // loop owns a separate context snapshot: replacing Agent.state alone would
    // appear to compact while the next request still sent the entire history.
    agent.prepareNextTurnWithContext = async ({ context }, signal) => {
      const changed = await compactBeforeTurn([...pendingQueuedDeliveries.keys()], signal);
      return changed ? { context: { ...context, messages: [...agent.state.messages] } } : undefined;
    };

    /**
     * What this runtime can still do about a failed turn without asking anybody.
     *
     * Three recoveries, one shape: each spends something the turn has a budget
     * for, each keeps the turn open while it does it, and each hands back the
     * same answer — that the run may be resumed in place. Everything else is
     * the user's to decide, and says so by returning false. The transport one
     * alone may wait without spending anything: a machine with no network is
     * waited on, not charged ({@link recoverFromTransport}).
     *
     * Overflow remains a one-shot recovery for provider limits the proactive
     * budget could not predict. It runs only after the failed loop has ended.
     *
     * The retry continues from what the compacted context ends with, and that is
     * not a coincidence to leave unstated: the reply that failed is dropped from
     * the durable path as unreplayable, and Pi never cuts a context in front of
     * a tool result, so what remains is the user message or the tool results the
     * failed reply was answering — which is what `continue` requires.
     */
    const recoverFromFailure = async (
      failed: RuntimeFailure,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const transient = isTransientTransportFailure(failed);
      if (transient || isUnreachedAuthFailure(failed)) {
        return recoverFromTransport(failed, signal, transient);
      }
      // **Refused reasoning is answered by dropping it.** A provider that binds
      // each `thinking` block to everything sent before it has found a block
      // whose prefix this runtime changed — a compaction entry written before
      // the tail was stripped, a resume that could not reproduce the live
      // array — and it says so with a 400 that the identical request can
      // never clear. The doc names exactly one repair without the beta header:
      // strip every reasoning block, keep each turn's text and tool calls, and
      // send it once more. That loses nothing a person can see (the model's
      // hidden scratchpad from earlier turns) and is the same class of act as
      // the overflow compaction below, which loses far more without asking.
      // The drop is made durable before the retry so a later attach makes the
      // same edit and does not put the refused blocks back.
      if (failed.reason === "reasoning" && !reasoningRecoveryUsed) {
        reasoningRecoveryUsed = true;
        agent.state.messages = agent.state.messages.map(withoutReasoning);
        await recordReasoningElision();
        return true;
      }
      if (failed.reason !== "context" || overflowRecoveryUsed) return false;
      overflowRecoveryUsed = true;
      // The run's own signal, not the attachment's: a person pressing stop
      // during the summary is stopping this turn, and the summary is now the
      // only part of it still running.
      const outcome = await compactContext({
        reason: "overflow",
        path: await conversationBranch(),
        signal,
      });
      return outcome.kind === "compacted";
    };

    unsubscribe = agent.subscribe(async (event, runSignal) => {
      if (event.type === "agent_start") {
        // A resumed attempt is the same turn continuing, so it neither starts one
        // nor refreshes the budget it is spending.
        const resumed = resumingTurn;
        resumingTurn = false;
        failure = undefined;
        interrupting = false;
        activityByToolCallId.clear();
        if (!resumed) {
          turnId = randomUUID();
          autoRetryAttempts = 0;
          autoRetryWaitedMs = 0;
          overflowRecoveryUsed = false;
          reasoningRecoveryUsed = false;
          await commitObservation(
            await persistObservation({ kind: "turn", state: "started", turnId }),
          );
        }
        const delivery = pendingRunDelivery;
        pendingRunDelivery = undefined;
        if (await persistAcceptedDelivery(delivery, turnId)) {
          if (delivery?.operation === "message.submit") {
            acceptedUserMessages.add(delivery.message);
          }
        }
        // Last, and only here: a `settle: "opened"` caller is released once the
        // turn's own start is committed and its Command is durably accepted
        // (VC-324). Everything it was promised has happened; the run has not
        // ended, and it never claimed it had.
        reportTurnOpened();
        return;
      }

      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
      ) {
        const observedAt = host.now();
        const retained = activityByToolCallId.get(event.toolCallId);
        const startedAt = retained?.startedAt ?? observedAt;
        const activity = mapPiActivity(
          event,
          event.type === "tool_execution_end"
            ? { turnId, input: retained?.input, startedAt: retained?.startedAt, observedAt }
            : event.type === "tool_execution_start"
              ? { turnId, observedAt }
              : { turnId, startedAt, observedAt },
        );

        if (event.type !== "tool_execution_end") {
          activityByToolCallId.set(event.toolCallId, { input: activity.input, startedAt });
          await commitObservation(activity);
          return;
        }

        try {
          await commitObservation(await persistObservation(activity));
        } finally {
          activityByToolCallId.delete(event.toolCallId);
        }
        return;
      }

      if (event.type === "message_update") {
        // The provider is answering again, which is the whole of what the
        // reconnecting notice was waiting to hear.
        await clearTransportNotice();
        const streamed = event.assistantMessageEvent;
        if (streamed.type === "text_delta") {
          await commitObservation({ kind: "delta", turnId, channel: "text", text: streamed.delta });
        }
        if (streamed.type === "thinking_delta") {
          await commitObservation({
            kind: "delta",
            turnId,
            channel: "reasoning",
            text: streamed.delta,
          });
        }
        return;
      }

      if (event.type === "message_end") {
        if (event.message.role === "user") {
          const delivery = pendingQueuedDeliveries.get(event.message);
          if (delivery !== undefined) {
            pendingQueuedDeliveries.delete(event.message);
            if (await persistAcceptedDelivery(delivery, randomUUID())) {
              acceptedUserMessages.add(event.message);
            }
          }
        }
        const acceptedUserMessage =
          event.message.role === "user" && acceptedUserMessages.has(event.message);
        const entryId = acceptedUserMessage
          ? null
          : await mainBranch.appendMessage(durableMessage(event.message), piContext());
        if (event.message.role !== "assistant") {
          return;
        }
        /* v8 ignore next -- acceptedUserMessages only contains user messages. */
        if (entryId === null) throw new Error("Pi assistant message was not persisted.");
        // Metering happens BEFORE classification, and that ordering is the
        // whole point. Classification asks whether the message said anything;
        // most agentic spend answers no — a reply that only called tools, a
        // reply that failed after its prompt was billed — and usage read off
        // the settled arm alone would report a fraction of the bill.
        const metered = assistantUsage(event.message as AssistantMessage);
        if (metered !== null) {
          await commitObservation(
            await persistObservation({ kind: "usage", entryId, turnId, usage: metered }),
          );
        }
        // Reported before the reply is classified, and for the same reason
        // metering is: this is a fact about the request that produced the
        // message, true whether or not the message itself said anything.
        //
        // A tool round can make several provider requests. Hold every drop and
        // publish one complete Turn fact at `agent_end`, after the reply that
        // anchors its transcript notice has settled.
        const dropped = providerReasoningDropped(event.message as AssistantMessage, turnId);
        if (dropped !== undefined) {
          pendingReasoningDrop = mergeProviderReasoningDrop(pendingReasoningDrop, dropped);
        }
        const outcome = classifyAssistantMessage(entryId, event.message as AssistantMessage);
        if (outcome.kind === "settled") {
          await commitObservation(
            await persistObservation({ kind: "message-settled", turnId, message: outcome.message }),
          );
        } else if (outcome.kind === "failed") {
          failure = outcome.failure;
        }
        return;
      }

      if (event.type !== "agent_end") {
        return;
      }
      activityByToolCallId.clear();
      if (pendingReasoningDrop !== undefined) {
        const dropped = await persistObservation(pendingReasoningDrop);
        pendingReasoningDrop = undefined;
        await commitObservation(dropped);
      }
      if (failure === undefined) {
        await clearTransportNotice();
        for (const reason of activeAttentionReasons) {
          const cleared = await persistObservation({
            kind: "attention",
            state: "cleared",
            reason,
            message: "Runtime recovered.",
          });
          activeAttentionReasons.delete(reason);
          await commitObservation(cleared);
        }
        await commitObservation(
          await persistObservation({ kind: "turn", state: "completed", turnId }),
        );
        return;
      }
      // An abort Pi named as one, and an abort only this runtime knows it
      // caused, are the same fact reported two ways: the turn ended because it
      // was asked to. Neither is an unrecoverable failure, and neither deserves
      // a banner offering no way out of a state the user chose.
      if (failure.reason !== "aborted" && !interrupting) {
        // Neither a dropped socket nor a spent window is a decision anyone has to
        // make, so the turn stays live over the recovery and the attempt that
        // follows: no completion, no interruption, and a follow-up typed
        // meanwhile queues against the same run exactly as it would mid-stream.
        // What survives the turn's own budget is reported as it always was.
        const recovered = await recoverFromFailure(failure, runSignal);
        // Re-read after the await, because both recoveries take real time: a
        // person who pressed stop during the backoff or the summary has ended
        // this turn themselves, and neither resuming it nor raising an Attention
        // over it is an honest answer to that.
        if (!interrupting) {
          if (recovered) {
            autoRetryPending = true;
            return;
          }
          // No longer reconnecting: the dead end below is the one standing
          // claim, and a "Reconnecting" row beside it would be a wait nobody is
          // running.
          await clearTransportNotice();
          // Including a context refusal that compaction could not answer — an
          // overflow with nothing left to summarize is still a dead end, and
          // still has to say so.
          //
          // What the runtime already spent on this turn rides the message, so
          // a person reading the dead end knows the automatic repairs are behind
          // it: the transport retries, and the reasoning it dropped and was
          // refused again without. Appended to the already-sanitized failure
          // rather than sanitized with it: the note is this runtime's own text,
          // and re-bounding the whole would cut the note off the end of a
          // provider sentence that already fills the bound.
          const spent = [
            ...(autoRetryAttempts > 0 ? [`after ${autoRetryAttempts} retries`] : []),
            ...(reasoningRecoveryUsed && failure.reason === "reasoning"
              ? ["after dropping this conversation's earlier reasoning"]
              : []),
          ];
          const reason = attentionReasonFor(failure);
          // A spent allowance whose reset the failure states: carried on the
          // Attention so a person can schedule the resume (quota-reset.ts).
          const resetsAt =
            reason === "runtime-failure"
              ? failureResetsAt({
                  failure,
                  providerId: agent.state.model.provider,
                  observedAt: host.now(),
                  holder: host.usageLimits?.holder,
                })
              : null;
          const raised = await persistObservation({
            kind: "attention",
            state: "raised",
            reason,
            message:
              spent.length === 0 ? failure.message : `${failure.message} (${spent.join("; ")})`,
            ...(resetsAt === null ? {} : { resetsAt }),
          });
          activeAttentionReasons.add(reason);
          await commitObservation(raised);
        }
      }
      // A Stop during a reconnect ends the wait with the turn.
      await clearTransportNotice();
      await commitObservation(
        await persistObservation({ kind: "turn", state: "interrupted", turnId }),
      );
    });

    const onAbort = (): void => {
      cancelled = true;
      autoRetryPending = false;
      interruptTurn();
      // The active submit promise owns any observer failure from this same run.
      /* v8 ignore next -- abort-listener failures are intentionally suppressed */
      void agent.waitForIdle().catch(() => undefined);
    };
    abortListener = onAbort;

    const handle: RuntimeAttachmentHandle = {
      async submitUserMessage(
        text,
        delivery = "queue",
        commandId,
        images = [],
        resources = [],
        settle = "turn",
      ): Promise<DeliveryOutcome> {
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (delivery === "replace") {
          return {
            kind: "rejected",
            reason: "replace-unsupported",
            message: "Pi does not support replacing the active turn.",
          };
        }
        // Wait out a compaction already rewriting the very array this delivery
        // is about to be composed against — see {@link contextRewrite}. Waited
        // on rather than refused: maintenance nobody asked for must not cost
        // someone their message. Every question below is asked after it,
        // because the answers can change while it is held.
        await contextRewrite;
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        const framedText = appendPromptResources(text, resources);
        if (agent.state.isStreaming) {
          const message = queuedUserMessage(framedText, images);
          const pending = {
            commandId: commandId ?? null,
            operation: "message.submit" as const,
            delivery,
            message,
            resources,
          };
          pendingQueuedDeliveries.set(message, pending);
          if (delivery === "steer") agent.steer(message);
          else agent.followUp(message);
          // No `turnOpened`: this message joined a turn that was already
          // running, which is the distinction a supervisor reads (VC-324).
          return { kind: "delivered", delivery };
        }
        consumeRunFailure();
        // Before the message is composed, not after: compaction can change what
        // the context holds, and the Brief is prepended on an empty one. Held
        // as a rewrite so an explicit `/compact` arriving meanwhile is refused
        // rather than admitted onto a context this turn is already composing
        // against; everything from here to `prompt` is synchronous, so there is
        // no gap between releasing it and Pi owning the array itself.
        await rewritingTheContext(() =>
          compactBeforeTurn([
            queuedUserMessage(
              conversationIsEmpty(agent.state.messages)
                ? composeFirstUserMessage(spec, framedText)
                : framedText,
              images,
            ),
          ]),
        );
        // Asked of the conversation, not of the array: the array is never empty
        // now that the system head lives in it (see `transcript-context.ts`).
        const delivered = conversationIsEmpty(agent.state.messages)
          ? composeFirstUserMessage(spec, framedText)
          : framedText;
        const message = queuedUserMessage(delivered, images);
        pendingRunDelivery = {
          commandId: commandId ?? null,
          operation: "message.submit" as const,
          delivery: "prompt" as const,
          message,
          resources,
        };
        const run = async (): Promise<void> => {
          await agent.prompt(message);
          await settleRun();
        };
        if (settle === "opened") {
          // The run is STARTED here and awaited nowhere: this call answers when
          // the turn has opened, and the turn's own end reaches the Session
          // through the observations it publishes either way (VC-324).
          const released = Promise.withResolvers<void>();
          const boundaryChecked = Promise.withResolvers<void>();
          const opening = { opened: false, release: released.resolve };
          turnOpening = opening;
          // A run that ended without ever opening a turn must not park its
          // caller for the life of the attachment. The run-end cleanup waits
          // until this caller has consumed the opening boundary, then drops
          // any later observer failure instead of charging a future Command.
          const finishDetachedRun = async (): Promise<void> => {
            /* v8 ignore next 3 -- Pi opens a turn before a run can settle; this only releases an impossible defensive no-open path. */
            if (turnOpening === opening) {
              turnOpening = undefined;
            }
            released.resolve();
            await boundaryChecked.promise;
            consumeRunFailure();
          };
          // Pi converts provider failures into run-end observations. The same
          // cleanup handles both Promise outcomes so a defensive rejection is
          // neither unhandled nor retained for another Command.
          detachedRunSettled = run().then(finishDetachedRun, finishDetachedRun);
          await released.promise;
          // The same command boundary the awaited path keeps, read at the
          // moment this one answers: a run that failed on its way to opening a
          // turn, or an observer that threw committing the turn's start, is
          // this caller's to be told about.
          const failed = consumeRunFailure();
          boundaryChecked.resolve();
          if (failed !== undefined) {
            throw failed;
          }
          return { kind: "delivered", delivery: "prompt", turnOpened: opening.opened };
        }
        await run();
        const failed = consumeRunFailure();
        if (failed !== undefined) {
          throw failed;
        }
        return { kind: "delivered", delivery: "prompt" };
      },

      async selectModel(selection) {
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (agent.state.isStreaming) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "The model cannot change while Pi is running.",
          };
        }
        let available: Awaited<ReturnType<Models["getAvailable"]>>;
        try {
          available = await models.getAvailable(
            selection.providerId,
            spec.signal ? { signal: spec.signal } : undefined,
          );
        } catch {
          return {
            kind: "rejected",
            reason: "model-unavailable",
            message: "The selected model is not currently available.",
          };
        }
        const selected = available.find(
          (candidate) =>
            candidate.provider === selection.providerId && candidate.id === selection.modelId,
        );
        if (!selected) {
          return {
            kind: "rejected",
            reason: "model-unavailable",
            message: "The selected model is not currently available.",
          };
        }
        if (!getSupportedThinkingLevels(selected).includes(selection.reasoningLevel)) {
          return {
            kind: "rejected",
            reason: "reasoning-unsupported",
            message: "The selected reasoning level is not supported by this model.",
          };
        }
        // Availability can resolve asynchronously. Recheck the idle boundary
        // immediately before changing the pair so neither half is applied to
        // a turn that started while credentials were being inspected.
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (agent.state.isStreaming) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "The model cannot change while Pi is running.",
          };
        }
        if (rewritingContext)
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "The context is being compacted.",
          };
        // Opaque state is model-bound. Reconstruct from durable original history
        // on a model switch rather than pretending its placeholder is a summary.
        // The new pair's own resolved route decides: the same catalog model
        // reached through OAuth or an endpoint override cannot replay a
        // checkpoint the metered public API minted (VC-331).
        const selectedRoute = await nativeCompactionAvailable(selected, models, spec.signal);
        await rewritingTheContext(async () => {
          const { path } = compactionPathForModel(
            await conversationBranch(),
            selected,
            selectedRoute,
          );
          const latest = path.findLast((entry) => entry.type === "compaction");
          nativeCompactionState =
            latest?.type === "compaction"
              ? providerCompactionFromDetails(latest.details)
              : undefined;
          agent.state.messages = withSystemHead(head, contextMessages(path));
          agent.state.model = selected;
          agent.state.thinkingLevel = selection.reasoningLevel;
        });
        return { kind: "selected" };
      },

      async retry(commandId): Promise<DeliveryOutcome> {
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (agent.state.isStreaming) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "Pi is already running.",
          };
        }
        observationDelivery.consumeFailure();
        const outcome = await retryFailedTurn(commandId ?? null);
        await settleRun();
        const failed = observationDelivery.consumeFailure();
        if (failed !== undefined) throw failed;
        return outcome;
      },

      /**
       * The third producer of a compaction, and the only one anybody asked
       * for.
       *
       * It runs the same {@link compactContext} the other two run, on the same
       * durable path, and emits the same observation with `manual` on it. What
       * is new here is only that someone is waiting for an answer, so every
       * way of not compacting becomes a refusal with a reason rather than a
       * fact filed to the ledger and nothing else.
       *
       * **Refused while Pi is running, never queued.** Rewriting the context
       * under a live turn corrupts the turn in flight, which is why automatic
       * maintenance uses idle or between-request boundaries. Queueing it instead
       * would answer a different question than the one asked: by the time the
       * turn ended the reply would already be in the context, so what ran
       * would not be the compaction the person requested when they requested
       * it. A refusal they can act on — stop the turn, or wait — is the honest
       * answer.
       *
       * **The switch does not reach here.** `autoCompaction` is Pi's
       * `enabled`, read by `shouldCompact` and by nothing else, so switching
       * it off cannot block this any more than it blocks overflow recovery.
       * That is the behaviour this wants: off means "do not interrupt me to
       * make room", and a person typing `/compact` is not being interrupted.
       *
       * The attachment's own signal bounds it, like {@link compactBeforeTurn}:
       * no turn is running, so there is no turn whose stop could mean this.
       */
      async compact(instructions): Promise<CompactionRequestOutcome> {
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        // Two ways for the context not to be free, and they are one question
        // asked of two owners: Pi is consuming the array, or a compaction is
        // already replacing it. Asked synchronously, before anything is
        // awaited, so the answer cannot go stale between the check and the act
        // — which is the whole failure this guard exists to prevent.
        //
        // One refusal, two sentences. A person told "while Pi is running" about
        // a Session that is plainly idle would go looking for a turn that is not
        // there; the wait they are actually in is a summary, and it ends.
        if (agent.state.isStreaming) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "The context cannot be compacted while Pi is running.",
          };
        }
        if (rewritingContext) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "This context is already being compacted.",
          };
        }
        const outcome = await rewritingTheContext(async () =>
          compactContext({
            reason: "manual",
            path: await conversationBranch(),
            signal: spec.signal,
            ...(instructions === undefined ? {} : { instructions }),
          }),
        );
        if (outcome.kind === "compacted") return { kind: "compacted" };
        return outcome.kind === "skipped"
          ? {
              kind: "rejected",
              reason: "nothing-to-compact",
              message: "There is nothing left to summarize.",
            }
          : { kind: "rejected", reason: "summary-failed", message: outcome.message };
      },

      async interrupt(): Promise<void> {
        interruptTurn();
        await agent.waitForIdle();
      },

      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        // Withdrawn attachments retry nothing. Cleared rather than tested for at
        // the drain: a decision to retry that was taken while this ran would
        // otherwise start a Pi run against an environment already cleaned up.
        autoRetryPending = false;
        spec.signal?.removeEventListener("abort", onAbort);
        interruptTurn();
        await agent.waitForIdle();
        await detachedRunSettled;
        unsubscribe?.();
        unsubscribe = undefined;
        stopWatchingResume?.();
        stopWatchingResume = undefined;
        streamSupervisor.dispose();
        // Cleanup runs on an uncancellable context on purpose: this is the
        // path taken precisely when the attachment's own signal has aborted,
        // and cancellation must not be able to stop the release of what it
        // just abandoned.
        await ownedToolEnv.cleanup(piContext());
        toolEnv = undefined;
        await removeScratch().catch(
          /* v8 ignore next -- a scratch directory that will not go is the OS temp sweep's. */
          () => undefined,
        );
        await sidecarEnv.cleanup(piContext());
        await observe({ kind: "attachment", state: "closed" });
      },

      async reconcile(cursor) {
        // `asc`, which is what 0.85.0 renamed the session-wide scan's
        // `oldestFirst` to. The branch scan below still spells it the old way;
        // the two orderings are the same order under two vocabularies.
        const entries = await sidecar.findEntries({ order: "asc" }, piContext());
        const cursorIndex =
          cursor === null ? -1 : entries.findIndex((entry) => entry.id === cursor);
        if (cursor !== null && cursorIndex < 0) {
          throw new Error("Pi recovery cursor is not present in the owned sidecar.");
        }
        const allMarkers = entries
          .filter((entry): entry is CustomEntry => entry.type === "custom")
          .map(recoveredObservation)
          .filter(
            (observation): observation is NonNullable<ReturnType<typeof recoveredObservation>> =>
              observation !== null,
          );
        assertUniqueAcceptedCommands(allMarkers);
        const afterCursorIds = new Set(entries.slice(cursorIndex + 1).map(({ id }) => id));
        const markers = allMarkers.filter((marker) => afterCursorIds.has(marker.recoveryCursor));
        const observations = markers
          .filter(
            (
              marker,
            ): marker is RecoverableObservation & {
              occurredAt: number;
              recoveryCursor: string;
            } => marker.kind !== "command-accepted",
          )
          .filter(
            (observation) =>
              observation.kind !== "message-settled" ||
              !disagreedSettledEntryIds.has(observation.message.entryId),
          );
        const receipts = [
          ...new Map(
            allMarkers
              .filter(
                (
                  marker,
                ): marker is AcceptedCommandMarker & {
                  occurredAt: number;
                  recoveryCursor: string;
                } => marker.kind === "command-accepted",
              )
              .map((marker) => [
                marker.commandId,
                { commandId: marker.commandId, acceptedAt: marker.occurredAt },
              ]),
          ).values(),
        ];
        return {
          cursor: markers.at(-1)?.recoveryCursor ?? cursor,
          observations,
          ...(receipts.length > 0 ? { receipts } : {}),
        };
      },

      recovery,
    };

    spec.signal?.addEventListener("abort", onAbort);
    if (isAborted(spec.signal)) {
      onAbort();
    }

    await observe({
      kind: "attachment",
      state: spec.recovery === undefined ? "started" : "recovered",
      recovery,
    });
    if (carryAttention !== undefined) await commitObservation(carryAttention);
    return handle;
  } catch (error) {
    if (abortListener !== undefined) {
      spec.signal?.removeEventListener("abort", abortListener);
    }
    unsubscribe?.();
    stopWatchingResume?.();
    await toolEnv?.cleanup(piContext()).catch(
      /* v8 ignore next -- owned-environment cleanup is best effort after a failed attach. */
      () => undefined,
    );
    await removeScratch().catch(
      /* v8 ignore next -- scratch removal is best effort after a failed attach. */
      () => undefined,
    );
    if (createdSidecar && sidecarPath !== undefined) {
      await sidecarEnv.remove(sidecarPath, { force: true }, piContext()).catch(
        /* v8 ignore next -- sidecar deletion is best effort after a failed attach. */
        () => undefined,
      );
    }
    await sidecarEnv.cleanup(piContext()).catch(
      /* v8 ignore next -- sidecar cleanup is best effort after a failed attach. */
      () => undefined,
    );
    throw error;
  }
}
