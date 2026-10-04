/**
 * Browser · the VC-614 rework, proposed in the lab before any of it ships.
 *
 * Round two. The first round answered "where does a browser live"; this one
 * starts from first principles on how a person and an agent share a tab, and
 * borrows what the agentic browsers (Manus, Operator, Comet, Claude in Chrome,
 * Opera Neon, Devin, Replit) learned the hard way.
 *
 *  1. NO TAKEOVER BUTTON. A person never asks permission to touch their own
 *     tab. Pointer or keys in the page pause the agent on the spot; four
 *     quiet seconds later it carries on by itself (the hairline under the
 *     header drains toward that). The only explicit handback left is the one
 *     the AGENT asks for: a sign-in, a captcha, a payment — "Hand back" ends
 *     the request it made. While it works, the page wears a thin ring in the
 *     agent's colour and the header narrates the step, so who-is-driving is
 *     never a guess.
 *
 *  2. A CURSOR WITH CHARACTER. Springs instead of teleports: x and y settle
 *     on different springs, so a glide draws a slight arc rather than a ruler
 *     line; the arrow leans into horizontal speed; the name tag trails a beat
 *     behind on a softer spring; a click dips the arrow and rings out. It
 *     arrives by fading in at its first target instead of flying in from a
 *     corner, and fades out when the agent stops. Reduced motion jumps.
 *
 *  3. THE DOCK SWITCHES BY DROPDOWN, NOT TABS. The dock is a viewer for one
 *     chat's tabs, not a second tab strip nested inside the workspace's; it
 *     follows the agent to the tab it just opened, so manual switching is
 *     the exception — and a dropdown holds fifteen dev-server tabs without
 *     shrinking each to an unreadable sliver.
 *
 *  4. THE DOCK AND A REAL SPLIT ARE DIFFERENT THINGS. A split belongs to the
 *     workspace and stays put across chats, board and ticket (try it: "You…
 *     open a tab in a real split", then switch surfaces). The dock belongs to
 *     its chat and lives INSIDE the chat's pane. When a split leaves the chat
 *     pane too narrow for both columns, the dock folds into a rail at the
 *     pane's edge and opens as a sheet over the transcript. One tab is in one
 *     place: splitting the docked tab moves it out of the dock.
 *
 *  5. THE ISLAND CARD, CRAFTED. Rows lead with the page title; the second line
 *     is the path, or — while an agent works the tab — what it is doing, in
 *     its colour. A tab that needs you rises to the top. Close is one press
 *     with Undo in the pill; closing a row collapses it instead of jolting the
 *     list. Arrow keys move through rows, Enter shows the tab beside chat.
 *
 * Everything is fixture-driven: the page is a mock, not a WebContentsView, so
 * judge layout, flow and feel here and native-plane behaviour in the app.
 */
import * as React from "react";
import {
  AnimatePresence,
  motion,
  useMotionTemplate,
  useReducedMotion,
  useSpring,
  useTransform,
  useVelocity,
} from "motion/react";
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretLeftIcon,
  ChatCircleIcon,
  CheckIcon,
  GlobeSimpleIcon,
  HandPointingIcon,
  KanbanIcon,
  LockKeyIcon,
  MagnifyingGlassIcon,
  NavigationArrowIcon,
  PlayIcon,
  RobotIcon,
  SidebarSimpleIcon,
  SquareSplitHorizontalIcon,
  TicketIcon,
  XIcon,
} from "@phosphor-icons/react";
import { sessionColor } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Spinner } from "@renderer/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

export const title = "Browser · docked beside its chat (VC-614)";
export const note =
  "Round two: no takeover button, a cursor with character, the dock vs a real split, and a crafted island card";
export const viewport = "window" as const;

/* ---------------------------------------------------------------- the model */

/** Where a tab is drawn. One tab is in one place. */
type Presentation = "background" | "beside" | "tab" | "split";

/**
 * What the owning agent is doing with the tab. There is no "held" state a
 * person must take: `paused` is what the person's own input causes, and it
 * ends by itself.
 */
type AgentState = "idle" | "working" | "paused" | "needsYou";

interface LabTab {
  id: string;
  /** The Session that opened it — a chat, or a child of one. */
  owner: string;
  url: string;
  title: string;
  loading: boolean;
  presentation: Presentation;
  /** Which chat's dock draws it while `presentation` is `beside`. */
  dockedIn: string | null;
  agent: AgentState;
  /** The step the agent is on, in its words — the dock header and island say it. */
  say: string | null;
}

interface LabChat {
  id: string;
  title: string;
  /** Child Sessions whose tabs this chat answers for. */
  children: readonly { id: string; title: string }[];
  /** The fixture transcript: what was asked, and the agent's two lines around its tab. */
  ask: string;
  reply: readonly [string, string];
}

const CHATS: readonly LabChat[] = [
  {
    id: "chat-settings",
    title: "Fix the settings page",
    children: [{ id: "child-audit", title: "Audit form contrast" }],
    ask: "Can you check the settings page in the dev server? The billing tab looks off.",
    reply: [
      "I'll open the dev server and look at both settings pages.",
      "The billing card's total overflows below 900px. I'll fix the grid and re-check.",
    ],
  },
  {
    id: "chat-auth",
    title: "Audit the auth flow",
    children: [],
    ask: "Walk the sign-in flow on the API server and tell me where an expired session lands.",
    reply: [
      "Opening the sign-in page on the API server.",
      "An expired session redirects to /login?error=expired, but the banner never renders.",
    ],
  },
];

type Surface =
  | { kind: "board" }
  | { kind: "ticket" }
  | { kind: "chat"; chatId: string }
  | { kind: "browser"; tabId: string };

/** One scripted agent step: where in the page (as fractions of it) and what. */
interface Step {
  x: number;
  y: number;
  act: "click" | "type" | "scroll";
  say: string;
}

interface Task {
  tabId: string;
  steps: readonly Step[];
  /** The next step to run. */
  at: number;
}

interface LabCursor {
  tabId: string;
  x: number;
  y: number;
  act: Step["act"];
  /** Bumped per click, so the press plays once per click. */
  press: number;
  visible: boolean;
}

interface Flash {
  text: string;
  /** A tab closed by one press, kept for the pill's Undo. */
  undo?: LabTab;
}

interface LabState {
  tabs: LabTab[];
  surface: Surface;
  /** Dock width per chat, as a share of the chat's pane. */
  dockWidth: Record<string, number>;
  /** The workspace split's width, as a share of the window row. */
  splitShare: number;
  /** Workspace strip order for tabs opened as tabs. */
  strip: string[];
  flash: Flash | null;
  task: Task | null;
  cursor: LabCursor | null;
  /** While the person is using a tab the agent works: when it may carry on. */
  youUntil: number | null;
  /** A folded dock opened as a sheet, per chat. */
  sheetOpen: Record<string, boolean>;
  serial: number;
}

type Action =
  | { type: "surface"; surface: Surface }
  | { type: "showBeside"; tabId: string; chatId: string }
  | { type: "hide"; tabId: string }
  | { type: "openAsTab"; tabId: string }
  | { type: "openInSplit"; tabId: string }
  | { type: "closeSplit" }
  | { type: "close"; tabId: string }
  | { type: "undoClose" }
  | { type: "closeAll"; chatId: string }
  | { type: "agentOpen"; owner: string; url: string; title: string; follow: string | null }
  | { type: "agentNavigate"; tabId: string; url: string; title: string }
  | { type: "settle"; tabId: string }
  | { type: "runTask"; tabId: string; steps: readonly Step[] }
  | { type: "step" }
  | { type: "finishTask" }
  | { type: "hideCursor" }
  | { type: "personInput"; tabId: string; at: number }
  | { type: "carryOn" }
  | { type: "askSignIn"; tabId: string }
  | { type: "handBack"; tabId: string }
  | { type: "dockWidth"; chatId: string; width: number }
  | { type: "splitShare"; share: number }
  | { type: "sheet"; chatId: string; open: boolean }
  | { type: "clearFlash" }
  | { type: "reset" };

