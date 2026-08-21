/**
 * The Pi-backed Agent Runtime wearing the Session Engine's native-adapter face.
 *
 * This is a desktop-private facade, not a second executor port. `@volli/agent-runtime`
 * already speaks product vocabulary; what it does not speak is the durable
 * Session's own seam — attachments, delivery receipts, commands — so everything
 * here is translation and nothing here is policy. There is one manifest id and
 * one profile because there is one executor: no registry, no catalog, no profile
 * spread to grow into.
 *
 * Observations are the exception, and they cross untranslated: `RuntimeObservation`
 * is the only observation vocabulary, and turning one into a Session fact is
 * `@volli/session-engine`'s job, because a durable id and a transcript address
 * are decisions about history rather than about Pi. What this file still owes
 * that path is the two suppressions in {@link PiBinding.#observe}, which are
 * facts about the binding's own lifecycle that no other layer can see.
 *
 * Two things the two contracts genuinely disagree about, and how they join:
 *
 * 1. **Identity.** `NativeAttachmentSpec` carries a Session and a directory,
 *    and the runtime needs a Role, a project, possibly a Ticket, a root Thread
 *    and a Runtime Brief. None of those are derivable from a directory, and
 *    reading SQLite here would drag Electron-adjacent state into a module the
 *    tests run in plain Node — so identity arrives through
 *    {@link PiAdapterOptions.resolveRuntimeContext}, which main implements over
 *    the same composition the `volli ticket brief` CLI verb uses. A ticketless
 *    Session is a Role, not a missing Ticket: it resolves a project Brief and
 *    attaches. What still fails the attach is a Session with no recorded model
 *    or no Brief to give, rather than starting an agent that would be told
 *    nothing about why it exists.
 *
 * 2. **Interrupt.** Aborting the runtime signal is how an attachment *ends* —
 *    Pi's abort listener latches the attachment cancelled and every later
 *    submit is rejected as closed. An interrupted turn is not an ended Session,
 *    and the Session Engine keeps the binding live across one, so
 *    `executor.interrupt` goes to the handle's own `interrupt()` and the
 *    AbortController stays what `release` pulls.
 *
 * 3. **Asking.** The runtime blocks a tool call on a person and waits with no
 *    timeout of its own; the Session seam carries commands one way and receipts
 *    the other, and has no verb that means "wait here until somebody answers".
 *    The join is a parked promise. {@link PiBinding.#ask} announces the question
 *    as an `interaction` observation, keeps its resolvers in a map, and returns
 *    a promise that {@link PiBinding.dispatch} settles when the answering
 *    command comes back the other way. The interaction id is the whole of what
 *    the two halves share — the runtime names a tool call and a Session command
 *    names an interaction — which is why {@link askInteractionId} derives one
 *    from the other and why that derivation is frozen. What is deliberately
 *    absent is durability: the question, the answer and the withdrawal are all
 *    Session facts, and this file emits observations for the Engine to write
 *    rather than writing any of them itself.
 *
 *    Two kinds of question take that path, parked in two maps under two frozen
 *    prefixes. An escalation is the runtime's own policy asking whether to stand
 *    aside, and its answer is read back through `askChoice` as a verdict; the
 *    model's own question ({@link PiBinding.#askUser}) carries the model's
 *    options and hands the answer back untouched, because reading it would mean
 *    deciding what one of the model's own ids meant. One prefix serving both
 *    would let either answer end the other's wait.
 */

