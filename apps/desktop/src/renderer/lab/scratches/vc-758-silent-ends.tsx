/** VC-758: production ChatPlane with frozen renderer/store inputs, not a drawn facsimile.
 * ?state=sending|steering|queued|working|error selects one reproducible state.
 * No runtime or provider connection; these screenshots prove presentation only.
 */
import * as React from "react";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_MODEL_PICKER_VIEW,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type SessionPresentationProjection,
} from "@volli/shared";
import { seedSlice } from "@volli/session-presentation";
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
export function seed() {
  const working = ["steering", "queued", "working"].includes(state);
  const messages: UIMessage[] =
    state === "working" || state === "sending"
      ? []
      : [
          {
            id: "request",
            role: "user",
            parts: [{ type: "text", text: "Check the release notes before we ship." }],
          },
          ...(state === "error"
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
        transcript: {
          ...slice.transcript,
          messages,
          durableMessages: messages,
          turnActive: working,
          turnEpoch: working ? 1 : 0,
        },
        sessionError:
          state === "error" ? "Context assembly failed before the model could start." : null,
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
          state === "sending" || state === "steering"
            ? [
                {
                  id: "pending",
                  text:
                    state === "sending"
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
  const Plane = before ? BeforePlane : ChatPlane;
  if (Plane === null)
    return <p>Run the screenshot capture script to materialize the baseline renderer.</p>;
  return (
    <React.Suspense>
      <TooltipProvider>
        <ModelAccessProvider client={client}>
          <div className="flex h-svh flex-col bg-background" data-vc-758-state={state}>
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