const DEV_PAGES: readonly { path: string; title: string }[] = [
  { path: "/settings", title: "Settings · Acme" },
  { path: "/settings/billing", title: "Billing · Acme" },
  { path: "/settings/members?invite=1", title: "Invite members · Acme" },
  { path: "/login", title: "Sign in · Acme" },
  { path: "/login?error=expired", title: "Session expired · Acme" },
  { path: "/dashboard", title: "Dashboard · Acme" },
  { path: "/projects/42/edit", title: "Edit project · Acme" },
  { path: "/onboarding/step-2", title: "Onboarding · Acme" },
  { path: "/?path=/story/button--primary", title: "Button – Primary ⋅ Storybook" },
  { path: "/?path=/story/dialog--confirm", title: "Dialog – Confirm ⋅ Storybook" },
  { path: "/api/health", title: "" },
  { path: "/docs/getting-started", title: "Getting started – Acme Docs" },
  { path: "/reset-password?token=…", title: "Reset password · Acme" },
  { path: "/404-check", title: "Not found · Acme" },
  { path: "/settings/appearance", title: "Appearance · Acme" },
];

const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5173",
  "http://localhost:5173",
  "http://localhost:6006",
  "http://127.0.0.1:3000",
] as const;

/** A run across the mock page's own landmarks, so the cursor's path reads as purposeful. */
const REVIEW_STEPS: readonly Step[] = [
  { x: 0.09, y: 0.28, act: "click", say: "Clicking “Billing”" },
  { x: 0.42, y: 0.32, act: "click", say: "Opening the plan card" },
  { x: 0.78, y: 0.36, act: "click", say: "Expanding “Invoices”" },
  { x: 0.55, y: 0.62, act: "type", say: "Typing a coupon code" },
  { x: 0.3, y: 0.56, act: "scroll", say: "Scrolling to the total" },
  { x: 0.86, y: 0.08, act: "click", say: "Opening “Account”" },
];

const AFTER_SIGN_IN_STEPS: readonly Step[] = [
  { x: 0.42, y: 0.32, act: "click", say: "Checking the session" },
  { x: 0.09, y: 0.36, act: "click", say: "Clicking “Members”" },
];

/** A step's beat: the glide lands, then the act reads, then the next one starts. */
const STEP_MS = 760;
/** The cursor lingers this long after the agent's last act, then fades. */
const CURSOR_LINGER_MS = 1200;
/** Quiet after the person's last input before the agent carries on by itself. */
const PERSON_QUIET_MS = 4000;

function initialTabs(): LabTab[] {
  const base = { loading: false, dockedIn: null, agent: "idle" as const, say: null };
  return [
    {
      ...base,
      id: "t1",
      owner: "chat-settings",
      url: "http://localhost:5173/settings",
      title: "Settings · Acme",
      presentation: "beside",
      dockedIn: "chat-settings",
    },
    {
      ...base,
      id: "t2",
      owner: "chat-settings",
      url: "http://localhost:5173/settings/billing",
      title: "Billing · Acme",
      presentation: "background",
    },
    {
      ...base,
      id: "t3",
      owner: "child-audit",
      url: "http://localhost:6006/?path=/story/button--primary",
      title: "Button – Primary ⋅ Storybook",
      presentation: "background",
    },
    {
      ...base,
      id: "t4",
      owner: "chat-auth",
      url: "http://127.0.0.1:3000/login",
      title: "Sign in · Acme",
      presentation: "background",
    },
  ];
}

const INITIAL: LabState = {
  tabs: initialTabs(),
  surface: { kind: "chat", chatId: "chat-settings" },
  dockWidth: {},
  splitShare: 0.42,
  strip: [],
  flash: null,
  task: null,
  cursor: null,
  youUntil: null,
  sheetOpen: {},
  serial: 100,
};

function chatOf(sessionId: string): LabChat | undefined {
  return CHATS.find(
    (chat) => chat.id === sessionId || chat.children.some((child) => child.id === sessionId),
  );
}

function sessionTitle(sessionId: string): string {
  for (const chat of CHATS) {
    if (chat.id === sessionId) return chat.title;
    const child = chat.children.find((one) => one.id === sessionId);
    if (child) return child.title;
  }
  return "another Session";
}

/** `localhost:5173` — the origin WITH its port, which is the whole point for dev servers. */
function originOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `/settings/billing?tab=2` — what tells two tabs on one origin apart. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    const path = safeDecode(`${parsed.pathname}${parsed.search}`);
    return path === "/" ? "/" : path.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/** Title first; a page with no title is named by its path, never by a bare host. */
function tabName(tab: Pick<LabTab, "url" | "title">): string {
  const named = tab.title.trim();
  return named.length > 0 ? named : `${originOf(tab.url)}${pathOf(tab.url)}`;
}

