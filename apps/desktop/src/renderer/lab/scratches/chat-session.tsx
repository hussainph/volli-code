import * as React from "react";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  CodeIcon,
  PlayIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import type { UIMessage } from "ai";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@ai-elements/conversation";
import { FileMentionProvider } from "@ai-elements/chat-markdown";
import { Message, MessageContent, MessageResponse } from "@ai-elements/message";
import { AppShell } from "@renderer/components/app-shell";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { RailDrawer } from "@renderer/components/ticket/rail-drawer";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

import { projectSessionTodos, groupMessageParts, type SessionTodo } from "../chat/activity";
import {
  ActivityGroup,
  AttentionBlock,
  SessionTodoDock,
  SessionTodoList,
  ToolRun,
} from "../chat/activity-ui";
import { SessionComposer } from "../chat/composer-ui";
import { useLabSessionController } from "../chat/session-controller";
import {
  enqueueMessage,
  nextRelease,
  type ComposerIntent,
  type QueuedMessage,
} from "../chat/session-model";
import { LabRuntimeCatalogProvider } from "../runtime-catalog-client";
import { appApi, seedApp } from "../seed";

export const title = "Ticket chat · OpenCode";
export const note = "Native OpenCode Session inside the ticket workspace";
export const viewport = "window" as const;
export const seed = seedApp;
export const api = appApi;

const SESSION_TAB_ID = "native-chat";

export default function ChatSessionScratch() {
  return (
    <LabRuntimeCatalogProvider>
      <AppShell mainContent={<LabMainContent />} />
    </LabRuntimeCatalogProvider>
  );
}

/** Keep the prototype Session alive while Settings takes over the canvas. */
function LabMainContent() {
  const settingsOpen = useUiStore((state) => state.settingsOpen);

  return (
    <>
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", settingsOpen && "hidden")}>
        <TicketChatWorkspace />
      </div>
      {settingsOpen ? <SettingsPage initialCategoryKey="harness" /> : null}
    </>
  );
}

