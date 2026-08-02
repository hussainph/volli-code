# Streaming chat interfaces: event model and Volli path

## Answer

**HTTP plus Server-Sent Events (SSE) is sufficient for visible token streaming and tool activity.** A WebSocket is useful when a product also needs a long-lived, bidirectional connection with incremental *input*, but it is not a prerequisite for streaming an assistant response. OpenAI's Responses API documents ordinary HTTP SSE for `stream: true`; its WebSocket mode is a separate option for persistent connections and incremental input. [OpenAI: Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)

Volli already has both required one-way streaming legs:

```text
provider deltas / tool updates
  -> OpenCode GET /event (SSE)
  -> OpenCode adapter event reducer
  -> durable Session frame + transcript artifact
  -> session.subscribe (HTTP SSE)
  -> one requestAnimationFrame-batched React paint
```

The right goal is **every provider event is reduced immediately and painted at most once per animation frame**. That is perceptibly token streaming without attempting one React render per raw token.

## What established streaming contracts model

OpenAI's Responses stream has a typed lifecycle, rather than a generic "chunk": it emits output-item and content-part starts, repeated `response.output_text.delta` events, then corresponding done/completed events. Text deltas carry a stable item/content identity and a `sequence_number`; clients append them to that identity rather than waiting for a final message. [OpenAI: streaming event reference](https://platform.openai.com/docs/api-reference/responses-streaming?lang=python)

Tool calls have the same shape. OpenAI emits `response.function_call_arguments.delta` while JSON arguments are being formed, followed by `response.function_call_arguments.done` with complete arguments. Application-owned tool execution then needs its own running, output, error, and completed events: function-call formation and tool execution are distinct lifecycles. [OpenAI: function-call streaming](https://developers.openai.com/api/docs/guides/function-calling#streaming)

The Vercel AI SDK's UI message protocol expresses this directly: text uses `text-start` / `text-delta` / `text-end`; tools use `tool-input-start` / `tool-input-delta` / `tool-input-available` / `tool-output-available`; and steps bracket model/tool loops. It is an SSE protocol with keep-alive and reconnect support, not a WebSocket-only design. [AI SDK UI: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)

The recommended provider-neutral reducer is therefore:

| Event family | Durable state keyed by | UI result |
| --- | --- | --- |
| `message-start` / `part-start` | message ID + part ID | Create an empty assistant block immediately. |
| `text-delta` / `reasoning-delta` | part ID | Append bytes to that part. |
| `tool-input-delta` | tool-call ID | Show progressively formed arguments, if the provider exposes them. |
| `tool-input-ready` | tool-call ID | Replace raw argument bytes with validated structured input. |
| `tool-running` / `tool-output` / `tool-error` | tool-call ID | Update a single stable tool row; do not append a new row for each status. |
| `part-done` / `turn-done` / error | part/turn ID | Mark terminal state and flush immediately. |

Unknown event types must be retained or ignored safely rather than treated as stream failure: OpenAI explicitly permits adding streaming event types as a backwards-compatible change. [OpenAI: backwards compatibility](https://developers.openai.com/api/reference/overview#backwards-compatibility)

## OpenCode contract

OpenCode exposes `event.subscribe()` as a server-sent-events stream. Its generated SDK defines message and part updates; `TextPart` has cumulative `text`, and `ToolPart` carries a stable `callID` and a state of `pending`, `running`, `completed`, or `error`. [OpenCode SDK](https://dev.opencode.ai/docs/sdk/) [Generated event and part types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)

OpenCode's own message source also defines `message.part.delta` with `sessionID`, `messageID`, `partID`, `field`, and `delta`. That is the transport-level shape an adapter should reduce when it is emitted, including a delta that arrives before a full part snapshot. [OpenCode message event source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts)

The generated OpenCode SSE client stores the last event ID, sends `Last-Event-ID` on reconnect, and retries with backoff. A consumer should still make the local Session ledger authoritative: on reconnect, resume from the durable Session sequence/cursor, deduplicate event IDs, and reconcile a final snapshot if the upstream stream cannot replay. [OpenCode SSE client source](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/core/serverSentEvents.gen.ts)

## What this means for the current Lab

The transport is not the missing primitive:

- `apps/desktop/src/renderer/lab/session-rpc-client.ts` already uses tRPC's `httpSubscriptionLink` for `session.subscribe`; this is an HTTP SSE subscription.
- `packages/session-rpc/src/index.ts` preserves a Session sequence cursor and reports overflow so a client can resume from its last event ID.
- `packages/opencode-adapter/src/index.ts` consumes OpenCode's `/event` SSE stream, reduces `message.updated`, `message.part.updated`, and `message.part.delta`, and coalesces transcript snapshots every 32 ms.
- `apps/desktop/src/renderer/lab/chat/session-controller.ts` coalesces already-durable frames into one `requestAnimationFrame` update. That is a paint-rate cap, not a response-level wait.

The previous blank-until-complete symptom therefore came from event reduction, not HTTP subscriptions: a delta could precede the first complete part/message snapshot. The adapter now creates the text part on that first delta, so subsequent 32 ms snapshots have something to persist and paint.

There is one intentionally narrower capability remaining: the adapter's `message.part.delta` reducer currently accepts only `field: "text"`. This supports response text but does **not** yet project raw tool-argument deltas. Tool lifecycle snapshots (`pending` / `running` / `completed` / `error`) are already preserved from OpenCode's `message.part.updated`; showing progressively formed tool arguments requires extending the same reducer and UI message projection to carry a stable `toolCallId` plus raw argument text.

## Implementation guardrails

1. Preserve the existing durable Session frame for every coalesced provider update; do not make the renderer the source of truth.
2. Coalesce at the adapter and render boundaries only (about 16–33 ms), then flush immediately on part/turn completion, failure, or cancellation.
3. Key all partial state by stable message/part/tool-call IDs. Never replace a response from a final snapshot if that would discard prior partial state.
4. Persist and expose a monotonically increasing local sequence; reconnect with that cursor, deduplicate upstream IDs, then reconcile if necessary.
5. Test delta-first text, snapshot-first text, tool pending→running→completed/error, tool-argument deltas, disconnect/reconnect, and a slow real-provider turn whose first visible character must arrive before completion.

The final point is the acceptance criterion: **when the provider emits an incremental event, Volli should make the corresponding text or tool-state change visible within one coalescing interval plus one animation frame.** If no incremental provider event arrives, the UI cannot manufacture real tokens, but it should continue to show durable turn/tool progress rather than a blank page.
