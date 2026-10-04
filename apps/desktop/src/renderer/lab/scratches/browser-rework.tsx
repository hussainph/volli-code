/**
 * Browser · the VC-614 rework, proposed in the lab before any of it ships.
 *
 * The complaint, in three parts, and the answer to each that this scratch
 * lets you judge with your hands rather than read about:
 *
 *  1. THE PEEK IS USELESS. A 288px-tall live page above the composer is too
 *     short to read and too narrow to lay out, so nobody uses it; people "Open
 *     as tab → drag into a split" instead. PROPOSED: the `preview`
 *     presentation stops being a strip above the composer and becomes a
 *     full-height pane DOCKED BESIDE the chat, with its own divider. One
 *     click from the island, the transcript card or the dock's own switcher.
 *
 *  2. THE SPLIT OUTLIVES ITS CHAT. A workspace split is the surface's, not the
 *     chat's, so the browser stays on screen when you go to the board, the
 *     Ticket, or a different chat with different tabs. PROPOSED: the dock is
 *     part of the chat. Switch away and it goes with the chat; switch to
 *     another chat and you see THAT chat's dock (or none). The dock's width is
 *     remembered per chat. "Open as tab" stays for when you really do want a
 *     workspace tab that persists — it is the deliberate choice, not the only
 *     door.
 *
 *  3. THE ISLAND LIST SAYS NOTHING. Rows were named by bare hostname, so
 *     fifteen dev-server tabs were fifteen rows reading "localhost"; the one
 *     state word was "pinned here"; the X armed instead of closing; and there
 *     was no way to open a tab at all. PROPOSED: rows lead with the page TITLE
 *     and carry the path on a second line, grouped under their origin WITH
 *     its port (`localhost:5173 · 9`); a filter appears once the list is long;
 *     the state words are the places a tab can be ("Beside chat", "In a tab")
 *     and who is driving it; a row click shows it beside the chat; the X
 *     closes on one press; "Open as tab" is on every row.
 *
 * Everything is fixture-driven: the page is a mock, not a WebContentsView, so
 * judge layout and flow here and native-plane behaviour in the app. The
 * drivers (bottom right) simulate the agent.
 */
import * as React from "react";
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  ChatCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  GlobeSimpleIcon,
  KanbanIcon,
  MagnifyingGlassIcon,
  NavigationArrowIcon,
  RobotIcon,
  SidebarSimpleIcon,
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
  "Proposal: the peek becomes a full-height dock that belongs to its chat; the island lists tabs by title, path and origin:port";
export const viewport = "window" as const;

/* ---------------------------------------------------------------- the model */

type Presentation = "background" | "beside" | "tab";

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
  /** The Session driving it right now, or null. */
  heldBy: string | null;
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

interface LabState {
  tabs: LabTab[];
  surface: Surface;
  /** Dock width per chat, as a share of the row. A chat that never docked has none. */
  dockWidth: Record<string, number>;
  /** Workspace strip order for tabs opened as tabs. */
  strip: string[];
  /** The last thing that happened, the way the island's now channel says it. */
  flash: string | null;
  serial: number;
}

type Action =
  | { type: "surface"; surface: Surface }
  | { type: "showBeside"; tabId: string; chatId: string }
  | { type: "hide"; tabId: string }
  | { type: "openAsTab"; tabId: string }
  | { type: "close"; tabId: string }
  | { type: "closeAll"; chatId: string }
  | { type: "agentOpen"; owner: string; url: string; title: string }
  | { type: "agentNavigate"; tabId: string; url: string; title: string }
  | { type: "settle"; tabId: string }
  | { type: "release"; tabId: string }
  | { type: "takeOver"; tabId: string }
  | { type: "dockWidth"; chatId: string; width: number }
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

function initialTabs(): LabTab[] {
  return [
    {
      id: "t1",
      owner: "chat-settings",
      url: "http://localhost:5173/settings",
      title: "Settings · Acme",
      loading: false,
      presentation: "beside",
      dockedIn: "chat-settings",
      heldBy: "chat-settings",
    },
    {
      id: "t2",
      owner: "chat-settings",
      url: "http://localhost:5173/settings/billing",
      title: "Billing · Acme",
      loading: false,
      presentation: "background",
      dockedIn: null,
      heldBy: null,
    },
    {
      id: "t3",
      owner: "child-audit",
      url: "http://localhost:6006/?path=/story/button--primary",
      title: "Button – Primary ⋅ Storybook",
      loading: false,
      presentation: "background",
      dockedIn: null,
      heldBy: "child-audit",
    },
    {
      id: "t4",
      owner: "chat-auth",
      url: "http://127.0.0.1:3000/login",
      title: "Sign in · Acme",
      loading: false,
      presentation: "background",
      dockedIn: null,
      heldBy: null,
    },
  ];
}

