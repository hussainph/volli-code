import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { access, realpath, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  BindingHandle,
  DeliveryReceipt,
  HarnessCommand,
  HarnessObservation,
  NativeAttachmentSpec,
  NativeCapabilityReport,
  NativeHarnessAdapter,
  NativeProbeContext,
  NativeProbeResult,
  ObservationSink,
  Reconciliation,
  ReleaseReason,
} from "@volli/session-engine";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type {
  ActivityDescriptor,
  ActivityKind,
  ActivityOutcome,
  ActivitySubject,
  SessionCapabilityCatalogItem,
  SessionInteraction,
  SessionNativeDetail,
  SessionNativeReference,
} from "@volli/shared";
type UIMessage = Extract<HarnessCommand, { kind: "message.submit" }>["message"];
type DynamicToolPart = Extract<UIMessage["parts"][number], { type: "dynamic-tool" }>;
type ToolMetadata = NonNullable<DynamicToolPart["toolMetadata"]>;
type OpenCodeStatusObservation = Extract<
  HarnessObservation,
  { kind: "turn.started" | "turn.completed" | "attention.raised" }
>;

const DIRECTORY_QUERY = "directory";
const ADAPTER_ID = "opencode";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DEFERRED_EVENTS = 1_000;
const MAX_REMEMBERED_EVENT_IDS = 10_000;
const MAX_SSE_BUFFER_LENGTH = 1_048_576;
const STREAM_SNAPSHOT_DELAY_MS = 32;

export interface OpenCodeChild {
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface OpenCodeProcessPort {
  resolveBinary(path: string): Promise<string>;
  version(path: string, signal: AbortSignal): Promise<string>;
  sha256(path: string): Promise<string>;
  spawn(input: {
    path: string;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
  }): Promise<OpenCodeChild>;
  allocatePort(): Promise<number>;
  randomSecret(): string;
}

export interface OpenCodeHttpResponse {
  status: number;
  body: unknown;
}

/** The legacy `/event` SSE envelope. No v2 `/api` event is accepted here. */
export interface OpenCodeSseEvent {
  id: string;
  type: string;
  properties: unknown;
}

export interface OpenCodeNetworkPort {
  request(input: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST";
    headers: Readonly<Record<string, string>>;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<OpenCodeHttpResponse>;
  subscribe(input: {
    baseUrl: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }): Promise<AsyncIterable<OpenCodeSseEvent>>;
}

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
  process?: OpenCodeProcessPort;
  network?: OpenCodeNetworkPort;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  healthRetryAttempts?: number;
  healthRetryDelayMs?: number;
  stopTimeoutMs?: number;
  maxDeferredEvents?: number;
}

interface ServerLease {
  readonly baseUrl: string;
  readonly password: string;
  readonly child: OpenCodeChild;
}

interface VerifiedOpenCodeBinary {
  readonly path: string;
  readonly fingerprint: string;
}

/**
 * Native adapter for the documented, directory-scoped OpenCode legacy API.
 *
 * The server is deliberately private to this module: a binding persists only a
 * provider Session id. The loopback URL and Basic credential never enter a
 * native reference, event, or transcript artifact.
 */
export class OpenCodeNativeAdapter implements NativeHarnessAdapter {
  readonly manifest = {
    id: ADAPTER_ID,
    displayName: "OpenCode",
    adapterVersion: "0.0.1",
    profiles: [{ id: "native", label: "Native", transport: "native" as const }],
  };

  readonly #process: OpenCodeProcessPort;
  readonly #network: OpenCodeNetworkPort;
  readonly #binaryPath: string;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #healthRetryAttempts: number;
  readonly #healthRetryDelayMs: number;
  readonly #stopTimeoutMs: number;
  readonly #maxDeferredEvents: number;
  #verifiedBinary: VerifiedOpenCodeBinary | null = null;
  #server: ServerLease | null = null;
  #starting: Promise<ServerLease> | null = null;
  #closing: Promise<void> | null = null;
  #closed = false;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#process = options.process ?? createNodeProcessPort();
    this.#network = options.network ?? createFetchNetworkPort();
    this.#binaryPath = options.binaryPath ?? "opencode";
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    // A cold OpenCode process routinely needs longer than a few hundred
    // milliseconds to bind and initialize its provider catalog. Keep the
    // default startup budget at ten seconds; tests can inject shorter bounds.
    this.#healthRetryAttempts = options.healthRetryAttempts ?? 100;
    this.#healthRetryDelayMs = options.healthRetryDelayMs ?? 100;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 2_000;
    this.#maxDeferredEvents = options.maxDeferredEvents ?? MAX_DEFERRED_EVENTS;
    if (!Number.isInteger(this.#maxDeferredEvents) || this.#maxDeferredEvents < 1) {
      throw new Error("OpenCode maxDeferredEvents must be a positive integer");
    }
  }

  async probe(context: NativeProbeContext, signal: AbortSignal): Promise<NativeProbeResult> {
    if (context.profileId !== "native") {
      return {
        status: "unavailable",
        runtime: null,
        reason: `Unknown OpenCode profile ${context.profileId}`,
      };
    }
    try {
      this.#throwIfClosed();
      const binary = await this.#resolveAndFingerprint();
      const version = await this.#process.version(binary.path, signal);
      this.#verifiedBinary = binary;
      const server = await this.#ensureServer();
      await this.#waitForHealth(server, signal);
      this.#throwIfClosed();
      return {
        status: "available",
        runtime: { path: binary.path, version, fingerprint: binary.fingerprint },
        capabilities: await this.#capabilities(server, context.directory),
      };
    } catch (error) {
      return {
        status: "unavailable",
        runtime: null,
        reason: error instanceof Error ? error.message : "OpenCode probe failed",
      };
    }
  }

  async attach(spec: NativeAttachmentSpec, sink: ObservationSink): Promise<BindingHandle> {
    if (spec.profileId !== "native") throw new Error(`Unknown OpenCode profile ${spec.profileId}`);
    this.#throwIfClosed();
    const server = await this.#ensureServer();
    await this.#waitForHealth(server);
    this.#throwIfClosed();
    const nativeSessionId = await this.#attachSession(server, spec);
    this.#throwIfClosed();
    const binding = new OpenCodeBinding({
      server,
      spec,
      nativeSessionId,
      network: this.#network,
      now: this.#now,
      sleep: this.#sleep,
      reconnectDelayMs: this.#healthRetryDelayMs,
      maxDeferredEvents: this.#maxDeferredEvents,
      onRelease: () => undefined,
    });
    await binding.start(sink);
    return binding;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const server = this.#server;
    const starting = this.#starting;
    this.#server = null;
    this.#starting = null;
    this.#closing = this.#closeServerLeases(server, starting);
    return this.#closing;
  }

  async #closeServerLeases(
    server: ServerLease | null,
    starting: Promise<ServerLease> | null,
  ): Promise<void> {
    if (server) await this.#stopChild(server.child);
    if (!starting) return;
    try {
      const lateServer = await starting;
      await this.#stopChild(lateServer.child);
    } catch {
      // Startup failed before a child lease existed. There is nothing to reap.
    }
  }

  async #attachSession(server: ServerLease, spec: NativeAttachmentSpec): Promise<string> {
    if (spec.continuity === "native_resume") {
      const nativeSessionId = spec.native?.id;
      if (!nativeSessionId)
        throw new Error("OpenCode native_resume requires a provider Session id");
      const response = await this.#scopedRequest(
        server,
        spec.directory,
        `/session/${encodeURIComponent(nativeSessionId)}`,
        "GET",
      );
      if (response.status !== 200)
        throw new Error(`OpenCode resume lookup returned ${response.status}`);
      return nativeSessionId;
    }
    const response = await this.#scopedRequest(server, spec.directory, "/session", "POST", {
      title: `Volli ${spec.sessionId}`,
    });
    const id = objectString(response.body, "id");
    if (response.status < 200 || response.status >= 300 || !id) {
      throw new Error(`OpenCode session creation returned ${response.status}`);
    }
    return id;
  }

  async #ensureServer(): Promise<ServerLease> {
    this.#throwIfClosed();
    if (this.#server) return this.#server;
    if (this.#starting) return this.#starting;
    const starting = this.#startServer();
    this.#starting = starting;
    void starting.then(
      (server) => {
        if (this.#starting === starting) this.#starting = null;
        if (!this.#closed) {
          this.#server = server;
          void server.child.exited.then(() => {
            if (this.#server === server) this.#server = null;
          });
        }
      },
      () => {
        if (this.#starting === starting) this.#starting = null;
      },
    );
    return starting;
  }

  #throwIfClosed(): void {
    if (this.#closed) throw new Error("OpenCode native adapter is closed");
  }

  async #startServer(): Promise<ServerLease> {
    const binary = await this.#verifiedBinaryForLaunch();
    const port = await this.#process.allocatePort();
    const password = this.#process.randomSecret();
    const child = await this.#process.spawn({
      path: binary.path,
      // `--no-mdns` and omitted `--cors` keep discovery and browser origins disabled.
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--no-mdns"],
      env: {
        OPENCODE_SERVER_PASSWORD: password,
        // The client authenticates with this explicit principal; do not inherit
        // an ambient OPENCODE_SERVER_USERNAME from the parent process.
        OPENCODE_SERVER_USERNAME: "opencode",
      },
    });
    return { baseUrl: `http://127.0.0.1:${port}`, password, child };
  }

  async #waitForHealth(server: ServerLease, signal?: AbortSignal): Promise<OpenCodeHttpResponse> {
    let last: OpenCodeHttpResponse | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.#healthRetryAttempts; attempt += 1) {
      try {
        if (signal?.aborted) throw signal.reason;
        const health = await this.#request(server, "/global/health", "GET", undefined, signal);
        last = health;
        if (health.status >= 200 && health.status < 300) return health;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
      if (attempt + 1 < this.#healthRetryAttempts) await this.#sleep(this.#healthRetryDelayMs);
    }
    if (last) throw new Error(`OpenCode health check returned ${last.status}`);
    throw lastError instanceof Error ? lastError : new Error("OpenCode health check failed");
  }

  async #resolveAndFingerprint(): Promise<VerifiedOpenCodeBinary> {
    const path = await this.#process.resolveBinary(this.#binaryPath);
    return { path, fingerprint: await this.#process.sha256(path) };
  }

  async #verifiedBinaryForLaunch(): Promise<VerifiedOpenCodeBinary> {
    const binary = this.#verifiedBinary ?? (await this.#resolveAndFingerprint());
    const currentFingerprint = await this.#process.sha256(binary.path);
    if (currentFingerprint !== binary.fingerprint) {
      this.#verifiedBinary = null;
      throw new Error(
        "OpenCode executable changed after verification; probe it again before launch",
      );
    }
    this.#verifiedBinary = binary;
    return binary;
  }

  async #stopChild(child: OpenCodeChild): Promise<void> {
    await Promise.race([child.stop().then(() => child.exited), this.#sleep(this.#stopTimeoutMs)]);
  }

  async #request(
    server: ServerLease,
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    signal?: AbortSignal,
  ) {
    return this.#network.request({
      baseUrl: server.baseUrl,
      path,
      method,
      headers: authHeaders(server.password),
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #scopedRequest(
    server: ServerLease,
    directory: string,
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<OpenCodeHttpResponse> {
    return this.#request(server, withDirectory(path, directory), method, body);
  }

  async #capabilities(server: ServerLease, directory: string): Promise<NativeCapabilityReport> {
    const [provider, agent, command, mcp, skill, tool] = await Promise.all([
      this.#catalog(server, directory, "/provider", "model"),
      this.#catalog(server, directory, "/agent", "agent"),
      this.#catalog(server, directory, "/command", "command"),
      this.#catalog(server, directory, "/mcp", "mcp"),
      this.#catalog(server, directory, "/skill", "skill"),
      this.#catalog(server, directory, "/experimental/tool/ids", "tool"),
    ]);
    return {
      features: [
        { id: "message.submit", state: "available", evidence: "verified", detail: null },
        { id: "executor.interrupt", state: "available", evidence: "verified", detail: null },
        { id: "interaction.permission", state: "available", evidence: "declared", detail: null },
        { id: "interaction.question", state: "available", evidence: "declared", detail: null },
        {
          id: "plugin.health",
          state: "unknown",
          evidence: "declared",
          detail: "OpenCode does not expose plugin health through the legacy API",
        },
        {
          id: "tool.health",
          state: "unknown",
          evidence: "declared",
          detail: "OpenCode does not expose tool health through the legacy API",
        },
      ],
      catalog: [...provider, ...agent, ...command, ...mcp, ...skill, ...tool],
    };
  }

  async #catalog(
    server: ServerLease,
    directory: string,
    path: string,
    kind: SessionCapabilityCatalogItem["kind"],
  ): Promise<readonly SessionCapabilityCatalogItem[]> {
    try {
      const response = await this.#scopedRequest(server, directory, path, "GET");
      if (response.status < 200 || response.status >= 300) return [];
      return catalogItems(kind, response.body);
    } catch {
      return [];
    }
  }
}

