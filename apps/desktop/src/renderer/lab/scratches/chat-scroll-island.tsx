/** VC-1210: the jump-to-latest button and the Activity Island in the production ChatPlane.
 * ?island=turn|shells|shells-turn|plan-turn|shells-long-turn picks what the island holds;
 * ?split=1 draws two planes side by side. "Toggle turn" starts or ends the turn in
 * place, so the bead's rise and the button can be watched moving together. The transcript is long enough to scroll,
 * so scrolling up shows the button over whatever the island draws.
 * No runtime or provider connection; these screenshots prove presentation only.
 */
import {
  ACTIVITY_METADATA_KEY,
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

export const title = "Chat · jump to latest over the island";
export const note = "Simulated wiring — actual ChatPlane over frozen store fixtures, no provider";
export const viewport = "window" as const;

const PROJECT = "chat-scroll-island-project";
const SESSIONS = ["chat-scroll-island-a", "chat-scroll-island-b"] as const;
const params = new URLSearchParams(window.location.search);
const island = params.get("island") ?? "shells-turn";
const split = params.has("split");
const turn = island.endsWith("turn");
const shells = island.includes("shells");
const plan = island.startsWith("plan");
const longCaption = island.includes("long");

const selection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
} as const;
const store = createChatSessionsStore();

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

function history(): UIMessage[] {
  const messages: UIMessage[] = [];
  for (let index = 1; index <= 14; index++)
    messages.push(
      {
        id: `request-${index}`,
        role: "user",
        parts: [{ type: "text", text: `Review release note section ${index}.` }],
      },
      {
        id: `reply-${index}`,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: `Section ${index} is checked against the compatibility notes. The existing behavior remains documented, the migration steps match the shipped schema, and the upgrade path from the previous release is covered.`,
          },
        ],
      },
    );
  return messages;
}

const command = longCaption
  ? "pnpm --filter @volli/desktop exec vitest run src/renderer/src/components/chat/liquid-island-shell.test.tsx --reporter=verbose"
  : "pnpm run check:release";

function runningTool(): UIMessage {
  return {
    id: "live-reply",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "bash",
        toolCallId: "bash-fixture",
        state: "input-available",
        input: { command },
        toolMetadata: {
          [ACTIVITY_METADATA_KEY]: {
            kind: "run-command",
            nativeToolName: "bash",
            subject: { label: command, path: null, lineRange: null },
            outcome: null,
            startedAt: 1,
            endedAt: null,
          },
        },
      },
    ],
  };
}

function seedSession(sessionId: string) {
  const messages = [
    ...history(),
    ...(turn
      ? [
          {
            id: "live-request",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "Run the release checks." }],
          },
          runningTool(),
        ]
      : []),
  ];
  const projection: SessionPresentationProjection = {
    session: {
      id: sessionId,
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
    turnActive: turn,
    lastActivityAt: 0,
    bornTicketless: true,
    scheduledResume: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    liveExecutor: { id: "chat-scroll-island-attachment" },
    ...(plan
      ? {
          todoList: [
            { content: "Read the release notes", status: "completed" as const },
            { content: "Run the release checks", status: "in_progress" as const },
            { content: "Draft the changelog", status: "pending" as const },
          ],
        }
      : {}),
  };
  const slice = seedSlice(turn ? "working" : "ready");
  return {
    ...slice,
    projection,
    transcript: {
      ...slice.transcript,
      messages,
      durableMessages: messages,
      turnActive: turn,
      turnEpoch: turn ? 29 : 28,
    },
    queueRevision: 1,
  };
}

export function seed() {
  store.setState({
    sessions: Object.fromEntries(SESSIONS.map((id) => [id, seedSession(id)])),
  });
  useChatDraftsStore.setState({
    drafts: Object.fromEntries(
      SESSIONS.map((id) => [id, { text: "", attachments: [], touchedAt: 0, held: [] }]),
    ),
  });
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBackgroundShellsStore.setState({
    byId: shells
      ? Object.fromEntries(
          SESSIONS.map((sessionId) => [
            `${sessionId}-shell`,
            {
              shellId: `${sessionId}-shell`,
              sessionId,
              projectId: PROJECT,
              ticketId: null,
              command: "pnpm dev",
              title: "Dev server",
              state: "running" as const,
              code: null,
              signal: null,
              startedAt: 1,
              exitedAt: null,
              pid: 1,
            },
          ]),
        )
      : {},
    hydrated: true,
  });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
}

/** Simulated wiring: flips the seeded turn in the store; no runtime is involved. */
function toggleTurn() {
  store.setState(({ sessions }) => {
    const next = { ...sessions };
    for (const id of SESSIONS) {
      const current = next[id];
      if (!current?.projection) continue;
      const running = !current.transcript.turnActive;
      const messages = running
        ? [
            ...history(),
            {
              id: "live-request",
              role: "user" as const,
              parts: [{ type: "text" as const, text: "Run the release checks." }],
            },
            runningTool(),
          ]
        : history();
      next[id] = {
        ...current,
        lifecycle: running ? "working" : "ready",
        projection: { ...current.projection, turnActive: running },
        transcript: {
          ...current.transcript,
          messages,
          durableMessages: messages,
          turnActive: running,
          turnEpoch: current.transcript.turnEpoch + 1,
        },
      };
    }
    return { sessions: next };
  });
}

export default function ChatScrollIslandScratch() {
  return (
    <TooltipProvider>
      <ModelAccessProvider client={client}>
        <div className="flex h-svh bg-background" data-chat-scroll-island={island}>
          <aside className="absolute top-4 left-2 z-10 text-ui text-muted-foreground">
            <button type="button" data-lab-toggle-turn="" onClick={toggleTurn}>
              Toggle turn
            </button>
          </aside>
          {(split ? SESSIONS : SESSIONS.slice(0, 1)).map((sessionId, index) => (
            <div
              key={sessionId}
              className={
                index > 0 ? "flex min-w-0 flex-1 border-l border-border" : "flex min-w-0 flex-1"
              }
            >
              <ChatPlane
                sessionId={sessionId}
                projectId={PROJECT}
                ticketId={null}
                onOpenFile={() => undefined}
                store={store}
              />
            </div>
          ))}
        </div>
      </ModelAccessProvider>
    </TooltipProvider>
  );
}
