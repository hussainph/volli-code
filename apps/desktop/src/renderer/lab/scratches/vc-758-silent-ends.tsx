/** VC-758: production ChatPlane with frozen renderer/store inputs, not a drawn facsimile.
 * ?state=sending|accepted-streaming|handoff|steering|queued|working|error|error-scrolled selects a state.
 * No runtime or provider connection; these screenshots prove presentation only.
 */
import * as React from "react";
import {
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

export const title = "VC-758 · silent timeline states";
export const note = "Actual ChatPlane; frozen host/store fixtures, no provider or Electron";
export const viewport = "window" as const;
const SESSION = "vc-758-screenshot-session";
const PROJECT = "vc-758-screenshot-project";
const selection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
} as const;
const store = createChatSessionsStore();
const state = new URLSearchParams(window.location.search).get("state") ?? "sending";
// The capture script temporarily materializes the exact baseline sources from Git.
// They are not maintained copies of product components and never ship.
const baseline = import.meta.glob<{ ChatPlane: typeof ChatPlane }>(
  "./vc-758-before-chat-plane.tsx",
)["./vc-758-before-chat-plane.tsx"];
const BeforePlane =
  baseline === undefined
    ? null
    : React.lazy(async () => ({ default: (await baseline()).ChatPlane }));
const before = new URLSearchParams(window.location.search).get("phase") === "before";
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
        attachmentId: "vc-758-fixture-attachment",
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
    seedSlice("ready").transcript,
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
        attachmentId: "vc-758-fixture-attachment",
        turnId: "reply-turn",
      }),
      frame(3, {
        kind: "command.receipt.recorded",
        receipt: {
          id: "opening-receipt",
          commandId: "ordinary-send",
          recordedAt: 3,
          sequence: 3,
          status: "accepted",
          acceptedAt: 3,
          result: { kind: "message.submitted", sessionId: SESSION },
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
                parts: [
                  {
                    key: "reply-text",
                    part: {
                      type: "text",
                      text: "I’m checking the release notes and tests.",
                      state: "streaming",
                    },
                  },
                ],
              },
            },
          },
        ]
      : [],
  );
}
export function seed() {
  const working = ["steering", "queued", "working", "accepted-streaming", "handoff"].includes(
    state,
  );
  const error = state === "error" || state === "error-scrolled";
  const messages: UIMessage[] =
    state === "working" || state === "sending" || state === "handoff"
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
    liveExecutor: { id: "vc-758-fixture-attachment" },
  };
  const slice = seedSlice(working ? "working" : "ready");
  store.setState({
    sessions: {
      [SESSION]: {
        ...slice,
        projection,
        transcript:
          state === "accepted-streaming"
            ? acceptedStreamingTranscript()
            : {
                ...slice.transcript,
                messages,
                durableMessages: messages,
                turnActive: working,
                turnEpoch: working ? 1 : 0,
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
        held:
          state === "sending" || state === "steering" || state === "handoff"
            ? [
                {
                  id: state === "handoff" ? "request" : "pending",
                  text:
                    state !== "steering"
                      ? "Check the release notes before we ship."
                      : "Focus on the compatibility section first.",
                  state: "sending",
                  delivery: state === "steering" ? "steer" : "send",
                },
              ]
            : [],
      },
    },
  });
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
}
export default function SilentEndsScratch() {
  const [handoff, setHandoff] = React.useState("pending");
  function advanceHandoff() {
    if (handoff === "pending") {
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
  const Plane = before ? BeforePlane : ChatPlane;
  if (Plane === null)
    return <p>Run the screenshot capture script to materialize the baseline renderer.</p>;
  return (
    <React.Suspense>
      <TooltipProvider>
        <ModelAccessProvider client={client}>
          <div
            className="flex h-svh flex-col bg-background"
            data-vc-758-state={state}
            data-vc-758-handoff={handoff}
          >
            {state === "handoff" ? (
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