interface BindingOptions {
  server: ServerLease;
  spec: NativeAttachmentSpec;
  nativeSessionId: string;
  network: OpenCodeNetworkPort;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  reconnectDelayMs: number;
  maxDeferredEvents: number;
  onRelease: () => void;
}

interface BufferedOpenCodeMessage {
  role: ReturnType<typeof messageRole> | null;
  metadata: OpenCodeMessageMetadata | null;
  readonly partOrder: string[];
  readonly parts: Map<string, unknown>;
}

/**
 * The tool call an open permission gates. OpenCode asks for permission on a
 * channel of its own, but names the call it is blocking on — so the prompt can
 * be raised on that tool row instead of only beside the transcript.
 */
interface OpenCodeApprovalTarget {
  readonly messageId: string;
  readonly callId: string;
}

/**
 * What OpenCode reports about an assistant turn itself, rather than its parts.
 * Every field is nullable: absent is not zero, and a turn header must be able to
 * render with nothing but the model id.
 */
interface OpenCodeMessageMetadata {
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly cost: number | null;
  readonly tokens: {
    readonly input: number | null;
    readonly output: number | null;
    readonly reasoning: number | null;
    readonly cacheRead: number | null;
    readonly cacheWrite: number | null;
  } | null;
}

interface PendingOpenCodeReconciliation {
  readonly token: string;
  readonly reconciliation: Reconciliation;
  readonly seenIds: readonly string[];
  readonly completesNativeHistoryImport: boolean;
  readonly turnStatus: "busy" | "idle" | null;
  readonly statusSignature: string | null;
}

class OpenCodeBinding implements BindingHandle {
  readonly native;
  readonly #server: ServerLease;
  readonly #spec: NativeAttachmentSpec;
  readonly #nativeSessionId: string;
  readonly #network: OpenCodeNetworkPort;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #reconnectDelayMs: number;
  readonly #maxDeferredEvents: number;
  readonly #onRelease: () => void;
  readonly #seen = new Set<string>();
  readonly #streamEventsSeen = new Set<string>();
  readonly #messages = new Map<string, BufferedOpenCodeMessage>();
  readonly #streamSnapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #streamSnapshotTriggers = new Map<string, string>();
  readonly #deferredEvents: OpenCodeSseEvent[] = [];
  readonly #questions = new Map<string, readonly OpenCodeQuestion[]>();
  /** Open tool-gating permissions, by OpenCode's permission id. */
  readonly #pendingApprovals = new Map<string, OpenCodeApprovalTarget>();
  readonly #streamAbort = new AbortController();
  #sink: ObservationSink | null = null;
  #emissionQueue: Promise<void> = Promise.resolve();
  #released = false;
  #cursor: SessionNativeDetail | null = null;
  #importNativeHistory: boolean;
  #turnStatus: "busy" | "idle" | null = null;
  #statusSignature: string | null = null;
  #pendingReconciliation: PendingOpenCodeReconciliation | null = null;
  #reconciliationSequence = 0;
  #reconciling = false;
  #drainingDeferredEvents = false;
  #requiresFullReconciliation = false;
  #streamReconnectSequence = 0;

  constructor(options: BindingOptions) {
    this.#server = options.server;
    this.#spec = options.spec;
    this.#nativeSessionId = options.nativeSessionId;
    this.#network = options.network;
    this.#now = options.now;
    this.#sleep = options.sleep;
    this.#reconnectDelayMs = options.reconnectDelayMs;
    this.#maxDeferredEvents = options.maxDeferredEvents;
    this.#onRelease = options.onRelease;
    this.native = { id: options.nativeSessionId, detail: null };
    this.#importNativeHistory = options.spec.continuity === "native_resume";
  }

  async start(sink: ObservationSink): Promise<void> {
    this.#sink = sink;
    const stream = await this.#subscribe();
    // #pump contains source, reconnect, and sink failures before this detached
    // task settles, so a transient durable-store failure cannot escape main.
    void this.#pump(stream);
  }