const INITIAL: LabState = {
  tabs: initialTabs(),
  surface: { kind: "chat", chatId: "chat-settings" },
  dockWidth: {},
  strip: [],
  flash: null,
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
  switch (action.type) {
    case "surface":
      return { ...state, surface: action.surface };
    case "showBeside": {
      const tab = find(action.tabId);
      if (!tab) return state;
      // One dock per chat: whatever it showed goes back to the background.
      const tabs = state.tabs.map((one) => {
        if (one.id === action.tabId) {
          return { ...one, presentation: "beside" as const, dockedIn: action.chatId };
        }
        if (one.presentation === "beside" && one.dockedIn === action.chatId) {
          return { ...one, presentation: "background" as const, dockedIn: null };
        }
        return one;
      });
      return {
        ...state,
        tabs,
        strip: state.strip.filter((id) => id !== action.tabId),
        // Showing a tab beside its chat is also going to that chat.
        surface: { kind: "chat", chatId: action.chatId },
        flash: `Beside chat · ${tabName(tab)}`,
      };
    }
    case "hide": {
      const tab = find(action.tabId);
      if (!tab) return state;
      return {
        ...state,
        tabs: patch(action.tabId, { presentation: "background", dockedIn: null }),
        strip: state.strip.filter((id) => id !== action.tabId),
        flash: `Back in the background · ${tabName(tab)}`,
      };
    }
    case "openAsTab": {
      const tab = find(action.tabId);
      if (!tab) return state;
      return {
        ...state,
        tabs: patch(action.tabId, { presentation: "tab", dockedIn: null }),
        strip: state.strip.includes(action.tabId) ? state.strip : [...state.strip, action.tabId],
        surface: { kind: "browser", tabId: action.tabId },
        flash: `Opened as tab · ${tabName(tab)}`,
      };
    }
    case "close": {
      const tab = find(action.tabId);
      if (!tab) return state;
      const surface =
        state.surface.kind === "browser" && state.surface.tabId === action.tabId
          ? ({ kind: "chat", chatId: chatOf(tab.owner)?.id ?? CHATS[0]!.id } as const)
          : state.surface;
      return {
        ...state,
        tabs: state.tabs.filter((one) => one.id !== action.tabId),
        strip: state.strip.filter((id) => id !== action.tabId),
        surface,
        flash: `Closed · ${tabName(tab)}`,
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
        flash: `Closed ${closing.size} tabs`,
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
        heldBy: action.owner,
      };
      // A Session drives one tab at a time in practice; opening a new one is
      // where its attention went, so the lab releases its others.
      return {
        ...state,
        tabs: [
          ...state.tabs.map((one) =>
            one.heldBy === action.owner ? { ...one, heldBy: null } : one,
          ),
          tab,
        ],
        serial: state.serial + 1,
        flash: `Opened · ${tabName(tab)}`,
      };
    }
    case "agentNavigate":
      return {
        ...state,
        serial: state.serial + 1,
        tabs: patch(action.tabId, {
          url: action.url,
          title: action.title,
          loading: true,
          heldBy: find(action.tabId)?.owner ?? null,
        }),
      };
    case "settle":
      return { ...state, tabs: patch(action.tabId, { loading: false }) };
    case "release":
      return { ...state, tabs: patch(action.tabId, { heldBy: null }) };
    case "takeOver": {
      const tab = find(action.tabId);
      return {
        ...state,
        tabs: patch(action.tabId, { heldBy: null }),
        flash: tab ? `You took over · ${tabName(tab)}` : state.flash,
      };
    }
    case "dockWidth":
      return { ...state, dockWidth: { ...state.dockWidth, [action.chatId]: action.width } };
    case "clearFlash":
      return { ...state, flash: null };
    case "reset":
      return { ...INITIAL, tabs: initialTabs() };
  }
}

