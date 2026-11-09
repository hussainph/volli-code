/** Simulated wiring: the real Home surface, ChatPlane and xterm terminal,
 * seeded with invented Voltaic shop work. The current project-ui store owns the tab
 * group and pane split; no transcript/composer is painted over the app.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_MODEL_PICKER_VIEW,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  SPLIT_VIEW_ROOT_PANE_ID,
} from "@volli/shared";
import { seedSlice } from "@volli/session-presentation";
import type { UIMessage } from "ai";

import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { terminalViewportSnapshot } from "@renderer/components/split/terminal-viewport-registry";
import { getOrCreateEngine } from "@renderer/terminal/registry";

import { ease, track } from "../kit/clock";
import {
  FrameLayer,
  Supers,
  useFilm,
  useFilmWallClock,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { NOW } from "../../renderer/lab/fixtures";
import { project, seedShell, sessionRows, shellApi, ShellWindow } from "../kit/split-shell";
import { Backdrop, useFilmTheme } from "../kit/world";

export const WINDOW = {
  landscape: { width: 1100, height: 720 },
  portrait: { width: 1000, height: 860 },
};
export const T = { split: 250 };
const RATIOS = [
  [250, 0.5],
  [330, 0.5],
  [1500, 0.56],
  [3500, 0.56],
] as const;
const CHAT = "film-chat-retry";
const CHAT_TAB = chatTabId(CHAT);
const TERM = "film-term-tests";
const TITLE = "Retry failed checkout requests";
const MODEL = {
  providerId: "anthropic",
  modelId: "claude-sonnet-4-5",
  reasoningLevel: "high",
} as const;

const MODEL_ACCESS: ModelAccessClient = {
  inspect: async () => ({
    observedAt: NOW,
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
        ...MODEL,
        label: "Claude Sonnet 4.5",
        state: "available",
        acceptsImageInput: true,
        reasoningLevels: ["low", "medium", "high"],
        contextWindow: 200000,
      },
    ],
  }),
  defaults: async () => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, global: MODEL }),
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
    throw new Error("Film fixture has no sign-in");
  },
  signOut: async () => {
    throw new Error("Film fixture has no sign-out");
  },
};

const MESSAGES: UIMessage[] = [
  {
    id: "retry-request",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Add a retry budget to the Voltaic checkout client. Keep the backoff jitter.",
      },
    ],
  },
  {
    id: "retry-reply",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "The retry budget is in place. **Jitter stays on**, and the budget resets for each request.\n\nThe regression tests cover exhausted budgets, transient failures and successful retries.",
      },
    ],
  },
  {
    id: "retry-check",
    role: "user",
    parts: [{ type: "text", text: "I’ll run the focused tests beside this chat." }],
  },
];
const template = sessionRows.find((row) => row.kind === "chat")!;
const EXTRA_ROW = {
  ...template,
  record: {
    ...template.record,
    sessionId: CHAT,
    projectId: project.id,
    ticketId: null,
    title: TITLE,
    activity: "idle" as const,
    waitingOn: null,
  },
};
const API = shellApi({
  sessions: { list: () => Promise.resolve({ ok: true, sessions: [...sessionRows, EXTRA_ROW] }) },
});

function seed(): void {
  seedShell();
  useUiStore.setState({ railCollapsed: true, sidebarPinned: false });
  const slice = seedSlice("ready");
  useChatSessionsStore.setState({
    openTabs: { [project.id]: [CHAT] },
    sessions: {
      [CHAT]: {
        ...slice,
        projection: {
          session: {
            id: CHAT,
            projectId: project.id,
            ticketId: null,
            title: TITLE,
            role: "project",
            parentSessionId: null,
            createdAt: NOW - 600000,
          },
          status: "open",
          signal: null,
          modelSelection: MODEL,
          modelTier: null,
          turnActive: false,
          lastActivityAt: NOW,
          bornTicketless: true,
          scheduledResume: null,
          attention: { active: [], primary: null },
          interactions: { active: [], resolved: [] },
          liveExecutor: null,
        },
        transcript: {
          ...slice.transcript,
          messages: MESSAGES,
          durableMessages: MESSAGES,
          turnEpoch: 2,
        },
      },
    },
  });
  useSessionsStore.setState({
    byOwner: {
      [project.id]: {
        tabs: [
          {
            sessionId: TERM,
            title: "pnpm test",
            scope: { kind: "project", projectId: project.id },
            layout: { kind: "pane", sessionId: TERM, exitCode: null },
            activePaneId: TERM,
          },
        ],
        activeSessionId: null,
      },
    },
  });
  useProjectUiStore.getState().setHomeActiveTab(project.id, CHAT_TAB);
}

/** Deterministic seeking: one actual two-pane tab group, including backwards seeks. */
function applySplit(t: number): void {
  const store = useProjectUiStore.getState();
  const root = store.byProject[project.id]?.homeSplitView?.root;
  if (t < T.split) {
    if (root?.kind === "split") {
      useProjectUiStore.setState(({ byProject }) => ({
        byProject: {
          ...byProject,
          [project.id]: { ...byProject[project.id]!, homeSplitView: null, homeActiveTab: CHAT_TAB },
        },
      }));
    }
    return;
  }
  if (root?.kind !== "split")
    store.splitHomePane(project.id, SPLIT_VIEW_ROOT_PANE_ID, "right", { tabId: TERM });
  const split = useProjectUiStore.getState().byProject[project.id]?.homeSplitView?.root;
  if (split?.kind !== "split") return;
  const ratio = track(t, RATIOS, ease.inOutCubic);
  if (Math.abs(split.ratio - ratio) > 0.00001) store.setHomeSplitRatio(project.id, split.id, ratio);
}