  async dispatch(command: HarnessCommand): Promise<DeliveryReceipt> {
    if (command.kind === "message.submit") return this.#dispatchMessage(command);

    try {
      if (command.kind === "executor.interrupt") {
        const response = await this.#request(
          `/session/${encodeURIComponent(this.#nativeSessionId)}/abort`,
          "POST",
        );
        return receipt(
          command.commandId,
          response.status >= 200 && response.status < 300,
          response.status,
          this.native,
          this.#now(),
        );
      }
      const response = await this.#resolveInteraction(command);
      return receipt(
        command.commandId,
        response.status >= 200 && response.status < 300,
        response.status,
        this.native,
        this.#now(),
      );
    } catch (error) {
      return {
        commandId: command.commandId,
        status: "unknown",
        detail: error instanceof Error ? error.message : "OpenCode transport failed",
        native: this.native,
      };
    }
  }

  async #dispatchMessage(
    command: Extract<HarnessCommand, { kind: "message.submit" }>,
  ): Promise<DeliveryReceipt> {
    try {
      const response = await this.#request(
        `/session/${encodeURIComponent(this.#nativeSessionId)}/prompt_async`,
        "POST",
        {
          ...(command.model
            ? { model: { providerID: command.model.providerId, modelID: command.model.modelId } }
            : {}),
          ...(command.agent ? { agent: command.agent } : {}),
          ...(command.variant ? { variant: command.variant } : {}),
          parts: textParts(command.message),
        },
      );
      return receipt(
        command.commandId,
        response.status === 204,
        response.status,
        this.native,
        this.#now(),
      );
    } catch (error) {
      return {
        commandId: command.commandId,
        status: "unknown",
        detail: error instanceof Error ? error.message : "OpenCode transport failed",
        native: this.native,
      };
    }
  }

  async reconcile(cursor: SessionNativeDetail | null): Promise<Reconciliation> {
    if (this.#pendingReconciliation) {
      if (!isReconciliationAcknowledgement(cursor, this.#pendingReconciliation.token)) {
        return this.#pendingReconciliation.reconciliation;
      }
      await this.acknowledgeReconciliation(cursor);
    }
    this.#reconciling = true;
    try {
      await this.#drainInFlightEmit();
      const reconciliation = await this.#readReconciliation(cursor);
      if (this.#requiresFullReconciliation) {
        // A fresh provider snapshot is authoritative; stale partial stream
        // deltas cannot be replayed safely after the bounded queue overflowed.
        this.#requiresFullReconciliation = false;
        this.#deferredEvents.length = 0;
      }
      return reconciliation;
    } finally {
      this.#reconciling = false;
      if (!this.#pendingReconciliation) await this.#drainDeferredEvents();
    }
  }

  async acknowledgeReconciliation(cursor: SessionNativeDetail | null): Promise<void> {
    const pending = this.#pendingReconciliation;
    if (!pending || !isReconciliationAcknowledgement(cursor, pending.token)) return;
    this.#commitReconciliation(pending);
    this.#pendingReconciliation = null;
    await this.#drainDeferredEvents();
  }

  async #readReconciliation(cursor: SessionNativeDetail | null): Promise<Reconciliation> {
    const [messages, status, permissionResponse, questionResponse, todoResponse] =
      await Promise.all([
        this.#request(`/session/${encodeURIComponent(this.#nativeSessionId)}/message`, "GET"),
        this.#request("/session/status", "GET"),
        this.#request("/permission", "GET").catch(() => ({ status: 404, body: [] })),
        this.#request("/question", "GET").catch(() => ({ status: 404, body: [] })),
        this.#request(`/session/${encodeURIComponent(this.#nativeSessionId)}/todo`, "GET").catch(
          () => ({ status: 404, body: [] }),
        ),
      ]);
    const token = `reconcile:${this.#nativeSessionId}:${++this.#reconciliationSequence}`;
    const observations: HarnessObservation[] = [];
    const seenIds = new Set<string>();
    const push = (observation: HarnessObservation): boolean => {
      if (this.#seen.has(observation.id) || seenIds.has(observation.id)) return false;
      seenIds.add(observation.id);
      observations.push(observation);
      return true;
    };
    let completesNativeHistoryImport = false;
    // Project permissions before messages — they are what tells a hydrated tool
    // row it is gated — but keep them behind messages in the emitted batch, so
    // the order a resuming consumer sees is the order it always saw.
    const permissionObservations = arrayBody(permissionResponse.body)
      .filter((candidate) => hasSessionId(candidate, this.#nativeSessionId))
      .flatMap((permission) => {
        const observation = this.#interactionObservation(
          "permission.asked",
          permission,
          `permission:${objectString(permission, "id") ?? "unknown"}`,
        );
        return observation ? [observation] : [];
      });
    if (isSuccessfulMessageResponse(messages)) {
      const importNativeHistory = this.#importNativeHistory;
      completesNativeHistoryImport = importNativeHistory;
      for (const message of messageResponses(messages.body)) {
        const info = nested(message, "info") ?? message;
        const id = objectString(info, "id");
        if (!id) continue;
        const role = messageRole(info);
        if (role !== "user" || importNativeHistory) {
          const observation = this.#messageObservation(`message:${id}`, id, role, message);
          if (observation.message.parts.length > 0) push(observation);
        }
      }
    }
    for (const observation of permissionObservations) push(observation);
    for (const question of arrayBody(questionResponse.body).filter((candidate) =>
      hasSessionId(candidate, this.#nativeSessionId),
    )) {
      const observation = this.#interactionObservation(
        "question.asked",
        question,
        `question:${objectString(question, "id") ?? "unknown"}`,
      );
      if (observation) push(observation);
    }
    if (todoResponse.status >= 200 && todoResponse.status < 300) {
      const todoObservation = this.#todoObservation(
        `reconcile:todo:${token}`,
        {
          sessionID: this.#nativeSessionId,
          todos: arrayBody(todoResponse.body),
        },
        { allowEmpty: false },
      );
      if (todoObservation) push(todoObservation);
    }
    const statusObservation = this.#statusObservation(`reconcile:status:${token}`, status.body);
    let statusSignature: string | null = null;
    let turnStatus: "busy" | "idle" | null = null;
    if (statusObservation) {
      const candidate = statusSignatureForObservation(statusObservation);
      if ((candidate === null || candidate !== this.#statusSignature) && push(statusObservation)) {
        statusSignature = candidate;
        turnStatus = turnStatusForObservation(statusObservation);
      }
    }
    if (observations.length === 0 && !completesNativeHistoryImport && turnStatus === null) {
      return { cursor: cursor ?? this.#cursor ?? { eventId: null }, observations, receipts: [] };
    }
    const reconciliation: Reconciliation = {
      cursor: { kind: "volli.opencode.reconciliation.v1", token },
      observations,
      receipts: [],
    };
    this.#pendingReconciliation = {
      token,
      reconciliation,
      seenIds: [...seenIds],
      completesNativeHistoryImport,
      turnStatus,
      statusSignature,
    };
    return reconciliation;
  }

  #commitReconciliation(pending: PendingOpenCodeReconciliation): void {
    for (const id of pending.seenIds) this.#rememberId(this.#seen, id);
    if (pending.completesNativeHistoryImport) this.#importNativeHistory = false;
    if (pending.turnStatus) this.#turnStatus = pending.turnStatus;
    if (pending.statusSignature) this.#statusSignature = pending.statusSignature;
  }

  async release(_reason: ReleaseReason): Promise<void> {
    if (this.#released) {
      await this.#drainInFlightEmit();
      return;
    }
    this.#released = true;
    this.#clearScheduledStreamSnapshots();
    this.#streamAbort.abort();
    await this.#drainInFlightEmit();
    this.#sink = null;
    this.#messages.clear();
    this.#pendingApprovals.clear();
    this.#deferredEvents.length = 0;
    this.#pendingReconciliation = null;
    this.#onRelease();
  }

  async #drainInFlightEmit(): Promise<void> {
    await Promise.allSettled([this.#emissionQueue]);
  }

  async #pump(initialStream: AsyncIterable<OpenCodeSseEvent>): Promise<void> {
    let disconnected = await this.#consumeStream(initialStream);
    while (!this.#released) {
      await this.#emitDisconnected(disconnected);
      try {
        await this.#sleep(this.#reconnectDelayMs);
      } catch {
        return;
      }
      if (this.#released) return;
      try {
        const stream = await this.#subscribe();
        await this.#emitReconnected();
        disconnected = await this.#consumeStream(stream);
      } catch (error) {
        disconnected =
          error instanceof Error ? error.message : "OpenCode event stream disconnected";
      }
    }
  }

  async #consumeStream(stream: AsyncIterable<OpenCodeSseEvent>): Promise<string | null> {
    let disconnected: string | null = "OpenCode event stream ended";
    try {
      for await (const event of stream) {
        if (this.#released) return disconnected;
        if (!this.#ownsStreamEvent(event) || this.#streamEventsSeen.has(event.id)) continue;
        await this.#handleEvent(event);
        this.#rememberStreamEvent(event.id);
      }
    } catch (error) {
      disconnected = error instanceof Error ? error.message : "OpenCode event stream disconnected";
    }
    return disconnected;
  }

  /**
   * OpenCode tags snapshots with their Session, but its high-frequency text
   * deltas can be scoped only by message and part. Accept that compact shape
   * only after a trusted, Session-tagged message or part established ownership.
   */
  #ownsStreamEvent(event: OpenCodeSseEvent): boolean {
    const sessionId = eventSessionId(event.properties);
    if (sessionId !== null) return sessionId === this.#nativeSessionId;
    if (event.type !== "message.part.delta" && event.type !== "message.part.removed") return false;
    const messageId = objectString(event.properties, "messageID");
    return messageId !== null && this.#messages.has(messageId);
  }

  #subscribe(): Promise<AsyncIterable<OpenCodeSseEvent>> {
    return this.#network.subscribe({
      baseUrl: this.#server.baseUrl,
      path: withDirectory("/event", this.#spec.directory),
      headers: authHeaders(this.#server.password),
      signal: this.#streamAbort.signal,
    });
  }

  async #emitDisconnected(disconnectDetail: string | null): Promise<void> {
    try {
      await this.#flushMessages(`opencode:sse-final:${this.#nativeSessionId}`);
    } catch {
      // Continue to the independently identified attention fact.
    }
    try {
      await this.#emit({
        id: `opencode:sse-disconnected:${this.#nativeSessionId}`,
        kind: "attention.raised",
        occurredAt: this.#now(),
        attention: {
          id: `opencode:sse-disconnected:${this.#nativeSessionId}`,
          kind: "adapter_disconnected",
          detail: disconnectDetail,
          diagnostic: null,
        },
      });
    } catch {
      // A failed durable attention must not prevent the terminal binding fact.
      // #emit remembers only after its sink commits, so this does not consume
      // the failure observation's independent native identity.
    }
  }

  async #emitReconnected(): Promise<void> {
    try {
      await this.#emit({
        id: `opencode:sse-reconnected:${this.#nativeSessionId}:${++this.#streamReconnectSequence}`,
        kind: "attention.cleared",
        occurredAt: this.#now(),
        attentionId: `opencode:sse-disconnected:${this.#nativeSessionId}`,
      });
    } catch {
      // The stream remains usable even if the durable attention clear fails.
    }
  }

  async #emit(observation: HarnessObservation): Promise<boolean> {
    const emission = this.#emissionQueue.then(() => this.#emitNow(observation));
    this.#emissionQueue = emission.then(
      () => undefined,
      () => undefined,
    );
    return emission;
  }

  async #emitNow(observation: HarnessObservation): Promise<boolean> {
    if (this.#seen.has(observation.id)) return true;
    const sink = this.#sink;
    if (this.#released || !sink) return false;
    await sink.emit(observation);
    if (this.#released || this.#sink !== sink) return false;
    this.#remember(observation);
    this.#cursor = observation.cursor ?? { eventId: observation.id };
    return true;
  }

  #remember(observation: HarnessObservation): void {
    this.#rememberId(this.#seen, observation.id);
  }

  #rememberStreamEvent(eventId: string): void {
    this.#rememberId(this.#streamEventsSeen, eventId);
  }

  #rememberId(ids: Set<string>, id: string): void {
    ids.add(id);
    if (ids.size > MAX_REMEMBERED_EVENT_IDS) {
      const first = ids.values().next().value as string;
      ids.delete(first);
    }
  }

  async #drainDeferredEvents(): Promise<void> {
    /* v8 ignore start -- public callers clear reconciliation state first; these guards only protect concurrent teardown or re-entry. */
    if (
      this.#released ||
      this.#pendingReconciliation ||
      this.#reconciling ||
      this.#requiresFullReconciliation ||
      this.#drainingDeferredEvents
    )
      return;
    /* v8 ignore stop */
    this.#drainingDeferredEvents = true;
    try {
      while (!this.#released && this.#deferredEvents.length > 0) {
        const event = this.#deferredEvents[0];
        await this.#handleEvent(event, true);
        this.#deferredEvents.shift();
      }
    } finally {
      this.#drainingDeferredEvents = false;
    }
  }

  async #handleEvent(event: OpenCodeSseEvent, deferred = false): Promise<void> {
    if (
      !deferred &&
      (this.#pendingReconciliation ||
        this.#reconciling ||
        this.#drainingDeferredEvents ||
        this.#requiresFullReconciliation)
    ) {
      if (this.#deferredEvents.length < this.#maxDeferredEvents) this.#deferredEvents.push(event);
      else this.#requiresFullReconciliation = true;
      return;
    }
    switch (event.type) {
      case "message.updated": {
        const messageId = this.#bufferMessage(event.properties);
        this.#scheduleStreamSnapshot(messageId, event.id);
        return;
      }
      case "message.part.updated": {
        const messageId = this.#bufferPart(event.properties);
        this.#scheduleStreamSnapshot(messageId, event.id);
        return;
      }
      case "message.part.delta": {
        const messageId = this.#applyPartDelta(event.properties);
        this.#scheduleStreamSnapshot(messageId, event.id);
        return;
      }
      case "message.part.removed": {
        const messageId = this.#removePart(event.properties);
        this.#scheduleStreamSnapshot(messageId, event.id);
        return;
      }
      case "message.removed": {
        const messageId =
          objectString(event.properties, "messageID") ?? objectString(event.properties, "id");
        if (messageId) {
          this.#clearScheduledStreamSnapshot(messageId);
          this.#messages.delete(messageId);
        }
        return;
      }
      case "session.status":
      case "session.idle":
      case "session.error": {
        const observation = this.#statusObservation(event.id, event.properties, event.type);
        if (
          event.type === "session.error" ||
          (observation && observation.kind === "turn.completed")
        ) {
          await this.#flushMessages(event.id);
        }
        const statusSignature = observation ? statusSignatureForObservation(observation) : null;
        if (
          observation &&
          (statusSignature === null || statusSignature !== this.#statusSignature) &&
          (await this.#emit(observation))
        ) {
          const turnStatus = turnStatusForObservation(observation);
          if (turnStatus) this.#turnStatus = turnStatus;
          if (statusSignature) this.#statusSignature = statusSignature;
        }
        return;
      }
      case "permission.asked":
      case "question.asked": {
        const observation = this.#interactionObservation(event.type, event.properties, event.id);
        if (observation) await this.#emit(observation);
        // Nothing further arrives on the gated call until a human answers, so
        // repaint now or the prompt would not reach its tool row until the
        // reply that already dismissed it.
        this.#scheduleStreamSnapshot(approvalTarget(event.properties)?.messageId ?? null, event.id);
        return;
      }
      case "permission.replied": {
        const observation = this.#resolvedInteractionObservation(event);
        if (observation) await this.#emit(observation);
        this.#clearApproval(event);
        return;
      }
      case "question.replied":
      case "question.rejected": {
        const observation = this.#resolvedInteractionObservation(event);
        if (observation) await this.#emit(observation);
        return;
      }
      case "todo.updated": {
        const observation = this.#todoObservation(event.id, event.properties, {
          allowEmpty: true,
        });
        if (observation) await this.#emit(observation);
        return;
      }
      default:
        return;
    }
  }

  #bufferMessage(raw: unknown): string | null {
    const info = nested(raw, "info") ?? raw;
    const messageId = objectString(info, "id");
    if (!messageId) return null;
    const message = this.#message(messageId);
    const role = explicitMessageRole(info);
    if (role) message.role = role;
    // Usage arrives on a later message.updated than the first one, so keep the
    // last non-empty reading rather than letting a partial snapshot erase it.
    message.metadata = openCodeMessageMetadata(info) ?? message.metadata;
    if (!isRecord(raw) || !Array.isArray(raw.parts)) return messageId;
    message.parts.clear();
    message.partOrder.length = 0;
    raw.parts.forEach((part, index) => {
      const partId = objectString(part, "id") ?? `snapshot:${index}`;
      message.partOrder.push(partId);
      message.parts.set(partId, part);
    });
    return messageId;
  }

  #bufferPart(raw: unknown): string | null {
    const part = nested(raw, "part");
    if (!part) return null;
    const messageId = objectString(raw, "messageID") ?? objectString(part, "messageID");
    const partId = objectString(part, "id");
    if (!messageId || !partId) return null;
    const message = this.#message(messageId);
    if (!message.parts.has(partId)) message.partOrder.push(partId);
    message.parts.set(partId, mergeOpenCodePart(message.parts.get(partId), part));
    return messageId;
  }

  #applyPartDelta(raw: unknown): string | null {
    const messageId = objectString(raw, "messageID");
    const partId = objectString(raw, "partID");
    const field = objectString(raw, "field");
    const delta = objectString(raw, "delta");
    if (!messageId || !partId || field !== "text" || delta === null) return null;
    const message = this.#messages.get(messageId);
    if (!message) return null;
    const part = message.parts.get(partId);
    if (!isRecord(part)) {
      // Delta can race ahead of message.part.updated. Treat as text so the
      // first tokens paint within one coalescing interval; if the typed
      // snapshot later says reasoning, mergeOpenCodePart preserves the
      // accumulated text onto the new type.
      message.partOrder.push(partId);
      message.parts.set(partId, {
        id: partId,
        messageID: messageId,
        type: "text",
        text: delta,
      });
      return messageId;
    }
    message.parts.set(partId, {
      ...part,
      [field]: `${objectString(part, field) ?? ""}${delta}`,
    });
    return messageId;
  }

  #removePart(raw: unknown): string | null {
    const messageId = objectString(raw, "messageID");
    const partId = objectString(raw, "partID");
    if (!messageId || !partId) return null;
    const message = this.#messages.get(messageId);
    if (!message) return null;
    message.parts.delete(partId);
    const orderIndex = message.partOrder.indexOf(partId);
    if (orderIndex >= 0) message.partOrder.splice(orderIndex, 1);
    return messageId;
  }

  #message(messageId: string): BufferedOpenCodeMessage {
    let message = this.#messages.get(messageId);
    if (!message) {
      message = { role: null, metadata: null, partOrder: [], parts: new Map() };
      this.#messages.set(messageId, message);
    }
    return message;
  }

  #scheduleStreamSnapshot(messageId: string | null, triggerId: string): void {
    if (!messageId || this.#released || !this.#messages.has(messageId)) return;
    this.#streamSnapshotTriggers.set(messageId, triggerId);
    if (this.#streamSnapshotTimers.has(messageId)) return;
    const timer = setTimeout(() => {
      this.#streamSnapshotTimers.delete(messageId);
      void this.#emitStreamSnapshot(messageId).catch(() => undefined);
    }, STREAM_SNAPSHOT_DELAY_MS);
    this.#streamSnapshotTimers.set(messageId, timer);
  }

  async #emitStreamSnapshot(messageId: string): Promise<void> {
    const buffered = this.#messages.get(messageId);
    const triggerId = this.#streamSnapshotTriggers.get(messageId);
    if (!buffered?.role || buffered.role === "user" || !triggerId) return;
    const turnBusy = this.#turnStatus !== "idle";
    const approvals = this.#approvalsForMessage(messageId);
    const parts = buffered.partOrder.flatMap((partId) =>
      openCodePart(buffered.parts.get(partId), { reasoningStreaming: turnBusy, approvals }),
    );
    if (parts.length === 0) return;
    // Fallback for the window before `time.end` lands: a thought is live only
    // while it is the message's *final* part. Once text or a tool call follows
    // it the model has moved on, even though the turn is still busy — and a
    // reasoning part left "streaming" makes the elapsed counter tick forever.
    if (turnBusy) {
      const lastIndex = parts.length - 1;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part?.type !== "reasoning" || index === lastIndex) continue;
        parts[index] = { ...part, state: "done" };
      }
    }
    const message: UIMessage = {
      id: messageId,
      role: buffered.role,
      parts,
      ...(buffered.metadata ? { metadata: buffered.metadata } : {}),
    };
    await this.#emit({
      id: transcriptObservationId(message),
      kind: "transcript.message",
      occurredAt: this.#now(),
      cursor: { eventId: triggerId },
      threadId: `thread:${this.#spec.sessionId}:root`,
      branchId: `branch:${this.#spec.sessionId}:main`,
      attemptId: `attempt:${messageId}`,
      turnId: null,
      message,
    });
  }

  #clearScheduledStreamSnapshot(messageId: string): void {
    const timer = this.#streamSnapshotTimers.get(messageId);
    if (timer) clearTimeout(timer);
    this.#streamSnapshotTimers.delete(messageId);
    this.#streamSnapshotTriggers.delete(messageId);
  }

  #clearScheduledStreamSnapshots(): void {
    for (const timer of this.#streamSnapshotTimers.values()) clearTimeout(timer);
    this.#streamSnapshotTimers.clear();
    this.#streamSnapshotTriggers.clear();
  }

  async #flushMessages(triggerId: string): Promise<void> {
    this.#clearScheduledStreamSnapshots();
    await this.#drainInFlightEmit();
    for (const [messageId, buffered] of this.#messages) {
      if (!buffered.role) {
        this.#messages.delete(messageId);
        continue;
      }
      if (buffered.role === "user") {
        this.#messages.delete(messageId);
        continue;
      }
      // Same gate as the streaming path: one message must not project two ways
      // depending on which path emitted it.
      const approvals = this.#approvalsForMessage(messageId);
      const parts = buffered.partOrder.flatMap((partId) =>
        openCodePart(buffered.parts.get(partId), { reasoningStreaming: false, approvals }),
      );
      if (parts.length === 0) {
        this.#messages.delete(messageId);
        continue;
      }
      const message: UIMessage = {
        id: messageId,
        role: buffered.role,
        parts,
        ...(buffered.metadata ? { metadata: buffered.metadata } : {}),
      };
      await this.#emit({
        id: transcriptObservationId(message),
        kind: "transcript.message",
        occurredAt: this.#now(),
        cursor: { eventId: triggerId },
        threadId: `thread:${this.#spec.sessionId}:root`,
        branchId: `branch:${this.#spec.sessionId}:main`,
        attemptId: `attempt:${messageId}`,
        turnId: null,
        message,
      });
      if (this.#released) {
        this.#messages.clear();
        return;
      }
      this.#messages.delete(messageId);
    }
  }

  #messageObservation(
    id: string,
    messageId: string,
    role: ReturnType<typeof messageRole>,
    raw: unknown,
  ): Extract<HarnessObservation, { kind: "transcript.message" }> {
    const metadata = openCodeMessageMetadata(nested(raw, "info") ?? raw);
    const message: UIMessage = {
      id: messageId,
      role,
      parts: messageParts(raw, this.#approvalsForMessage(messageId)),
      ...(metadata ? { metadata } : {}),
    };
    return {
      id: transcriptObservationId(message),
      kind: "transcript.message",
      occurredAt: this.#now(),
      cursor: { eventId: id },
      threadId: `thread:${this.#spec.sessionId}:root`,
      branchId: `branch:${this.#spec.sessionId}:main`,
      attemptId: `attempt:${messageId}`,
      turnId: null,
      message,
    };
  }

  /**
   * Project OpenCode's first-party todo list into a stable synthetic transcript
   * message. The chat UI hides todowrite parts and reads this via
   * projectSessionTodos — same shape whether the source was todowrite tool
   * metadata or a todo.updated SSE / GET /todo reconcile.
   */
  #todoObservation(
    eventId: string,
    raw: unknown,
    options: { allowEmpty: boolean },
  ): Extract<HarnessObservation, { kind: "transcript.message" }> | null {
    /* v8 ignore next -- unreachable: #ownsStreamEvent already requires a Session-tagged record, and reconcile builds one. */
    if (!isRecord(raw)) return null;
    const sessionId = objectString(raw, "sessionID") ?? objectString(raw, "sessionId");
    if (sessionId !== null && sessionId !== this.#nativeSessionId) return null;
    const todos = (Array.isArray(raw.todos) ? raw.todos : arrayBody(raw.todos)).filter(
      (item): item is Record<string, unknown> => isRecord(item) && typeof item.content === "string",
    );
    if (todos.length === 0 && !options.allowEmpty) return null;
    const serializableTodos = todos.map((todo) => {
      const serialized: Record<string, unknown> = {};
      if (typeof todo.id === "string") serialized.id = todo.id;
      serialized.content = todo.content;
      if (typeof todo.status === "string") serialized.status = todo.status;
      if (typeof todo.priority === "string") serialized.priority = todo.priority;
      return serialized;
    });
    const messageId = `opencode:todos:${this.#nativeSessionId}`;
    const message: UIMessage = {
      id: messageId,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "todowrite",
          toolCallId: `todos:${this.#nativeSessionId}`,
          state: "output-available",
          input: { todos: serializableTodos },
          output: { todos: serializableTodos },
          title: `${serializableTodos.length} todos`,
          // Same descriptor a real todowrite part carries, so the renderer
          // recognizes the projected list by kind and never by tool name.
          toolMetadata: openCodeToolMetadata(
            {
              status: "completed",
              input: { todos: serializableTodos },
              metadata: { todos: serializableTodos },
            },
            "todowrite",
          ),
        },
      ],
    };
    return {
      id: transcriptObservationId(message),
      kind: "transcript.message",
      occurredAt: this.#now(),
      cursor: { eventId },
      threadId: `thread:${this.#spec.sessionId}:root`,
      branchId: `branch:${this.#spec.sessionId}:main`,
      attemptId: `attempt:${messageId}`,
      turnId: null,
      message,
    };
  }

  #statusObservation(
    id: string,
    raw: unknown,
    eventType = "session.status",
  ): OpenCodeStatusObservation | null {
    if (eventType === "session.error") {
      const failure = safeOpenCodeError(raw);
      return {
        id,
        kind: "attention.raised",
        occurredAt: this.#now(),
        attention: {
          id: `opencode:error:${id}`,
          kind: "adapter_unrecoverable",
          detail: failure.detail,
          diagnostic: failure.diagnostic,
        },
      };
    }
    const sessionStatus =
      isRecord(raw) && isRecord(raw[this.#nativeSessionId]) ? raw[this.#nativeSessionId] : raw;
    const status =
      eventType === "session.idle"
        ? "idle"
        : (objectString(nested(sessionStatus, "status") ?? sessionStatus, "type") ??
          objectString(sessionStatus, "type"));
    if (status === "busy") {
      if (this.#turnStatus === status) return null;
      return {
        id,
        kind: "turn.started",
        occurredAt: this.#now(),
        turnId: `turn:${this.#nativeSessionId}`,
      };
    }
    if (status === "idle") {
      if (this.#turnStatus === status) return null;
      return {
        id,
        kind: "turn.completed",
        occurredAt: this.#now(),
        turnId: `turn:${this.#nativeSessionId}`,
      };
    }
    if (status === "retry") {
      const retry = safeOpenCodeRetry(sessionStatus);
      return {
        id,
        kind: "attention.raised",
        occurredAt: this.#now(),
        attention: {
          id: `opencode:retry:${id}`,
          kind: "transport_retrying",
          detail: retry.detail,
          diagnostic: retry.diagnostic,
        },
      };
    }
    return null;
  }

  #interactionObservation(type: string, raw: unknown, id: string): HarnessObservation | null {
    const nativeId = requestId(raw);
    if (!nativeId) return null;
    const kind = type.startsWith("permission") ? "permission" : "question";
    const interaction: Omit<SessionInteraction, "attachmentId"> = {
      id: `${kind}:${nativeId}`,
      kind,
      title:
        objectString(raw, "title") ??
        (kind === "permission" ? "Permission required" : "Question required"),
      detail: objectString(raw, "description") ?? objectString(raw, "pattern"),
      options:
        kind === "permission"
          ? [
              { id: "once", label: "Allow once", description: null },
              { id: "always", label: "Allow always", description: null },
              { id: "reject", label: "Reject", description: null },
            ]
          : questionOptions(raw),
      multiple: kind === "question",
      native: { id: nativeId, detail: kind === "question" ? questionDetail(questions(raw)) : null },
    };
    if (kind === "question") this.#questions.set(nativeId, questions(raw));
    // Both the SSE event and the hydrate sweep land here, so one record keeps a
    // permission opened before this binding attached gating its row too.
    const target = kind === "permission" ? approvalTarget(raw) : null;
    if (target) this.#pendingApprovals.set(nativeId, target);
    return {
      id,
      kind: "interaction.opened",
      occurredAt: this.#now(),
      cursor: { eventId: id },
      interaction,
    };
  }

  #resolvedInteractionObservation(event: OpenCodeSseEvent): HarnessObservation | null {
    const nativeId = objectString(event.properties, "requestID");
    if (!nativeId) return null;
    if (event.type === "permission.replied") {
      const reply = objectString(event.properties, "reply");
      return {
        id: event.id,
        kind: "interaction.resolved",
        occurredAt: this.#now(),
        cursor: { eventId: event.id },
        interactionId: `permission:${nativeId}`,
        resolution: {
          optionIds: reply ? [reply] : [],
          response: objectString(event.properties, "message"),
        },
      };
    }
    if (event.type === "question.rejected") {
      return {
        id: event.id,
        kind: "interaction.resolved",
        occurredAt: this.#now(),
        cursor: { eventId: event.id },
        interactionId: `question:${nativeId}`,
        resolution: { optionIds: ["reject"], response: null },
      };
    }
    return {
      id: event.id,
      kind: "interaction.resolved",
      occurredAt: this.#now(),
      cursor: { eventId: event.id },
      interactionId: `question:${nativeId}`,
      resolution: {
        optionIds: questionAnswerOptionIds(
          this.#questions.get(nativeId) ?? questions(event.properties),
          event.properties,
        ),
        response: null,
      },
    };
  }

  /**
   * An answered permission stops gating its call, whoever answered it. Drop the
   * gate and repaint: allowed, the row goes back to running; rejected, OpenCode
   * fails the call itself and the row settles into that error. The adapter
   * never states a verdict OpenCode has not reported.
   */
  #clearApproval(event: OpenCodeSseEvent): void {
    const permissionId = objectString(event.properties, "requestID");
    if (!permissionId) return;
    const target = this.#pendingApprovals.get(permissionId);
    if (!target) return;
    this.#pendingApprovals.delete(permissionId);
    this.#scheduleStreamSnapshot(target.messageId, event.id);
  }

  /**
   * OpenCode keys permissions by their own id; a message projects by call id. A
   * session blocks on its first open permission, so this map holds ones — a
   * scan beats keeping a second index true to the first.
   */
  #approvalsForMessage(messageId: string): ReadonlyMap<string, string> {
    const byCallId = new Map<string, string>();
    for (const [permissionId, target] of this.#pendingApprovals) {
      if (target.messageId === messageId) byCallId.set(target.callId, permissionId);
    }
    return byCallId;
  }

  async #resolveInteraction(
    command: Extract<HarnessCommand, { kind: "interaction.resolve" }>,
  ): Promise<OpenCodeHttpResponse> {
    const nativeId = command.interaction.native.id;
    if (!nativeId) throw new Error("OpenCode interaction has no native id");
    if (command.interaction.kind === "permission") {
      const option = command.resolution.optionIds[0] ?? "reject";
      const reply = option === "once" || option === "always" ? option : "reject";
      return this.#request(`/permission/${encodeURIComponent(nativeId)}/reply`, "POST", {
        reply,
        ...(command.resolution.response ? { message: command.resolution.response } : {}),
      });
    }
    if (command.resolution.optionIds[0] === "reject") {
      return this.#request(`/question/${encodeURIComponent(nativeId)}/reject`, "POST");
    }
    return this.#request(`/question/${encodeURIComponent(nativeId)}/reply`, "POST", {
      answers: questionAnswers(
        this.#questions.get(nativeId) ?? questions(command.interaction.native.detail),
        command.resolution.optionIds,
      ),
    });
  }

  #request(path: string, method: "GET" | "POST", body?: unknown): Promise<OpenCodeHttpResponse> {
    return this.#network.request({
      baseUrl: this.#server.baseUrl,
      path: withDirectory(path, this.#spec.directory),
      method,
      headers: authHeaders(this.#server.password),
      ...(body === undefined ? {} : { body }),
    });
  }
}

