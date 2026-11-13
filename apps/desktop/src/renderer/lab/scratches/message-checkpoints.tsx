/**
 * The checkpoint rail (VC-1211) on the production ChatPlane, over a seeded
 * long transcript. Simulated wiring: the Session, its history and its running
 * turn are store fixtures; there is no host, runtime or provider.
 *
 *   ?n=<exchanges>   how many messages the person sent (default 40; try 300)
 *   ?running         the latest exchange is still streaming: the Activity
 *                    Island is up and the reply is partial
 *   ?split           two planes side by side, as a split pane draws them
 *   ?width=<px>      the plane's width, to find where the rail hides
 *   ?short           every exchange is one line each way
 *   ?stream          with ?running, a word lands in the live reply every 50ms
 *   ?real            each reply is a real Session's shape: tool calls with output,
 *                    markdown and a distinct code block, so nothing is cached
 *   ?cloud           a cloud launch, for the team row in the plane's corner
 *                    (no backend: the row shows a failed read and Retry;
 *                    ?cloud=long makes that reason 300 characters)
 */
import {
  ACTIVITY_METADATA_KEY,
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_MODEL_PICKER_VIEW,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type SessionPresentationProjection,
} from "@volli/shared";
import * as React from "react";
import { seedSlice } from "@volli/session-presentation";
import type { UIMessage } from "ai";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { adoptLaunch } from "@renderer/stores/launch";
import { useCloudTeamStore } from "@renderer/lib/cloud-team";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";

export const title = "Chat · message checkpoints";
export const note =
  "Simulated wiring · production ChatPlane over a seeded long transcript; ?n= ?running ?split ?width= ?short";
export const viewport = "window" as const;

const params = new URLSearchParams(window.location.search);
const EXCHANGES = Math.max(0, Number(params.get("n") ?? 40) || 0);
const RUNNING = params.has("running");
const STREAM = RUNNING && params.has("stream");
const SPLIT = params.has("split");
const SHORT = params.has("short");
const REAL = params.has("real");
const WIDTH = Number(params.get("width") ?? 0) || null;
const PROJECT = "checkpoint-lab-project";
const SESSIONS = SPLIT ? ["checkpoint-lab-left", "checkpoint-lab-right"] : ["checkpoint-lab"];

const selection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
} as const;
const store = createChatSessionsStore();

const ASKS = [
  "Okay, so I've listed down those requirements. Can you turn them into a schema we can actually test against?",
  "Why does the board flicker when a card moves between columns? It only happens on the second move.",
  "Rename `sessionLedger` to `history` everywhere, but keep the durable ids exactly as they are.",
  "Check the release notes against the migration guide before we ship.",
  "What breaks if we drop the legacy host protocol entirely?",
  "יש לי שאלה על ההגדרות של החיבור — האם זה עובד גם בלי חשבון?",
  "这个分支上的测试为什么在 CI 上失败,但在本地通过?",
  "Ship it 🚀 — then write the changelog entry.",
  "Look at https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/break/at/all/so/it/has/to/wrap",
  "Use a predefined set of activity types, sessions, and members for this version.",
];
const REPLIES = [
  "Done. The schema lives in `schema.ts` with one table per entity, and each invariant has a test beside it. The two rules that could not be expressed as constraints are checked in the mutation instead.",
  "The second move reads the column's width before the first move's layout settles. I moved the read into the drop handler, so it now happens once per drop, after layout.",
  "Renamed across 41 files. The ids derived from the old name are kept as literal strings with a comment saying they are durable.",
  "Two mismatches: the guide still names the old flag, and the notes omit the database migration. Both are fixed in the branch.",
  "Only the superseded install path. Nothing current calls it; the two tests that reached it are retired with it.",
  "כן, החיבור עובד גם בלי חשבון. ההגדרות נשמרות על המחשב.",
  "CI 使用了更旧的 Node 版本。我已经在工作流中固定了版本。",
  "Shipped, and the changelog entry is in.",
  "That URL redirects twice before it answers; the client now follows redirects up to three times.",
  "Sounds good. I'll use a fixed set for now and note where it should become configurable.",
];

function tool(
  id: string,
  kind: "run-command" | "read-file",
  label: string,
  output: string,
): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: kind === "run-command" ? "bash" : "read",
    toolCallId: id,
    state: "output-available",
    input: kind === "run-command" ? { command: label } : { path: label },
    output: { content: [{ type: "text", text: output }] },
    toolMetadata: {
      [ACTIVITY_METADATA_KEY]: {
        kind,
        nativeToolName: kind === "run-command" ? "bash" : "read",
        subject: { label, path: kind === "read-file" ? label : null, lineRange: null },
        outcome: {
          exitCode: kind === "run-command" ? 0 : null,
          matchCount: null,
          fileCount: null,
          lineCount: null,
          bytes: null,
          addedLines: null,
          removedLines: null,
          diff: null,
          summary: null,
        },
        startedAt: 1,
        endedAt: 2,
      },
    },
  } as UIMessage["parts"][number];
}