const OUTPUT = [
  "\x1b[38;5;244m/work/voltaic\x1b[0m $ pnpm test src/client",
  "",
  "\x1b[1m RUN \x1b[0m v4.0.0 /work/voltaic",
  "",
  " \x1b[32m✓\x1b[0m src/client/retry.test.ts (9 tests)",
  " \x1b[32m✓\x1b[0m src/client/backoff.test.ts (6 tests)",
  "",
  " Test Files  \x1b[32m2 passed\x1b[0m",
  "      Tests  \x1b[32m15 passed\x1b[0m",
  "",
  "/work/voltaic $ ",
].join("\r\n");

const CUE: Cue = {
  at: 200,
  until: 3300,
  eyebrow: "Multitasking",
  lines: ["Chat and terminal.", "Side by side."],
  weights: [780, 320],
};
const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower-right" }],
  portrait: [{ ...CUE, place: "lower" }],
};

export function SplitShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmWallClock(t, NOW);
  useFilmTheme("rose");
  useFixtures({ api: API, seed });
  const windowSize = WINDOW[format];
  const fed = React.useRef(false);
  React.useLayoutEffect(() => {
    applySplit(t);
    const anchor = terminalViewportSnapshot().get(TERM)?.anchor;
    const shell = anchor?.closest<HTMLElement>(".film-shell");
    const box = shell?.querySelector<HTMLElement>('[data-slot="terminal-viewport-box"]');
    if (!anchor || !shell || !box || !box.querySelector(".xterm")) return;
    // The split rig stays axis-aligned: native viewport measurements and
    // xterm's IntersectionObserver remain truthful through the dolly.
    const engine = getOrCreateEngine(TERM);
    engine.fit();
    if (!fed.current) {
      fed.current = true;
      // Feed only once the real terminal is attached. The parser's callback
      // (not a timeout) marks output readiness for capture diagnostics.
      engine.write(`\x1bc${OUTPUT}`, () => {
        shell.dataset.filmTerminalReady = "true";
      });
    }
  }, [t]);
  return (
    <>
      <Surface
        id="window"
        style={{
          position: "absolute",
          left: `calc(50% - ${windowSize.width / 2}px)`,
          top: `calc(50% - ${windowSize.height / 2}px)`,
          width: windowSize.width,
          height: windowSize.height,
        }}
        content={
          <ModelAccessProvider client={MODEL_ACCESS}>
            <ShellWindow width={windowSize.width} height={windowSize.height} />
          </ModelAccessProvider>
        }
      />
      <Backdrop t={t} theme="rose" focus={format === "landscape" ? [0.7, 0.7] : [0.5, 0.75]} />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