export function createOpenCodeNativeAdapter(
  options: OpenCodeAdapterOptions = {},
): OpenCodeNativeAdapter {
  return new OpenCodeNativeAdapter(options);
}

function receipt(
  commandId: string,
  accepted: boolean,
  status: number,
  native: SessionNativeReference,
  now: number,
): DeliveryReceipt {
  return accepted
    ? { commandId, status: "accepted", acceptedAt: now, native }
    : { commandId, status: "rejected", code: `OPENCODE_HTTP_${status}`, detail: null, native };
}

function textParts(message: UIMessage): readonly { type: "text"; text: string }[] {
  return message.parts.flatMap((part) =>
    part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
  );
}

function authHeaders(password: string): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "content-type": "application/json",
  };
}

function withDirectory(path: string, directory: string): string {
  return `${path}?${DIRECTORY_QUERY}=${encodeURIComponent(directory)}`;
}

function objectString(value: unknown, key: string): string | null {
  if (!isRecord(value) || typeof value[key] !== "string") return null;
  return value[key];
}

function nested(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value[key])) return null;
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayBody(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.items)) return value.items;
  return [];
}

function messageRole(raw: unknown): "system" | "user" | "assistant" {
  return explicitMessageRole(raw) ?? "assistant";
}

function explicitMessageRole(raw: unknown): "system" | "user" | "assistant" | null {
  const role = objectString(raw, "role");
  return role === "system" || role === "user" || role === "assistant" ? role : null;
}

