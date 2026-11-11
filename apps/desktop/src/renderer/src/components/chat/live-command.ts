import {
  activityDescriptor,
  activityStatus,
  formatDuration,
  isBlankText,
} from "@volli/session-presentation";
import type { DynamicToolUIPart } from "ai";
import { useEffect, useMemo, useState } from "react";

const TAIL_LINES = 12;
const TAIL_CHARACTERS = 4096;

/** Only text evidence belongs in a command's live preview, never serialized tool data. */
export function commandOutputTail(part: DynamicToolUIPart): string | null {
  const output: unknown =
    "output" in part
      ? part.output
      : isRecord(part.input)
        ? part.input["volli.activity.output"]
        : undefined;
  const text =
    typeof output === "string"
      ? output
      : isRecord(output) && Array.isArray(output.content)
        ? (output.content as unknown[])
            .filter(
              (block): block is { type: "text"; text: string } =>
                isRecord(block) && block.type === "text" && typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n")
        : "";
  // Trim trailing blank lines before taking the tail: a final newline is not
  // another output line. Cut characters first so splitting is bounded too.
  const tail = text.trimEnd().slice(-TAIL_CHARACTERS).split(/\r?\n/).slice(-TAIL_LINES).join("\n");
  return isBlankText(tail) ? null : tail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A live-only clock; settled rows use their recorded presentation meta. */
export function useLiveCommand(
  part: DynamicToolUIPart,
  enabled = true,
): { tail: string | null; elapsed: string | null } {
  const descriptor = activityDescriptor(part);
  const command = descriptor.kind === "run-command";
  const live = enabled && command && activityStatus(part) === "running";
  const { toolCallId } = part;
  const { startedAt } = descriptor;
  const [clock, setClock] = useState<{
    toolCallId: string;
    startedAt: number | null;
    baseline: number;
    now: number;
  } | null>(null);

  useEffect(() => {
    if (!live) {
      setClock(null);
      return;
    }
    // Without a recorded clock, only this observed live window is measured.
    // A historical mount must never manufacture a duration for a settled row.
    const observedAt = Date.now();
    const baseline = startedAt ?? observedAt;
    const tick = () => setClock({ toolCallId, startedAt, baseline, now: Date.now() });
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [live, toolCallId, startedAt]);

  const elapsed =
    live && clock?.toolCallId === toolCallId && clock.startedAt === startedAt
      ? formatDuration(Math.max(0, clock.now - clock.baseline))
      : null;
  const tail = useMemo(() => (command ? commandOutputTail(part) : null), [command, part]);
  return { tail, elapsed };
}