import { createPiAgentRuntime, type PiRuntimeHostOptions } from "@volli/agent-runtime";
import type {
  BindingHandle,
  DeliveryReceipt,
  HarnessCommand,
  NativeAttachmentSpec,
  NativeHarnessAdapter,
  NativeRuntimeIdentity,
  ObservationSink,
  Reconciliation,
  ReleaseReason,
} from "@volli/session-engine";
import { NativeAttachmentError } from "@volli/session-engine";
import {
  appendPromptResources,
  askChoice,
  askOffer,
  askInteractionId,
  askUserInteractionId,
  DEFAULT_INTERACTION_PROMPT_ID,
  errorMessage,
  readSkillResources,
  type AgentRuntime,
  type CompactionRequestOutcome,
  type DeliveryOutcome,
  type ModelSelection,
  type ModelSelectionOutcome,
  type PromptResource,
  type RuntimeAskChoice,
  type RuntimeAskRequest,
  type RuntimeAskUserRequest,
  type RuntimeAttachmentHandle,
  type RuntimeObservation,
  type RuntimeRecoveryRef,
  type SessionInteractionOption,
  type SessionInteractionResolution,
  type SessionNativeDetail,
  type SessionNativeReference,
  type SessionRuntimeSpec,
  type UIMessageLike,
  type WorkLocationKind,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { SessionWebPorts } from "../web/ports";
import type { TurnAttachments } from "../turn-attachments";
import { STRUCTURED_ADAPTER_ID } from "./sessions";

/**
 * The one adapter id. Pi is the structured product's single target executor.
 *
 * Aliased rather than re-declared, and the boot sweep is why. It retires every
 * local open attachment whose `adapterId` is not
 * {@link STRUCTURED_ADAPTER_ID} — so two literals that merely happen to read
 * the same would, the day one is renamed, durably close every live Pi
 * attachment in the database on the next launch. That predicate is
 * fail-destructive, so the agreement is held by the compiler rather than by
 * whoever edits second.
 */
export const PI_ADAPTER_ID = STRUCTURED_ADAPTER_ID;

/**
 * The namespace every durable id derived from Pi's observations is minted under.
 *
 * A frozen literal, not `PI_ADAPTER_ID`: the two happen to read the same and
 * mean different things — one names the executor an attachment was opened by,
 * the other prefixes ids already written into history. Tying them together would
 * make renaming the adapter silently re-key every fact on disk.
 */
const PI_DURABLE_ID_NAMESPACE = "pi";

/** Pi's npm home and pinned release; both are recorded in `packages/agent-runtime/UPSTREAM.md`. */
const PI_RUNTIME_PACKAGE = "@earendil-works/pi-agent-core";
const PI_RUNTIME_VERSION = "0.84.1";

const PI_ADAPTER_VERSION = "0.0.1";

/**
 * Static, because there is nothing to interrogate: Pi is a library this process
 * already holds, not a binary on a PATH that may be missing, stale or untrusted.
 * These three strings are recorded in every attachment's durable binding
 * envelope, so they must stay exactly what past builds wrote.
 */
const PI_RUNTIME_IDENTITY: NativeRuntimeIdentity = {
  path: PI_RUNTIME_PACKAGE,
  version: PI_RUNTIME_VERSION,
  fingerprint: `npm:${PI_RUNTIME_PACKAGE}@${PI_RUNTIME_VERSION}`,
};

/**
 * The coding tools this slice loads — with no gate and no sandbox, the only
 * bound. Exported for the `prompt.baseline` diagnostic, which must price the
 * authority layer over the same tool list a real attach names.
 */
export const PI_TOOLS = { tools: ["read", "edit", "write", "execute"] } as const;

/** Everything about a Session that a directory cannot tell the runtime. */
interface PiRuntimeContextFields {
  projectId: string;
  /**
   * The Session's root Thread, from `sessionRootThreadId` and nowhere else.
   *
   * Pi writes this into its recovery sidecar and **throws** on recovery when
   * what it finds there does not match what it was handed. The Session Engine
   * files this Session's transcript under the same string, so a second
   * derivation would not quietly disagree about an address — it would fail
   * every existing Session's attach.
   */
  rootThreadId: string;
  /** The generated Runtime Brief; the runtime prepends it to the first user message. */
  brief: string;
  /** Durable product policy selected before this attachment starts. */
  model: ModelSelection;
  /**
   * Which tree the Session runs in. Not derivable from the Role here: a Ticket
   * that never took a worktree is bound to the project's Main checkout by
   * `location.ts`, and policy that assumed otherwise would treat a person's
   * uncommitted work as a disposable branch.
   *
   * Resolved but unread while Pi runs ungated — it exists only to key policy,
   * and no Authority Snapshot is built. Kept resolved because the resolver is
   * the correct answer to a question the re-architecture still asks.
   */
  location: WorkLocationKind;
  /**
   * The skills this Session was explicitly started with, read from its own
   * durable `prompt-resources` record — never from disk at attach time, so a
   * recovery re-attach composes the exact system prompt the first attach did.
   * Empty for the ordinary Session, and empty stays empty: nothing is ever
   * injected that the start did not name.
   */
  promptResources: readonly PromptResource[];
}

/**
 * The Role a Session attaches under, resolved with the identity it implies.
 *
 * Mirrors the runtime's own identity union rather than carrying an optional
 * Ticket: "ticketless" is what a project Session *is*, and a resolver that
 * returned a Ticket Session with a null Ticket would not typecheck here.
 */
export type PiRuntimeContext =
  | (PiRuntimeContextFields & { role: "ticket"; ticketId: string })
  | (PiRuntimeContextFields & { role: "project"; ticketId: null });

export interface PiAdapterOptions {
  /**
   * Directory that owns every attachment's Pi recovery sidecar. Main resolves
   * it from Electron's `userData`; this module stays Electron-free so its tests
   * run in plain Node.
   */
  sessionDataDir: string;
  /** Resolves durable Session identity to the Role it runs under; `null` when it cannot. */
  resolveRuntimeContext: (sessionId: string) => Promise<PiRuntimeContext | null>;
  /** Injectable Pi model collection, for deterministic tests and host-owned credentials. */
  models?: PiRuntimeHostOptions["models"];
  /**
   * The credential store behind {@link PiAdapterOptions.models}. Main passes the
   * pair so Model Access can tell a provider configured from a stored
   * credential apart from one reading an ambient environment variable — the
   * question that decides whether signing out has anything to remove.
   */
  credentials?: PiRuntimeHostOptions["credentials"];
  /**
   * Injectable execution environment factory. Defaults to Pi's own
   * `piExecutionEnv`; main supplies one that prepends Volli's CLI bin dir
   * onto a Session's `PATH`, so `volli` resolves inside a structured turn's
   * shell tool whether or not the background install's `~/.local/bin/volli`
   * link is reachable yet.
   */
  executionEnvFactory?: PiRuntimeHostOptions["executionEnvFactory"];
  /**
   * The web ports this profile's Web Access setting amounts to, resolved once
   * per attachment.
   *
   * Optional, and its absence means a Session is offered no web tool — the same
   * thing an answer of `{}` means, because a profile that configured no
   * provider and a build that wired no resolver are the same situation from the
   * model's side. Main implements it over the settings owner, which is the only
   * thing in the app that reads the stored credential.
   *
   * Called at attach, not per turn: what a Session may reach is pinned when it
   * starts, exactly as its Authority Snapshot would be, so a Settings change
   * never lands mid-turn.
   *
   * It must not throw. This runs on the attach path, so a failure to work out
   * what web access amounts to would cost the Session its attachment rather
   * than its web tools — an unreadable credential is a Session with no web,
   * which is what `WebAccessSettings.resolve` answers instead of raising.
   */
  resolveWebPorts?: () => SessionWebPorts;
  /**
   * The model the runtime's own background work — context compaction's summary
   * — runs on. Purpose in, selection out: this module speaks Sessions, and
   * mapping Model Access's `utility` purpose onto a stored default is the
   * composition root's job, in the one place it already resolves the others.
   */
  utilityModel?: PiRuntimeHostOptions["utilityModel"];
  /**
   * The compaction policy every Session is run under — the global automatic
   * switch and the per-model reserves. Read per compaction rather than per
   * attach, for the reason {@link PiAdapterOptions.utilityModel} is: a Session
   * outlives the settings change that retunes it.
   */
  compactionPolicy?: PiRuntimeHostOptions["compactionPolicy"];
  /** Injectable runtime factory. Defaults to the real Pi-backed runtime. */
  createRuntime?: (options: PiRuntimeHostOptions) => AgentRuntime;
  /**
   * Materializes a turn's attachments and reads back what the model needs
   * (VC-50). Injected, so this module keeps knowing nothing about the database
   * or the Blob store; main supplies the real one. Absent means a Session whose
   * messages carry no files, which is every message a test sends.
   */
  prepareTurnAttachments?: (
    message: UIMessageLike,
    owner: { sessionId: string; ticketId: string | null; workspacePath: string },
  ) => Promise<TurnAttachments>;
  now?: () => number;
}

/** The rejection codes a caller can act on, per runtime rejection reason. */
const REJECTION_CODES = {
  "busy-unsupported": "PI_BUSY",
  closed: "PI_ATTACHMENT_CLOSED",
  "replace-unsupported": "PI_REPLACE_UNSUPPORTED",
  "retry-unavailable": "PI_RETRY_UNAVAILABLE",
} as const satisfies Record<Extract<DeliveryOutcome, { kind: "rejected" }>["reason"], string>;

const MODEL_SELECTION_REJECTION_CODES = {
  "busy-unsupported": "PI_BUSY",
  closed: "PI_ATTACHMENT_CLOSED",
  "model-unavailable": "PI_MODEL_UNAVAILABLE",
  "reasoning-unsupported": "PI_REASONING_UNSUPPORTED",
} as const satisfies Record<Extract<ModelSelectionOutcome, { kind: "rejected" }>["reason"], string>;

/**
 * Every way an explicit compaction does not happen, as a code the receipt
 * carries. Two of them are not failures at all — a context with nothing left
 * to summarize, and a summary the provider would not produce — and they are
 * refusals here for the reason `CompactionRequestOutcome` gives: a person
 * asked, so every answer has to be one.
 */
const COMPACTION_REJECTION_CODES = {
  "busy-unsupported": "PI_BUSY",
  closed: "PI_ATTACHMENT_CLOSED",
  "nothing-to-compact": "PI_NOTHING_TO_COMPACT",
  "summary-failed": "PI_COMPACTION_FAILED",
} as const satisfies Record<
  Extract<CompactionRequestOutcome, { kind: "rejected" }>["reason"],
  string
>;

function piRecoveryRef(spec: NativeAttachmentSpec): RuntimeRecoveryRef | undefined {
  if (spec.continuity !== "native_resume") return undefined;
  const detail = spec.native?.detail;
  if (
    spec.native === null ||
    detail === null ||
    Array.isArray(detail) ||
    typeof detail !== "object"
  ) {
    throw new Error("Pi recovery metadata is missing or invalid.");
  }
  const record = detail as { readonly [key: string]: SessionNativeDetail };
  if (
    record["runtime"] !== "pi" ||
    typeof record["sessionId"] !== "string" ||
    typeof record["sessionFilePath"] !== "string" ||
    spec.native.id !== record["sessionId"]
  ) {
    throw new Error("Pi recovery metadata does not match the persisted attachment.");
  }
  return {
    runtime: "pi",
    sessionId: record["sessionId"],
    sessionFilePath: record["sessionFilePath"],
  };
}

function recoveryEntryId(cursor: SessionNativeDetail | null): string | null {
  if (cursor === null || Array.isArray(cursor) || typeof cursor !== "object") return null;
  const entryId = (cursor as { readonly [key: string]: SessionNativeDetail })["entryId"];
  if (typeof entryId !== "string") {
    throw new Error("Pi recovery cursor is missing its sidecar entry id.");
  }
  return entryId;
}

export interface PiRuntimeHost {
  readonly adapter: NativeHarnessAdapter;
  inspectModelAccess: AgentRuntime["inspectModelAccess"];
  /** The utility-completion door (VC-81 auto-titling), passed through unchanged. */
  completeUtility: AgentRuntime["completeUtility"];
}

/** Main-owned singular runtime host; the native adapter remains private migration scaffolding. */
export function createPiRuntimeHost(options: PiAdapterOptions): PiRuntimeHost {
  const now = options.now ?? Date.now;
  const create = options.createRuntime ?? createPiAgentRuntime;
  const runtime = create({
    sessionDataDir: options.sessionDataDir,
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.executionEnvFactory === undefined
      ? {}
      : { executionEnvFactory: options.executionEnvFactory }),
    ...(options.utilityModel === undefined ? {} : { utilityModel: options.utilityModel }),
    ...(options.compactionPolicy === undefined
      ? {}
      : { compactionPolicy: options.compactionPolicy }),
  });

  return {
    adapter: piNativeAdapter(options, runtime, now),
    inspectModelAccess: (input) => runtime.inspectModelAccess(input),
    completeUtility: (input) => runtime.completeUtility(input),
  };
}