/**
 * OpenCode carries usage on the AssistantMessage itself. Returns null when the
 * snapshot reports none of it — a user message, or an assistant message whose
 * usage has not landed yet — so an empty object never reaches the transcript.
 */
function openCodeMessageMetadata(info: unknown): OpenCodeMessageMetadata | null {
  const providerId = objectString(info, "providerID");
  const modelId = objectString(info, "modelID");
  const cost = objectFiniteNumber(info, "cost");
  const usage = nested(info, "tokens");
  const cache = nested(usage, "cache");
  const tokens = usage
    ? {
        input: objectFiniteNumber(usage, "input"),
        output: objectFiniteNumber(usage, "output"),
        reasoning: objectFiniteNumber(usage, "reasoning"),
        cacheRead: objectFiniteNumber(cache, "read"),
        cacheWrite: objectFiniteNumber(cache, "write"),
      }
    : null;
  if (providerId === null && modelId === null && cost === null && tokens === null) return null;
  return { providerId, modelId, cost, tokens };
}

interface OpenCodeQuestion {
  readonly options: readonly OpenCodeQuestionOption[];
  readonly label: string;
}

interface OpenCodeQuestionOption {
  /** The value OpenCode expects in QuestionAnswer. It is its documented label. */
  readonly value: string;
  readonly label: string;
  /** OpenCode declares this as user-facing choice explanation. */
  readonly description: string | null;
}

