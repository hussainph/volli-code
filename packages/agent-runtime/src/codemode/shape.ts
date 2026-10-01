/**
 * What a script receives from one nested call, and how each tool's answer is
 * typed for it (VC-471).
 *
 * A model reading a direct result reads display text. A script should not have
 * to: it filters, counts and compares, and parsing prose to do that is how a
 * program silently breaks the day the prose changes. So every code-callable
 * tool resolves to one stable shape, declared to the model as TypeScript:
 *
 * | tool            | resolves to                                                   |
 * | --------------- | ------------------------------------------------------------- |
 * | `bash`          | `{ output, exitCode, truncated, fullOutputPath? }`, any exit  |
 * | MCP tools       | `{ text, structuredContent?, isError, omittedImages }`        |
 * | Volli verbs     | `{ text, details? }`                                          |
 * | schema-bearing Session tools | their native `structuredContent`                |
 * | everything else | its text                                                      |
 *
 * A verb whose registry entry declares `resultDetails` has its `details` typed
 * by that schema, so a program reads `started.details.handle` rather than
 * parsing the sentence a direct caller reads. `details` stays optional even
 * then: a verb that refused answers with `text` alone, and that absence is how
 * a program tells a refusal from a result.
 *
 * A call that failed rejects, with the same message a direct call would have
 * shown the model — except a non-zero `bash` exit and an MCP `isError`, which
 * are answers rather than failures and resolve, as Pi's own codemode does.
 *
 * **No image enters a script** (phase 1's explicit image design). A block that
 * was an image becomes a placeholder naming its type, and nothing a script
 * prints or returns is sent to the model as an image. Images are where a page
 * could put text that reads as Volli's own and a person cannot see, and the
 * one tool whose result is only an image — `browser_screenshot` — is not
 * code-callable at all.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { isMcpToolId, MCP_UNTRUSTED_DATA_WARNING_TEXT } from "./trust";

/** A JSON Schema, as declarations render it. */
export type JsonSchema = Record<string, unknown>;

export type ToolKind = "bash" | "mcp" | "verb" | "structured" | "text";

/** Which shape a tool's results take, from the frozen tool and its own schema. */
export function toolKind(name: string, isVerb: boolean, outputSchema?: unknown): ToolKind {
  if (name === "bash") return "bash";
  if (isMcpToolId(name)) return "mcp";
  if (isVerb) return "verb";
  if (typeof outputSchema === "object" && outputSchema !== null) return "structured";
  return "text";
}

/** What a typed verb's `details` says about the one case it is absent. */
export const VERB_DETAILS_ABSENT = "Absent when the call was refused; `text` then says why.";

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null;
}

/**
 * The declared result type of each kind, for the TypeScript the model reads.
 * `schema` types the part of the result a tool declares for itself: an MCP
 * tool's `structuredContent`, or a Volli verb's `details`.
 */
export function outputSchemaFor(kind: ToolKind, schema?: unknown): JsonSchema {
  switch (kind) {
    case "bash":
      return {
        type: "object",
        properties: {
          output: { type: "string" },
          exitCode: { type: "number" },
          truncated: { type: "boolean" },
          fullOutputPath: { type: "string" },
        },
        required: ["output", "exitCode", "truncated"],
      };
    case "mcp":
      return {
        type: "object",
        properties: {
          text: { type: "string" },
          structuredContent: isSchema(schema) ? schema : {},
          isError: { type: "boolean" },
          omittedImages: { type: "number" },
        },
        required: ["text", "isError", "omittedImages"],
      };
    case "verb":
      return {
        type: "object",
        properties: {
          text: { type: "string" },
          details: isSchema(schema)
            ? {
                ...schema,
                description:
                  typeof schema.description === "string"
                    ? `${schema.description} ${VERB_DETAILS_ABSENT}`
                    : VERB_DETAILS_ABSENT,
              }
            : { type: "object", additionalProperties: true },
        },
        required: ["text"],
      };
    case "structured":
      return schema as JsonSchema;
    case "text":
      return { type: "string" };
  }
}

/** What one nested call came to, before it is handed to the script. */
export type ShapedOutcome = { ok: true; value: unknown } | { ok: false; message: string };

type Block = AgentToolResult<unknown>["content"][number];

/** A tool's blocks as text, every image a placeholder. */
function textOf(content: readonly Block[]): { text: string; images: number } {
  let images = 0;
  const parts = content.map((block) => {
    if (block.type === "text") return block.text;
    images += 1;
    return `[image ${block.mimeType} left out: Code Mode passes no images to programs]`;
  });
  return { text: parts.join("\n"), images };
}

/**
 * The anchored line agent-core's `bash` ends a non-zero exit with. Its own
 * fixed format, not anything the command printed: the regex is anchored to the
 * very end of the message, after the output.
 */
const EXIT_LINE = /(?:^|\n\n)Command exited with code (\d+)$/u;

interface BashDetails {
  truncation?: unknown;
  fullOutputPath?: unknown;
}

/** One nested call's result, shaped for the script. */
export function shapeResult(
  kind: ToolKind,
  result: AgentToolResult<unknown>,
  isError: boolean,
): ShapedOutcome {
  const { text, images } = textOf(result.content ?? []);
  switch (kind) {
    case "bash": {
      const details = (result.details ?? {}) as BashDetails;
      const fullOutputPath =
        typeof details.fullOutputPath === "string"
          ? { fullOutputPath: details.fullOutputPath }
          : {};
      if (!isError) {
        return {
          ok: true,
          value: {
            output: text === "(no output)" ? "" : text,
            exitCode: 0,
            truncated: details.truncation !== undefined,
            ...fullOutputPath,
          },
        };
      }
      const exit = EXIT_LINE.exec(text);
      if (exit === null) return { ok: false, message: text };
      const output = text.slice(0, exit.index);
      return {
        ok: true,
        value: {
          output,
          exitCode: Number(exit[1]),
          truncated: /\n\n\[Showing (?:lines|last) [^\n]*\]$/u.test(output),
          ...fullOutputPath,
        },
      };
    }
    case "mcp": {
      // An MCP call that reached the server always comes back as a result; one
      // that never did (refused, invalid, aborted) carries no structured half
      // and no trust notice, and is a failure like any other tool's.
      const content = result.content ?? [];
      const fromServer =
        content[0]?.type === "text" && content[0].text === MCP_UNTRUSTED_DATA_WARNING_TEXT;
      if (!fromServer)
        return isError
          ? { ok: false, message: text }
          : { ok: true, value: { text, isError: false, omittedImages: images } };
      const body = textOf(content.slice(1));
      return {
        ok: true,
        value: {
          text: body.text,
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: result.structuredContent }),
          isError,
          omittedImages: body.images,
        },
      };
    }
    case "verb": {
      if (isError) return { ok: false, message: text };
      const details = result.details;
      return {
        ok: true,
        value: typeof details === "object" && details !== null ? { text, details } : { text },
      };
    }
    case "structured":
      if (isError) return { ok: false, message: text };
      if (result.structuredContent === undefined)
        return {
          ok: false,
          message: "The tool declared an output schema but returned no structured content.",
        };
      return { ok: true, value: result.structuredContent };
    case "text":
      return isError ? { ok: false, message: text } : { ok: true, value: text };
  }
}
