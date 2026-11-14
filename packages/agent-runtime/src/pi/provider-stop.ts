/** Read only provider-returned fields, never classify prose (VC-482). */
import type { AssistantMessage, JsonObject, ProviderResponse } from "@earendil-works/pi-ai";
import {
  SESSION_CREDENTIAL_STOP_TYPES,
  type SessionRuntimeSpec,
  type SessionStopCategory,
  type SessionStopDetail,
} from "@volli/shared";
import { safeStopMessage } from "./safe-diagnostic";
export { safeStopMessage } from "./safe-diagnostic";

type RedactionPort = SessionRuntimeSpec["credentialRedaction"];

const TYPES: Readonly<Record<string, SessionStopCategory>> = {
  refusal: "provider-refused",
  sensitive: "provider-refused",
  SAFETY: "provider-refused",
  BLOCKLIST: "provider-refused",
  PROHIBITED_CONTENT: "provider-refused",
  content_filter: "provider-refused",
  "incomplete.content_filter": "provider-refused",
  content_policy_violation: "provider-refused",
  overloaded_error: "provider-overloaded",
  server_overloaded: "provider-overloaded",
  rate_limit_error: "rate-limited",
  rate_limit_exceeded: "rate-limited",
  usage_limit_reached: "rate-limited",
  usage_not_included: "rate-limited",
  insufficient_quota: "rate-limited",
  quota_exceeded: "rate-limited",
  RESOURCE_EXHAUSTED: "rate-limited",
  authentication_error: "auth-failed",
  invalid_api_key: "auth-failed",
  permission_error: "auth-failed",
  UNAUTHENTICATED: "auth-failed",
  PERMISSION_DENIED: "auth-failed",
  [SESSION_CREDENTIAL_STOP_TYPES.missing]: "auth-failed",
  [SESSION_CREDENTIAL_STOP_TYPES.refreshFailed]: "auth-failed",
  [SESSION_CREDENTIAL_STOP_TYPES.unavailable]: "auth-failed",
  // Anthropic's 402: payment or billing, a spent allowance by another name.
  billing_error: "rate-limited",
  invalid_request_error: "bad-request",
  INVALID_ARGUMENT: "bad-request",
  // A model this account is not served (Anthropic, OpenAI, Google wording).
  not_found_error: "bad-request",
  model_not_found: "bad-request",
  NOT_FOUND: "bad-request",
  context_length_exceeded: "context-overflow",
  context_window_exceeded: "context-overflow",
  ECONNRESET: "network",
  ETIMEDOUT: "network",
  ECONNREFUSED: "network",
  ENOTFOUND: "network",
  EPIPE: "network",
  EAI_AGAIN: "network",
  UND_ERR_SOCKET: "network",
  UND_ERR_CONNECT_TIMEOUT: "network",
  UND_ERR_HEADERS_TIMEOUT: "network",
  UND_ERR_BODY_TIMEOUT: "network",
  APIConnectionError: "network",
  APIConnectionTimeoutError: "network",
  "volli.stream-stalled": "runtime-stopped",
  "volli.runtime-error": "runtime-stopped",
};
function categoryFor(type: string): SessionStopCategory | undefined {
  return Object.hasOwn(TYPES, type) ? TYPES[type] : undefined;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function instant(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/** The sidecar needs only the diagnostic facts used by reasoning recovery.
 * All other diagnostics (errors, stacks, payloads, headers) are withheld after
 * stop capture. Even a known diagnostic's arbitrary extension fields stay out.
 */
export function safeProviderMessage(
  message: AssistantMessage,
  port?: RedactionPort,
  refused = false,
): AssistantMessage {
  const { diagnostics, errorMessage, rawStopReason } = message;
  // Failed replies are not replayable protocol state. Keep billing and identity,
  // but withhold content and arbitrary SDK extensions that can echo a request.
  const safe: AssistantMessage =
    refused || message.stopReason === "error" || message.stopReason === "aborted"
      ? {
          role: "assistant",
          content: [],
          api: message.api,
          provider: message.provider,
          model: message.model,
          usage: message.usage,
          stopReason: message.stopReason,
          timestamp: message.timestamp,
        }
      : { ...message };
  delete safe.diagnostics;
  delete safe.errorMessage;
  delete safe.rawStopReason;
  if (errorMessage !== undefined) safe.errorMessage = safeStopMessage(errorMessage, port);
  if (rawStopReason !== undefined)
    safe.rawStopReason = safeStopMessage(rawStopReason, port).slice(0, 80);
  const selected = diagnostics?.flatMap((diagnostic) => {
    if (diagnostic.type !== "anthropic_input_transformations") return [];
    const values = diagnostic.details?.["transformations"];
    if (!Array.isArray(values)) return [];
    return [
      {
        type: "anthropic_input_transformations",
        timestamp: instant(diagnostic.timestamp) ?? 0,
        details: {
          transformations: values
            .filter((value) => value !== null && typeof value === "object" && !Array.isArray(value))
            .map((value) => {
              const entry = record(value);
              const type =
                entry["type"] === "prefix_binding_mismatch" ||
                entry["type"] === "model_binding_mismatch"
                  ? entry["type"]
                  : "unknown";
              const path = text(entry["path"]);
              const transformation: JsonObject = { type };
              if (
                path !== null &&
                path.length <= 160 &&
                /^messages\.\d+\.content\.\d+$/.test(path)
              ) {
                transformation["path"] = safeStopMessage(path, port);
              }
              return transformation;
            }),
        },
      },
    ];
  });
  if (selected !== undefined && selected.length > 0) safe.diagnostics = selected;
  return safe;
}

/** One request's small accumulator. Raw events and headers are never retained. */
export class ProviderStopCapture {
  constructor(private readonly redaction?: RedactionPort) {}

  #type: string | null = null;
  /** Why no credential could be had for this request, before anything was sent. */
  #credential: string | null = null;
  /**
   * Whether this request reached the wire: a fetch began, a response arrived,
   * or the provider streamed an event. A credential cause is only ever the
   * answer when nothing did — a request that went out has its own facts, and
   * they win.
   */
  #sent = false;
  #message: string | null = null;
  #status: number | null = null;
  #resetsAt: number | null = null;
  #bodyResetsAt: number | null = null;

  /**
   * Resolve this request's credential first, and keep why it could not be had.
   *
   * Pi resolves auth inside the stream's setup and, when that throws, reports
   * the stream as failed with nothing but the thrown sentence: the typed
   * `ModelsError.code` is gone, no request was sent, so no status or provider
   * type exists either. A refused OAuth refresh's sentence embeds the token
   * endpoint's JSON body, which the privacy filter rightly withholds — and a
   * stop with no type, no status and withheld prose read as `unknown`
   * (VC-1236). Resolving through Pi's public `getAuth` first keeps the code as
   * a fact. The failure is rethrown unchanged, so Pi's own failure stays the
   * stream's failure and no second refresh is attempted.
   *
   * `missing` is the caller's reading of a resolution that answered nothing
   * for a provider Pi knows: the case Pi's own request setup refuses as "not
   * configured". It is recorded only as a candidate; {@link detail} uses it
   * only when no request went out.
   */
  async credential(resolve: () => Promise<{ missing: boolean }>): Promise<void> {
    this.#credential = null;
    let resolved: { missing: boolean };
    try {
      resolved = await resolve();
    } catch (error) {
      const code = record(error)["code"];
      this.#credential =
        code === "oauth"
          ? SESSION_CREDENTIAL_STOP_TYPES.refreshFailed
          : code === "auth"
            ? SESSION_CREDENTIAL_STOP_TYPES.unavailable
            : null;
      throw error;
    }
    if (resolved.missing) this.#credential = SESSION_CREDENTIAL_STOP_TYPES.missing;
  }

  /** Preserve error facts before an SDK replaces them with friendly prose. */
  fetch(inner: typeof globalThis.fetch, now: () => number): typeof globalThis.fetch {
    return async (input, init) => {
      this.#sent = true;
      this.#type = null;
      this.#message = null;
      this.#status = null;
      this.#resetsAt = null;
      this.#bodyResetsAt = null;
      let response: Response;
      try {
        response = await inner(input, init);
      } catch (error) {
        const cause = record(error instanceof Error && "cause" in error ? error.cause : error);
        const type = text(cause["code"]) ?? (error instanceof Error ? error.name : null);
        if (type !== null) this.#type = type;
        throw error;
      }
      this.response(
        {
          status: response.status,
          headers: { "retry-after": response.headers.get("retry-after") ?? "" },
        },
        now(),
      );
      if (!response.ok) {
        const reader = response.clone().body?.getReader();
        if (reader !== undefined) {
          const abort = () => {
            void reader.cancel().catch(() => undefined);
          };
          const signal = init?.signal;
          signal?.addEventListener("abort", abort, { once: true });
          let raw = "";
          let bytes = 0;
          const decoder = new TextDecoder();
          try {
            while (true) {
              if (signal?.aborted) break;
              const part = await reader.read();
              if (part.done) {
                raw += decoder.decode();
                break;
              }
              bytes += part.value.byteLength;
              if (bytes > 8192) {
                raw = "";
                break;
              }
              raw += decoder.decode(part.value, { stream: true });
            }
            if (raw.length > 0) this.#read(JSON.parse(raw));
          } catch {
            /* Body failure must never replace the provider's failure. */
          } finally {
            signal?.removeEventListener("abort", abort);
            void reader.cancel().catch(() => undefined);
          }
        }
      }
      return response;
    };
  }

  response(response: ProviderResponse, now: number): void {
    this.#sent = true;
    this.#status = response.status;
    // Select only a retry instant. Never copy the header map into a fact.
    const retry = response.headers["retry-after"];
    if (retry !== undefined && retry.trim().length > 0) {
      const seconds = Number(retry);
      const at =
        Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(retry);
      this.#resetsAt = instant(at);
    }
  }

  /** One event the provider streamed for this request. */
  event(value: unknown): void {
    this.#sent = true;
    this.#read(value);
  }

  /** Read one provider error/stop shape, from the stream, a body or an SDK envelope. */
  #read(value: unknown): void {
    const event = record(value);
    const response = record(event["response"]);
    const delta = record(event["delta"]);
    const error = record(event["error"] ?? response["error"]);
    const incomplete = record(response["incomplete_details"]);
    const code = text(error["code"]);
    const errorType = text(error["type"]) ?? text(error["status"]);
    const topType = text(event["type"]);
    const topCode = text(event["code"]);
    const type =
      (code !== null && categoryFor(code) !== undefined ? code : (errorType ?? code)) ??
      (event["type"] === "error" ? text(event["code"]) : null) ??
      text(delta["stop_reason"]) ??
      text(incomplete["reason"]) ??
      (topCode !== null && categoryFor(topCode) !== undefined ? topCode : null) ??
      (topType !== null && categoryFor(topType) !== undefined ? topType : null);
    if (type !== null) this.#type = type;
    if (event["type"] === "response.refusal.done" || event["type"] === "response.refusal.delta")
      this.#type = "refusal";
    const message =
      text(error["message"]) ??
      (event["type"] === "error" || (type !== null && categoryFor(type) !== undefined)
        ? text(event["message"])
        : null) ??
      text(record(delta["stop_details"])["explanation"]) ??
      (event["type"] === "response.refusal.done" ? text(event["refusal"]) : null);
    if (message !== null) this.#message = safeStopMessage(message, this.redaction);
    // Codex usage_limit_reached gives resets_at in epoch seconds.
    const reset = instant(error["resets_at"] ?? event["resets_at"]);
    if (reset !== null) this.#bodyResetsAt = instant(reset * 1000);
  }

  detail(message: AssistantMessage): SessionStopDetail {
    // SDK HTTP errors sometimes arrive as a JSON envelope in errorMessage.
    // Parse that envelope, not its English sentence; plain prose supplies no type.
    const raw = message.errorMessage ?? "";
    const envelope = /^(?:(\d{3})\s*:?[ ]*)?(\{[\s\S]*\})$/.exec(raw);
    if (envelope !== null) {
      try {
        this.#read(JSON.parse(envelope[2]!));
        if (envelope[1] !== undefined && this.#status === null) this.#status = Number(envelope[1]);
      } catch {
        /* Malformed prose is not evidence. */
      }
    }
    let type =
      message.rawStopReason === "volli.stream-stalled" ||
      message.rawStopReason === "volli.runtime-error"
        ? message.rawStopReason
        : ((this.#sent ? null : this.#credential) ?? this.#type ?? message.rawStopReason ?? null);
    // A diagnostic is historical unless Pi explicitly attributes it to the
    // failed stream (after its first event, without an SSE fallback). Even then
    // it cannot override a terminal response/status/stop reason.
    if (type === null && (this.#status === null || this.#status < 400)) {
      for (const diagnostic of message.diagnostics ?? []) {
        if (
          diagnostic.type !== "provider_transport_failure" ||
          diagnostic.details?.["eventsEmitted"] !== true ||
          diagnostic.details?.["fallbackTransport"] !== undefined
        )
          continue;
        const code = text(diagnostic.error?.code);
        const name = text(diagnostic.error?.name);
        if (code !== null && categoryFor(code) !== undefined) type = code;
        else if (name === "WebSocketCloseError" && diagnostic.error?.code === 1006) type = name;
        else if (name !== null && categoryFor(name) !== undefined) type = name;
      }
    }
    const typedCategory =
      type === "WebSocketCloseError" ? "network" : type === null ? undefined : categoryFor(type);
    const statusCategory =
      this.#status === 401 || this.#status === 403
        ? "auth-failed"
        : this.#status === 429 || this.#status === 402
          ? "rate-limited"
          : this.#status === 503 || this.#status === 529
            ? "provider-overloaded"
            : this.#status === 400 || this.#status === 404 || this.#status === 422
              ? "bad-request"
              : "unknown";
    const category =
      typedCategory === undefined || typedCategory === "bad-request"
        ? statusCategory === "unknown"
          ? (typedCategory ?? "unknown")
          : statusCategory
        : typedCategory;
    return {
      category,
      providerType: type === null ? null : safeStopMessage(type, this.redaction).slice(0, 80),
      message: this.#message ?? (raw.length === 0 ? null : safeStopMessage(raw, this.redaction)),
      httpStatus: this.#status,
      retry: "not-retried",
      resetsAt: this.#bodyResetsAt ?? this.#resetsAt,
    };
  }
}

/** Retry exhaustion is a runtime fact beside, not instead of, the provider cause. */
export function finalStopDetail(
  detail: SessionStopDetail,
  retries: number,
  resetsAt: number | null,
): SessionStopDetail {
  return {
    ...detail,
    category: detail.category === "unknown" && retries > 0 ? "retries-exhausted" : detail.category,
    retry: retries > 0 ? "exhausted" : "not-retried",
    resetsAt: detail.resetsAt ?? resetsAt,
  };
}
