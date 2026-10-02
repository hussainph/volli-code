import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv, ShellExecOptions } from "./harness-env";
import { Type } from "@earendil-works/pi-ai";
import type { NonCodingToolId, SessionRuntimeSpec } from "@volli/shared";

export type SecretPort = NonNullable<SessionRuntimeSpec["secret"]>;
type RedactionPort = NonNullable<SessionRuntimeSpec["credentialRedaction"]>;
export const REQUEST_SECRET_TOOL_NAME = "request_secret" satisfies NonCodingToolId;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const requestSecretSchema = Type.Object(
  {
    name: Type.String({
      pattern: ENVIRONMENT_NAME.source,
      maxLength: 128,
      description: "The uppercase environment variable the command needs, e.g. API_TOKEN.",
    }),
    purpose: Type.Optional(
      Type.String({ maxLength: 500, description: "Why this credential is needed." }),
    ),
  },
  { additionalProperties: false },
);

/** The credential never crosses this port: only its name, purpose and outcome do. */
export function createRequestSecretTool(
  port: SecretPort,
  attachmentSignal?: AbortSignal,
): AgentTool<typeof requestSecretSchema, undefined> {
  return {
    name: REQUEST_SECRET_TOOL_NAME,
    label: "credential",
    description: [
      "Ask the person to supply a credential in Volli's secure field outside the chat.",
      "Supply only its uppercase environment variable name and optional purpose; never a value, scope or prefill.",
      "The host injects the credential into commands; refer to the environment variable, never ask to read or echo it.",
      "Only signed in, declined or still missing is returned.",
      "Output redaction is best-effort exact text matching, not protection against encoded or deliberately exfiltrated secrets.",
    ].join(" "),
    parameters: requestSecretSchema,
    async execute(toolCallId, params, callSignal): Promise<AgentToolResult<undefined>> {
      // Pi's validation is not this boundary. Reject extra properties even when
      // a provider or programmatic caller got them past the declared schema.
      if (
        params === null ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        Object.keys(params).some((key) => key !== "name" && key !== "purpose") ||
        typeof params.name !== "string" ||
        ENVIRONMENT_NAME.exec(params.name)?.[0] !== params.name ||
        (params.purpose !== undefined &&
          (typeof params.purpose !== "string" || params.purpose.length > 500))
      ) {
        throw new Error(
          "request_secret accepts only an uppercase environment name and optional purpose.",
        );
      }
      const withdrawn = new AbortController();
      const abandon = (): void => withdrawn.abort();
      const signals = [attachmentSignal, callSignal].filter((signal) => signal !== undefined);
      for (const signal of signals) {
        if (signal.aborted) abandon();
        else signal.addEventListener("abort", abandon, { once: true });
      }
      try {
        const outcome = await port.request(
          {
            name: params.name,
            ...(params.purpose === undefined ? {} : { purpose: params.purpose }),
            toolCallId,
          },
          withdrawn.signal,
        );
        // A malformed host answer must never become free-form credential text.
        if (outcome !== "signed in" && outcome !== "declined" && outcome !== "still missing") {
          throw new Error("The credential request returned no safe outcome.");
        }
        return { content: [{ type: "text", text: outcome }], details: undefined };
      } finally {
        for (const signal of signals) signal.removeEventListener("abort", abandon);
      }
    },
  };
}

/** Fail closed if the host cannot redact; never expose its failure's text. */
export function redactCredentialText(text: string, port: RedactionPort): string {
  try {
    return port.redact(text);
  } catch {
    return "[Text withheld: credential redaction failed.]";
  }
}

/**
 * JSON-shaped tool results, including details and structuredContent, are scrubbed
 * before Pi publishes updates/results or records them in its sidecar. Exact text
 * only: not an encoding detector or an exfiltration boundary. Images are withheld
 * while this launch holds credential values: replacing bytes in base64 corrupts
 * images and text redaction cannot find a credential rendered as pixels.
 */
function scrub(value: unknown, port: RedactionPort): unknown {
  if (typeof value === "string") return redactCredentialText(value, port);
  if (typeof value === "number" || typeof value === "boolean") {
    // A JSON primitive can carry the exact credential too. Keep its original
    // type (and e.g. negative zero) only when the textual check is unchanged.
    const text = String(value);
    const safe = redactCredentialText(text, port);
    return safe === text ? value : safe;
  }
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, port));
  if (value !== null && typeof value === "object") {
    if ("type" in value && value.type === "image") {
      let sensitive = true;
      try {
        sensitive = port.hasValues?.() ?? true;
      } catch {
        /* Fail closed. */
      }
      return sensitive
        ? { type: "text", text: "[Image withheld while secure credentials are enabled.]" }
        : value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactCredentialText(key, port),
        scrub(entry, port),
      ]),
    );
  }
  return value;
}

/** Shell spills happen below the tool wrapper. Do not write an unredacted
 * output log when credentials are held; inline output still goes through the
 * result scrubber. A deliberately written project file is not a shell spill.
 */
export function privateSecretExecution(
  env: ExecutionEnv,
  port: RedactionPort | undefined,
): ExecutionEnv {
  if (port === undefined) return env;
  return new Proxy(env, {
    get(target, property) {
      if (property === "exec") {
        return (
          command: string,
          options: ShellExecOptions | undefined,
          context: Parameters<ExecutionEnv["exec"]>[2],
        ) => {
          let sensitive = true;
          try {
            sensitive = port.hasValues?.() ?? true;
          } catch {
            /* Fail closed. */
          }
          return target.exec(
            command,
            sensitive && options?.capture !== undefined
              ? { ...options, capture: { ...options.capture, spill: false } }
              : options,
            context,
          );
        };
      }
      const member: unknown = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

/** Wrap every bound tool and Code Mode itself, not just execution tools. */
export function redactToolResults(tool: AgentTool, port: RedactionPort | undefined): AgentTool {
  if (port === undefined) return tool;
  const safeResult = (result: AgentToolResult<unknown>): AgentToolResult<unknown> =>
    scrub(result, port) as AgentToolResult<unknown>;
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      try {
        return safeResult(
          await tool.execute(toolCallId, params, signal, (partial) =>
            onUpdate?.(safeResult(partial)),
          ),
        );
      } catch (error) {
        // Drop the original stack, cause and custom properties, which may all
        // carry values a message-only redaction would leave in durable events.
        // eslint-disable-next-line preserve-caught-error -- the original cause may contain a credential
        throw new Error(
          redactCredentialText(error instanceof Error ? error.message : String(error), port),
        );
      }
    },
  };
}