/**
 * A provider QuestionRequest is one interaction containing `questions[]`.
 * UI option ids encode the question index and raw option value, so a selected
 * flat set round-trips exactly to OpenCode's `answers: string[][]` payload.
 */
function questions(raw: unknown): readonly OpenCodeQuestion[] {
  const values = isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : [];
  return values.map((question, index) => {
    const options =
      isRecord(question) && Array.isArray(question.options)
        ? question.options.flatMap(questionOption)
        : [];
    return {
      options,
      label: isRecord(question)
        ? (objectString(question, "header") ??
          objectString(question, "question") ??
          objectString(question, "label") ??
          `Question ${index + 1}`)
        : `Question ${index + 1}`,
    };
  });
}

function questionOption(raw: unknown): readonly OpenCodeQuestionOption[] {
  // OpenCode 1.17's QuestionOption is { label, description }; strings remain
  // accepted for compatibility with older servers and stored interactions.
  if (typeof raw === "string") return [{ value: raw, label: raw, description: null }];
  const label = objectString(raw, "label");
  if (!label) return [];
  return [
    {
      // QuestionAnswer is documented as string[][] and QuestionOption has no
      // separate machine value, so its label is the sole provider answer value.
      value: label,
      label,
      description: objectString(raw, "description"),
    },
  ];
}

function questionOptions(
  raw: unknown,
): readonly { id: string; label: string; description: string | null }[] {
  return questions(raw).flatMap((question, questionIndex) =>
    question.options.map((option) => ({
      id: questionOptionId(questionIndex, option.value),
      label:
        question.label === `Question ${questionIndex + 1}`
          ? option.label
          : `${question.label}: ${option.label}`,
      description: option.description,
    })),
  );
}

function questionOptionId(questionIndex: number, value: string): string {
  return `question:${questionIndex}:${Buffer.from(value).toString("base64url")}`;
}

function parseQuestionOptionId(id: string): { questionIndex: number; value: string } | null {
  const match = /^question:(\d+):([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) return null;
  const value = Buffer.from(match[2], "base64url").toString("utf8");
  return questionOptionId(Number(match[1]), value) === id
    ? { questionIndex: Number(match[1]), value }
    : null;
}

function questionAnswers(
  questionRequests: readonly OpenCodeQuestion[],
  optionIds: readonly string[],
): string[][] {
  const answers = questionRequests.map(() => [] as string[]);
  for (const optionId of optionIds) {
    const decoded = parseQuestionOptionId(optionId);
    if (
      decoded &&
      answers[decoded.questionIndex] &&
      questionRequests[decoded.questionIndex]?.options.some(
        (option) => option.value === decoded.value,
      )
    ) {
      answers[decoded.questionIndex].push(decoded.value);
    }
  }
  return answers;
}

function questionDetail(questionRequests: readonly OpenCodeQuestion[]): SessionNativeDetail {
  return {
    questions: questionRequests.map((question) => ({
      label: question.label,
      // This opaque recovery reference needs only the provider answer values;
      // provider prose stays on the intentionally user-facing interaction option.
      options: question.options.map((option) => ({ value: option.value, label: option.label })),
    })),
  };
}

function questionAnswerOptionIds(
  questionRequests: readonly OpenCodeQuestion[],
  raw: unknown,
): readonly string[] {
  const answers = isRecord(raw) && Array.isArray(raw.answers) ? raw.answers : [];
  return answers.flatMap((answer, questionIndex) =>
    Array.isArray(answer)
      ? answer
          .filter(
            (value): value is string =>
              typeof value === "string" &&
              questionRequests[questionIndex]?.options.some((option) => option.value === value),
          )
          .map((value) => questionOptionId(questionIndex, value))
      : [],
  );
}

function requestId(raw: unknown): string | null {
  return objectString(raw, "requestID") ?? objectString(raw, "id");
}

function hasSessionId(raw: unknown, sessionId: string): boolean {
  return objectString(raw, "sessionID") === sessionId;
}

function messageResponses(body: unknown): readonly unknown[] {
  if (isRecord(body) && isRecord(body.info) && Array.isArray(body.parts)) return [body];
  return arrayBody(body);
}

function isSuccessfulMessageResponse(response: OpenCodeHttpResponse): boolean {
  if (Math.floor(response.status / 100) !== 2) return false;
  const body = response.body;
  if (isMessageResponse(body)) return true;
  const responses = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.items)
      ? body.items
      : null;
  return responses !== null && (responses.length === 0 || responses.some(isMessageResponse));
}

function isMessageResponse(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.parts)) return false;
  const info = nested(value, "info") ?? value;
  return objectString(info, "id") !== null && explicitMessageRole(info) !== null;
}

function safeOpenCodeRetry(raw: unknown): {
  detail: string | null;
  diagnostic: SessionNativeDetail | null;
} {
  const status = nested(raw, "status") ?? raw;
  const diagnostic: Record<string, SessionNativeDetail> = {};
  const attempt = objectFiniteNumber(status, "attempt");
  const next = objectFiniteNumber(status, "next");
  if (attempt !== null) diagnostic.attempt = attempt;
  if (next !== null) diagnostic.next = next;
  return {
    detail: Object.keys(diagnostic).length > 0 ? "OpenCode is retrying" : null,
    diagnostic: Object.keys(diagnostic).length > 0 ? diagnostic : null,
  };
}

function safeOpenCodeError(raw: unknown): {
  detail: string | null;
  diagnostic: SessionNativeDetail | null;
} {
  const error = nested(raw, "error");
  if (!error) return { detail: null, diagnostic: null };
  const data = nested(error, "data");
  const diagnostic: Record<string, SessionNativeDetail> = {};
  const name = safeOpenCodeErrorName(objectString(error, "name"));
  const statusCode = objectFiniteNumber(data, "statusCode");
  const isRetryable = objectBoolean(data, "isRetryable");
  if (name) diagnostic.name = name;
  if (statusCode !== null) diagnostic.statusCode = statusCode;
  if (isRetryable !== null) diagnostic.isRetryable = isRetryable;
  const hasDiagnostic = Object.keys(diagnostic).length > 0;
  return {
    detail: name
      ? `OpenCode ${name}${statusCode === null ? "" : ` (status ${statusCode})`}`
      : statusCode === null
        ? null
        : `OpenCode session error (status ${statusCode})`,
    diagnostic: hasDiagnostic ? diagnostic : null,
  };
}

function safeOpenCodeErrorName(name: string | null): string | null {
  return name && SAFE_OPEN_CODE_ERROR_NAMES.has(name) ? name : null;
}

function objectFiniteNumber(value: unknown, key: string): number | null {
  const candidate = isRecord(value) ? value[key] : null;
  return typeof candidate === "number" ? candidate : null;
}

function objectBoolean(value: unknown, key: string): boolean | null {
  if (!isRecord(value) || typeof value[key] !== "boolean") return null;
  return value[key];
}

const SAFE_OPEN_CODE_ERROR_NAMES = new Set([
  "ProviderAuthError",
  "UnknownError",
  "MessageOutputLengthError",
  "MessageAbortedError",
  "StructuredOutputError",
  "ContextOverflowError",
  "ContentFilterError",
  "APIError",
]);

/** Maps the legacy OpenCode Part union to durable AI SDK UI parts. */
function messageParts(raw: unknown, approvals: ReadonlyMap<string, string>): UIMessage["parts"] {
  if (!isRecord(raw) || !Array.isArray(raw.parts)) return [];
  return raw.parts.flatMap((part) => openCodePart(part, { approvals }));
}