function TicketChatWorkspace() {
  const session = useLabSessionController();
  const [activeTabId, setActiveTabId] = React.useState(SESSION_TAB_ID);
  const [fileTabs, setFileTabs] = React.useState<TicketTabDescriptor[]>([]);
  const [todos, setTodos] = React.useState<SessionTodo[] | null>(null);
  // The rail's width and collapsed state are app-wide chrome the ChromeBar
  // already owns, so this surface reads them rather than growing a second
  // toggle beside the one in the window's title band.
  const railWidth = useUiStore((state) => state.railWidth);
  const railCollapsed = useUiStore((state) => state.railCollapsed);

  const tabs = React.useMemo<TicketTabDescriptor[]>(
    () => [
      { id: "doc", kind: "body", label: "LAB-14" },
      {
        id: SESSION_TAB_ID,
        kind: "session",
        label: "OpenCode 1",
        // The Session's liveness rides its own tab. The chat plane below has no
        // header of its own: a third chrome band would only repeat this word.
        status: session.lifecycle,
      },
      ...fileTabs,
    ],
    [fileTabs, session.lifecycle],
  );

  // Live todos from the plan activity; clear leftovers when the Session goes
  // idle (OpenCode paradigm — unfinished plans do not reopen later).
  React.useEffect(() => {
    if (session.lifecycle === "idle") {
      setTodos(null);
      return;
    }
    const projected = projectSessionTodos(session.messages);
    if (projected !== null) setTodos(projected.length > 0 ? projected : null);
  }, [session.lifecycle, session.messages]);

  const openFileTab = React.useCallback((path: string) => {
    const id = `file:${path}`;
    setFileTabs((current) => {
      if (current.some((tab) => tab.id === id)) return current;
      const label = path.includes("/") ? (path.split("/").pop() ?? path) : path;
      return [...current, { id, kind: "file", label, relPath: path }];
    });
    setActiveTabId(id);
  }, []);

  const onSession = activeTabId === SESSION_TAB_ID;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TicketTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        creating={session.lifecycle === "starting"}
        onSelectTab={setActiveTabId}
        onCloseTab={(tab) => {
          if (tab.kind === "file") {
            setFileTabs((current) => current.filter((entry) => entry.id !== tab.id));
            setActiveTabId(SESSION_TAB_ID);
            return;
          }
          setActiveTabId("doc");
        }}
        onRenameSessionTab={() => undefined}
        onNewSession={() => void session.start()}
        canFocusTerminal={false}
        onEnterTerminalFocus={() => undefined}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTabId === "doc" ? (
            <TicketIntent onOpenSession={() => setActiveTabId(SESSION_TAB_ID)} />
          ) : activeTabId.startsWith("file:") ? (
            <LabFilePreview path={activeTabId.slice("file:".length)} />
          ) : (
            <ChatPlane session={session} todos={todos} onOpenFile={openFileTab} />
          )}
        </main>
        {onSession && !railCollapsed ? (
          <aside
            className="flex shrink-0 flex-col overflow-hidden border-l border-sidebar-border bg-sidebar"
            style={{ width: railWidth }}
          >
            <SessionRail todos={todos} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Standing state, consulted rather than monitored — the transcript already
 * holds this turn's narrative. Only what has no other home lives here; changes
 * and files stay in the rail modes that already own them.
 */
function SessionRail({ todos }: { todos: SessionTodo[] | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
      <SessionRailDrawer label="Plan" count={todos?.length ?? 0}>
        {todos && todos.length > 0 ? (
          <div className="px-4 pb-3">
            <SessionTodoList todos={todos} />
          </div>
        ) : null}
      </SessionRailDrawer>
      <SessionRailDrawer label="Subagents" count={0} />
      <SessionRailDrawer label="Background processes" count={0} />
    </div>
  );
}

/**
 * Derived open state — a drawer opens because it has something in it, and stays
 * wherever the user last put it after that. No timer, so a click mid-transition
 * wins by construction.
 */
function SessionRailDrawer({
  label,
  count,
  children,
}: React.PropsWithChildren<{ label: string; count: number }>) {
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null);
  const open = userOpen ?? count > 0;
  return (
    <RailDrawer label={label} count={count} open={open} onOpenChange={setUserOpen}>
      {children}
    </RailDrawer>
  );
}

function LabFilePreview({ path }: { path: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-8 [scrollbar-gutter:stable]">
      <ContentColumn>
        <h1 className="font-mono text-heading font-semibold">{path}</h1>
      </ContentColumn>
    </div>
  );
}

function TicketIntent({ onOpenSession }: { onOpenSession(): void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-8 [scrollbar-gutter:stable]">
      <ContentColumn className="pb-16">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">LAB-14</span>
          <span>·</span>
          <span>Doing</span>
        </div>
        <h1 className="mt-3 text-title font-semibold tracking-tight">
          Teach the lab greeting to use a developer’s name
        </h1>
        <div className="mt-6 space-y-4 text-sm leading-6 text-foreground">
          <p>
            The disposable task repository contains a small greeting function and a failing test.
            Update the implementation without changing its public API.
          </p>
          <section className="border-t border-border pt-6">
            <h2 className="text-ui font-semibold">Acceptance</h2>
            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
              <p className="flex items-center gap-2">
                <CheckCircleIcon className="size-4" /> `greeting("Ada")` returns `Hello, Ada!`
              </p>
              <p className="flex items-center gap-2">
                <CheckCircleIcon className="size-4" /> `npm test` passes
              </p>
            </div>
          </section>
        </div>
        <Button className="mt-8" onClick={onOpenSession}>
          <TerminalWindowIcon className="size-4" />
          Open Session
        </Button>
      </ContentColumn>
    </div>
  );
}

function ChatPlane({
  session,
  todos,
  onOpenFile,
}: {
  session: ReturnType<typeof useLabSessionController>;
  todos: SessionTodo[] | null;
  onOpenFile(path: string): void;
}) {
  const [input, setInput] = React.useState("");
  const [queued, setQueued] = React.useState<readonly QueuedMessage[]>([]);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const composerHeight = useMeasuredHeight<HTMLDivElement>();
  const working = session.lifecycle === "working";
  const needsRuntimeChoice = session.catalog.models.length === 0;

  const { submit, selection, liveAttachmentId } = session;
  const ready = liveAttachmentId !== null && selection.modelId.length > 0;

  const send = React.useCallback(
    (text: string, intent: ComposerIntent) => {
      if (intent === "queue") {
        setQueued((current) => enqueueMessage(current, { id: nextId(), text }));
        setInput("");
        return;
      }
      void submit(text, intent === "steer" ? "steer" : "queue").then((sent) => {
        if (sent) setInput("");
      });
    },
    [submit],
  );

  // A queue drains one message into an idle Session. The released id is latched
  // so a re-render between the state write and the send cannot deliver twice.
  const released = React.useRef<string | null>(null);
  React.useEffect(() => {
    const next = nextRelease(queued, { working, ready });
    if (!next || released.current === next.id) return;
    released.current = next.id;
    setQueued((current) => current.filter((entry) => entry.id !== next.id));
    void submit(next.text, "queue");
  }, [queued, ready, submit, working]);

  const planeStyle = { "--composer-height": `${composerHeight.height}px` } as React.CSSProperties;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={planeStyle}>
      <FileMentionProvider onOpenFile={onOpenFile}>
        <Conversation className="min-h-0 bg-background">
          <ConversationContent className="gap-6 px-0 pt-8 pb-[calc(var(--composer-height)+2rem)]">
            {session.messages.length === 0 ? (
              <ConversationEmptyState className="min-h-80">
                <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-[var(--shadow-raised)]">
                  <CodeIcon className="size-5 text-muted-foreground" />
                </div>
                {needsRuntimeChoice ? (
                  <Button variant="outline" onClick={() => setSettingsOpen(true)}>
                    Choose OpenCode models
                  </Button>
                ) : session.liveAttachmentId ? null : (
                  <Button
                    disabled={session.lifecycle === "starting"}
                    onClick={() => void session.start()}
                  >
                    {session.lifecycle === "starting" ? (
                      <CircleNotchIcon className="size-4 animate-spin" />
                    ) : (
                      <PlayIcon className="size-4" weight="fill" />
                    )}
                    {session.sessionId ? "Start new Session" : "Start OpenCode"}
                  </Button>
                )}
              </ConversationEmptyState>
            ) : (
              <ContentColumn className="flex flex-col gap-6">
                {session.messages.map((message) => (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    working={working}
                    onOpenFile={onOpenFile}
                  />
                ))}
              </ContentColumn>
            )}
          </ConversationContent>
          <ConversationScrollButton className="bottom-[calc(var(--composer-height)+0.75rem)]" />
        </Conversation>
      </FileMentionProvider>

      {/* A short fade over the transcript, keyed to the measured composer rather
          than a magic offset that breaks the moment the plan dock expands. The
          old full-height scrim repainted the card rung over itself and read as
          a grey wash. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[var(--composer-height)] h-8 bg-gradient-to-t from-background to-transparent" />

      <div
        ref={composerHeight.ref}
        className="pointer-events-none absolute inset-x-0 bottom-0 pb-5"
      >
        <ContentColumn>
          {todos && todos.length > 0 && !todosEveryDone(todos) ? (
            <SessionTodoDock todos={todos} />
          ) : null}
          <SessionComposer
            value={input}
            onValueChange={setInput}
            models={session.catalog.models}
            agents={session.catalog.agents}
            selection={selection}
            onSelectionChange={session.setSelection}
            working={working}
            ready={ready}
            queued={queued}
            onQueuedChange={setQueued}
            onSubmit={send}
            onStop={() => void session.interrupt()}
          />
        </ContentColumn>
      </div>
    </div>
  );
}

/** Live height of a node, so a layout can be keyed to it instead of a constant. */
function useMeasuredHeight<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  height: number;
} {
  const ref = React.useRef<T>(null);
  const [height, setHeight] = React.useState(0);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, height };
}

function ChatMessage({
  message,
  working,
  onOpenFile,
}: {
  message: UIMessage;
  working: boolean;
  onOpenFile(path: string): void;
}) {
  const blocks = message.role === "assistant" ? groupMessageParts(message.parts, message.id) : null;
  // A user message is prose only; the assistant path owns every other shape.
  const prose = message.parts.flatMap((part, index) =>
    part.type === "text" ? [{ key: `${message.id}:${index}`, text: part.text }] : [],
  );

  // Plan-only projections must not leave an empty bubble.
  if (blocks && blocks.length === 0) return null;

  return (
    <Message from={message.role} className="max-w-full">
      <MessageContent className="group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-3.5 group-[.is-user]:py-2.5">
        {blocks
          ? blocks.map((block) => {
              switch (block.kind) {
                case "text":
                  return (
                    <MessageResponse
                      key={block.key}
                      isAnimating={working && message.role === "assistant"}
                    >
                      {block.part.text}
                    </MessageResponse>
                  );
                case "activity":
                  return (
                    <ActivityGroup
                      key={block.key}
                      items={block.items}
                      working={working}
                      onOpenFile={onOpenFile}
                    />
                  );
                case "tool-run":
                  return <ToolRun key={block.key} items={block.items} onOpenFile={onOpenFile} />;
                case "attention":
                  return (
                    <AttentionBlock key={block.key} part={block.part} onOpenFile={onOpenFile} />
                  );
                default:
                  return null;
              }
            })
          : prose.map((entry) => <MessageResponse key={entry.key}>{entry.text}</MessageResponse>)}
      </MessageContent>
    </Message>
  );
}

function todosEveryDone(todos: readonly SessionTodo[]): boolean {
  return todos.every((todo) => todo.status === "completed" || todo.status === "cancelled");
}

function nextId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `queued-${Date.now()}-${Math.random()}`;
}