function reducer(state: LabState, action: Action): LabState {
  const patch = (tabId: string, change: Partial<LabTab>): LabTab[] =>
    state.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...change } : tab));
  const find = (tabId: string) => state.tabs.find((tab) => tab.id === tabId);
  /** Moving a tab somewhere takes it out of wherever it was: one tab, one place. */
  const place = (tabId: string, presentation: Presentation, dockedIn: string | null) =>
    state.tabs.map((one) => {
      if (one.id === tabId) return { ...one, presentation, dockedIn };
      // One dock per chat and one split per workspace: the previous occupant
      // goes back to the background rather than stacking.
      const displaced =
        (presentation === "beside" && one.presentation === "beside" && one.dockedIn === dockedIn) ||
        (presentation === "split" && one.presentation === "split");
      return displaced ? { ...one, presentation: "background" as const, dockedIn: null } : one;
    });
  switch (action.type) {
    case "surface":
      return { ...state, surface: action.surface };
    case "showBeside": {
      const tab = find(action.tabId);
      if (!tab) return state;
      return {
        ...state,
        tabs: place(action.tabId, "beside", action.chatId),
        strip: state.strip.filter((id) => id !== action.tabId),
        // Showing a tab beside its chat is also going to that chat.
        surface: { kind: "chat", chatId: action.chatId },
        flash: { text: `Beside chat · ${tabName(tab)}` },
      };
    }
    case "hide": {
      const tab = find(action.tabId);
      if (!tab) return state;
      return {
        ...state,
        tabs: patch(action.tabId, { presentation: "background", dockedIn: null }),
        strip: state.strip.filter((id) => id !== action.tabId),
        flash: { text: `Still open in the background · ${tabName(tab)}` },
      };
    }
    case "openAsTab": {
      const tab = find(action.tabId);
      if (!tab) return state;
      return {
        ...state,
        tabs: place(action.tabId, "tab", null),
        strip: state.strip.includes(action.tabId) ? state.strip : [...state.strip, action.tabId],
        surface: { kind: "browser", tabId: action.tabId },
        flash: { text: `Opened as tab · ${tabName(tab)}` },
      };
    }
    case "openInSplit": {
      const tab = find(action.tabId);
      if (!tab) return state;
      // A browser surface showing this very tab would draw it twice.
      const surface =
        state.surface.kind === "browser" && state.surface.tabId === action.tabId
          ? ({ kind: "chat", chatId: chatOf(tab.owner)?.id ?? CHATS[0]!.id } as const)
          : state.surface;
      return {
        ...state,
        tabs: place(action.tabId, "split", null),
        strip: state.strip.filter((id) => id !== action.tabId),
        surface,
        flash: { text: `In a split · ${tabName(tab)}` },
      };
    }
    case "closeSplit":
      return {
        ...state,
        tabs: state.tabs.map((one) =>
          one.presentation === "split" ? { ...one, presentation: "background" as const } : one,
        ),
      };
    case "close": {
      const tab = find(action.tabId);
      if (!tab) return state;
      const surface =
        state.surface.kind === "browser" && state.surface.tabId === action.tabId
          ? ({ kind: "chat", chatId: chatOf(tab.owner)?.id ?? CHATS[0]!.id } as const)
          : state.surface;
      const stopsTask = state.task?.tabId === action.tabId;
      return {
        ...state,
        tabs: state.tabs.filter((one) => one.id !== action.tabId),
        strip: state.strip.filter((id) => id !== action.tabId),
        surface,
        task: stopsTask ? null : state.task,
        cursor: state.cursor?.tabId === action.tabId ? null : state.cursor,
        flash: { text: `Closed · ${tabName(tab)}`, undo: tab },
      };
    }
    case "undoClose": {
      const tab = state.flash?.undo;
      if (!tab) return state;
      // A reopened page comes back where it was if that place is still free.
      const restored: LabTab = { ...tab, agent: "idle", say: null, loading: true };
      return {
        ...state,
        tabs: [...state.tabs, { ...restored, presentation: "background", dockedIn: null }],
        flash: { text: `Reopened · ${tabName(tab)}` },
      };
    }
    case "closeAll": {
      const closing = new Set(
        state.tabs.filter((tab) => chatOf(tab.owner)?.id === action.chatId).map((tab) => tab.id),
      );
      return {
        ...state,
        tabs: state.tabs.filter((tab) => !closing.has(tab.id)),
        strip: state.strip.filter((id) => !closing.has(id)),
        task: state.task && closing.has(state.task.tabId) ? null : state.task,
        cursor: state.cursor && closing.has(state.cursor.tabId) ? null : state.cursor,
        flash: { text: `Closed ${closing.size} tabs` },
      };
    }
    case "agentOpen": {
      const id = `t${state.serial}`;
      const tab: LabTab = {
        id,
        owner: action.owner,
        url: action.url,
        title: action.title,
        loading: true,
        presentation: "background",
        dockedIn: null,
        agent: "idle",
        say: null,
      };
      const opened = { ...state, tabs: [...state.tabs, tab], serial: state.serial + 1 };
      // The dock FOLLOWS the agent: if this chat's dock is open, the tab the
      // agent just opened is the one worth looking at.
      if (action.follow !== null) {
        return {
          ...opened,
          tabs: reducer(opened, { type: "showBeside", tabId: id, chatId: action.follow }).tabs,
          flash: { text: `Beside chat · ${tabName(tab)}` },
        };
      }
      return { ...opened, flash: { text: `Opened · ${tabName(tab)}` } };
    }
    case "agentNavigate":
      return {
        ...state,
        serial: state.serial + 1,
        tabs: patch(action.tabId, { url: action.url, title: action.title, loading: true }),
      };
    case "settle":
      return { ...state, tabs: patch(action.tabId, { loading: false }) };
    case "runTask": {
      // One task at a time in the lab; a new one replaces the old.
      const tabs = state.tabs.map((one) =>
        one.id === action.tabId
          ? { ...one, agent: "working" as const, say: "Starting…" }
          : one.agent === "working" || one.agent === "paused"
            ? { ...one, agent: "idle" as const, say: null }
            : one,
      );
      return {
        ...state,
        tabs,
        task: { tabId: action.tabId, steps: action.steps, at: 0 },
        youUntil: null,
      };
    }
    case "step": {
      const task = state.task;
      if (!task) return state;
      const next = task.steps[task.at];
      if (!next) return state;
      const fresh = state.cursor === null || state.cursor.tabId !== task.tabId;
      return {
        ...state,
        tabs: patch(task.tabId, { say: next.say }),
        task: { ...task, at: task.at + 1 },
        cursor: {
          tabId: task.tabId,
          x: next.x,
          y: next.y,
          act: next.act,
          press:
            next.act === "click"
              ? fresh
                ? 1
                : state.cursor!.press + 1
              : (state.cursor?.press ?? 0),
          visible: true,
        },
      };
    }
    case "finishTask": {
      const task = state.task;
      if (!task) return state;
      return {
        ...state,
        tabs: patch(task.tabId, { agent: "idle", say: null }),
        task: null,
        flash: { text: `Done with ${tabName(find(task.tabId) ?? { url: "", title: "the tab" })}` },
      };
    }
    case "hideCursor":
      return state.cursor ? { ...state, cursor: { ...state.cursor, visible: false } } : state;
    case "personInput": {
      // The person's own input outranks the agent's, without asking. Only a
      // tab the agent is working pauses; an idle tab is simply theirs.
      const tab = find(action.tabId);
      if (!tab || (tab.agent !== "working" && tab.agent !== "paused")) return state;
      return {
        ...state,
        tabs: patch(action.tabId, { agent: "paused" }),
        youUntil: action.at + PERSON_QUIET_MS,
      };
    }
    case "carryOn": {
      const task = state.task;
      if (!task) return { ...state, youUntil: null };
      return {
        ...state,
        tabs: patch(task.tabId, { agent: "working" }),
        youUntil: null,
      };
    }
    case "askSignIn": {
      const tab = find(action.tabId);
      if (!tab) return state;
      return {
        ...state,
        tabs: patch(action.tabId, {
          agent: "needsYou",
          say: "Needs you to sign in",
          url: `${new URL(tab.url).origin}/login`,
          title: "Sign in · Acme",
          loading: true,
        }),
        task: null,
        cursor: state.cursor ? { ...state.cursor, visible: false } : null,
        serial: state.serial + 1,
      };
    }
    case "handBack":
      return reducer(
        {
          ...state,
          tabs: patch(action.tabId, {
            url: `${new URL(find(action.tabId)!.url).origin}/settings/members`,
            title: "Members · Acme",
            loading: true,
          }),
        },
        { type: "runTask", tabId: action.tabId, steps: AFTER_SIGN_IN_STEPS },
      );
    case "dockWidth":
      return { ...state, dockWidth: { ...state.dockWidth, [action.chatId]: action.width } };
    case "splitShare":
      return { ...state, splitShare: action.share };
    case "sheet":
      return { ...state, sheetOpen: { ...state.sheetOpen, [action.chatId]: action.open } };
    case "clearFlash":
      return { ...state, flash: null };
    case "reset":
      return { ...INITIAL, tabs: initialTabs() };
  }
}

const Dispatch = React.createContext<React.Dispatch<Action>>(() => undefined);
/** The lab's whole state, for the leaves that draw the cursor and the status line. */
const LabContext = React.createContext<LabState>(INITIAL);

/* -------------------------------------------------------------- the scratch */

