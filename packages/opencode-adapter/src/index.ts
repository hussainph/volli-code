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
import type {
  SessionCapabilityCatalogItem,
  SessionInteraction,
  SessionNativeDetail,
  SessionNativeReference,
} from "@volli/shared";
type UIMessage = Extract<HarnessCommand, { kind: "message.submit" }>["message"];

const DIRECTORY_QUERY = "directory";
const ADAPTER_ID = "opencode";

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
}

interface ServerLease {
  readonly baseUrl: string;
  readonly password: string;
  readonly child: OpenCodeChild;
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
      const path = await this.#process.resolveBinary(this.#binaryPath);
      const [version, fingerprint] = await Promise.all([
        this.#process.version(path, signal),
        this.#process.sha256(path),
      ]);
      const server = await this.#ensureServer();
      await this.#waitForHealth(server);
      this.#throwIfClosed();
      return {
        status: "available",
        runtime: { path, version, fingerprint },
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
    const path = await this.#process.resolveBinary(this.#binaryPath);
    const port = await this.#process.allocatePort();
    const password = this.#process.randomSecret();
    const child = await this.#process.spawn({
      path,
      // `--no-mdns` and omitted `--cors` keep discovery and browser origins disabled.
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--no-mdns"],
      env: { OPENCODE_SERVER_PASSWORD: password },
    });
    return { baseUrl: `http://127.0.0.1:${port}`, password, child };
  }

  async #waitForHealth(server: ServerLease): Promise<OpenCodeHttpResponse> {
    let last: OpenCodeHttpResponse | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.#healthRetryAttempts; attempt += 1) {
      try {
        const health = await this.#request(server, "/global/health", "GET");
        last = health;
        if (health.status >= 200 && health.status < 300) return health;
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < this.#healthRetryAttempts) await this.#sleep(this.#healthRetryDelayMs);
    }
    if (last) throw new Error(`OpenCode health check returned ${last.status}`);
    throw lastError instanceof Error ? lastError : new Error("OpenCode health check failed");
  }

  async #stopChild(child: OpenCodeChild): Promise<void> {
    await Promise.race([child.stop().then(() => child.exited), this.#sleep(this.#stopTimeoutMs)]);
  }

  async #request(server: ServerLease, path: string, method: "GET" | "POST", body?: unknown) {
    return this.#network.request({
      baseUrl: server.baseUrl,
      path,
      method,
      headers: authHeaders(server.password),
      ...(body === undefined ? {} : { body }),
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
  onRelease: () => void;
}

interface BufferedOpenCodeMessage {
  readonly id: string;
  role: ReturnType<typeof messageRole> | null;
  readonly partOrder: string[];
  readonly parts: Map<string, unknown>;
}

class OpenCodeBinding implements BindingHandle {
  readonly native;
  readonly #server: ServerLease;
  readonly #spec: NativeAttachmentSpec;
  readonly #nativeSessionId: string;
  readonly #network: OpenCodeNetworkPort;
  readonly #now: () => number;
  readonly #onRelease: () => void;
  readonly #seen = new Set<string>();
  readonly #streamEventsSeen = new Set<string>();
  readonly #messages = new Map<string, BufferedOpenCodeMessage>();
  readonly #questions = new Map<string, readonly OpenCodeQuestion[]>();
  readonly #streamAbort = new AbortController();
  #sink: ObservationSink | null = null;
  #released = false;
  #cursor: SessionNativeDetail | null = null;
  #importNativeHistory: boolean;

  constructor(options: BindingOptions) {
    this.#server = options.server;
    this.#spec = options.spec;
    this.#nativeSessionId = options.nativeSessionId;
    this.#network = options.network;
    this.#now = options.now;
    this.#onRelease = options.onRelease;
    this.native = { id: options.nativeSessionId, detail: null };
    this.#importNativeHistory = options.spec.continuity === "native_resume";
  }