/** @deprecated Main should own {@link createPiRuntimeHost}; retained for isolated adapter tests. */
export function createPiNativeAdapter(options: PiAdapterOptions): NativeHarnessAdapter {
  return createPiRuntimeHost(options).adapter;
}

function piNativeAdapter(
  options: PiAdapterOptions,
  runtime: AgentRuntime,
  now: () => number,
): NativeHarnessAdapter {
  return {
    id: PI_ADAPTER_ID,
    durableIdNamespace: PI_DURABLE_ID_NAMESPACE,
    adapterVersion: PI_ADAPTER_VERSION,
    runtime: PI_RUNTIME_IDENTITY,

    async attach(spec: NativeAttachmentSpec, sink: ObservationSink): Promise<BindingHandle> {
      let recovery: RuntimeRecoveryRef | undefined;
      try {
        recovery = piRecoveryRef(spec);
      } catch (error) {
        throw new NativeAttachmentError(
          errorMessage(error),
          "PI_RECOVERY_FAILED",
          "adapter_unrecoverable",
        );
      }
      const context = await options.resolveRuntimeContext(spec.sessionId);
      if (context === null) {
        // Thrown, not emitted: the runtime discards this attach's sink when the
        // attach rejects, so the error message is the only channel that
        // survives — and it becomes the `attach_failed` receipt's detail, which
        // is where a user looks.
        throw new NativeAttachmentError(
          "Pi requires a Session with a selected model and Runtime Brief.",
          "PI_CONFIGURATION_INVALID",
          "configuration_invalid",
        );
      }
      const binding = new PiBinding({
        spec,
        sink,
        context,
        recovery,
        now,
        web: options.resolveWebPorts?.() ?? {},
        prepareTurnAttachments: options.prepareTurnAttachments,
      });
      try {
        binding.bind(await runtime.startSession(binding.runtimeSpec()));
      } catch (error) {
        throw new NativeAttachmentError(
          errorMessage(error),
          recovery === undefined ? "PI_CONFIGURATION_INVALID" : "PI_RECOVERY_FAILED",
          recovery === undefined ? "configuration_invalid" : "adapter_unrecoverable",
        );
      }
      return binding;
    },
  };
}