export default function BrowserRework() {
  const [state, dispatch] = React.useReducer(reducer, INITIAL);

  // Loads settle on their own, the way a real page does.
  React.useEffect(() => {
    const loading = state.tabs.filter((tab) => tab.loading);
    if (loading.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const tab of loading) dispatch({ type: "settle", tabId: tab.id });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [state.tabs]);

  // The scripted agent: one step per beat while it is working, nothing while
  // the person has the tab, a beat of rest after the last act.
  const taskTab = state.task ? state.tabs.find((tab) => tab.id === state.task!.tabId) : undefined;
  const working = taskTab?.agent === "working";
  const at = state.task?.at ?? -1;
  const total = state.task?.steps.length ?? 0;
  React.useEffect(() => {
    if (!working) return;
    const timer = window.setTimeout(
      () => dispatch({ type: at >= total ? "finishTask" : "step" }),
      at === 0 ? 240 : STEP_MS,
    );
    return () => window.clearTimeout(timer);
  }, [working, at, total]);

  // The cursor lingers after the agent stops, then lets go.
  const cursorIdle = state.cursor?.visible === true && state.task === null;
  React.useEffect(() => {
    if (!cursorIdle) return;
    const timer = window.setTimeout(() => dispatch({ type: "hideCursor" }), CURSOR_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [cursorIdle]);

  // The person's pause ends by itself after a quiet spell; every input pushes it out.
  React.useEffect(() => {
    if (state.youUntil === null) return;
    const timer = window.setTimeout(
      () => dispatch({ type: "carryOn" }),
      Math.max(0, state.youUntil - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [state.youUntil]);

  // The now channel says one thing and lets go; an Undo stays a little longer.
  React.useEffect(() => {
    if (state.flash === null) return;
    const timer = window.setTimeout(
      () => dispatch({ type: "clearFlash" }),
      state.flash.undo ? 5000 : 2600,
    );
    return () => window.clearTimeout(timer);
  }, [state.flash]);

  return (
    <TooltipProvider delayDuration={300}>
      <Dispatch.Provider value={dispatch}>
        <LabContext.Provider value={state}>
          <div
            className="flex h-svh flex-col p-2 text-ui text-foreground"
            style={{ background: "var(--canvas)" }}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-raised">
              <WorkspaceStrip state={state} drivers={<Drivers state={state} />} />
              <WorkspaceRow state={state} />
            </div>
          </div>
        </LabContext.Provider>
      </Dispatch.Provider>
    </TooltipProvider>
  );
}

/* ---------------------------------------------------------- workspace strip */

function WorkspaceStrip({ state, drivers }: { state: LabState; drivers: React.ReactNode }) {
  const dispatch = React.useContext(Dispatch);
  const same = (surface: Surface): boolean =>
    JSON.stringify(surface) === JSON.stringify(state.surface);
  const item = (key: string, surface: Surface, icon: React.ReactNode, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => dispatch({ type: "surface", surface })}
      className={cn(
        "flex h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-ui transition-colors",
        same(surface)
          ? "bg-background text-foreground shadow-raised"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-rail px-2">
      {item("board", { kind: "board" }, <KanbanIcon className="size-3.5 shrink-0" />, "Board")}
      {item(
        "ticket",
        { kind: "ticket" },
        <TicketIcon className="size-3.5 shrink-0" />,
        "VC-614 Ticket",
      )}
      {CHATS.map((chat) =>
        item(
          chat.id,
          { kind: "chat", chatId: chat.id },
          <ChatCircleIcon className="size-3.5 shrink-0" />,
          chat.title,
        ),
      )}
      {state.strip.map((tabId) => {
        const tab = state.tabs.find((one) => one.id === tabId);
        if (!tab) return null;
        return item(
          tabId,
          { kind: "browser", tabId },
          <GlobeSimpleIcon className="size-3.5 shrink-0" />,
          tabName(tab),
        );
      })}
      {/* Clear of the lab's own theme toolbar, which floats top right. */}
      <span className="mr-56 ml-auto">{drivers}</span>
    </div>
  );
}

/* --------------------------------------------------- the row and its split */

/**
 * The workspace row: the surface, and — when there is one — the workspace's
 * split beside it. The split is the WORKSPACE's: it stays through every
 * surface change, which is the contrast with the dock, which is the chat's.
 */
function WorkspaceRow({ state }: { state: LabState }) {
  const dispatch = React.useContext(Dispatch);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const split = state.tabs.find((tab) => tab.presentation === "split") ?? null;
  return (
    <div ref={rowRef} className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1">
        <SurfaceBody state={state} />
      </div>
      {split ? (
        <>
          <Sash
            label="Resize split"
            containerRef={rowRef}
            onShare={(share) => dispatch({ type: "splitShare", share })}
            minStart={520}
            minEnd={360}
          />
          <div
            className="flex min-w-0 shrink-0 flex-col"
            style={{ width: `${state.splitShare * 100}%`, minWidth: 360 }}
          >
            <BrowserFrame
              tab={split}
              place="split"
              chatId={chatOf(split.owner)?.id ?? CHATS[0]!.id}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** A vertical divider that reports the END side's share of its container. */
function Sash({
  label,
  containerRef,
  onShare,
  minStart,
  minEnd,
}: {
  label: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onShare(share: number): void;
  minStart: number;
  minEnd: number;
}) {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const row = containerRef.current;
    if (!row) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = row.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(bounds.right - moveEvent.clientX);
      const clamped = Math.max(minEnd, Math.min(bounds.width - minStart, next));
      onShare(clamped / bounds.width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={startDrag}
      className="group relative w-px shrink-0 cursor-col-resize bg-border"
    >
      <span className="absolute inset-y-0 -left-1.5 w-3 transition-colors group-hover:bg-primary/20" />
    </div>
  );
}

/* ------------------------------------------------------------------ surfaces */

function SurfaceBody({ state }: { state: LabState }) {
  const surface = state.surface;
  if (surface.kind === "board") return <Placeholder icon={KanbanIcon} label="Board" />;
  if (surface.kind === "ticket") return <Placeholder icon={TicketIcon} label="VC-614 · Ticket" />;
  if (surface.kind === "browser") {
    const tab = state.tabs.find((one) => one.id === surface.tabId);
    if (!tab) return <Placeholder icon={GlobeSimpleIcon} label="Tab closed" />;
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <BrowserFrame tab={tab} place="tab" chatId={chatOf(tab.owner)?.id ?? CHATS[0]!.id} />
      </div>
    );
  }
  const chat = CHATS.find((one) => one.id === surface.chatId)!;
  return <ChatWithDock chat={chat} state={state} />;
}

function Placeholder({ icon: Icon, label }: { icon: typeof KanbanIcon; label: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 p-6">
      <div className="flex items-center gap-2 text-heading text-foreground">
        <Icon className="size-4" />
        {label}
      </div>
      <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
        {[0, 1, 2, 3].map((column) => (
          <div key={column} className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2">
            {Array.from({ length: 3 - (column % 2) }, (_, card) => (
              <div key={card} className="h-14 rounded-md border border-border/60 bg-background" />
            ))}
          </div>
        ))}
      </div>
      <div className="text-muted-foreground">
        No dock here: a chat&apos;s dock leaves with the chat. A workspace split stays.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ chat + its dock */

const DOCK_DEFAULT_SHARE = 0.5;
const DOCK_MIN_PX = 360;
const CHAT_MIN_PX = 380;
/** Below this the chat's pane cannot hold both columns, and the dock folds. */
const FOLD_BELOW_PX = DOCK_MIN_PX + CHAT_MIN_PX;

function ChatWithDock({ chat, state }: { chat: LabChat; state: LabState }) {
  const dispatch = React.useContext(Dispatch);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const width = useWidth(rowRef);
  const docked =
    state.tabs.find((tab) => tab.presentation === "beside" && tab.dockedIn === chat.id) ?? null;
  const share = state.dockWidth[chat.id] ?? DOCK_DEFAULT_SHARE;
  const folded = width > 0 && width < FOLD_BELOW_PX;
  const sheetOpen = state.sheetOpen[chat.id] === true;

  return (
    <div ref={rowRef} className="relative flex min-w-0 flex-1">
      <ChatColumn chat={chat} state={state} />
      {docked && !folded ? (
        <>
          <Sash
            label="Resize browser"
            containerRef={rowRef}
            onShare={(next) => dispatch({ type: "dockWidth", chatId: chat.id, width: next })}
            minStart={CHAT_MIN_PX}
            minEnd={DOCK_MIN_PX}
          />
          <div
            className="flex min-w-0 shrink-0 flex-col"
            style={{ width: `${share * 100}%`, minWidth: DOCK_MIN_PX }}
          >
            <BrowserFrame tab={docked} place="beside" chatId={chat.id} />
          </div>
        </>
      ) : null}
      {docked && folded ? (
        <>
          <DockRail
            tab={docked}
            open={sheetOpen}
            onToggle={() => dispatch({ type: "sheet", chatId: chat.id, open: !sheetOpen })}
          />
          <AnimatePresence>
            {sheetOpen ? (
              <motion.div
                key="sheet"
                initial={{ opacity: 0, transform: "translateX(16px)" }}
                animate={{ opacity: 1, transform: "translateX(0px)" }}
                exit={{ opacity: 0, transform: "translateX(16px)" }}
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                className="absolute inset-y-0 right-11 z-10 flex w-[min(calc(100%-3.5rem),34rem)] flex-col border-l border-border bg-background shadow-overlay"
              >
                <BrowserFrame tab={docked} place="beside" chatId={chat.id} />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>
      ) : null}
    </div>
  );
}

/** The folded dock: a rail that keeps the tab's identity and status on screen. */
function DockRail({ tab, open, onToggle }: { tab: LabTab; open: boolean; onToggle(): void }) {
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border bg-rail py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={open ? "Fold the browser" : "Show the browser"}
            aria-expanded={open}
            onClick={onToggle}
          >
            <CaretLeftIcon className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {open
            ? "Fold the browser"
            : "The split left too little room — show the browser over the chat"}
        </TooltipContent>
      </Tooltip>
      <OriginChip
        url={tab.url}
        title={tab.title}
        driver={tab.agent === "working" ? tab.owner : null}
      />
      <span
        className="text-muted-foreground [writing-mode:vertical-rl]"
        style={{ maxHeight: "16rem" }}
      >
        <span className="truncate">{tabName(tab)}</span>
      </span>
    </div>
  );
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function ChatColumn({ chat, state }: { chat: LabChat; state: LabState }) {
  const tabs = chatTabs(state, chat.id);
  const first = tabs[0];
  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-border/60 px-4 text-muted-foreground">
        {chat.title}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        <div className="max-w-xl self-end rounded-xl bg-muted px-3 py-2">{chat.ask}</div>
        <div className="flex max-w-2xl flex-col gap-2 leading-prose">
          <p>{chat.reply[0]}</p>
          {first ? <TranscriptCard tab={first} chatId={chat.id} /> : null}
          <p>{chat.reply[1]}</p>
        </div>
      </div>
      <div className="shrink-0 px-6 pb-4">
        <div className="mb-2 flex justify-center">
          <IslandPill chat={chat} state={state} />
        </div>
        <div className="rounded-xl border border-border bg-background px-3 py-3 text-muted-foreground shadow-raised">
          Ask, or describe a change…
        </div>
      </div>
    </div>
  );
}

/** The chat's own tabs and its children's, newest last — what the island lists. */
function chatTabs(state: LabState, chatId: string): LabTab[] {
  return state.tabs.filter((tab) => chatOf(tab.owner)?.id === chatId);
}

function isDockedIn(tab: LabTab, chatId: string): boolean {
  return tab.presentation === "beside" && tab.dockedIn === chatId;
}

/* ------------------------------------------------------ the transcript card */

function TranscriptCard({ tab, chatId }: { tab: LabTab; chatId: string }) {
  const dispatch = React.useContext(Dispatch);
  const beside = isDockedIn(tab, chatId);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2 py-1.5">
      <OriginChip
        url={tab.url}
        title={tab.title}
        driver={tab.agent === "working" ? tab.owner : null}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground">{tabName(tab)}</div>
        <div className="truncate font-mono text-muted-foreground">
          {originOf(tab.url)}
          {pathOf(tab.url)}
        </div>
      </div>
      {beside ? (
        <Button size="xs" variant="ghost" onClick={() => dispatch({ type: "hide", tabId: tab.id })}>
          Hide
        </Button>
      ) : (
        <Button
          size="xs"
          variant="secondary"
          onClick={() => dispatch({ type: "showBeside", tabId: tab.id, chatId })}
        >
          Show beside chat
        </Button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- the island pill */

function IslandPill({ chat, state }: { chat: LabChat; state: LabState }) {
  const dispatch = React.useContext(Dispatch);
  const tabs = chatTabs(state, chat.id);
  const [open, setOpen] = React.useState(false);
  if (tabs.length === 0 && !state.flash?.undo) return null;
  const loading = tabs.some((tab) => tab.loading);
  const needs = tabs.find((tab) => tab.agent === "needsYou");
  const working = tabs.find((tab) => tab.agent === "working" || tab.agent === "paused");
  // What the pill says, most urgent first: a request, the live step, the last event.
  const line = needs
    ? `Needs you · ${tabName(needs)}`
    : working
      ? working.agent === "paused"
        ? "Paused while you use the tab"
        : (working.say ?? "")
      : (state.flash?.text ?? null);
  return (
    <span className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex h-8 items-center gap-2 rounded-full border bg-background px-3 shadow-raised transition-[background-color,border-color] duration-150 active:scale-[0.97]",
              open && "bg-muted",
              needs ? "border-primary/60" : "border-border",
            )}
          >
            {needs ? (
              <span className="size-1.5 rounded-full bg-primary" />
            ) : (
              <GlobeSimpleIcon className="size-3.5 text-muted-foreground" />
            )}
            <span className="tabular-nums">{tabs.length}</span>
            {working && working.agent === "working" ? (
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: sessionColor(working.owner) }}
              />
            ) : loading ? (
              <Spinner className="size-3" />
            ) : null}
            <AnimatePresence initial={false} mode="popLayout">
              {line ? (
                <motion.span
                  key={line}
                  initial={{ opacity: 0, filter: "blur(2px)" }}
                  animate={{ opacity: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, filter: "blur(2px)" }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
                  className={cn(
                    "max-w-72 truncate",
                    needs ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {line}
                </motion.span>
              ) : null}
            </AnimatePresence>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" sideOffset={10} className="w-[28rem] p-1 text-ui">
          <TabsCard chat={chat} tabs={tabs} onDone={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      {state.flash?.undo ? (
        <Button size="xs" variant="ghost" onClick={() => dispatch({ type: "undoClose" })}>
          Undo
        </Button>
      ) : null}
    </span>
  );
}

const FILTER_FROM = 7;
const GROUP_FROM = 4;

function TabsCard({
  chat,
  tabs,
  onDone,
}: {
  chat: LabChat;
  tabs: readonly LabTab[];
  onDone(): void;
}) {
  const dispatch = React.useContext(Dispatch);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState("");
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 2500);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? tabs.filter((tab) => `${tab.title} ${tab.url}`.toLowerCase().includes(needle))
    : tabs;
  // A request outranks every grouping: it is the one row that wants you.
  const needsYou = shown.filter((tab) => tab.agent === "needsYou");
  const rest = shown.filter((tab) => tab.agent !== "needsYou");
  const grouped = tabs.length >= GROUP_FROM;
  const groups = new Map<string, LabTab[]>();
  for (const tab of rest) {
    const origin = grouped ? originOf(tab.url) : "";
    groups.set(origin, [...(groups.get(origin) ?? []), tab]);
  }

  /** Arrow keys walk the rows' own targets; the filter hands off to the first. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-tab-row]") ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? rows[Math.min(rows.length - 1, at + 1)]
        : at <= 0
          ? rows[0]
          : rows[at - 1];
    next?.focus();
  };

  return (
    <div className="flex flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-8 items-center gap-2 px-2">
        <span className="flex-1 text-foreground">
          Browser tabs <span className="text-muted-foreground tabular-nums">{tabs.length}</span>
        </span>
        <Button
          size="xs"
          variant="ghost"
          className={cn(
            "text-muted-foreground hover:text-destructive",
            armed && "bg-destructive/10 text-destructive",
          )}
          onClick={() => {
            if (!armed) {
              setArmed(true);
              return;
            }
            dispatch({ type: "closeAll", chatId: chat.id });
            onDone();
          }}
        >
          {armed ? `Close all ${tabs.length}?` : "Close all"}
        </Button>
      </div>
      {tabs.length >= FILTER_FROM ? (
        <div className="relative px-1 pb-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter by title or address"
            className="h-7 pl-7 shadow-none"
          />
        </div>
      ) : null}
      <div ref={listRef} className="flex max-h-96 flex-col overflow-y-auto">
        {shown.length === 0 ? (
          <div className="px-2 py-3 text-muted-foreground">No tab matches “{query.trim()}”.</div>
        ) : null}
        {needsYou.length > 0 ? (
          <Group label="Needs you">
            {needsYou.map((tab) => (
              <TabRow key={tab.id} tab={tab} chat={chat} grouped={false} onShown={onDone} />
            ))}
          </Group>
        ) : null}
        {[...groups].map(([origin, members]) => (
          <Group key={origin} label={grouped ? origin : null} count={members.length}>
            <AnimatePresence initial={false}>
              {members.map((tab) => (
                <motion.div
                  key={tab.id}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                  className="overflow-hidden"
                >
                  <TabRow tab={tab} chat={chat} grouped={grouped} onShown={onDone} />
                </motion.div>
              ))}
            </AnimatePresence>
          </Group>
        ))}
      </div>
    </div>
  );
}

/** A section of the list; its header sticks while its rows scroll under it. */
function Group({
  label,
  count,
  children,
}: React.PropsWithChildren<{ label: string | null; count?: number }>) {
  return (
    <div className="flex flex-col">
      {label !== null ? (
        <div className="sticky top-0 z-[1] flex items-center gap-1.5 bg-popover px-2 pt-2 pb-1 text-label text-muted-foreground">
          <span className={cn(label.includes(":") ? "font-mono" : "uppercase")}>{label}</span>
          {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function TabRow({
  tab,
  chat,
  grouped,
  onShown,
}: {
  tab: LabTab;
  chat: LabChat;
  grouped: boolean;
  onShown(): void;
}) {
  const dispatch = React.useContext(Dispatch);
  const beside = isDockedIn(tab, chat.id);
  const child = tab.owner !== chat.id ? sessionTitle(tab.owner) : null;
  const untitled = tab.title.trim() === "";
  // A request already says itself in the place word ("Sign in"); only live
  // work takes over the second line.
  const live = tab.agent === "working";
  const address = grouped ? pathOf(tab.url) : `${originOf(tab.url)}${pathOf(tab.url)}`;
  return (
    <ListRow
      data-tab-row=""
      density="two-line"
      leading={
        <OriginChip
          url={tab.url}
          title={tab.title}
          driver={tab.agent === "working" ? tab.owner : null}
        />
      }
      primary={grouped && untitled ? pathOf(tab.url) : tabName(tab)}
      primaryTrailing={<PlaceWord tab={tab} chatId={chat.id} />}
      secondary={
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {/* While an agent works the tab, the second line says what it is
              doing, in its colour; otherwise it is the address. */}
          {live && tab.say ? (
            <span className="truncate" style={{ color: sessionColor(tab.owner) }}>
              {tab.say}
            </span>
          ) : grouped && untitled ? null : (
            <span className="truncate font-mono text-label tracking-normal">{address}</span>
          )}
          {child ? <span className="shrink-0 truncate">· {child}</span> : null}
        </span>
      }
      selected={beside}
      onActivate={() => {
        if (tab.presentation === "tab") {
          dispatch({ type: "surface", surface: { kind: "browser", tabId: tab.id } });
        } else if (tab.presentation !== "split") {
          dispatch({ type: "showBeside", tabId: tab.id, chatId: chat.id });
        }
        onShown();
      }}
      actions={
        <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          <IconAction
            label="Open in a split"
            onPress={() => {
              dispatch({ type: "openInSplit", tabId: tab.id });
              onShown();
            }}
          >
            <SquareSplitHorizontalIcon />
          </IconAction>
          <IconAction
            label={tab.presentation === "tab" ? "Go to tab" : "Open as tab"}
            onPress={() => {
              if (tab.presentation === "tab") {
                dispatch({ type: "surface", surface: { kind: "browser", tabId: tab.id } });
              } else {
                dispatch({ type: "openAsTab", tabId: tab.id });
              }
              onShown();
            }}
          >
            <ArrowSquareOutIcon />
          </IconAction>
          <IconAction
            label="Close tab"
            destructive
            onPress={() => dispatch({ type: "close", tabId: tab.id })}
          >
            <XIcon />
          </IconAction>
        </span>
      }
    />
  );
}

/** Where a tab is — quiet words, because the row's title is the headline. */
function PlaceWord({ tab, chatId }: { tab: LabTab; chatId: string }) {
  const place = isDockedIn(tab, chatId)
    ? "Beside chat"
    : tab.presentation === "tab"
      ? "In a tab"
      : tab.presentation === "split"
        ? "In the split"
        : null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-muted-foreground">
      {tab.loading ? <Spinner className="size-3" /> : null}
      {tab.agent === "needsYou" ? (
        <span className="flex items-center gap-1 text-foreground">
          <LockKeyIcon className="size-3" />
          Sign in
        </span>
      ) : place ? (
        <span>{place}</span>
      ) : null}
    </span>
  );
}

function IconAction({
  label,
  destructive = false,
  onPress,
  children,
}: React.PropsWithChildren<{ label: string; destructive?: boolean; onPress(): void }>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          className={cn("text-muted-foreground", destructive && "hover:text-destructive")}
          onClick={onPress}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A favicon stand-in: the title's initial on the ORIGIN's colour, so one dev
 * server reads as one hue. While an agent drives the tab, a ring in that
 * agent's colour sits around it — the same colour as its cursor.
 */
function OriginChip({
  url,
  title: pageTitle,
  driver = null,
}: {
  url: string;
  title: string;
  driver?: string | null;
}) {
  const name = tabName({ url, title: pageTitle });
  return (
    <span className="relative flex size-5 shrink-0">
      <span
        aria-hidden
        className="flex size-5 items-center justify-center rounded-sm text-label leading-none font-semibold text-white"
        style={{ backgroundColor: sessionColor(originOf(url)) }}
      >
        {name
          .replace(/^[^A-Za-z0-9]+/, "")
          .charAt(0)
          .toUpperCase() || "·"}
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-[3px] rounded-[7px] border-[1.5px] transition-opacity duration-200"
        style={{
          borderColor: driver ? sessionColor(driver) : "transparent",
          opacity: driver ? 1 : 0,
        }}
      />
    </span>
  );
}

/* --------------------------------------------------------- the browser frame */

/**
 * The browser's chrome over a mock page. `beside` adds the dock's header: the
 * switcher (this chat's other tabs, without opening the island), the live
 * status, and the ways out — a split, a tab, back to the background, closed.
 */
function BrowserFrame({
  tab,
  place,
  chatId,
}: {
  tab: LabTab;
  place: "beside" | "tab" | "split";
  chatId: string;
}) {
  const dispatch = React.useContext(Dispatch);
  const state = React.useContext(LabContext);
  const siblings = chatTabs(state, chatId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="@container/chrome relative shrink-0 border-b border-border bg-rail">
        {place === "beside" ? (
          <div className="flex h-8 items-center gap-1 border-b border-border/60 px-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-0 shrink gap-1.5 px-1.5"
                  aria-label="Switch tab"
                >
                  <OriginChip url={tab.url} title={tab.title} />
                  <span className="truncate">{tabName(tab)}</span>
                  {siblings.length > 1 ? (
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {siblings.findIndex((one) => one.id === tab.id) + 1}/{siblings.length}
                    </span>
                  ) : null}
                  <CaretDownIcon className="size-3 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-96 w-80">
                <DropdownMenuLabel>Show beside chat</DropdownMenuLabel>
                {siblings.map((one) => (
                  <DropdownMenuItem
                    key={one.id}
                    onSelect={() => dispatch({ type: "showBeside", tabId: one.id, chatId })}
                  >
                    {one.id === tab.id ? <CheckIcon /> : <GlobeSimpleIcon />}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{tabName(one)}</span>
                      <span className="truncate font-mono text-muted-foreground">
                        {originOf(one.url)}
                        {pathOf(one.url)}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <AgentStatus tab={tab} />
            <IconAction
              label="Open in a split"
              onPress={() => dispatch({ type: "openInSplit", tabId: tab.id })}
            >
              <SquareSplitHorizontalIcon />
            </IconAction>
            <IconAction
              label="Open as tab"
              onPress={() => dispatch({ type: "openAsTab", tabId: tab.id })}
            >
              <ArrowSquareOutIcon />
            </IconAction>
            <IconAction
              label="Hide — the tab stays open"
              onPress={() => dispatch({ type: "hide", tabId: tab.id })}
            >
              <SidebarSimpleIcon className="-scale-x-100" />
            </IconAction>
            <IconAction
              label="Close tab"
              destructive
              onPress={() => dispatch({ type: "close", tabId: tab.id })}
            >
              <XIcon />
            </IconAction>
          </div>
        ) : null}
        <div className="flex h-9 items-center gap-1 px-2">
          <Button variant="ghost" size="icon-sm" aria-label="Back">
            <ArrowLeftIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Forward" disabled>
            <ArrowRightIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Reload">
            {tab.loading ? <Spinner className="size-3.5" /> : <ArrowClockwiseIcon />}
          </Button>
          <Input
            aria-label="Address"
            readOnly
            value={`${originOf(tab.url)}${pathOf(tab.url)}`}
            className="h-7 min-w-0 flex-1 bg-background font-mono shadow-none"
          />
          {place !== "beside" ? (
            <>
              <AgentStatus tab={tab} compact />
              <IconAction
                label="Show beside its chat"
                onPress={() => dispatch({ type: "showBeside", tabId: tab.id, chatId })}
              >
                <SidebarSimpleIcon className="-scale-x-100" />
              </IconAction>
              {place === "split" ? (
                <IconAction
                  label="Close the split"
                  onPress={() => dispatch({ type: "closeSplit" })}
                >
                  <XIcon />
                </IconAction>
              ) : null}
            </>
          ) : null}
        </div>
        {/* The person's pause drains toward the agent carrying on: a linear
            hairline, because it IS a clock. Restarted per input on purpose. */}
        {tab.agent === "paused" && state.youUntil !== null ? (
          <span
            key={state.youUntil}
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-px origin-left"
            style={{
              backgroundColor: sessionColor(tab.owner),
              animation: `vc614-drain ${PERSON_QUIET_MS}ms linear forwards`,
            }}
          />
        ) : null}
      </div>
      {tab.agent === "needsYou" ? <NeedsYouBar tab={tab} /> : null}
      <MockPage tab={tab} />
      <style>
        {"@keyframes vc614-drain { from { transform: scaleX(1) } to { transform: scaleX(0) } }"}
      </style>
    </div>
  );
}

/**
 * Who is doing what, in the dock header — the replacement for the holder pill
 * and its Take over button. Narration while the agent works; a plain notice
 * while the person's input has it paused.
 */
function AgentStatus({ tab, compact = false }: { tab: LabTab; compact?: boolean }) {
  const color = sessionColor(tab.owner);
  const text =
    tab.agent === "working"
      ? (tab.say ?? "Working")
      : tab.agent === "paused"
        ? "Paused — yours until you stop"
        : null;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center justify-end gap-1.5 px-1 text-muted-foreground",
        // In the dock header it takes the slack between switcher and actions;
        // beside an address field it only takes what it says.
        compact ? "max-w-56 shrink" : "flex-1",
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {text ? (
          <motion.span
            key={tab.agent === "paused" ? "paused" : text}
            initial={{ opacity: 0, filter: "blur(2px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(2px)" }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="flex min-w-0 items-center gap-1.5"
          >
            {tab.agent === "paused" ? (
              <HandPointingIcon className="size-3.5 shrink-0" />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            )}
            <span className={cn("truncate", compact && "@max-[520px]/chrome:hidden")}>{text}</span>
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}

/** The one explicit handback left: the agent asked, so the person answers. */
function NeedsYouBar({ tab }: { tab: LabTab }) {
  const dispatch = React.useContext(Dispatch);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5">
      <LockKeyIcon className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        {sessionTitle(tab.owner)} needs you to sign in. Hand it back when you&apos;re done.
      </span>
      <Button size="xs" onClick={() => dispatch({ type: "handBack", tabId: tab.id })}>
        Hand back
      </Button>
    </div>
  );
}

/** A fake page — enough structure to judge the dock's proportions, and a stage for the cursor. */
function MockPage({ tab }: { tab: LabTab }) {
  const dispatch = React.useContext(Dispatch);
  const state = React.useContext(LabContext);
  const pageRef = React.useRef<HTMLDivElement>(null);
  const width = useWidth(pageRef);
  const height = useHeight(pageRef);
  const storybook = originOf(tab.url).endsWith(":6006");
  const signIn = pathOf(tab.url).startsWith("/login");
  const ink = sessionColor(originOf(tab.url));
  const cursor = state.cursor?.tabId === tab.id ? state.cursor : null;
  const working = tab.agent === "working";
  const touch = () => dispatch({ type: "personInput", tabId: tab.id, at: Date.now() });
  return (
    <div
      ref={pageRef}
      // Focusable like a real page, so keys reach it — and so it can be poked.
      role="group"
      aria-label="The page"
      tabIndex={0}
      onPointerDown={touch}
      onWheel={touch}
      onKeyDown={touch}
      className="@container/page relative min-h-0 flex-1 overflow-hidden bg-white text-[#1f2328] outline-none"
    >
      {tab.loading ? (
        <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse" style={{ background: ink }} />
      ) : null}
      <div className="flex h-11 items-center gap-3 border-b border-black/10 px-4">
        <span className="size-5 rounded-md" style={{ background: ink }} />
        <span className="font-semibold">{storybook ? "Storybook" : "Acme"}</span>
        <span className="ml-auto flex gap-3 text-black/50">
          <span>Docs</span>
          <span>Account</span>
        </span>
      </div>
      {signIn ? (
        <div className="flex h-full items-start justify-center pt-16">
          <div className="flex w-72 flex-col gap-3 rounded-xl border border-black/10 p-5">
            <div className="text-heading font-semibold">Sign in</div>
            <div className="h-8 rounded-md border border-black/15" />
            <div className="h-8 rounded-md border border-black/15" />
            <div className="h-8 rounded-md" style={{ background: ink }} />
          </div>
        </div>
      ) : (
        <div className="flex h-full">
          <div className="hidden w-44 shrink-0 flex-col gap-2 border-r border-black/10 p-3 @min-[720px]/page:flex">
            {["General", "Billing", "Members", "Appearance"].map((label) => (
              <span key={label} className="rounded px-2 py-1 text-black/60">
                {label}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
            <div className="text-heading font-semibold">{tabName(tab).split(/[·⋅–]/)[0]}</div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <div
                  key={index}
                  className="flex h-20 flex-col gap-2 rounded-lg border border-black/10 p-3"
                >
                  <span className="h-2 w-1/2 rounded bg-black/10" />
                  <span className="h-2 w-3/4 rounded bg-black/5" />
                </div>
              ))}
            </div>
            <div className="h-2 w-2/3 rounded bg-black/5" />
            <div className="h-2 w-1/2 rounded bg-black/5" />
          </div>
        </div>
      )}
      {/* Who is driving, at the page's edge: a thin ring in the agent's colour
          while it works. Opacity only — a pulsing box-shadow is the one that
          cost Claude in Chrome half a core. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 border-2 transition-opacity duration-200"
        style={{ borderColor: sessionColor(tab.owner), opacity: working ? 0.85 : 0 }}
      />
      <AnimatePresence>
        {cursor?.visible && width > 0 ? (
          <AgentCursor
            key="cursor"
            x={cursor.x * width}
            y={cursor.y * height}
            act={cursor.act}
            press={cursor.press}
            color={sessionColor(tab.owner)}
            name={sessionTitle(tab.owner)}
            busy={working}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function useHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = React.useState(0);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry?.contentRect.height ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

/* ------------------------------------------------------------- the cursor */

/*
 * Motion, from the build sequence (animate skill):
 *  - Gate: it moves on every agent act — tens per minute — but nobody
 *    triggers it, they WATCH it, and the eye has to follow a jump to know
 *    where the agent is. Purpose: spatial consistency. It earns motion; it
 *    does not earn slowness.
 *  - Tool: springs (Motion), because each act retargets mid-flight and a
 *    spring carries its velocity through the change where a transition
 *    restarts.
 *  - Properties: transform and opacity only, one translate3d string.
 *  - Character, in three cheap layers: x and y on different springs so the
 *    path bows; the arrow leans with horizontal speed; the tag trails on a
 *    softer spring. Settles in ~300ms — near the old 250ms cap, so an act
 *    waits no longer than it does today.
 *  - Reduced motion: position jumps, nothing leans, the press keeps only its
 *    fade.
 */
const X_SPRING = { stiffness: 420, damping: 36, mass: 0.7 };
const Y_SPRING = { stiffness: 300, damping: 30, mass: 0.7 };
const TAG_SPRING = { stiffness: 220, damping: 26, mass: 0.8 };
const LEAN_SPRING = { stiffness: 300, damping: 30 };
const ARROW_PATH = "M1.5 1.5 L1.5 16.2 L5.9 12.4 L12.6 12.1 Z";

function AgentCursor({
  x,
  y,
  act,
  press,
  color,
  name,
  busy,
}: {
  x: number;
  y: number;
  act: Step["act"];
  press: number;
  color: string;
  name: string;
  busy: boolean;
}) {
  const reduce = useReducedMotion() === true;
  // Start AT the first target: an entrance fades in place rather than flying
  // in from the corner, which is the teleport-then-glide the app does today.
  const sx = useSpring(x, X_SPRING);
  const sy = useSpring(y, Y_SPRING);
  React.useEffect(() => {
    if (reduce) {
      sx.jump(x);
      sy.jump(y);
    } else {
      sx.set(x);
      sy.set(y);
    }
  }, [x, y, reduce, sx, sy]);
  const tx = useSpring(sx, TAG_SPRING);
  const ty = useSpring(sy, TAG_SPRING);
  const vx = useVelocity(sx);
  const leanTarget = useTransform(vx, [-1600, 0, 1600], reduce ? [0, 0, 0] : [-14, 0, 14]);
  const lean = useSpring(leanTarget, LEAN_SPRING);
  const arrow = useMotionTemplate`translate3d(${sx}px, ${sy}px, 0) rotate(${lean}deg)`;
  const tag = useMotionTemplate`translate3d(calc(${tx}px + 14px), calc(${ty}px + 18px), 0)`;

  return (
    <motion.div
      className="pointer-events-none absolute inset-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <motion.div className="absolute top-0 left-0 origin-top-left" style={{ transform: arrow }}>
        {/* The press: a dip of the arrow and a ring that rings out, keyed on
            the click so each plays once — the one place a restart is right. */}
        {press > 0 ? (
          <motion.span
            key={`ring-${press}`}
            className="absolute -top-3 -left-3 size-6 rounded-full border-2"
            style={{ borderColor: color }}
            initial={{ opacity: 0.6, transform: reduce ? "scale(1)" : "scale(0.4)" }}
            animate={{ opacity: 0, transform: reduce ? "scale(1)" : "scale(1.5)" }}
            transition={{ duration: 0.36, ease: [0.23, 1, 0.32, 1] }}
          />
        ) : null}
        <motion.svg
          key={`arrow-${press}`}
          viewBox="0 0 16 20"
          className="size-5 origin-top-left drop-shadow-[0_1px_1px_rgb(0_0_0/0.25)]"
          initial={reduce || press === 0 ? false : { transform: "scale(0.86)" }}
          animate={{ transform: "scale(1)" }}
          transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
        >
          <path
            d={ARROW_PATH}
            fill={color}
            stroke="white"
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
        </motion.svg>
      </motion.div>
      <motion.div
        className="absolute top-0 left-0 flex items-center gap-1 rounded-sm px-1.5 py-px text-label whitespace-nowrap text-white shadow-raised"
        style={{ transform: tag, backgroundColor: color }}
        animate={{ opacity: busy ? 1 : 0.7 }}
        transition={{ duration: 0.16 }}
      >
        {name}
        {act === "type" && busy ? (
          <>
            <span className="opacity-80">typing</span>
            <span className="h-2.5 w-px animate-pulse bg-white" />
          </>
        ) : null}
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ drivers */

function Drivers({ state }: { state: LabState }) {
  const dispatch = React.useContext(Dispatch);
  const current = state.surface.kind === "chat" ? state.surface.chatId : CHATS[0]!.id;
  const docked = state.tabs.find((tab) => isDockedIn(tab, current));
  const target = docked ?? chatTabs(state, current)[0];
  const open = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const page = DEV_PAGES[(state.serial + index) % DEV_PAGES.length]!;
      const origin = DEV_ORIGINS[(state.serial + index) % DEV_ORIGINS.length]!;
      const storybook = page.title.includes("Storybook");
      dispatch({
        type: "agentOpen",
        owner: index % 4 === 3 && current === "chat-settings" ? "child-audit" : current,
        url: `${storybook ? "http://localhost:6006" : origin}${page.path}`,
        title: page.title,
        // Fifteen at once is a batch, not a thing to watch: only a single
        // open pulls the dock along.
        follow: count === 1 && docked ? current : null,
      });
    }
  };
  const splitCandidate = chatTabs(state, current).find((tab) => tab.presentation === "background");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary">
          <RobotIcon />
          Simulate
          <CaretDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>In this chat, the agent…</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={!target}
          onSelect={() => {
            if (!target) return;
            if (!isDockedIn(target, current)) {
              dispatch({ type: "showBeside", tabId: target.id, chatId: current });
            }
            dispatch({ type: "runTask", tabId: target.id, steps: REVIEW_STEPS });
          }}
        >
          <PlayIcon />
          Works the tab beside chat
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!target}
          onSelect={() => target && dispatch({ type: "askSignIn", tabId: target.id })}
        >
          <LockKeyIcon />
          Asks you to sign in
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open(1)}>
          <GlobeSimpleIcon />
          Opens a tab
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open(15)}>
          <GlobeSimpleIcon />
          Opens 15 dev-server tabs
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!docked}
          onSelect={() => {
            if (!docked) return;
            const page = DEV_PAGES[state.serial % DEV_PAGES.length]!;
            dispatch({
              type: "agentNavigate",
              tabId: docked.id,
              url: `${new URL(docked.url).origin}${page.path}`,
              title: page.title,
            });
          }}
        >
          <NavigationArrowIcon />
          Navigates the tab beside chat
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>You…</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={!docked || (docked.agent !== "working" && docked.agent !== "paused")}
          onSelect={() =>
            docked && dispatch({ type: "personInput", tabId: docked.id, at: Date.now() })
          }
        >
          <HandPointingIcon />
          Click into the page while it works
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!splitCandidate}
          onSelect={() =>
            splitCandidate && dispatch({ type: "openInSplit", tabId: splitCandidate.id })
          }
        >
          <SquareSplitHorizontalIcon />
          Open another tab in a real split
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => dispatch({ type: "reset" })}>
          <ArrowClockwiseIcon />
          Reset the lab
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