const Dispatch = React.createContext<React.Dispatch<Action>>(() => undefined);

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

  // The now channel says one thing and lets go, as the island's does.
  React.useEffect(() => {
    if (state.flash === null) return;
    const timer = window.setTimeout(() => dispatch({ type: "clearFlash" }), 2600);
    return () => window.clearTimeout(timer);
  }, [state.flash, state.serial, state.tabs]);

  return (
    <TooltipProvider delayDuration={300}>
      <Dispatch.Provider value={dispatch}>
        <div
          className="flex h-svh flex-col p-2 text-ui text-foreground"
          style={{ background: "var(--canvas)" }}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-raised">
            <WorkspaceStrip state={state} drivers={<Drivers state={state} />} />
            <div className="flex min-h-0 flex-1">
              <SurfaceBody state={state} />
            </div>
          </div>
        </div>
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
      {CHATS.map((chat) => {
        const docked = state.tabs.some(
          (tab) => tab.presentation === "beside" && tab.dockedIn === chat.id,
        );
        return item(
          chat.id,
          { kind: "chat", chatId: chat.id },
          <ChatCircleIcon className="size-3.5 shrink-0" />,
          docked ? `${chat.title}` : chat.title,
        );
      })}
      {state.strip.map((tabId) => {
        const tab = state.tabs.find((one) => one.id === tabId);
        if (!tab) return null;
        return item(
          tabId,
          { kind: "browser", tabId },
          <RobotIcon weight="bold" className="size-3 shrink-0" />,
          tabName(tab),
        );
      })}
      {/* Clear of the lab's own theme toolbar, which floats top right. */}
      <span className="mr-56 ml-auto">{drivers}</span>
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
    <div className="flex flex-1 flex-col gap-3 p-6">
      <div className="flex items-center gap-2 text-heading text-foreground">
        <Icon className="size-4" />
        {label}
      </div>
      <div className="grid flex-1 grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((column) => (
          <div key={column} className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2">
            {Array.from({ length: 3 - (column % 2) }, (_, card) => (
              <div key={card} className="h-14 rounded-md border border-border/60 bg-background" />
            ))}
          </div>
        ))}
      </div>
      <div className="text-muted-foreground">
        No browser here: a chat&apos;s dock leaves with the chat.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ chat + its dock */

const DOCK_DEFAULT_SHARE = 0.5;
const DOCK_MIN_PX = 360;
const CHAT_MIN_PX = 380;

function ChatWithDock({ chat, state }: { chat: LabChat; state: LabState }) {
  const dispatch = React.useContext(Dispatch);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const docked =
    state.tabs.find((tab) => tab.presentation === "beside" && tab.dockedIn === chat.id) ?? null;
  const share = state.dockWidth[chat.id] ?? DOCK_DEFAULT_SHARE;

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const row = rowRef.current;
    if (!row) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = row.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(bounds.right - moveEvent.clientX);
      const max = bounds.width - CHAT_MIN_PX;
      dispatch({
        type: "dockWidth",
        chatId: chat.id,
        width: Math.max(DOCK_MIN_PX, Math.min(max, next)) / bounds.width,
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={rowRef} className="flex min-w-0 flex-1">
      <ChatColumn chat={chat} state={state} />
      {docked ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize browser"
            onPointerDown={startDrag}
            className="group relative w-px shrink-0 cursor-col-resize bg-border"
          >
            <span className="absolute inset-y-0 -left-1.5 w-3 group-hover:bg-primary/20" />
          </div>
          <div
            className="flex min-w-0 shrink-0 flex-col"
            style={{ width: `${share * 100}%`, minWidth: DOCK_MIN_PX }}
          >
            <BrowserFrame tab={docked} place="beside" chatId={chat.id} state={state} />
          </div>
        </>
      ) : null}
    </div>
  );
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

/* ------------------------------------------------------ the transcript card */

function TranscriptCard({ tab, chatId }: { tab: LabTab; chatId: string }) {
  const dispatch = React.useContext(Dispatch);
  const beside = tab.presentation === "beside" && tab.dockedIn === chatId;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5">
      <OriginChip url={tab.url} title={tab.title} />
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
      <Button
        size="xs"
        variant="ghost"
        onClick={() => dispatch({ type: "openAsTab", tabId: tab.id })}
      >
        Open as tab
      </Button>
    </div>
  );
}

/* ----------------------------------------------------------- the island pill */