  async start(sink: ObservationSink): Promise<void> {
    this.#sink = sink;
    const stream = await this.#network.subscribe({
      baseUrl: this.#server.baseUrl,
      path: withDirectory("/event", this.#spec.directory),
      headers: authHeaders(this.#server.password),
      signal: this.#streamAbort.signal,
    });
    // #pump contains both source and sink failures before this detached task
    // settles, so a transient durable-store failure cannot escape the main process.
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
    const [messages, status, permissionResponse, questionResponse] = await Promise.all([
      this.#request(`/session/${encodeURIComponent(this.#nativeSessionId)}/message`, "GET"),
      this.#request("/session/status", "GET"),
      this.#request("/permission", "GET").catch(() => ({ status: 404, body: [] })),
      this.#request("/question", "GET").catch(() => ({ status: 404, body: [] })),
    ]);
    const observations: HarnessObservation[] = [];
    const importNativeHistory = this.#importNativeHistory;
    for (const message of messageResponses(messages.body)) {
      const info = nested(message, "info") ?? message;
      const id = objectString(info, "id");
      if (id && !this.#seen.has(reconciledMessageKey(id))) {
        const role = messageRole(info);
        this.#messages.delete(id);
        this.#seen.add(reconciledMessageKey(id));
        if (role !== "user" || importNativeHistory) {
          const observation = this.#messageObservation(`message:${id}`, id, role, message);
          if (observation.message.parts.length > 0) this.#pushUnique(observations, observation);
        }
      }
    }
    this.#importNativeHistory = false;
    for (const permission of arrayBody(permissionResponse.body).filter((candidate) =>
      hasSessionId(candidate, this.#nativeSessionId),
    )) {
      const observation = this.#interactionObservation(
        "permission.asked",
        permission,
        `permission:${objectString(permission, "id") ?? "unknown"}`,
      );
      if (observation) this.#pushUnique(observations, observation);
    }
    for (const question of arrayBody(questionResponse.body).filter((candidate) =>
      hasSessionId(candidate, this.#nativeSessionId),
    )) {
      const observation = this.#interactionObservation(
        "question.asked",
        question,
        `question:${objectString(question, "id") ?? "unknown"}`,
      );
      if (observation) this.#pushUnique(observations, observation);
    }
    const statusObservation = this.#statusObservation("reconcile:status", status.body);
    if (statusObservation) this.#pushUnique(observations, statusObservation);
    return {
      cursor: this.#cursor ?? cursor ?? { eventId: null },
      observations,
      receipts: [],
    };
  }

  async release(_reason: ReleaseReason): Promise<void> {
    this.#released = true;
    this.#streamAbort.abort();
    this.#sink = null;
    this.#messages.clear();
    this.#onRelease();
  }

  async #pump(stream: AsyncIterable<OpenCodeSseEvent>): Promise<void> {
    let disconnected: string | null = "OpenCode event stream ended";
    try {
      for await (const event of stream) {
        if (this.#released) return;
        if (this.#streamEventsSeen.has(event.id)) continue;
        await this.#handleEvent(event);
        this.#streamEventsSeen.add(event.id);
      }
    } catch (error) {
      disconnected = error instanceof Error ? error.message : "OpenCode event stream disconnected";
    }
    if (!this.#released) {
      await this.#emitDisconnected(disconnected);
    }
  }

  async #emitDisconnected(disconnectDetail: string | null): Promise<void> {
    try {
      await this.#flushMessages(`opencode:sse-final:${this.#nativeSessionId}`);
    } catch {
      // Continue to the independently identified attention and terminal facts.
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
    if (this.#released) return;
    try {
      await this.#emit({
        id: `opencode:sse-binding-failed:${this.#nativeSessionId}`,
        kind: "attachment.failed",
        occurredAt: this.#now(),
        detail: disconnectDetail,
      });
    } catch {
      // The detached pump must not surface a durable-store failure as an
      // unhandled rejection. There is no safe further delivery path.
      this.#sink = null;
    }
  }

  async #emit(observation: HarnessObservation): Promise<void> {
    /* v8 ignore next -- a released binding exits its pump before another observation can enter. */
    if (!this.#sink) return;
    await this.#sink.emit(observation);
    this.#remember(observation);
    this.#cursor = observation.cursor ?? { eventId: observation.id };
  }

  #pushUnique(target: HarnessObservation[], observation: HarnessObservation): void {
    if (this.#isSeen(observation)) return;
    this.#remember(observation);
    this.#cursor = observation.cursor ?? { eventId: observation.id };
    target.push(observation);
  }