// The `ask:` / `ask-user:` interaction id derivations are frozen durable
// segments and live in @volli/shared beside the interaction vocabulary, so the
// renderer that correlates on them and this adapter that mints them cannot
// drift. See `askInteractionId` / `askUserInteractionId` there.

/**
 * What the question says, in the two shapes an escalation arrives in.
 *
 * A refusal a person may overrule is a question about this one call; a refusal
 * that stands whatever the answer is a statement that it did not run. The
 * difference is not tone, it is the options: {@link askOffer} answers the second
 * case with "Keep working" and "Stop the turn", neither of which grants
 * anything, so a title phrased as a permission request would describe controls
 * that do not exist. The refusing rule's own words are the explanation and go in
 * `detail`; the title only has to name the call.
 */
function askTitle(request: RuntimeAskRequest): string {
  return request.overridable
    ? `Allow this ${request.tool} call?`
    : `Blocked this ${request.tool} call`;
}

/**
 * What an answer meets when nothing is waiting for it, said once because both
 * ends of the resolve path can reach it: the question was never this
 * attachment's, or it stopped being anyone's while the answer was in flight.
 */
const UNKNOWN_INTERACTION =
  "Nothing is waiting on this question: it was answered already, it was withdrawn, or it was asked by an earlier attachment.";

/** One question in front of a person, and everything needed to stop asking it. */
interface ParkedAsk {
  /** The request as the runtime made it; an answer is read back against it. */
  request: RuntimeAskRequest;
  settle: PromiseWithResolvers<RuntimeAskChoice>;
  /** Drops this question's listener from the runtime's withdrawal signal. */
  forget: () => void;
}

/**
 * One of the model's own questions, parked the same way and answered differently.
 *
 * It keeps no request. An escalation holds one because `askChoice` reads the
 * answer back against it; there is nothing to read back against here, and
 * keeping the request anyway would be an invitation to start.
 */
interface ParkedAskUser {
  settle: PromiseWithResolvers<SessionInteractionResolution>;
  /** Drops this question's listener from the runtime's withdrawal signal. */
  forget: () => void;
}

interface PiBindingOptions {
  spec: NativeAttachmentSpec;
  sink: ObservationSink;
  context: PiRuntimeContext;
  recovery: RuntimeRecoveryRef | undefined;
  now: () => number;
  /** What this Session may reach on the web, already resolved. `{}` is "nothing". */
  web: SessionWebPorts;
  prepareTurnAttachments: PiAdapterOptions["prepareTurnAttachments"];
}

class PiBinding implements BindingHandle {
  readonly #spec: NativeAttachmentSpec;
  readonly #sink: ObservationSink;
  readonly #context: PiRuntimeContext;
  readonly #recovery: RuntimeRecoveryRef | undefined;
  readonly #now: () => number;
  readonly #web: SessionWebPorts;
  readonly #prepareTurnAttachments: PiAdapterOptions["prepareTurnAttachments"];
  readonly #abort = new AbortController();
  /** Questions the runtime is parked on, by the interaction id they were asked under. */
  readonly #asked = new Map<string, ParkedAsk>();
  /** The model's own questions, kept apart because their answers are read differently. */
  readonly #askedUser = new Map<string, ParkedAskUser>();
  #handle: RuntimeAttachmentHandle | null = null;
  #native: SessionNativeReference = { id: null, detail: null };
  /**
   * Set the moment {@link PiBinding.release} begins, and read by every command
   * path instead of {@link PiBinding.#released}.
   *
   * Release cannot set `#released` until it has announced its withdrawals, so
   * the two flags exist to say different things: this one closes the door on new
   * work, `#released` closes it on new facts. One flag could only do both by
   * accepting a command onto a handle that is already closing — a durable
   * `accepted` receipt for a message Pi will never process.
   */
  #releasing = false;
  #released = false;

  constructor(options: PiBindingOptions) {
    this.#spec = options.spec;
    this.#sink = options.sink;
    this.#context = options.context;
    this.#recovery = options.recovery;
    this.#now = options.now;
    this.#web = options.web;
    this.#prepareTurnAttachments = options.prepareTurnAttachments;
  }