function IslandPill({ chat, state }: { chat: LabChat; state: LabState }) {
  const tabs = chatTabs(state, chat.id);
  const [open, setOpen] = React.useState(false);
  if (tabs.length === 0) return null;
  const loading = tabs.some((tab) => tab.loading);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 items-center gap-2 rounded-full border border-border bg-background px-3 shadow-raised transition-colors",
            open && "bg-muted",
          )}
        >
          <span className="relative flex">
            <GlobeSimpleIcon className="size-3.5 text-muted-foreground" />
          </span>
          <span className="tabular-nums">{tabs.length}</span>
          {loading ? <Spinner className="size-3" /> : null}
          {state.flash ? (
            <span className="max-w-72 truncate text-muted-foreground">{state.flash}</span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" sideOffset={10} className="w-[28rem] p-1">
        <TabsCard chat={chat} tabs={tabs} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
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
  const grouped = tabs.length >= GROUP_FROM;
  const groups = new Map<string, LabTab[]>();
  for (const tab of shown) {
    const origin = originOf(tab.url);
    groups.set(origin, [...(groups.get(origin) ?? []), tab]);
  }

  return (
    <div className="flex flex-col">
      <div className="flex h-8 items-center gap-2 px-2">
        <GlobeSimpleIcon className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-foreground">
          {tabs.length} browser {tabs.length === 1 ? "tab" : "tabs"}
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
            placeholder="Filter by title or URL"
            className="h-7 pl-7 shadow-none"
          />
        </div>
      ) : null}
      <div className="flex max-h-96 flex-col overflow-y-auto">
        {shown.length === 0 ? (
          <div className="px-2 py-3 text-muted-foreground">No tab matches.</div>
        ) : null}
        {[...groups].map(([origin, members]) => (
          <div key={origin} className="flex flex-col">
            {grouped ? (
              <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-label text-muted-foreground uppercase">
                <span className="font-mono normal-case">{origin}</span>
                <span className="tabular-nums">· {members.length}</span>
              </div>
            ) : null}
            {members.map((tab) => (
              <TabRow key={tab.id} tab={tab} chat={chat} grouped={grouped} onShown={onDone} />
            ))}
          </div>
        ))}
      </div>
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
  const beside = tab.presentation === "beside" && tab.dockedIn === chat.id;
  const child = tab.owner !== chat.id ? sessionTitle(tab.owner) : null;
  const untitled = tab.title.trim() === "";
  return (
    <ListRow
      density="two-line"
      leading={<OriginChip url={tab.url} title={tab.title} />}
      primary={grouped && untitled ? pathOf(tab.url) : tabName(tab)}
      primaryTrailing={<PlaceWord tab={tab} chatId={chat.id} />}
      secondary={
        <span className="flex min-w-0 items-center gap-1.5">
          {/* An untitled page is already named by its path; say it once. */}
          {grouped && untitled ? null : (
            <span className="truncate font-mono text-label tracking-normal">
              {grouped ? pathOf(tab.url) : `${originOf(tab.url)}${pathOf(tab.url)}`}
            </span>
          )}
          {child ? <span className="shrink-0 truncate">· by {child}</span> : null}
        </span>
      }
      selected={beside}
      onActivate={() => {
        if (tab.presentation === "tab") {
          dispatch({ type: "surface", surface: { kind: "browser", tabId: tab.id } });
        } else {
          dispatch({ type: "showBeside", tabId: tab.id, chatId: chat.id });
        }
        onShown();
      }}
      actions={
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
          <IconAction label="Replay what the agent did" onPress={() => undefined}>
            <ClockCounterClockwiseIcon />
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

/**
 * Where a tab is and who has it — the words that replace "pinned here". A
 * tab in the background says nothing about place; "Agent" rides any tab a
 * Session is driving, in that Session's colour.
 */
function PlaceWord({ tab, chatId }: { tab: LabTab; chatId: string }) {
  const place =
    tab.presentation === "beside" && tab.dockedIn === chatId
      ? "Beside chat"
      : tab.presentation === "tab"
        ? "In a tab"
        : null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
      {tab.loading ? <Spinner className="size-3" /> : null}
      {place ? (
        <span className="rounded-sm bg-muted px-1 text-label text-foreground uppercase">
          {place}
        </span>
      ) : null}
      {tab.heldBy ? (
        <span className="flex items-center gap-1" title={`${sessionTitle(tab.heldBy)} is driving`}>
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: sessionColor(tab.heldBy) }}
          />
          <span className="text-label uppercase">Driving</span>
        </span>
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

/** A favicon stand-in: the title's initial on the ORIGIN's colour, so one dev server reads as one hue. */
function OriginChip({ url, title: pageTitle }: { url: string; title: string }) {
  const name = tabName({ url, title: pageTitle });
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-sm text-label leading-none font-semibold text-white"
      style={{ backgroundColor: sessionColor(originOf(url)) }}
    >
      {name
        .replace(/^[^A-Za-z0-9]+/, "")
        .charAt(0)
        .toUpperCase() || "·"}
    </span>
  );
}

/* --------------------------------------------------------- the browser frame */

/**
 * The browser's chrome over a mock page. `beside` adds the dock's own
 * switcher (this chat's other tabs, without opening the island) and the two
 * ways out: open as a workspace tab, or put it back in the background.
 */
function BrowserFrame({
  tab,
  place,
  chatId,
  state,
}: {
  tab: LabTab;
  place: "beside" | "tab";
  chatId: string;
  state?: LabState;
}) {
  const dispatch = React.useContext(Dispatch);
  const siblings = state ? chatTabs(state, chatId) : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="@container/chrome shrink-0 border-b border-border bg-rail">
        {/* The dock's own header: WHICH tab, who has it, and the ways out. A
            workspace tab needs none of it — the strip already says which. */}
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
            <span className="flex-1" />
            {tab.heldBy ? <HolderPill tab={tab} /> : null}
            <IconAction
              label="Open as tab"
              onPress={() => dispatch({ type: "openAsTab", tabId: tab.id })}
            >
              <ArrowSquareOutIcon />
            </IconAction>
            <IconAction
              label="Hide (keeps the tab)"
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
          {place === "tab" ? (
            <>
              {tab.heldBy ? <HolderPill tab={tab} /> : null}
              <IconAction
                label="Show beside its chat"
                onPress={() => dispatch({ type: "showBeside", tabId: tab.id, chatId })}
              >
                <SidebarSimpleIcon className="-scale-x-100" />
              </IconAction>
            </>
          ) : null}
        </div>
      </div>
      <MockPage tab={tab} />
    </div>
  );
}

function HolderPill({ tab }: { tab: LabTab }) {
  const dispatch = React.useContext(Dispatch);
  const holder = tab.heldBy!;
  return (
    <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background pr-0.5 pl-2">
      <span className="size-1.5 rounded-full" style={{ backgroundColor: sessionColor(holder) }} />
      <span className="max-w-40 truncate @max-[440px]/chrome:hidden">{sessionTitle(holder)}</span>
      <Button
        size="xs"
        variant="ghost"
        className="h-5 rounded-full"
        onClick={() => dispatch({ type: "takeOver", tabId: tab.id })}
      >
        Take over
      </Button>
    </span>
  );
}

/** A fake page — enough structure to judge the dock's proportions, nothing more. */
function MockPage({ tab }: { tab: LabTab }) {
  const storybook = originOf(tab.url).endsWith(":6006");
  const ink = sessionColor(originOf(tab.url));
  return (
    <div className="@container/page relative min-h-0 flex-1 overflow-hidden bg-white text-[#1f2328]">
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
      {tab.heldBy ? (
        <span className="pointer-events-none absolute top-40 left-1/2 flex items-start gap-1">
          <NavigationArrowIcon
            weight="fill"
            className="size-4 -scale-x-100"
            style={{ color: sessionColor(tab.heldBy) }}
          />
          <span
            className="rounded px-1 text-label text-white"
            style={{ backgroundColor: sessionColor(tab.heldBy) }}
          >
            {sessionTitle(tab.heldBy)}
          </span>
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ drivers */

function Drivers({ state }: { state: LabState }) {
  const dispatch = React.useContext(Dispatch);
  const current = state.surface.kind === "chat" ? state.surface.chatId : CHATS[0]!.id;
  const docked = state.tabs.find(
    (tab) => tab.presentation === "beside" && tab.dockedIn === current,
  );
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
      });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary">
          <RobotIcon />
          Simulate the agent
          <CaretDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>In this chat, the agent…</DropdownMenuLabel>
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
        <DropdownMenuItem
          disabled={!docked?.heldBy}
          onSelect={() => docked && dispatch({ type: "release", tabId: docked.id })}
        >
          <CheckIcon />
          Releases it
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
