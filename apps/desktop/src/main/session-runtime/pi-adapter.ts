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
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  errorMessage,
  type AgentRuntime,
  type DeliveryOutcome,
  type ModelSelection,
  type ModelSelectionOutcome,
  type RuntimeAttachmentHandle,
  type RuntimeObservation,
  type RuntimeRecoveryRef,
  type SessionNativeDetail,
  type SessionNativeReference,
  type SessionRuntimeSpec,
  type WorkLocationKind,
} from "@volli/shared";
import type { UIMessage } from "ai";
import { STRUCTURED_ADAPTER_ID } from "./structured-sessions";

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

/** The explicitly contained coding tools this slice loads. */
const PI_TOOLS = { tools: ["read", "edit", "write", "execute"] } as const;

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
   */
  location: WorkLocationKind;
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
  /** Injectable runtime factory. Defaults to the real Pi-backed runtime. */
  createRuntime?: (options: PiRuntimeHostOptions) => AgentRuntime;
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
}

/** Main-owned singular runtime host; the native adapter remains private migration scaffolding. */
export function createPiRuntimeHost(options: PiAdapterOptions): PiRuntimeHost {
  const now = options.now ?? Date.now;
  const create = options.createRuntime ?? createPiAgentRuntime;
  const runtime = create({
    sessionDataDir: options.sessionDataDir,
    ...(options.models === undefined ? {} : { models: options.models }),
  });

  return {
    adapter: piNativeAdapter(options, runtime, now),
    inspectModelAccess: (input) => runtime.inspectModelAccess(input),
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
      const binding = new PiBinding({ spec, sink, context, recovery, now });
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

interface PiBindingOptions {
  spec: NativeAttachmentSpec;
  sink: ObservationSink;
  context: PiRuntimeContext;
  recovery: RuntimeRecoveryRef | undefined;
  now: () => number;
}

class PiBinding implements BindingHandle {
  readonly #spec: NativeAttachmentSpec;
  readonly #sink: ObservationSink;
  readonly #context: PiRuntimeContext;
  readonly #recovery: RuntimeRecoveryRef | undefined;
  readonly #now: () => number;
  readonly #abort = new AbortController();
  #handle: RuntimeAttachmentHandle | null = null;
  #native: SessionNativeReference = { id: null, detail: null };
  #released = false;

  constructor(options: PiBindingOptions) {
    this.#spec = options.spec;
    this.#sink = options.sink;
    this.#context = options.context;
    this.#recovery = options.recovery;
    this.#now = options.now;
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
      // The pack is pinned by identity, not by value: a Settings edit must not
      // change what a running Session may do, while the facts its rules read
      // stay live.
      authority: {
        mode: "auto",
        location: context.location,
        tools: [...PI_TOOLS.tools],
        rulePackId: BUILTIN_RULE_PACK_ID,
        rulePackHash: BUILTIN_RULE_PACK_HASH,
        classifierModel: null,
        fallback: { consecutiveDenials: 3, sessionDenials: 20 },
      },
      brief: { text: this.#context.brief },
      tools: { tools: [...PI_TOOLS.tools] },
      ...(this.#recovery === undefined ? {} : { recovery: this.#recovery }),
      signal: this.#abort.signal,
      observer: (observation) => this.#observe(observation),
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
    if (handle === null || this.#released) {
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
      case "interaction.resolve":
        return this.#rejected(
          command.commandId,
          "PI_INTERACTION_UNSUPPORTED",
          "Pi raises no interactions in this migration slice, so there is none to resolve.",
        );
    }
  }

  async reconcile(cursor: Parameters<BindingHandle["reconcile"]>[0]): Promise<Reconciliation> {
    const handle = this.#handle;
    if (handle === null || this.#released) {
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
   * End the live attachment, never the Session.
   *
   * The sink closes first: the Session Engine writes `attachment.closed` itself
   * once this resolves, and Pi's own close observation would otherwise say the
   * same thing a second time in the other direction.
   */
  async release(_reason: ReleaseReason): Promise<void> {
    if (this.#released) return;
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
    if (text.trim().length === 0) {
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
      const outcome = await handle.submitUserMessage(text, command.delivery, command.commandId);
      return outcome.kind === "delivered"
        ? this.#accepted(command.commandId)
        : this.#rejected(command.commandId, REJECTION_CODES[outcome.reason], outcome.message);
    } catch (error) {
      // The prompt reached Pi and something after it failed. "Unknown" is the
      // only truthful receipt: the turn may well have run.
      return this.#unknown(command.commandId, error);
    }
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

/** Pi takes one string; a `UIMessage` may carry several text parts. */
function messageText(message: UIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
}
