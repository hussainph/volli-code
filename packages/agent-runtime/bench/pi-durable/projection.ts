/** Execution records -> existing RuntimeObservation vocabulary, never product commands. */
import type { EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import { EMPTY_ACTIVITY_SUBJECT, type RuntimeObservation } from "@volli/shared";

export const turnIdFor = (id: number) => `durable-submission-${id}`;

export function projectRecords(
  entries: readonly EntryRecord[],
  submissions: readonly SubmissionRecord[],
) {
  const observations: RuntimeObservation[] = [];
  const ordered = entries.toSorted((a, b) => a.id - b.id);
  const inputs = submissions
    .filter((s) => s.type === "input" && s.entry !== undefined)
    .toSorted((a, b) => (a.entry ?? 0) - (b.entry ?? 0));
  const receipts: { commandId: string; acceptedAt: number }[] = [];
  for (const [index, input] of inputs.entries()) {
    const turnId = turnIdFor(input.id);
    const start = ordered.find((e) => e.id === input.entry)?.model?.[0]?.timestamp ?? 0;
    const slice = ordered.filter(
      (e) => e.id > (input.entry ?? 0) && e.id < (inputs[index + 1]?.entry ?? Infinity),
    );
    if (input.requestId) receipts.push({ commandId: input.requestId, acceptedAt: start });
    observations.push({
      kind: "turn",
      state: "started",
      turnId,
      occurredAt: start,
      recoveryCursor: `${turnId}:start`,
    });
    const calls = new Map<string, { args: Record<string, unknown>; timestamp: number }>();
    for (const entry of slice) {
      for (const message of entry.model ?? []) {
        const recoveryCursor = `entry-${entry.id}`;
        if (message.role === "assistant") {
          const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
          const reasoning = message.content
            .flatMap((b) => (b.type === "thinking" ? [b.thinking] : []))
            .join("");
          for (const block of message.content) {
            if (block.type === "toolCall")
              calls.set(block.id, { args: block.arguments, timestamp: message.timestamp });
          }
          if (text || reasoning)
            observations.push({
              kind: "message-settled",
              turnId,
              message: {
                entryId: `durable-${entry.id}`,
                role: "assistant",
                text,
                reasoning,
                model: { providerId: message.provider, modelId: message.model },
              },
              occurredAt: message.timestamp,
              recoveryCursor,
            });
          // Metering/provider-resource parity is intentionally NOT claimed by this fixture adapter.
        } else if (message.role === "toolResult") {
          const call = calls.get(message.toolCallId);
          observations.push({
            kind: "activity",
            turnId,
            activityId: message.toolCallId,
            descriptor: {
              kind: message.toolName === "read" ? "read-file" : "write-file",
              nativeToolName: message.toolName,
              subject: {
                ...EMPTY_ACTIVITY_SUBJECT,
                path: typeof call?.args.path === "string" ? call.args.path : null,
              },
              outcome: null,
              startedAt: call?.timestamp ?? null,
              endedAt: message.timestamp,
            },
            input: JSON.stringify(call?.args ?? {}),
            output: message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
            ...(message.isError
              ? { state: "failed" as const, error: "Tool failed or interrupted; inspect result" }
              : { state: "completed" as const }),
            occurredAt: message.timestamp,
            recoveryCursor,
          });
        }
      }
    }
    if (input.status === "done" || input.status === "unanswered")
      observations.push({
        kind: "turn",
        state: input.status === "done" ? "completed" : "interrupted",
        turnId,
        occurredAt: slice.at(-1)?.model?.[0]?.timestamp ?? start,
        recoveryCursor: `${turnId}:end`,
      });
  }
  return { observations, receipts };
}

export function observationKey(observation: RuntimeObservation): string | undefined {
  return "recoveryCursor" in observation ? observation.recoveryCursor : undefined;
}