  #isSeen(observation: HarnessObservation): boolean {
    return this.#seen.has(observation.id);
  }

  #remember(observation: HarnessObservation): void {
    this.#seen.add(observation.id);
  }

  async #handleEvent(event: OpenCodeSseEvent): Promise<void> {
    const sessionId = objectString(event.properties, "sessionID");
    if (sessionId !== this.#nativeSessionId) return;
    switch (event.type) {
      case "message.updated":
        this.#bufferMessage(event.properties);
        return;
      case "message.part.updated":
        this.#bufferPart(event.properties);
        return;
      case "message.part.delta":
        this.#applyPartDelta(event.properties);
        return;
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
        if (observation) await this.#emit(observation);
        return;
      }
      case "permission.asked":
      case "question.asked": {
        const observation = this.#interactionObservation(event.type, event.properties, event.id);
        if (observation) await this.#emit(observation);
        return;
      }
      case "permission.replied":
      case "question.replied":
      case "question.rejected": {
        const observation = this.#resolvedInteractionObservation(event);
        if (observation) await this.#emit(observation);
        return;
      }
      default:
        return;
    }
  }

  #bufferMessage(raw: unknown): void {
    const info = nested(raw, "info") ?? raw;
    const messageId = objectString(info, "id");
    if (!messageId) return;
    const message = this.#message(messageId);
    const role = explicitMessageRole(info);
    if (role) message.role = role;
    if (!isRecord(raw) || !Array.isArray(raw.parts)) return;
    message.parts.clear();
    message.partOrder.length = 0;
    raw.parts.forEach((part, index) => {
      const partId = objectString(part, "id") ?? `snapshot:${index}`;
      message.partOrder.push(partId);
      message.parts.set(partId, part);
    });
  }

  #bufferPart(raw: unknown): void {
    const part = nested(raw, "part");
    if (!part) return;
    const messageId = objectString(raw, "messageID") ?? objectString(part, "messageID");
    const partId = objectString(part, "id");
    if (!messageId || !partId) return;
    const message = this.#message(messageId);
    if (!message.parts.has(partId)) message.partOrder.push(partId);
    message.parts.set(partId, part);
  }

  #applyPartDelta(raw: unknown): void {
    const messageId = objectString(raw, "messageID");
    const partId = objectString(raw, "partID");
    const field = objectString(raw, "field");
    const delta = objectString(raw, "delta");
    if (!messageId || !partId || field !== "text" || delta === null) return;
    const message = this.#messages.get(messageId);
    const part = message?.parts.get(partId);
    if (!message || !isRecord(part)) return;
    message.parts.set(partId, {
      ...part,
      [field]: `${objectString(part, field) ?? ""}${delta}`,
    });
  }

  #message(messageId: string): BufferedOpenCodeMessage {
    let message = this.#messages.get(messageId);
    if (!message) {
      message = { id: messageId, role: null, partOrder: [], parts: new Map() };
      this.#messages.set(messageId, message);
    }
    return message;
  }

  async #flushMessages(triggerId: string): Promise<void> {
    for (const [messageId, buffered] of this.#messages) {
      if (!buffered.role) {
        this.#messages.delete(messageId);
        continue;
      }
      if (buffered.role === "user") {
        this.#seen.add(reconciledMessageKey(messageId));
        this.#messages.delete(messageId);
        continue;
      }
      const parts = buffered.partOrder.flatMap((partId) =>
        openCodePart(buffered.parts.get(partId)),
      );
      if (parts.length === 0) {
        this.#seen.add(reconciledMessageKey(messageId));
        this.#messages.delete(messageId);
        continue;
      }
      const message: UIMessage = { id: messageId, role: buffered.role, parts };
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
      this.#seen.add(reconciledMessageKey(messageId));
      this.#messages.delete(messageId);
    }
  }

  #messageObservation(
    id: string,
    messageId: string,
    role: ReturnType<typeof messageRole>,
    raw: unknown,
  ): Extract<HarnessObservation, { kind: "transcript.message" }> {
    const message: UIMessage = { id: messageId, role, parts: messageParts(raw) };
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

  #statusObservation(
    id: string,
    raw: unknown,
    eventType = "session.status",
  ): HarnessObservation | null {
    if (eventType === "session.error") {
      return {
        id,
        kind: "attention.raised",
        occurredAt: this.#now(),
        attention: {
          id: `opencode:error:${id}`,
          kind: "adapter_unrecoverable",
          detail: objectString(nested(raw, "error") ?? raw, "message"),
          diagnostic: detail(raw),
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
    if (status === "busy")
      return {
        id,
        kind: "turn.started",
        occurredAt: this.#now(),
        turnId: `turn:${this.#nativeSessionId}`,
      };
    if (status === "idle")
      return {
        id,
        kind: "turn.completed",
        occurredAt: this.#now(),
        turnId: `turn:${this.#nativeSessionId}`,
      };
    if (status === "retry") {
      return {
        id,
        kind: "attention.raised",
        occurredAt: this.#now(),
        attention: {
          id: `opencode:retry:${id}`,
          kind: "transport_retrying",
          detail: objectString(nested(raw, "status") ?? raw, "message"),
          diagnostic: detail(raw),
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
              { id: "once", label: "Allow once" },
              { id: "always", label: "Allow always" },
              { id: "reject", label: "Reject" },
            ]
          : questionOptions(raw),
      multiple: kind === "question",
      native: { id: nativeId, detail: kind === "question" ? questionDetail(questions(raw)) : null },
    };
    if (kind === "question") this.#questions.set(nativeId, questions(raw));
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

function detail(value: unknown): SessionNativeDetail | null {
  return isSessionNativeDetail(value) ? value : null;
}

function isSessionNativeDetail(value: unknown): value is SessionNativeDetail {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isSessionNativeDetail);
  return isRecord(value) && Object.values(value).every(isSessionNativeDetail);
}

function messageRole(raw: unknown): "system" | "user" | "assistant" {
  return explicitMessageRole(raw) ?? "assistant";
}

function explicitMessageRole(raw: unknown): "system" | "user" | "assistant" | null {
  const role = objectString(raw, "role");
  return role === "system" || role === "user" || role === "assistant" ? role : null;
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
): readonly { id: string; label: string; description?: string }[] {
  return questions(raw).flatMap((question, questionIndex) =>
    question.options.map((option) => ({
      id: questionOptionId(questionIndex, option.value),
      label:
        question.label === `Question ${questionIndex + 1}`
          ? option.label
          : `${question.label}: ${option.label}`,
      ...(option.description ? { description: option.description } : {}),
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

/**
 * Maps the legacy OpenCode Part union to transcript-safe AI SDK UI parts.
 * Tool inputs, outputs, raw pending text, metadata, and errors can contain
 * secrets, so a tool is represented only by its identity and lifecycle state.
 */
function messageParts(raw: unknown): UIMessage["parts"] {
  if (!isRecord(raw) || !Array.isArray(raw.parts)) return [];
  return raw.parts.flatMap((part) => openCodePart(part));
}

function transcriptObservationId(message: UIMessage): string {
  const digest = createHash("sha256")
    .update("volli:opencode:transcript:v1\0")
    .update(JSON.stringify(message))
    .digest("hex")
    .slice(0, 24);
  return `message:${message.id}:${digest}`;
}

function openCodePart(part: unknown): UIMessage["parts"] {
  const type = objectString(part, "type");
  if (type === "text") {
    const text = objectString(part, "text");
    return text === null ? [] : [{ type: "text", text }];
  }
  if (type === "reasoning") {
    const text = objectString(part, "text");
    return text === null ? [] : [{ type: "reasoning", text }];
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
  };
  switch (objectString(state, "status")) {
    case "pending":
    case "running":
      return [{ ...base, state: "input-streaming" }];
    case "completed":
      return [{ ...base, state: "output-available", input: null, output: null }];
    case "error":
      return [{ ...base, state: "output-error", input: null, errorText: "Tool failed" }];
    default:
      return [];
  }
}

function reconciledMessageKey(messageId: string): string {
  return `reconcile:message:${messageId}`;
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
      detail: {
        ...(status ? { status } : {}),
        ...(objectString(raw, "error") ? { error: objectString(raw, "error") } : {}),
      },
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
    request: async ({ baseUrl, path, method, headers, body }) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
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
    rest = rest.slice(separator);
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

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