/** A reply shaped like a real Session's: work, then prose with a distinct code block. */
function realReply(index: number, reply: string): UIMessage["parts"] {
  const file = `src/module-${index}.ts`;
  return [
    { type: "text", text: "Looking at it." },
    tool(`read-${index}`, "read-file", file, `export const value${index} = ${index};\n`.repeat(30)),
    tool(
      `grep-${index}`,
      "run-command",
      `rg -n value${index} src`,
      `${file}:1:value${index}\n`.repeat(12),
    ),
    tool(`test-${index}`, "run-command", "pnpm test", `✓ ${index} passed\n`.repeat(20)),
    {
      type: "text",
      text: `## Step ${index + 1}\n\n${reply}\n\n- **${index}** changed\n- \`${file}\` updated\n\n\`\`\`ts\nexport function step${index}(input: number): number {\n  const scaled = input * ${index + 1};\n  return scaled > ${index * 7} ? scaled - ${index} : scaled + ${index};\n}\n\`\`\`\n\n${reply}`,
    },
  ];
}

function exchange(index: number): UIMessage[] {
  const ask = ASKS[index % ASKS.length]!;
  const reply = REPLIES[index % REPLIES.length]!;
  const long = !SHORT && index % 3 === 0;
  return [
    {
      id: `ask-${index}`,
      role: "user",
      parts: [{ type: "text", text: `(${index + 1}) ${ask}` }],
    },
    {
      id: `reply-${index}`,
      role: "assistant",
      parts: REAL
        ? realReply(index, reply)
        : [
            { type: "text", text: long ? `${reply}\n\n${reply}\n\n- ${reply}\n- ${reply}` : reply },
            ...(long
              ? [
                  {
                    type: "text" as const,
                    text: "```ts\nexport function settle(card: Card): Column {\n  return card.column;\n}\n```\n\nThat is the last of it for this step.",
                  },
                ]
              : []),
          ],
    },
  ];
}

function transcriptFor(): UIMessage[] {
  const messages = Array.from({ length: EXCHANGES }, (_, index) => exchange(index)).flat();
  if (RUNNING && messages.length > 0) {
    // The latest reply is still arriving: only its first sentence is in.
    const last = messages[messages.length - 1]!;
    messages[messages.length - 1] = {
      ...last,
      parts: [{ type: "text", text: "Looking at the column widths first.", state: "streaming" }],
    };
  }
  return messages;
}

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
  // Simulated wiring: a cloud launch with no backend behind it.
  if (params.has("cloud"))
    adoptLaunch({
      store: "cloud",
      userId: "lab",
      backendUrl: "https://lab.invalid",
      deployment: "local",
    });
  // The team row at its tallest: a failed read shows its reason and Retry.
  // `?cloud=long`: a backend refusal at its 300-character cap, to see it wrap.
  if (params.has("cloud"))
    useCloudTeamStore.setState({
      readError:
        params.get("cloud") === "long"
          ? "The workspace member directory could not be read because the backend refused the request: "
              .repeat(4)
              .slice(0, 300)
          : "Team unavailable",
    });
  const messages = transcriptFor();
  const sessions = Object.fromEntries(
    SESSIONS.map((id) => {
      const projection: SessionPresentationProjection = {
        session: {
          id,
          projectId: PROJECT,
          ticketId: null,
          title: "Message checkpoints",
          role: "project",
          parentSessionId: null,
          createdAt: 0,
        },
        status: "open",
        signal: null,
        modelSelection: selection,
        modelTier: null,
        turnActive: RUNNING,
        lastActivityAt: 0,
        bornTicketless: true,
        scheduledResume: null,
        attention: { active: [], primary: null },
        interactions: { active: [], resolved: [] },
        liveExecutor: { id: "checkpoint-lab-attachment" },
      };
      const slice = seedSlice(RUNNING ? "working" : "ready");
      return [
        id,
        {
          ...slice,
          projection,
          transcript: {
            ...slice.transcript,
            messages,
            durableMessages: messages,
            turnActive: RUNNING,
            turnEpoch: RUNNING ? 1 : 0,
          },
          queue: [],
          queueRevision: 1,
        },
      ];
    }),
  );
  store.setState({ sessions });
  useChatDraftsStore.setState({
    drafts: Object.fromEntries(
      SESSIONS.map((id) => [id, { text: "", attachments: [], touchedAt: 0, held: [] }]),
    ),
  });
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
}

/** Simulated wiring: a token stream is a store write per word, as a frame batch is. */
function useStream() {
  React.useEffect(() => {
    if (!STREAM) return;
    let words = 0;
    const timer = window.setInterval(() => {
      words += 1;
      store.setState(({ sessions }) => ({
        sessions: Object.fromEntries(
          Object.entries(sessions).map(([id, session]) => {
            const messages = session.transcript.messages.slice();
            const last = messages[messages.length - 1]!;
            messages[messages.length - 1] = {
              ...last,
              parts: [
                {
                  type: "text",
                  text: `Looking at the column widths first.${" word".repeat(words)}`,
                  state: "streaming",
                },
              ],
            };
            return [id, { ...session, transcript: { ...session.transcript, messages } }];
          }),
        ),
      }));
    }, 50);
    return () => window.clearInterval(timer);
  }, []);
}

export default function MessageCheckpointsScratch() {
  useStream();
  return (
    <TooltipProvider>
      <ModelAccessProvider client={client}>
        <div className="flex h-svh gap-1.5 bg-muted p-1.5">
          {SESSIONS.map((id) => (
            <div
              key={id}
              data-checkpoint-lab-pane={id}
              className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-background"
              style={WIDTH === null ? undefined : { flex: "none", width: WIDTH }}
            >
              <ChatPlane
                sessionId={id}
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
