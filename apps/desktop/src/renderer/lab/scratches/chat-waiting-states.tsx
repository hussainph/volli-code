/** Production ChatPlane with frozen renderer/store inputs, not a drawn facsimile.
 * ?state=attaching|history-attaching|sending|handoff|first-token|thinking|tool|between-steps|text|steering|queued|error selects a proof state.
 * Attaching simulates local-held → host-queued → turn-open ownership without a queue strip.
 * History-attaching repeats that idle Send with a completed turn and no live executor.
 * Steering has no delivery tab; queued remains a follow-up behind a running turn.
 * Also: background|moved-background|tools-updated|compaction surface audit fixtures.
 * No runtime or provider connection; these screenshots prove presentation only.
 */
import * as React from "react";
import {
  ACTIVITY_METADATA_KEY,
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_MODEL_PICKER_VIEW,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  scrubSessionEventPayload,
  type SessionEventPayload,
  type SessionPresentationProjection,
} from "@volli/shared";
import { appendFrames, seedSlice, type ChatSessionFrame } from "@volli/session-presentation";
import type { UIMessage } from "ai";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";

export const title = "Chat · waiting and progress";
export const note = "Actual ChatPlane; frozen host/store fixtures, no provider or Electron";
export const viewport = "window" as const;
const SESSION = "chat-waiting-screenshot-session";
const PROJECT = "chat-waiting-screenshot-project";
const selection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
} as const;
const store = createChatSessionsStore();
const state = new URLSearchParams(window.location.search).get("state") ?? "sending";
const attaching = state === "attaching" || state === "history-attaching";
const historyMessages: UIMessage[] =
  state === "history-attaching"
    ? [
        {
          id: "history-request",
          role: "user",
          parts: [{ type: "text", text: "Review the previous release first." }],
        },
        {
          id: "history-reply",
          role: "assistant",
          parts: [{ type: "text", text: "The previous release is checked." }],
        },
      ]
    : [];
function idleTranscript() {
  return {
    ...seedSlice("ready").transcript,
    messages: historyMessages,
    durableMessages: historyMessages,
    // A completed prior turn has both a start and an end boundary.
    turnEpoch: historyMessages.length > 0 ? 2 : 0,
  };
}
// Optional exact Git baseline, materialized temporarily by delivery-capture.mjs.
const baselineModule = import.meta.glob<{ ChatPlane: typeof ChatPlane }>(
  "./chat-waiting-baseline-chat-plane.tsx",
)["./chat-waiting-baseline-chat-plane.tsx"];
const BaselinePlane =
  baselineModule === undefined
    ? null
    : React.lazy(async () => ({ default: (await baselineModule()).ChatPlane }));