function transcriptObservationId(message: UIMessage): string {
  const digest = createHash("sha256")
    .update("volli:opencode:transcript:v1\0")
    .update(JSON.stringify(message))
    .digest("hex")
    .slice(0, 24);
  return `message:${message.id}:${digest}`;
}

/** Reads the call a `permission.asked` payload gates, when it gates one at all. */
function approvalTarget(raw: unknown): OpenCodeApprovalTarget | null {
  const tool = nested(raw, "tool");
  const messageId = objectString(tool, "messageID");
  const callId = objectString(tool, "callID");
  return messageId && callId ? { messageId, callId } : null;
}

function openCodePart(
  part: unknown,
  options?: { reasoningStreaming?: boolean; approvals?: ReadonlyMap<string, string> },
): UIMessage["parts"] {
  const type = objectString(part, "type");
  if (type === "text") {
    const text = objectString(part, "text");
    return text === null ? [] : [{ type: "text", text }];
  }
  if (type === "reasoning") {
    const text = objectString(part, "text");
    // OpenCode opens every reasoning part with `text: ""` and serves the same
    // empty string to a mid-stream re-hydrate, because deltas never reach its
    // database. Both project to nothing worth drawing.
    if (text === null || text.trim() === "") return [];
    // `finishReasoning` stamps `time.end` the moment a thought settles, which is
    // its own event — independent of the turn ending or of anything following
    // the part. Trust it over the turn's busy flag, or the renderer's elapsed
    // counter keeps ticking against a thought that finished long ago.
    const settled = Number.isFinite(nested(part, "time")?.end);
    return [
      {
        type: "reasoning",
        text,
        state: options?.reasoningStreaming && !settled ? "streaming" : "done",
      },
    ];
  }
  if (type !== "tool") return [];
  const toolName = objectString(part, "tool");
  const toolCallId = objectString(part, "callID");
  const state = nested(part, "state");
  if (!toolName || !toolCallId || !state) return [];
  const title = objectString(state, "title");
  const base = {
    type: "dynamic-tool" as const,
    toolName,
    toolCallId,
    ...(title ? { title } : {}),
    toolMetadata: openCodeToolMetadata(state, toolName),
  };
  const status = objectString(state, "status");
  // A permission only gates a call still in flight. Once OpenCode reports the
  // call settled that verdict is the newer fact, so the row recovers on its own
  // even if the reply lifting the gate never reached this binding.
  const approvalId =
    status === "pending" || status === "running" ? options?.approvals?.get(toolCallId) : undefined;
  if (approvalId !== undefined) {
    return [
      {
        ...base,
        state: "approval-requested",
        input: state.input ?? null,
        approval: { id: approvalId },
      },
    ];
  }
  switch (status) {
    case "pending":
      return [
        {
          ...base,
          state: "input-streaming",
          ...(Object.hasOwn(state, "input") ? { input: state.input } : {}),
        },
      ];
    // OpenCode has committed the arguments and is executing. That is
    // `input-available` — the state a spinner belongs to.
    case "running":
      return [
        {
          ...base,
          state: "input-available",
          input: state.input ?? null,
        },
      ];
    case "completed":
      return [
        {
          ...base,
          state: "output-available",
          input: state.input ?? null,
          output: state.output ?? null,
        },
      ];
    case "error":
      return [
        {
          ...base,
          state: "output-error",
          input: state.input ?? null,
          errorText: objectString(state, "error") ?? "Tool failed",
        },
      ];
    default:
      return [];
  }
}

function mergeOpenCodePart(previous: unknown, next: Record<string, unknown>): unknown {
  if (
    isRecord(previous) &&
    objectString(previous, "type") === "tool" &&
    objectString(next, "type") === "tool"
  ) {
    const previousState = nested(previous, "state");
    const nextState = nested(next, "state");
    if (!previousState || !nextState) return next;
    return {
      ...previous,
      ...next,
      state: { ...previousState, ...nextState },
    };
  }
  // Deltas only ever append, so a buffer already holding text outranks any
  // snapshot carrying a prefix of it — whether the snapshot omits the field
  // (reasoning opens with type only, then deltas) or spells it as the empty
  // string OpenCode opens with and re-serves on a mid-stream re-hydrate. A
  // snapshot that diverges is genuinely newer and replaces the buffer.
  if (isRecord(previous)) {
    const previousText = objectString(previous, "text");
    const nextText = objectString(next, "text");
    if (previousText && (nextText === null || previousText.startsWith(nextText))) {
      return { ...next, text: previousText };
    }
  }
  return next;
}

/**
 * OpenCode's HTTP/SSE boundary is JSON, so its provider-native metadata is
 * already serializable. Keep it namespaced instead of flattening provider
 * fields into AI SDK's portable tool vocabulary — and stamp the harness-neutral
 * activity descriptor beside it, so the renderer switches on `kind` rather than
 * on OpenCode's tool names.
 */
function openCodeToolMetadata(state: Record<string, unknown>, toolName: string): ToolMetadata {
  const opencode: Record<string, unknown> = {};
  for (const key of ["raw", "metadata", "time", "attachments"] as const) {
    if (Object.hasOwn(state, key) && state[key] !== undefined) opencode[key] = state[key];
  }
  return {
    [ACTIVITY_METADATA_KEY]: openCodeActivity(state, toolName),
    ...(Object.keys(opencode).length > 0 ? { opencode } : {}),
  } as ToolMetadata;
}

/**
 * OpenCode's tool vocabulary, mapped onto the shared activity kinds. Everything
 * absent — including MCP tools, which are named `<server>_<tool>` — is `"other"`,
 * a first-class row rather than a degraded one, so the lookup can never fail.
 */
export const OPENCODE_ACTIVITY: Readonly<Record<string, ActivityKind>> = {
  bash: "run-command",
  read: "read-file",
  edit: "edit-file",
  apply_patch: "edit-file",
  write: "write-file",
  grep: "search",
  glob: "search",
  search: "search",
  websearch: "search",
  list: "list-directory",
  webfetch: "fetch-url",
  todowrite: "plan",
  todoread: "plan",
  todo_write: "plan",
  task: "delegate",
};

export function openCodeActivityKind(toolName: string): ActivityKind {
  return OPENCODE_ACTIVITY[toolName.toLowerCase()] ?? "other";
}

/**
 * Keys that name what a call acted on, most specific first. The trailing sweep
 * over any string scalar is what keeps `"other"` readable: an unmapped MCP tool
 * still gets a subject rather than a blob.
 */
const ACTIVITY_SUBJECT_KEYS = [
  "command",
  "path",
  "filePath",
  "file_path",
  "pattern",
  "query",
  "url",
  "glob",
] as const;

/** Kinds whose subject is a workspace file the UI can open in a tab. */
const ACTIVITY_PATH_KINDS = new Set<ActivityKind>(["read-file", "edit-file", "write-file"]);

const MAX_INFERRED_LABEL_LENGTH = 200;

function openCodeActivity(state: Record<string, unknown>, toolName: string): ActivityDescriptor {
  const kind = openCodeActivityKind(toolName);
  const input = recordAt(state, "input");
  const metadata = recordAt(state, "metadata");
  const time = recordAt(state, "time");
  return {
    kind,
    nativeToolName: toolName,
    subject: openCodeActivitySubject(kind, input, metadata),
    outcome: openCodeActivityOutcome(state, input, metadata),
    startedAt: objectFiniteNumber(time, "start"),
    endedAt: objectFiniteNumber(time, "end"),
  };
}

function openCodeActivitySubject(
  kind: ActivityKind,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): ActivitySubject {
  return {
    label: activityLabel(input),
    path: ACTIVITY_PATH_KINDS.has(kind) ? activityFilePath(input, metadata) : null,
    lineRange: activityLineRange(metadata),
  };
}

function activityLabel(input: Record<string, unknown>): string | null {
  for (const key of ACTIVITY_SUBJECT_KEYS) {
    const named = trimmedString(input[key]);
    if (named) return named;
  }
  // Anything left is an unrecognized argument name. Take the first scalar that
  // still reads as a phrase — never a file body, which would bloat the ledger.
  for (const value of Object.values(input)) {
    const candidate = trimmedString(value);
    if (candidate && candidate.length <= MAX_INFERRED_LABEL_LENGTH && !candidate.includes("\n")) {
      return candidate;
    }
  }
  return null;
}

/**
 * The absolute path OpenCode resolved, when it reported one; otherwise the path
 * the model asked for. `read` reports it under `metadata.display`, `edit` under
 * `metadata.filediff`, `write` under `metadata.filepath`.
 */