  /**
   * This turn's attachments, or nothing when the host wired no preparer and
   * when the message carries no files. Reading `directory` off the spec keeps
   * the materialize target the same tree the agent is actually working in.
   */
  async #prepareAttachments(message: UIMessageLike): Promise<TurnAttachments> {
    const prepare = this.#prepareTurnAttachments;
    if (prepare === undefined) return { note: "", images: [] };
    return prepare(message, {
      sessionId: this.#spec.sessionId,
      ticketId: this.#context.ticketId,
      workspacePath: this.#spec.directory,
    });
  }

  get native(): SessionNativeReference {
    return this.#native;
  }

  runtimeSpec(): SessionRuntimeSpec {
    const context = this.#context;
    const identity = {
      sessionId: this.#spec.sessionId,
      rootThreadId: context.rootThreadId,
      attachmentId: this.#spec.attachmentId,
      projectId: context.projectId,
    };
    return {
      identity:
        context.role === "ticket"
          ? { ...identity, role: "ticket", ticketId: context.ticketId }
          : { ...identity, role: "project", ticketId: null },
      // The directory the Session Engine PREPARED: for a worktree ticket the
      // isolated checkout — never the main one — and for a ticketless Session
      // the project root, which is the only place it was ever going to run.
      workspacePath: this.#spec.directory,
      venue: "local",
      model: this.#context.model,
      // No `authority`: Volli runs Pi ungated, so the runtime installs no gate
      // and the rule pack never runs. The Snapshot is omitted rather than
      // neutered — see docs/plans/authority-two-axis-rearchitecture.md, which
      // replaces the policy this adapter used to pin and keeps the mechanism,
      // including the `ask` port still wired below.
      brief: { text: this.#context.brief },
      // The seam `composeSystemPrompt` renders as delimited RESOURCE sections.
      // Omitted rather than empty when the Session named no skills, so a spec
      // with no resources is a spec with no resources field — same shape the
      // runtime's own tests pin.
      ...(context.promptResources.length === 0 ? {} : { promptResources: context.promptResources }),
      tools: { tools: [...PI_TOOLS.tools] },
      ...(this.#recovery === undefined ? {} : { recovery: this.#recovery }),
      signal: this.#abort.signal,
      observer: (observation) => this.#observe(observation),
      ask: (request, signal) => this.#ask(request, signal),
      // Always wired, which is what puts the ask tool in front of the model: a
      // desktop Session always has somewhere to put a question, because the
      // chat surface asking it is the same surface that started the turn.
      askUser: (request, signal) => this.#askUser(request, signal),
      // The web ports are the opposite case and spread rather than assigned, so
      // a profile with no Web Access configured produces a spec with no
      // `webFetch` and no `webSearch` FIELD — not one set to undefined. The
      // runtime registers each tool on the field's presence, so absence is what
      // keeps the network out of a Session's vocabulary entirely.
      ...this.#web,
    };
  }

  /**
   * Adopt the live attachment, and with it the recovery reference.
   *
   * The reference is the whole of what crosses back out of Pi: a runtime tag, a
   * Pi Session id, and the sidecar path Session 4 reopens. No credential, no
   * transport detail, nothing a later reader could mistake for Session truth.
   */
  bind(handle: RuntimeAttachmentHandle): void {
    this.#handle = handle;
    const recovery = handle.recovery;
    if (recovery === undefined) return;
    this.#native = {
      id: recovery.sessionId,
      detail: {
        runtime: recovery.runtime,
        sessionId: recovery.sessionId,
        sessionFilePath: recovery.sessionFilePath,
      },
    };
  }

  async dispatch(command: HarnessCommand): Promise<DeliveryReceipt> {
    const handle = this.#handle;
    if (handle === null || this.#releasing) {
      return this.#rejected(
        command.commandId,
        "PI_ATTACHMENT_CLOSED",
        "This attachment is closed.",
      );
    }
    switch (command.kind) {
      case "message.submit":
        return this.#submit(handle, command);
      case "model.select":
        try {
          const outcome = await handle.selectModel(command.selection);
          return outcome.kind === "selected"
            ? this.#accepted(command.commandId)
            : this.#rejected(
                command.commandId,
                MODEL_SELECTION_REJECTION_CODES[outcome.reason],
                outcome.message,
              );
        } catch {
          return this.#rejected(
            command.commandId,
            "PI_MODEL_SELECTION_FAILED",
            "The model policy could not be applied. Retry.",
          );
        }
      case "executor.interrupt":
        try {
          await handle.interrupt();
          return this.#accepted(command.commandId);
        } catch (error) {
          return this.#unknown(command.commandId, error);
        }
      case "executor.retry":
        try {
          const outcome = await handle.retry(command.commandId);
          return outcome.kind === "delivered"
            ? this.#accepted(command.commandId)
            : this.#rejected(command.commandId, REJECTION_CODES[outcome.reason], outcome.message);
        } catch (error) {
          return this.#unknown(command.commandId, error);
        }
      case "context.compact":
        try {
          // The compaction itself is announced by the runtime, as the same
          // Session Event its two automatic siblings emit. What comes back
          // here is only whether the request was served, which is this
          // receipt's whole job.
          const outcome = await handle.compact(command.instructions ?? undefined);
          return outcome.kind === "compacted"
            ? this.#accepted(command.commandId)
            : this.#rejected(
                command.commandId,
                COMPACTION_REJECTION_CODES[outcome.reason],
                outcome.message,
              );
        } catch (error) {
          return this.#unknown(command.commandId, error);
        }
      case "interaction.resolve": {
        // Looked up WITHOUT claiming, because the answer has to be a Session
        // fact before the question stops waiting — see the emit below.
        if (!this.#awaiting(command.interaction.id)) {
          return this.#rejected(command.commandId, "PI_INTERACTION_UNKNOWN", UNKNOWN_INTERACTION);
        }
        // The answer is announced from here, and it has to be: the Session
        // Engine writes `interaction.resolved` from THIS observation and from
        // nowhere else. The delivery receipt this returns is a receipt, not a
        // fact — `projectSession` folds it into `receipts` and never looks at
        // its `result` — so a Session whose adapter stayed silent would settle
        // the parked call, resume the turn, and leave the question active
        // forever: a card that cannot be cleared, `sessionAwaitsUser()` stuck
        // true, and every later question hidden behind it.
        //
        // Emitted BEFORE the ask is settled, mirroring {@link PiBinding.#ask},
        // which refuses to park on a question the Session could not record. The
        // same bargain read the other way: an answer the Session could not
        // record must not be reported as delivered, because the turn would
        // resume on a decision history has no account of.
        try {
          await this.#observe({
            kind: "interaction",
            state: "resolved",
            occurredAt: this.#now(),
            interactionId: command.interaction.id,
            resolution: command.resolution,
          });
        } catch (error) {
          // Nothing was claimed, so the question is still parked and still
          // active: the card stays answerable and pressing it again retries.
          // That recoverable state is the whole reason the claim happens after
          // the emit — claiming first would leave the ask unparked AND
          // unrecorded, and the retry would meet PI_INTERACTION_UNKNOWN with the
          // turn blocked behind a card nothing can ever answer.
          return this.#rejected(
            command.commandId,
            "PI_INTERACTION_NOT_RECORDED",
            `This answer could not be recorded, so it was not delivered. Try again: ${errorMessage(error)}`,
          );
        }
        // Lost the claim while the fact was committing — a withdrawal or a
        // release got here first. History keeps the resolution, which is true:
        // a person did answer. What is no longer true is that the runtime is
        // waiting for it, so this reports a decision that reached nobody.
        if (!this.#settleAnswer(command.interaction.id, command.resolution)) {
          return this.#rejected(command.commandId, "PI_INTERACTION_UNKNOWN", UNKNOWN_INTERACTION);
        }
        return this.#accepted(command.commandId);
      }
    }
  }

  async reconcile(cursor: Parameters<BindingHandle["reconcile"]>[0]): Promise<Reconciliation> {
    const handle = this.#handle;
    if (handle === null || this.#releasing) {
      return { cursor, observations: [], receipts: [] };
    }
    const entryId = recoveryEntryId(cursor);
    const replay = await handle.reconcile(entryId);
    return {
      // Pi's own history, offered whole. Which of these become Session facts,
      // and under what ids, is the Engine's replay translation to decide — the
      // same decision it makes for the live pass, which is what keeps one fact
      // seen twice from being recorded twice.
      cursor: replay.cursor === null ? cursor : { entryId: replay.cursor },
      observations: replay.observations,
      receipts: (replay.receipts ?? []).map(({ commandId, acceptedAt }) => ({
        commandId,
        status: "accepted",
        acceptedAt,
        native: this.#native,
      })),
    };
  }

  /**
   * The Session cancelled a question the runtime is still parked on.
   *
   * Announces nothing, and that is the whole difference between this and every
   * other way an ask ends. Cancelling is the Engine's own durable act — it
   * writes `interaction.cancelled` before it calls this, because the fact is
   * that nobody was told an answer — so a second announcement from here would
   * record one withdrawal twice.
   */
  async withdrawInteraction(interactionId: string): Promise<void> {
    await this.#withdraw(interactionId, false);
  }

  /**
   * End the live attachment, never the Session.
   *
   * The sink closes first: the Session Engine writes `attachment.closed` itself
   * once this resolves, and Pi's own close observation would otherwise say the
   * same thing a second time in the other direction.
   *
   * Everything still parked on a person is withdrawn *before* that, though,
   * because {@link PiBinding.#observe} admits nothing once the flag is set: a
   * cancellation announced after it would be dropped on the floor, leaving a
   * question on screen that no later fact can ever clear and nothing left alive
   * to answer it. Each withdrawal takes its own listener with it, so the abort
   * below finds nothing left to withdraw — and a question that raced this loop
   * is harmless either way, because the claim in {@link PiBinding.#take} lets
   * only one path end any of them.
   */
  async release(_reason: ReleaseReason): Promise<void> {
    if (this.#releasing) return;
    this.#releasing = true;
    // Iterated live rather than over a snapshot: a question that slipped in
    // between two awaits here is one this loop still has to withdraw, and a
    // question the map no longer holds is one something else already ended.
    for (const asked of [this.#asked, this.#askedUser]) {
      for (const interactionId of asked.keys()) await this.#withdraw(interactionId, true);
    }
    this.#released = true;
    this.#abort.abort();
    await this.#handle?.close();
  }

  async #submit(
    handle: RuntimeAttachmentHandle,
    command: Extract<HarnessCommand, { kind: "message.submit" }>,
  ): Promise<DeliveryReceipt> {
    // `command.model`, `agent` and `variant` go nowhere, and nothing is lost
    // by that. They are contract scaffolding no Volli surface fills — the chat
    // client's `message.submit` carries a message and a delivery, so the
    // runtime hands all three down as `null` — and a per-message override is
    // not this product's model semantics in the first place. A Session's model
    // is durable: chosen through `model.select`, and applied at attach from
    // the Session's own projected selection.
    const text = messageText(command.message);
    // Attachments are prepared BEFORE the empty-text check, because they can
    // make an otherwise-empty message a real one: dragging in a screenshot and
    // pressing return without typing is an ordinary way to ask "what is this?"
    // (VC-50). A failure here is the turn's failure — a message whose file the
    // agent will never see is not one worth delivering silently.
    let attachments: TurnAttachments;
    try {
      attachments = await this.#prepareAttachments(command.message);
    } catch (error) {
      return this.#rejected(command.commandId, "PI_ATTACHMENT_FAILED", errorMessage(error));
    }
    if (text.trim().length === 0 && attachments.note.length === 0) {
      return this.#rejected(
        command.commandId,
        "PI_EMPTY_MESSAGE",
        "There was no text in this message to send.",
      );
    }
    if (command.delivery === "replace") {
      return this.#rejected(
        command.commandId,
        "PI_REPLACE_UNSUPPORTED",
        "Pi does not support replacing the active turn.",
      );
    }
    try {
      const outcome = await handle.submitUserMessage(
        `${text}${attachments.note}`,
        command.delivery,
        command.commandId,
        attachments.images,
      );
      return outcome.kind === "delivered"
        ? this.#accepted(command.commandId)
        : this.#rejected(command.commandId, REJECTION_CODES[outcome.reason], outcome.message);
    } catch (error) {
      // The prompt reached Pi and something after it failed. "Unknown" is the
      // only truthful receipt: the turn may well have run.
      return this.#unknown(command.commandId, error);
    }
  }

  /**
   * Put one blocked tool call to a person, and do not come back until answered.
   *
   * The wait is unbounded by design: the runtime awaits this with no timeout of
   * its own, so nothing here needs to invent one and a question left up
   * overnight costs a parked promise. `signal` is the other half of that
   * bargain — it is the only notice this side gets that the turn the question
   * belongs to has stopped waiting, and a host that ignores it strands the card
   * it opened.
   *
   * The `opened` emit is awaited, and its failure deliberately left to
   * propagate. A question whose fact never committed is a question nobody was
   * shown, so parking on it would block the turn on an answer that cannot
   * arrive; rejecting instead tells the runtime the host could not obtain one,
   * which lets the refusal stand and be recorded. That is the honest account of
   * a question that was never asked.
   */
  async #ask(request: RuntimeAskRequest, signal: AbortSignal): Promise<RuntimeAskChoice> {
    const offer = askOffer(request);
    const interactionId = askInteractionId(request.toolCallId);
    await this.#observe({
      kind: "interaction",
      state: "opened",
      occurredAt: this.#now(),
      interaction: {
        id: interactionId,
        kind: offer.kind,
        title: askTitle(request),
        detail: request.reason,
        options: offer.options,
        multiple: false,
        // `prompts` is left off rather than written out. A record without them
        // is read as the one question its flat fields ask, and stating that
        // single prompt here would be the same derivation made twice — once
        // durably, where a later disagreement could not be corrected.
        native: this.#native,
      },
    });
    const withdraw = (): void => {
      void this.#withdraw(interactionId, true);
    };
    const parked: ParkedAsk = {
      request,
      settle: Promise.withResolvers<RuntimeAskChoice>(),
      forget: () => signal.removeEventListener("abort", withdraw),
    };
    this.#asked.set(interactionId, parked);
    // Read rather than trusted to the listener: a signal that aborted while the
    // `opened` fact was committing will never fire again, and this question
    // would then park for the life of the Session on a turn that gave up on it.
    if (signal.aborted) withdraw();
    else signal.addEventListener("abort", withdraw, { once: true });
    return parked.settle.promise;
  }

  /**
   * Put one of the model's own questions to a person, and wait for their answer.
   *
   * Everything {@link PiBinding.#ask} says about the wait holds here: no timeout,
   * `signal` is the only notice that the turn stopped waiting, and the `opened`
   * emit is awaited with its failure left to propagate, because parking on a
   * question nobody was shown blocks the turn on an answer that cannot arrive.
   * A rejection reaches the model as a failed tool call, which is what actually
   * happened to it.
   *
   * The options are the model's rather than Volli's: whatever it offered, mapped
   * onto the ledger's own option shape and not checked against any vocabulary —
   * an id that reads like a refusal is one of the model's answers and refuses
   * nothing.
   *
   * Whether a person may say something the model did not list is what `prompts`
   * is here to record, and every question this opens declares one — options or
   * not. The default admits free text: a person asked to choose between two
   * things the model imagined must be able to say a third, so `custom` is true
   * unless the model closed it with `allowOther: false`. `custom` lives on a
   * prompt and nowhere else, so a question that left `prompts` off would be
   * durably saying the opposite — and history, not the card, is what a later
   * reader has to go on. The flat `options` and `multiple` stay beside it: a
   * reader that predates prompts still sees the choice, and only loses the part
   * it could not have rendered anyway.
   */
  async #askUser(
    request: RuntimeAskUserRequest,
    signal: AbortSignal,
  ): Promise<SessionInteractionResolution> {
    const interactionId = askUserInteractionId(request.toolCallId);
    const options: SessionInteractionOption[] = (request.options ?? []).map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description ?? null,
    }));
    const multiple = request.multiple === true;
    // A closed question with nothing to choose between asks for an answer that
    // cannot be given, so the model's `false` is overruled exactly there rather
    // than opening a card no press can ever satisfy.
    const custom = options.length === 0 || request.allowOther !== false;
    await this.#observe({
      kind: "interaction",
      state: "opened",
      occurredAt: this.#now(),
      interaction: {
        id: interactionId,
        kind: "question",
        title: request.question,
        detail: null,
        options,
        multiple,
        prompts: [
          {
            id: DEFAULT_INTERACTION_PROMPT_ID,
            label: request.question,
            detail: null,
            options,
            multiple,
            custom,
          },
        ],
        native: this.#native,
      },
    });
    const withdraw = (): void => {
      void this.#withdraw(interactionId, true);
    };
    const parked: ParkedAskUser = {
      settle: Promise.withResolvers<SessionInteractionResolution>(),
      forget: () => signal.removeEventListener("abort", withdraw),
    };
    this.#askedUser.set(interactionId, parked);
    // Read rather than trusted to the listener, for the reason spelled out in
    // {@link PiBinding.#ask}: a signal that aborted while the `opened` fact was
    // committing will never fire again.
    if (signal.aborted) withdraw();
    else signal.addEventListener("abort", withdraw, { once: true });
    return parked.settle.promise;
  }

  /** Whether either kind of question is still waiting under this id. */
  #awaiting(interactionId: string): boolean {
    return this.#asked.has(interactionId) || this.#askedUser.has(interactionId);
  }

  /**
   * Hand one answer to whichever kind of question was waiting for it.
   *
   * The two readings are the whole reason this is one function and not a shared
   * one: an escalation's option ids are the runtime's private evidence for a
   * verdict, and the model's are the model's own, handed back exactly as a
   * person chose them. False means nothing was still waiting.
   */
  #settleAnswer(interactionId: string, resolution: SessionInteractionResolution): boolean {
    const parkedUser = this.#takeUser(interactionId);
    if (parkedUser !== undefined) {
      parkedUser.settle.resolve(resolution);
      return true;
    }
    const parked = this.#take(interactionId);
    if (parked === undefined) return false;
    // `askChoice` is the runtime's own private reading of a decision the ledger
    // already holds in the person's own option ids.
    parked.settle.resolve(askChoice(parked.request, resolution.optionIds));
    return true;
  }

  /**
   * Claim a parked question, so that exactly one path can end it.
   *
   * The map delete is the dedupe, and everything that ends an ask goes through
   * here to get it: an answer, a withdrawal, an abort and a release all reach
   * for the same question, and the second one to arrive must find nothing.
   *
   * Dropping the abort listener is not what makes that work — a withdrawal
   * arriving after the claim finds nothing and does nothing. What it buys is
   * that a question which has ended holds no reference back into this binding,
   * so how long the runtime keeps its signal around afterwards cannot matter.
   */
  #take(interactionId: string): ParkedAsk | undefined {
    const parked = this.#asked.get(interactionId);
    if (parked === undefined) return undefined;
    this.#asked.delete(interactionId);
    parked.forget();
    return parked;
  }

  /** The same claim over the model's own questions. */
  #takeUser(interactionId: string): ParkedAskUser | undefined {
    const parked = this.#askedUser.get(interactionId);
    if (parked === undefined) return undefined;
    this.#askedUser.delete(interactionId);
    parked.forget();
    return parked;
  }

  /**
   * Stop asking one question, telling the Session unless it already knows.
   *
   * The parked promise is *rejected*, never resolved with a refusal. A refusal
   * is a decision, and a withdrawal is the absence of one; resolving would print
   * a choice nobody made, which is the exact failure `interaction.cancelled`
   * exists to avoid. The runtime reads a rejection as "the host could not obtain
   * an answer" and lets its own refusal stand, which is what actually happened.
   */
  async #withdraw(interactionId: string, announce: boolean): Promise<void> {
    // Either map, one claim: the Engine cancels an interaction by id and has no
    // reason to know which kind of question it was, and only one of the two can
    // be holding any id.
    const parked = this.#take(interactionId) ?? this.#takeUser(interactionId);
    if (parked === undefined) return;
    try {
      if (announce) {
        await this.#observe({
          kind: "interaction",
          state: "cancelled",
          occurredAt: this.#now(),
          interactionId,
          reason: "withdrawn",
        });
      }
    } catch {
      // A cancellation the Session could not record still ends here. Whatever
      // failed is the sink's own failure to report, and there is nothing this
      // side could do about it in any case; what it must not do is leave the
      // runtime parked on a promise that release is waiting to settle.
    }
    parked.settle.reject(new Error("The question was withdrawn before anyone answered it."));
  }

  #accepted(commandId: string): DeliveryReceipt {
    return { commandId, status: "accepted", acceptedAt: this.#now(), native: this.#native };
  }

  #rejected(commandId: string, code: string, detail: string): DeliveryReceipt {
    return { commandId, status: "rejected", code, detail, native: this.#native };
  }

  #unknown(commandId: string, error: unknown): DeliveryReceipt {
    return { commandId, status: "unknown", detail: errorMessage(error), native: this.#native };
  }

  /**
   * Everything Pi says, forwarded once; the Session Engine decides what it means.
   *
   * Two things are suppressed here rather than there, because both are facts
   * about this binding's own lifecycle that the Engine cannot see.
   *
   * **A released binding does not admit new observations.** Pi's own close
   * lands here on the way out of `release`, and the Engine writes
   * `attachment.closed` itself once `release` resolves; letting Pi's arrive
   * first would delete the binding before that write and throw
   * "already closed" out of every executor-stop command.
   *
   * This covers only what has not been admitted yet. An observation already
   * past it fans out into several Session facts on the far side of this seam,
   * and this flag cannot reach into that — a fan-out admitted a moment before
   * `release` would otherwise write its tail after the close, where the ledger
   * refuses it rather than files it late, and the rejection surfaces back
   * through Pi's observer. The Session Engine stops its own observation
   * pipeline for exactly that reason; the guarantee is enforced there, not
   * inferred from `close()` happening to await `waitForIdle()`.
   *
   * **An attachment fact needs a binding to be about.** Before the handle
   * exists, `started` is the Engine's own `attachment.opened` said twice and
   * `failed` is the rejection `attach` is about to throw. The guard names that
   * one kind because it is the only one that can arrive that early: everything
   * else follows from a turn, and a turn needs the handle. Widening it would
   * risk dropping a refusal that had already reached the model, which is the one
   * ordering this must never produce.
   */
  #observe(observation: RuntimeObservation): Promise<void> {
    if (this.#released) return Promise.resolve();
    if (observation.kind === "attachment" && this.#handle === null) return Promise.resolve();
    return this.#sink.emit(observation);
  }
}

/**
 * Pi takes one string; a `UIMessage` may carry several text parts — and,
 * since VC-49, skill resource parts. This is where the two halves of such a
 * message become the delivered prompt: the user's text first and verbatim
 * (its `/skill` reference intact, mid-sentence included), then each skill
 * body as its own delimited RESOURCE block, adjacent to the text and never
 * spliced into it.
 */
function messageText(message: UIMessage): string {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
  return appendPromptResources(text, readSkillResources(message.parts));
}
