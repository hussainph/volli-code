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
import { ReasoningLine } from "@ai-elements/reasoning";
import { AppShell } from "@renderer/components/app-shell";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { RailDrawer } from "@renderer/components/ticket/rail-drawer";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

import {
  isAwaitingFirstOutput,
  projectSessionTodos,
  groupMessageParts,
  type ChatBlock,
  type SessionTodo,
} from "../chat/activity";
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
          {/* The bottom gap has to clear the composer *and* the fade above it —
              at +2rem the last lines of the transcript came to rest inside the
              gradient and sat there dimmed. +5rem clears the h-16 fade with air
              to spare, so the final line lands on clean background. */}
          <ConversationContent className="gap-6 px-0 pt-8 pb-[calc(var(--composer-height)+5rem)]">
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
                {working && isAwaitingFirstOutput(session.messages) ? (
                  <ReasoningLine verb="Working" meta={null} streaming />
                ) : null}
              </ContentColumn>
            )}
          </ConversationContent>
          {/* A short fade over the transcript, keyed to the measured composer
              rather than a magic offset that breaks the moment the plan dock
              expands. The old full-height scrim repainted the card rung over
              itself and read as a grey wash.

              It lives inside the Conversation, ahead of the button, so paint
              order is structural: content, then fade, then button. As a later
              sibling of the whole Conversation it painted *over* the button
              and washed its lower half toward the background — which read as
              the button being clipped.

              Tall enough to contain that button, which floats 12px above the
              composer and stands 28px: at h-8 its top sat above the fade, on
              crisp text, and sliced it. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-[var(--composer-height)] h-16 bg-gradient-to-t from-background to-transparent" />

          {/* Glass, not a plug. This button only exists while the reader is
              scrolled up, so there is always live text behind it; an opaque
              circle punches a hole in that text. */}
          <ConversationScrollButton className="bottom-[calc(var(--composer-height)+0.75rem)] bg-background/70 shadow-[var(--shadow-raised)] backdrop-blur-md dark:bg-background/70 dark:hover:bg-muted/70" />
        </Conversation>
      </FileMentionProvider>

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
      if (!entry) return;
      // Border box, not `contentRect`: the content box drops the observed
      // node's own padding. The composer carries pb-5, so this under-reported
      // by 20px — and every consumer of it (the transcript's bottom padding,
      // the fade, the jump-to-bottom button) sat 20px too low. The fade's
      // opaque end landed below the composer's hard top edge, which is why a
      // line got cut while still partly visible.
      setHeight(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
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
      <MessageContent className="gap-0 group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-3.5 group-[.is-user]:py-2.5">
        {blocks
          ? blocks.map((block, index) => (
              <div key={block.key} className={blockSpacing(blocks[index - 1], block)}>
                {renderBlock(block, { working, role: message.role, onOpenFile })}
              </div>
            ))
          : prose.map((entry) => <MessageResponse key={entry.key}>{entry.text}</MessageResponse>)}
      </MessageContent>
    </Message>
  );
}

/**
 * The container owns the rhythm, not the blocks. Machine rows sit flush so a run
 * of tool lines reads as one list whether or not the projection split it into
 * separate blocks; prose and bordered cards get a real gap. Blocks carrying
 * their own margins is what made the same boundary measure 8, 12 or 16px
 * depending only on which kinds happened to be adjacent.
 */
function isRowBlock(block: ChatBlock): boolean {
  return block.kind === "activity" || block.kind === "tool-run";
}

function blockSpacing(previous: ChatBlock | undefined, current: ChatBlock): string {
  if (!previous) return "";
  return isRowBlock(previous) && isRowBlock(current) ? "" : "mt-3";
}

function renderBlock(
  block: ChatBlock,
  context: { working: boolean; role: UIMessage["role"]; onOpenFile(path: string): void },
): React.ReactNode {
  switch (block.kind) {
    case "text":
      return (
        <MessageResponse isAnimating={context.working && context.role === "assistant"}>
          {block.part.text}
        </MessageResponse>
      );
    case "activity":
      return (
        <ActivityGroup
          items={block.items}
          working={context.working}
          onOpenFile={context.onOpenFile}
        />
      );
    case "tool-run":
      return <ToolRun items={block.items} onOpenFile={context.onOpenFile} />;
    case "attention":
      return <AttentionBlock part={block.part} onOpenFile={context.onOpenFile} />;
    default:
      return null;
  }
}

function todosEveryDone(todos: readonly SessionTodo[]): boolean {
  return todos.every((todo) => todo.status === "completed" || todo.status === "cancelled");
}

function nextId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `queued-${Date.now()}-${Math.random()}`;
}
