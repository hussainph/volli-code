import * as React from "react";

const TOOL_PREVIEW_LIMIT = 1_200;

export interface SessionMessageFrame {
  sequence: number;
  transcript: {
    message: {
      role: string;
      parts: readonly unknown[];
    };
  } | null;
}

interface SessionMessagePart {
  key: string;
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  title?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  toolMetadata?: unknown;
}

export function SessionMessageList({ frames }: { frames: readonly SessionMessageFrame[] }) {
  const messages = frames.flatMap((frame) =>
    frame.transcript
      ? [
          {
            sequence: frame.sequence,
            role: frame.transcript.message.role,
            parts: frame.transcript.message.parts.flatMap((part, partIndex) => {
              const normalized = sessionMessagePart(part);
              return normalized ? [{ ...normalized, key: `${frame.sequence}:${partIndex}` }] : [];
            }),
          },
        ]
      : [],
  );

  if (messages.length === 0) {
    return <p className="text-ui text-muted-foreground">No committed messages</p>;
  }

  return (
    <div className="space-y-3">
      {messages.map((message) => {
        const reasoning = message.parts.filter(
          (part): part is SessionMessagePart & { text: string } =>
            part.type === "reasoning" && typeof part.text === "string" && part.text.length > 0,
        );
        const text = message.parts.filter(
          (part): part is SessionMessagePart & { text: string } =>
            part.type === "text" && typeof part.text === "string" && part.text.length > 0,
        );
        const tools = message.parts.filter(
          (part): part is SessionMessagePart & { toolName: string; toolCallId: string } =>
            part.type === "dynamic-tool" &&
            typeof part.toolName === "string" &&
            typeof part.toolCallId === "string",
        );
        return (
          <article key={message.sequence} className="space-y-2 border-l border-border pl-3">
            <p className="font-mono text-label text-muted-foreground">
              {String(message.sequence).padStart(4, "0")} {message.role}
            </p>
            {text.map((part) => (
              <pre key={part.key} className="whitespace-pre-wrap text-label text-foreground">
                {part.text}
              </pre>
            ))}
            {reasoning.map((part) => (
              <details key={part.key} className="border border-border bg-muted/30 px-2 py-1">
                <summary className="cursor-pointer text-label text-muted-foreground">
                  Reasoning summary
                </summary>
                <pre className="mt-2 whitespace-pre-wrap text-label text-foreground">
                  {part.text}
                </pre>
              </details>
            ))}
            {tools.length > 0 ? <ToolCallBundle tools={tools} /> : null}
          </article>
        );
      })}
    </div>
  );
}

function ToolCallBundle({
  tools,
}: {
  tools: readonly (SessionMessagePart & { toolName: string; toolCallId: string })[];
}) {
  return (
    <details className="border border-border bg-muted/30 px-2 py-1">
      <summary className="cursor-pointer text-label text-muted-foreground">
        {tools.length} tool {tools.length === 1 ? "call" : "calls"}
      </summary>
      <div className="mt-2 space-y-2">
        {tools.map((tool) => (
          <article key={tool.toolCallId} className="border border-border bg-card p-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-label">
              <strong className="text-foreground">{tool.title ?? tool.toolName}</strong>
              <span className="text-muted-foreground">
                {tool.toolName} · {tool.state ?? "unknown"}
              </span>
              <code className="text-muted-foreground">{tool.toolCallId}</code>
            </div>
            <div className="mt-2 space-y-1">
              {Object.hasOwn(tool, "input") ? <ToolValue label="Input" value={tool.input} /> : null}
              {Object.hasOwn(tool, "output") ? (
                <ToolValue label="Output" value={tool.output} />
              ) : null}
              {tool.errorText ? <ToolValue label="Error" value={tool.errorText} /> : null}
              {Object.hasOwn(tool, "toolMetadata") ? (
                <ToolValue label="Metadata" value={tool.toolMetadata} />
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}

function ToolValue({ label, value }: { label: string; value: unknown }) {
  return (
    <details>
      <summary className="cursor-pointer font-mono text-label uppercase text-muted-foreground">
        {label}
      </summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-label text-foreground">
        {valuePreview(value)}
      </pre>
    </details>
  );
}

function sessionMessagePart(value: unknown): Omit<SessionMessagePart, "key"> | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return {
    type: value.type,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
    ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(Object.hasOwn(value, "input") ? { input: value.input } : {}),
    ...(Object.hasOwn(value, "output") ? { output: value.output } : {}),
    ...(typeof value.errorText === "string" ? { errorText: value.errorText } : {}),
    ...(Object.hasOwn(value, "toolMetadata") ? { toolMetadata: value.toolMetadata } : {}),
  };
}

function valuePreview(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const display = serialized ?? String(value);
  return display.length > TOOL_PREVIEW_LIMIT
    ? `${display.slice(0, TOOL_PREVIEW_LIMIT)}\n… truncated in feed`
    : display;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