function activityFilePath(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string | null {
  return (
    trimmedString(activityFileDisplay(metadata).path) ??
    trimmedString(metadata.filepath) ??
    trimmedString(recordAt(metadata, "filediff").file) ??
    trimmedString(input.filePath) ??
    trimmedString(input.path)
  );
}

/** OpenCode's `read` reports its rendered slice under `metadata.display`. */
function activityFileDisplay(metadata: Record<string, unknown>): Record<string, unknown> {
  const display = recordAt(metadata, "display");
  return display.type === "file" ? display : {};
}

function activityLineRange(
  metadata: Record<string, unknown>,
): { start: number; end: number } | null {
  const display = activityFileDisplay(metadata);
  // A whole-file read has no span worth showing — only a partial one does.
  if (display.truncated !== true) return null;
  const start = objectFiniteNumber(display, "lineStart");
  const end = objectFiniteNumber(display, "lineEnd");
  return start === null || end === null ? null : { start, end };
}

/**
 * Measured results, and only measured ones: a pending or running call has none,
 * and OpenCode reports no byte count or short summary for any tool, so those
 * stay null rather than becoming a zero the UI would render as fact.
 */
function openCodeActivityOutcome(
  state: Record<string, unknown>,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): ActivityOutcome | null {
  const status = objectString(state, "status");
  if (status !== "completed" && status !== "error") return null;
  const filediff = recordAt(metadata, "filediff");
  const display = recordAt(metadata, "display");
  return {
    exitCode: objectFiniteNumber(metadata, "exit"),
    matchCount: objectFiniteNumber(metadata, "matches"),
    fileCount: objectFiniteNumber(metadata, "count") ?? objectFiniteNumber(display, "totalEntries"),
    lineCount: objectFiniteNumber(activityFileDisplay(metadata), "totalLines"),
    bytes: null,
    addedLines: objectFiniteNumber(filediff, "additions") ?? writtenLineCount(metadata, input),
    removedLines: objectFiniteNumber(filediff, "deletions"),
    diff: trimmedString(metadata.diff),
    summary: null,
  };
}

/**
 * `write` reports no diff, but a file it created did not exist a moment ago —
 * every line of the content it was handed is an addition. An overwrite is not
 * countable this way, so it reports nothing.
 */
function writtenLineCount(
  metadata: Record<string, unknown>,
  input: Record<string, unknown>,
): number | null {
  if (metadata.exists !== false) return null;
  return typeof input.content === "string" ? input.content.split("\n").length : null;
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : {};
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isReconciliationAcknowledgement(
  cursor: SessionNativeDetail | null,
  token: string,
): boolean {
  return (
    isRecord(cursor) &&
    objectString(cursor, "kind") === "volli.opencode.reconciliation.v1" &&
    objectString(cursor, "token") === token
  );
}

function turnStatusForObservation(observation: OpenCodeStatusObservation): "busy" | "idle" | null {
  if (observation.kind === "turn.started") return "busy";
  if (observation.kind === "turn.completed") return "idle";
  return null;
}

function statusSignatureForObservation(observation: OpenCodeStatusObservation): string | null {
  if (observation.kind === "turn.started") return "busy";
  if (observation.kind === "turn.completed") return "idle";
  if (observation.attention.kind !== "transport_retrying") return null;
  return `retry:${observation.attention.detail ?? ""}:${JSON.stringify(
    observation.attention.diagnostic ?? null,
  )}`;
}

function catalogItems(
  kind: SessionCapabilityCatalogItem["kind"],
  body: unknown,
): readonly SessionCapabilityCatalogItem[] {
  if (kind === "model") return modelCatalogItems(body);
  if (kind === "mcp") return mcpCatalogItems(body);
  if (kind === "tool") return toolCatalogItems(body);
  const entries = isRecord(body) && Array.isArray(body.all) ? body.all : arrayBody(body);
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = objectString(entry, "id") ?? objectString(entry, "name");
    if (!id) return [];
    return [
      {
        kind,
        id,
        label: objectString(entry, "name") ?? objectString(entry, "label") ?? id,
        state: "available" as const,
        evidence: "reported" as const,
        detail: catalogDetail(kind, entry),
      },
    ];
  });
}

function modelCatalogItems(body: unknown): readonly SessionCapabilityCatalogItem[] {
  if (!isRecord(body)) return [];
  const providers = Array.isArray(body.all) ? body.all : [];
  const connected = new Set(
    Array.isArray(body.connected)
      ? body.connected.filter((id): id is string => typeof id === "string")
      : [],
  );
  return providers.flatMap((provider) => {
    const providerId = objectString(provider, "id");
    const models = nested(provider, "models");
    if (!providerId || !models) return [];
    return Object.entries(models).flatMap(([modelKey, model]) => {
      const modelId = objectString(model, "id") ?? modelKey;
      if (!modelId) return [];
      const variants = nested(model, "variants");
      return [
        {
          kind: "model" as const,
          id: `${providerId}/${modelId}`,
          label: objectString(model, "name") ?? modelId,
          state: connected.has(providerId) ? ("available" as const) : ("unavailable" as const),
          evidence: "reported" as const,
          detail: {
            providerId,
            modelId,
            ...(objectString(model, "family") ? { family: objectString(model, "family") } : {}),
            ...(objectString(model, "status") ? { status: objectString(model, "status") } : {}),
            variants: variants ? Object.keys(variants) : [],
          },
        },
      ];
    });
  });
}

function mcpCatalogItems(body: unknown): readonly SessionCapabilityCatalogItem[] {
  if (!isRecord(body)) return [];
  return Object.entries(body).map(([id, raw]) => {
    const status = objectString(raw, "status");
    const detail: SessionNativeDetail = status ? { status } : {};
    return {
      kind: "mcp" as const,
      id,
      label: id,
      state:
        status === "connected"
          ? ("available" as const)
          : status
            ? ("unavailable" as const)
            : ("unknown" as const),
      evidence: "reported" as const,
      detail,
    };
  });
}

function toolCatalogItems(body: unknown): readonly SessionCapabilityCatalogItem[] {
  return arrayBody(body)
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({
      kind: "tool" as const,
      id,
      label: id,
      state: "available" as const,
      evidence: "reported" as const,
      detail: null,
    }));
}

function catalogDetail(
  kind: "agent" | "command" | "skill",
  entry: Record<string, unknown>,
): SessionNativeDetail | null {
  if (kind === "skill") {
    const description = objectString(entry, "description");
    return description ? { description } : null;
  }
  if (kind === "agent") {
    const model = nested(entry, "model");
    return compactDetail({
      description: objectString(entry, "description"),
      mode: objectString(entry, "mode"),
      native: typeof entry.native === "boolean" ? entry.native : null,
      hidden: typeof entry.hidden === "boolean" ? entry.hidden : null,
      model:
        model && objectString(model, "providerID") && objectString(model, "modelID")
          ? {
              providerId: objectString(model, "providerID"),
              modelId: objectString(model, "modelID"),
            }
          : null,
      variant: objectString(entry, "variant"),
    });
  }
  return compactDetail({
    description: objectString(entry, "description"),
    source: objectString(entry, "source"),
    agent: objectString(entry, "agent"),
    model: objectString(entry, "model"),
    subtask: typeof entry.subtask === "boolean" ? entry.subtask : null,
    hints: Array.isArray(entry.hints)
      ? entry.hints.filter((hint): hint is string => typeof hint === "string")
      : null,
  });
}

function compactDetail(
  values: Readonly<Record<string, SessionNativeDetail | null>>,
): SessionNativeDetail | null {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, SessionNativeDetail] => entry[1] !== null,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/* v8 ignore start -- Node and fetch ports are platform glue; adapter behavior is covered through injected ports. */
function createNodeProcessPort(): OpenCodeProcessPort {
  return {
    resolveBinary: resolveExecutable,
    version: async (path, signal) => {
      const child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      const code = await new Promise<number | null>((resolve, reject) => {
        const abort = () => child.kill();
        signal.addEventListener("abort", abort, { once: true });
        child.once("error", reject);
        child.once("exit", (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        });
      });
      if (code !== 0) throw new Error(`OpenCode --version exited ${code ?? "without a code"}`);
      return Buffer.concat(output).toString("utf8").trim();
    },
    sha256: async (path) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    spawn: async ({ path, args, env }) => {
      const child = spawn(path, [...args], { env: { ...process.env, ...env }, stdio: "ignore" });
      return {
        exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))),
        stop: async () => {
          child.kill();
        },
      };
    },
    allocatePort: async () =>
      new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close();
            reject(new Error("Could not allocate loopback port"));
            return;
          }
          server.close((error) => (error ? reject(error) : resolve(address.port)));
        });
      }),
    randomSecret: () => randomBytes(32).toString("base64url"),
  };
}

async function resolveExecutable(path: string): Promise<string> {
  if (isAbsolute(path) || path.includes("/")) return realpath(path);
  const directories = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
  for (const directory of directories) {
    const candidate = join(directory, path);
    try {
      await access(candidate, constants.X_OK);
      return realpath(candidate);
    } catch {
      // Continue until the first executable in PATH, exactly as shell lookup does.
    }
  }
  throw new Error(`OpenCode executable ${path} was not found on PATH`);
}

function createFetchNetworkPort(): OpenCodeNetworkPort {
  return {
    request: async ({ baseUrl, path, method, headers, body, signal }) => {
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        signal: requestSignal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let decoded: unknown = null;
      if (text) {
        try {
          decoded = JSON.parse(text) as unknown;
        } catch {
          decoded = text;
        }
      }
      return { status: response.status, body: decoded };
    },
    subscribe: async ({ baseUrl, path, headers, signal }) => {
      const response = await fetch(`${baseUrl}${path}`, { headers, signal });
      if (!response.ok || !response.body)
        throw new Error(`OpenCode event stream returned ${response.status}`);
      return parseOpenCodeSse(response.body);
    },
  };
}
/* v8 ignore stop */

/** Exported test seam for the legacy, data-only OpenCode `/event` stream. */
export async function* parseOpenCodeSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<OpenCodeSseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_LENGTH)
        throw new Error("OpenCode SSE frame exceeded the 1 MiB safety limit");
      const parsed = consumeSseBlocks(buffer);
      buffer = parsed.rest;
      yield* parsed.events;
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  if (buffer) yield* decodeSseBlock(buffer);
}

function consumeSseBlocks(buffer: string): { rest: string; events: readonly OpenCodeSseEvent[] } {
  const events: OpenCodeSseEvent[] = [];
  let rest = buffer;
  let boundary = rest.search(/\r?\n\r?\n/);
  while (boundary !== -1) {
    const block = rest.slice(0, boundary);
    const separator = rest[boundary] === "\r" ? 4 : 2;
    events.push(...decodeSseBlock(block));
    rest = rest.slice(boundary + separator);
    boundary = rest.search(/\r?\n\r?\n/);
  }
  return { rest, events };
}

function decodeSseBlock(block: string): readonly OpenCodeSseEvent[] {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return [];
  try {
    const decoded: unknown = JSON.parse(data);
    if (!isRecord(decoded) || typeof decoded.id !== "string" || typeof decoded.type !== "string")
      return [];
    return [{ id: decoded.id, type: decoded.type, properties: decoded.properties }];
  } catch {
    return [];
  }
}

function eventSessionId(properties: unknown): string | null {
  return (
    objectString(properties, "sessionID") ??
    objectString(nested(properties, "info"), "sessionID") ??
    objectString(nested(properties, "part"), "sessionID")
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