const client: ModelAccessClient = {
  inspect: async () => ({
    observedAt: 0,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        state: "available",
        accountLabel: null,
        billingSource: "subscription",
        recovery: null,
        hasStoredCredential: true,
        signIn: [],
      },
    ],
    models: [
      {
        ...selection,
        label: "Claude Sonnet 4.5",
        state: "available",
        acceptsImageInput: true,
        reasoningLevels: ["low", "medium", "high"],
        contextWindow: 200000,
      },
    ],
  }),
  defaults: async () => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, global: selection }),
  setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
  hiddenModels: async () => [],
  setHiddenModels: async (value) => value,
  compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
  setCompactionPolicy: async (value) => value,
  codeModePolicy: async () => DEFAULT_CODE_MODE_POLICY,
  setCodeModePolicy: async (value) => value,
  pickerView: async () => DEFAULT_MODEL_PICKER_VIEW,
  setPickerView: async (value) => value,
  beginSignIn: async () => {
    throw new Error("No sign-in in this fixture");
  },
  signOut: async () => {
    throw new Error("No sign-out in this fixture");
  },
};
const ok = async () => ({ ok: true, value: [] });
export const api = {
  appState: {
    get: async () => ({ ok: true, value: null }),
    set: async () => ({ ok: true, value: undefined }),
  },
  browser: { list: ok },
  shells: { list: ok },
};
// Fixture facts, not an actual send. The receipt names the command explicitly;
// turn.started deliberately has no commandId, so event proximity proves nothing.
function acceptedStreamingTranscript(includeReply = true) {
  const request: UIMessage = {
    id: "request",
    role: "user",
    parts: [{ type: "text", text: "Check the release notes before we ship." }],
  };
  function frame(
    sequence: number,
    payload: SessionEventPayload,
    message: UIMessage | null = null,
  ): ChatSessionFrame {
    return {
      sessionId: SESSION,
      sequence,
      event: {
        id: `fixture-event-${sequence}`,
        sessionId: SESSION,
        sequence,
        occurredAt: sequence,
        recordedAt: sequence,
        attachmentId: "chat-waiting-fixture-attachment",
        commandId: null,
        provenance: {
          source: { kind: "system", id: "runtime", detail: null },
          venue: { id: "lab", kind: "local" },
        },
        payload: scrubSessionEventPayload(payload),
      },
      transcript: message === null ? null : { message },
    };
  }
  return appendFrames(
    idleTranscript(),
    [
      frame(
        1,
        {
          kind: "command.recorded",
          command: {
            id: "ordinary-send",
            sessionId: SESSION,
            createdAt: 0,
            route: null,
            intent: {
              kind: "message.submit",
              reference: { id: "request-artifact", mediaType: null, digest: null },
            },
          },
        },
        request,
      ),
      frame(2, {
        kind: "turn.started",
        attachmentId: "chat-waiting-fixture-attachment",
        turnId: "reply-turn",
      }),
      frame(3, {
        kind: "command.receipt.recorded",
        receipt: {
          id: "opening-receipt",
          commandId: "ordinary-send",
          recordedAt: 3,
          sequence: 3,
          ...(state === "delivery-error"
            ? {
                status: "rejected" as const,
                code: "failure",
                detail: "Context assembly failed before the model could start.",
              }
            : state === "unconfirmed"
              ? { status: "unreconciled" as const, detail: "Delivery could not be confirmed." }
              : {
                  status: "accepted" as const,
                  acceptedAt: 3,
                  result: { kind: "message.submitted" as const, sessionId: SESSION },
                }),
        },
      }),
    ],
    includeReply
      ? [
          {
            kind: "overlay",
            sessionId: SESSION,
            throughSequence: 3,
            messageId: "reply",
            delta: {
              op: "reset",
              message: {
                id: "reply",
                role: "assistant",
                parts: liveParts().map((part, index) => ({ key: `reply-${index}`, part })),
              },
            },
          },
        ]
      : [],
  );
}
function liveParts(): UIMessage["parts"] {
  const active = livePart();
  if (active.type !== "dynamic-tool") return [active];
  if (state === "pending-tool")
    return [
      {
        type: "dynamic-tool",
        toolName: active.toolName,
        toolCallId: active.toolCallId,
        state: "input-streaming",
        input: active.input,
        toolMetadata: active.toolMetadata,
      },
    ];
  if (state !== "capped-bundle") return [active];
  return [
    ...Array.from({ length: 20 }, (_, index): UIMessage["parts"][number] => ({
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: `settled-${index}`,
      state: "output-available",
      input: { command: `echo "Completed check ${index + 1}"` },
      output: "done",
      toolMetadata: active.toolMetadata,
    })),
    active,
  ];
}
function livePart(): UIMessage["parts"][number] {
  if (state === "thinking")
    return {
      type: "reasoning",
      text: "Tracing the release notes against the compatibility guarantees.",
      state: "streaming",
    };
  if (
    [
      "tool",
      "background",
      "moved-background",
      "between-steps",
      "capped-bundle",
      "pending-tool",
    ].includes(state)
  ) {
    const settled = state === "between-steps" || state === "moved-background";
    return {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "bash-fixture",
      state: "output-available",
      preliminary: !settled,
      input: { command: "pnpm run check:release" },
      output: {
        content: [
          {
            type: "text",
            text:
              state === "moved-background"
                ? "Moved command to background shell fixture-shell.\nIt keeps running. A notice will arrive when it exits; use shell_output to read it or shell_kill to end it.\nNo output so far."
                : "Checking compatibility…",
          },
        ],
        details: { backgroundable: true },
      },
      toolMetadata: {
        [ACTIVITY_METADATA_KEY]: {
          kind: "run-command",
          nativeToolName: "bash",
          subject: { label: "pnpm run check:release", path: null, lineRange: null },
          outcome: settled
            ? {
                exitCode: 0,
                matchCount: null,
                fileCount: null,
                lineCount: null,
                bytes: null,
                addedLines: null,
                removedLines: null,
                diff: null,
                summary: null,
              }
            : null,
          startedAt: 1,
          endedAt: settled ? 2400 : null,
        },
      },
    };
  }
  return { type: "text", text: "I’m checking the release notes and tests.", state: "streaming" };
}
export function seed() {
  const working = [
    "steering",
    "queued",
    "working",
    "accepted-streaming",
    "handoff",
    "first-token",
    "thinking",
    "tool",
    "capped-bundle",
    "pending-tool",
    "background",
    "moved-background",
    "between-steps",
    "text",
    "compaction",
  ].includes(state);
  const error = state === "error" || state === "error-scrolled" || state === "delivery-error";
  const messages: UIMessage[] =
    state === "history-attaching"
      ? historyMessages
      : ["attaching", "working", "sending", "handoff", "first-token"].includes(state)
        ? []
        : [
            {
              id: "request",
              role: "user",
              parts: [{ type: "text", text: "Check the release notes before we ship." }],
            },
            ...(error
              ? []
              : [
                  {
                    id: "reply",
                    role: "assistant" as const,
                    parts: [
                      { type: "text" as const, text: "I’m checking the release notes and tests." },
                    ],
                  },
                ]),
          ];
  if (state === "error-scrolled") {
    for (let index = 1; index <= 16; index++) {
      messages.push(
        {
          id: `history-request-${index}`,
          role: "user",
          parts: [{ type: "text", text: `Review release note section ${index}.` }],
        },
        {
          id: `history-reply-${index}`,
          role: "assistant",
          parts: [
            {
              type: "text",
              text: `Section ${index} is checked against the compatibility notes. The existing behavior remains documented; the migration notes are next.`,
            },
          ],
        },
      );
    }
  }
  const projection: SessionPresentationProjection = {
    session: {
      id: SESSION,
      projectId: PROJECT,
      ticketId: null,
      title: "Release notes",
      role: "project",
      parentSessionId: null,
      createdAt: 0,
    },
    status: "open",
    signal: null,
    modelSelection: selection,
    modelTier: null,
    turnActive: working,
    lastActivityAt: 0,
    bornTicketless: true,
    scheduledResume: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    liveExecutor: attaching ? null : { id: "chat-waiting-fixture-attachment" },
  };
  // Simulated wiring: an idle Send has no executor or open turn yet, even
  // when this Session already has history. Do not invent active turn facts.
  const slice = seedSlice(attaching ? "starting" : working ? "working" : "ready");
  store.setState({
    sessions: {
      [SESSION]: {
        ...slice,
        projection,
        transcript: [
          "accepted-streaming",
          "delivery-error",
          "unconfirmed",
          "thinking",
          "tool",
          "capped-bundle",
          "pending-tool",
          "background",
          "moved-background",
          "between-steps",
          "text",
          "tools-updated",
          "compaction",
        ].includes(state)
          ? {
              ...acceptedStreamingTranscript(
                !["tools-updated", "compaction", "delivery-error", "unconfirmed"].includes(state),
              ),
              ...(["delivery-error", "unconfirmed"].includes(state) ? { turnActive: false } : {}),
              liveCompaction:
                state === "compaction" ? { throughSequence: 3, reason: "manual" as const } : null,
              toolRefreshes:
                state === "tools-updated"
                  ? [
                      {
                        sequence: 4,
                        afterMessageId: "request",
                        trigger: "cold-turn" as const,
                        added: ["browser_snapshot", "browser_act"],
                        changed: ["bash"],
                      },
                    ]
                  : [],
            }
          : {
              ...slice.transcript,
              messages,
              durableMessages: messages,
              turnActive: working,
              turnEpoch: state === "history-attaching" ? 2 : working ? 1 : 0,
            },
        sessionError: error ? "Context assembly failed before the model could start." : null,
        queue:
          state === "queued"
            ? [{ id: "follow-up", text: "Also check the migration notes.", queueState: "queued" }]
            : [],
        queueRevision: 1,
      },
    },
  });
  useChatDraftsStore.setState({
    drafts: {
      [SESSION]: {
        text: "",
        attachments: [],
        touchedAt: 0,
        held: ["attaching", "history-attaching", "sending", "steering", "handoff"].includes(state)
          ? [
              {
                id: state === "handoff" || attaching ? "request" : "pending",
                text:
                  state !== "steering"
                    ? "Check the release notes before we ship."
                    : "Focus on the compatibility section first.",
                state: "sending",
                // Enter while idle is Send, including a Session with history;
                // a transport queue does not change that composer intent.
                delivery: state === "steering" ? "steer" : "send",
              },
            ]
          : [],
      },
    },
  });
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBackgroundShellsStore.setState({
    byId:
      state === "moved-background"
        ? {
            "fixture-shell": {
              shellId: "fixture-shell",
              sessionId: SESSION,
              projectId: PROJECT,
              ticketId: null,
              command: "pnpm run check:release",
              title: "Release checks",
              state: "running",
              code: null,
              signal: null,
              startedAt: 1,
              exitedAt: null,
              pid: 1,
            },
          }
        : {},
    hydrated: true,
  });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
}
export default function ChatPolishScratch() {
  const [handoff, setHandoff] = React.useState(attaching ? "held-attaching" : "pending");
  function advanceHandoff() {
    if (handoff === "held-attaching") {
      // Simulated wiring: the host queue takes ownership while attachment is
      // still pending. No new transcript message, executor, or turn yet.
      store.setState(({ sessions }) => ({
        sessions: {
          ...sessions,
          [SESSION]: {
            ...sessions[SESSION]!,
            queue: [
              {
                id: "request",
                text: "Check the release notes before we ship.",
                queueState: "queued",
              },
            ],
            queueRevision: 2,
          },
        },
      }));
      setHandoff("queued-attaching");
    } else if (handoff === "queued-attaching") {
      // The same message becomes durable as the turn opens. Keep this plane
      // mounted so captures can compare bubble/Working bounds at every stage.
      store.setState(({ sessions }) => {
        const current = sessions[SESSION]!;
        return {
          sessions: {
            ...sessions,
            [SESSION]: {
              ...current,
              lifecycle: "working",
              projection: {
                ...current.projection!,
                turnActive: true,
                liveExecutor: { id: "chat-waiting-fixture-attachment" },
              },
              transcript: acceptedStreamingTranscript(false),
              queue: [],
              queueRevision: 3,
            },
          },
        };
      });
      setHandoff("durable-delivered");
    } else if (handoff === "pending") {
      // Seed the same acknowledgement bit the client sets when its receipt arrives
      // before the stream. This is a presentation fixture, not a real send.
      useChatDraftsStore.getState().amendHeldMessage(SESSION, "request", (message) => ({
        ...message,
        deliveryAccepted: true,
      }));
      setHandoff("accepted-held");
    } else if (handoff === "accepted-held") {
      // Preserve the mounted plane and active turn; only stream ownership lands.
      // The real ChatPlane reconciliation effect retires the matching held copy.
      store.setState(({ sessions }) => ({
        sessions: {
          ...sessions,
          [SESSION]: { ...sessions[SESSION]!, transcript: acceptedStreamingTranscript(false) },
        },
      }));
      setHandoff("durable-delivered");
    }
  }
  const Plane = new URLSearchParams(window.location.search).has("baseline")
    ? BaselinePlane
    : ChatPlane;
  if (Plane === null) throw new Error("Baseline sources not materialized");
  return (
    <React.Suspense>
      <TooltipProvider>
        <ModelAccessProvider client={client}>
          <div
            className="flex h-svh flex-col bg-background"
            data-chat-waiting-state={state}
            data-chat-waiting-handoff={handoff}
          >
            {state === "handoff" || attaching ? (
              <aside className="absolute top-4 left-2 z-10 flex w-40 flex-col gap-2 text-ui text-muted-foreground">
                <span>Seeded lab presentation proof</span>
                <span>{handoff}</span>
                <button
                  type="button"
                  disabled={handoff === "durable-delivered"}
                  onClick={advanceHandoff}
                >
                  Advance handoff
                </button>
              </aside>
            ) : null}
            <Plane
              sessionId={SESSION}
              projectId={PROJECT}
              ticketId={null}
              onOpenFile={() => undefined}
              store={store}
            />
          </div>
        </ModelAccessProvider>
      </TooltipProvider>
    </React.Suspense>
  );
}
