import * as React from "react";
import {
  ArrowClockwiseIcon,
  ArrowUpIcon,
  BugIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  CodeIcon,
  CopyIcon,
  PlayIcon,
  SidebarSimpleIcon,
  SquareIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import type { DynamicToolUIPart, UIMessage } from "ai";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@ai-elements/tool";
import { AppShell } from "@renderer/components/app-shell";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import { useLabSessionController, type MessageDelivery } from "../chat/session-controller";
import { appApi, seedApp } from "../seed";

export const title = "Ticket chat · OpenCode";
export const note = "Native OpenCode Session inside the ticket workspace";
export const viewport = "window" as const;
export const seed = seedApp;
export const api = appApi;

const TABS: readonly TicketTabDescriptor[] = [
  { id: "doc", kind: "body", label: "LAB-14" },
  { id: "native-chat", kind: "session", label: "OpenCode 1" },
];

type RailView = "context" | "events";
type DebugDensity = "normal" | "inspect" | "wire";

export default function ChatSessionScratch() {
  return <AppShell mainContent={<TicketChatWorkspace />} />;
}

function TicketChatWorkspace() {
  const session = useLabSessionController();
  const [activeTabId, setActiveTabId] = React.useState("native-chat");
  const [railView, setRailView] = React.useState<RailView>("context");
  const [railOpen, setRailOpen] = React.useState(true);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TicketTabStrip
        tabs={TABS}
        activeTabId={activeTabId}
        creating={session.lifecycle === "starting"}
        onSelectTab={setActiveTabId}
        onCloseTab={() => setActiveTabId("doc")}
        onRenameSessionTab={() => undefined}
        onNewSession={() => void session.start()}
        canFocusTerminal={false}
        onEnterTerminalFocus={() => undefined}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTabId === "doc" ? (
            <TicketIntent onOpenSession={() => setActiveTabId("native-chat")} />
          ) : (
            <ChatPlane
              session={session}
              inspectorOpen={railOpen}
              onToggleRail={() => setRailOpen((open) => !open)}
            />
          )}
        </main>
        <aside
          aria-hidden={!railOpen}
          inert={!railOpen}
          className={cn(
            "shrink-0 overflow-hidden bg-sidebar transition-[width,opacity] duration-200 ease-swift",
            railOpen
              ? "w-80 border-l border-sidebar-border opacity-100"
              : "w-0 border-l-0 opacity-0",
          )}
        >
          <div className="flex h-full w-80 flex-col">
            <RailHeader view={railView} onChange={setRailView} />
            {railView === "context" ? (
              <ContextRail session={session} />
            ) : (
              <DebugRail session={session} />
            )}
          </div>
        </aside>
      </div>
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
  inspectorOpen,
  onToggleRail,
}: {
  session: ReturnType<typeof useLabSessionController>;
  inspectorOpen: boolean;
  onToggleRail(): void;
}) {
  const [input, setInput] = React.useState("");
  const [delivery, setDelivery] = React.useState<MessageDelivery>("queue");
  const working = session.lifecycle === "working";

  React.useEffect(() => {
    if (working && delivery === "queue") setDelivery("steer");
    if (!working && delivery === "steer") setDelivery("queue");
  }, [delivery, working]);

  return (
    <>
      <header className="flex min-h-12 items-center gap-3 border-b border-border px-4">
        <StatusDot lifecycle={session.lifecycle} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h1 className="text-ui font-semibold">OpenCode</h1>
            <span className="truncate text-xs text-muted-foreground">{session.status}</span>
          </div>
        </div>
        <span className="hidden rounded-full border border-border px-2 py-0.5 font-mono text-label text-muted-foreground xl:inline">
          disposable workspace
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={inspectorOpen ? "Hide Session inspector" : "Show Session inspector"}
          aria-pressed={!inspectorOpen}
          onClick={onToggleRail}
        >
          <SidebarSimpleIcon className="size-4" />
        </Button>
      </header>

      <Conversation className="min-h-0 bg-background">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-6 pb-44 pt-8">
          {session.messages.length === 0 ? (
            <ConversationEmptyState className="min-h-80">
              <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-sm">
                <CodeIcon className="size-5 text-muted-foreground" />
              </div>
              <div className="mt-1 space-y-1 text-center">
                <h2 className="text-heading font-semibold">Work the ticket with OpenCode</h2>
                <p className="text-sm text-muted-foreground">
                  One durable Session. One disposable repository.
                </p>
              </div>
              {session.liveAttachmentId ? null : (
                <Button
                  className="mt-3"
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
            session.messages.map((message) => (
              <ChatMessage key={message.id} message={message} working={working} />
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton className="bottom-36" />
      </Conversation>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent px-6 pb-5 pt-12">
        <PromptInput
          className="pointer-events-auto mx-auto w-full max-w-3xl border-border bg-card/95 shadow-lg backdrop-blur-xl"
          onSubmit={async ({ text }) => {
            const sent = await session.submit(text, delivery);
            if (sent) setInput("");
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              disabled={!session.liveAttachmentId}
              placeholder={working ? "Steer the active turn…" : "Ask, plan, or implement…"}
              className="min-h-16 text-sm"
            />
          </PromptInputBody>
          <PromptInputFooter className="flex-wrap border-t border-border/70 pt-2">
            <PromptInputTools className="flex-wrap">
              <RuntimeSelects session={session} delivery={delivery} onDelivery={setDelivery} />
            </PromptInputTools>
            <div className="ml-auto flex items-center gap-1">
              {working ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void session.interrupt()}
                >
                  <SquareIcon className="size-3.5" weight="fill" />
                  <span className="sr-only">Stop OpenCode</span>
                </Button>
              ) : null}
              <PromptInputSubmit
                status="ready"
                disabled={!input.trim() || !session.liveAttachmentId || !session.selection.modelId}
              >
                <ArrowUpIcon className="size-4" weight="bold" />
              </PromptInputSubmit>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </>
  );
}

function RuntimeSelects({
  session,
  delivery,
  onDelivery,
}: {
  session: ReturnType<typeof useLabSessionController>;
  delivery: MessageDelivery;
  onDelivery(next: MessageDelivery): void;
}) {
  const models = session.catalog.models.filter(
    (model) => model.providerId === session.selection.providerId,
  );
  const selectedModel = models.find((model) => model.modelId === session.selection.modelId);
  const update = (patch: Partial<typeof session.selection>) =>
    session.setSelection({ ...session.selection, ...patch });

  return (
    <>
      <CompactSelect
        label="Provider"
        value={session.selection.providerId}
        disabled={session.catalog.providers.length === 0}
        onChange={(providerId) => {
          const model = session.catalog.models.find(
            (candidate) => candidate.providerId === providerId && candidate.state === "available",
          );
          update({
            providerId,
            modelId: model?.modelId ?? "",
            variant: model?.variants[0] ?? "",
          });
        }}
        options={session.catalog.providers.map((provider) => ({
          value: provider,
          label: provider,
        }))}
      />
      <CompactSelect
        label="Model"
        value={session.selection.modelId}
        disabled={models.length === 0}
        onChange={(modelId) => {
          const model = models.find((candidate) => candidate.modelId === modelId);
          update({ modelId, variant: model?.variants[0] ?? "" });
        }}
        options={models.map((model) => ({
          value: model.modelId,
          label: model.label,
          disabled: model.state !== "available",
        }))}
      />
      <CompactSelect
        label="Effort"
        value={session.selection.variant}
        disabled={!selectedModel || selectedModel.variants.length === 0}
        onChange={(variant) => update({ variant })}
        options={(selectedModel?.variants ?? []).map((variant) => ({
          value: variant,
          label: variant,
        }))}
        emptyLabel="default effort"
      />
      <CompactSelect
        label="Mode"
        value={session.selection.agent}
        disabled={session.catalog.agents.length === 0}
        onChange={(agent) => update({ agent })}
        options={session.catalog.agents.map((entry) => ({
          value: entry.id,
          label: entry.label,
          disabled: entry.state !== "available",
        }))}
        emptyLabel="default mode"
      />
      <CompactSelect
        label="Delivery"
        value={delivery}
        onChange={(value) => onDelivery(value as MessageDelivery)}
        options={[
          { value: "queue", label: "queue" },
          { value: "steer", label: "steer" },
          { value: "replace", label: "replace" },
        ]}
      />
    </>
  );
}

function CompactSelect({
  label,
  value,
  options,
  disabled,
  onChange,
  emptyLabel,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange(value: string): void;
  emptyLabel?: string;
}) {
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="h-6 max-w-36 rounded-full border-0 bg-transparent px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      {value ? null : <option value="">{emptyLabel ?? `no ${label.toLowerCase()}`}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function ChatMessage({ message, working }: { message: UIMessage; working: boolean }) {
  return (
    <Message from={message.role} className="max-w-full">
      <MessageContent className="group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-3.5 group-[.is-user]:py-2.5">
        {message.parts.map((part, index) => {
          const key = `${message.id}:${index}`;
          switch (part.type) {
            case "text":
              return <MessageResponse key={key}>{part.text}</MessageResponse>;
            case "reasoning":
              return (
                <Reasoning key={key} isStreaming={working && message.role === "assistant"}>
                  <ReasoningTrigger />
                  <ReasoningContent>{part.text}</ReasoningContent>
                </Reasoning>
              );
            case "dynamic-tool":
              return <ChatTool key={key} part={part} />;
            default:
              return null;
          }
        })}
      </MessageContent>
    </Message>
  );
}

function ChatTool({ part }: { part: DynamicToolUIPart }) {
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;
  return (
    <Tool defaultOpen={part.state === "output-error"} className="mb-2 border-border bg-card/60">
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={part.toolName}
        title={part.title}
      />
      <ToolContent>
        {"input" in part ? <ToolInput input={part.input} /> : null}
        <ToolOutput output={output} errorText={errorText} />
      </ToolContent>
    </Tool>
  );
}

function StatusDot({
  lifecycle,
}: {
  lifecycle: ReturnType<typeof useLabSessionController>["lifecycle"];
}) {
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        lifecycle === "working" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_18%,transparent)]",
        lifecycle === "ready" && "bg-primary",
        lifecycle === "error" && "bg-destructive",
        (lifecycle === "idle" || lifecycle === "starting") && "bg-muted-foreground",
      )}
    />
  );
}

function RailHeader({ view, onChange }: { view: RailView; onChange(view: RailView): void }) {
  return (
    <div className="flex min-h-12 items-center gap-1 border-b border-sidebar-border px-3">
      <Button
        size="sm"
        variant={view === "context" ? "secondary" : "ghost"}
        onClick={() => onChange("context")}
      >
        Context
      </Button>
      <Button
        size="sm"
        variant={view === "events" ? "secondary" : "ghost"}
        onClick={() => onChange("events")}
      >
        <BugIcon className="size-3.5" />
        Events
      </Button>
    </div>
  );
}

function ContextRail({ session }: { session: ReturnType<typeof useLabSessionController> }) {
  const selectedAgent = session.catalog.agents.find(
    (agent) => agent.id === session.selection.agent,
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 text-ui [scrollbar-gutter:stable]">
      <RailSection title="Ticket">
        <p className="font-medium text-foreground">LAB-14 · Greeting task</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Ticket body and acceptance criteria form the Runtime Brief.
        </p>
      </RailSection>
      <RailSection title="Workspace">
        <div className="flex items-center gap-2 text-foreground">
          <TerminalWindowIcon className="size-4 text-muted-foreground" />
          Disposable git repository
        </div>
        <p className="mt-1 font-mono text-label text-muted-foreground">
          TASK.md · src/greeting.ts · test/greeting.test.ts
        </p>
      </RailSection>
      <RailSection title="Runtime">
        <KeyValue label="Harness" value="OpenCode · native" />
        <KeyValue
          label="Model"
          value={
            session.selection.modelId
              ? `${session.selection.providerId}/${session.selection.modelId}`
              : "Not reported"
          }
        />
        <KeyValue label="Effort" value={session.selection.variant || "Provider default"} />
        <KeyValue label="Mode" value={selectedAgent?.label ?? "Provider default"} />
      </RailSection>
      <RailSection title="Session">
        <KeyValue label="Identity" value={session.sessionId || "Not created"} mono />
        <KeyValue label="Attachment" value={session.liveAttachmentId || "Not attached"} mono />
      </RailSection>
    </div>
  );
}

function DebugRail({ session }: { session: ReturnType<typeof useLabSessionController> }) {
  const [density, setDensity] = React.useState<DebugDensity>("normal");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-sidebar-border px-3 py-2">
        {(["normal", "inspect", "wire"] as const).map((value) => (
          <Button
            key={value}
            size="xs"
            variant={density === value ? "secondary" : "ghost"}
            onClick={() => setDensity(value)}
          >
            {value}
          </Button>
        ))}
        <Button
          className="ml-auto"
          size="icon-xs"
          variant="ghost"
          disabled={!session.liveAttachmentId}
          onClick={() => void session.reconcile()}
        >
          <ArrowClockwiseIcon className="size-3.5" />
          <span className="sr-only">Reconcile</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable]">
        {density === "normal" ? (
          <div className="space-y-3">
            <DebugCard label="State" value={session.status} />
            <DebugCard label="Events" value={`${session.frames.length} committed`} />
            <DebugCard label="Messages" value={`${session.messages.length} transcript frames`} />
            <DebugCard
              label="Attention"
              value={`${session.projection?.attention.active.length ?? 0} active`}
            />
          </div>
        ) : density === "inspect" ? (
          <div className="space-y-5 text-xs">
            <InspectList title="Receipts" values={session.projection?.receipts ?? []} />
            <InspectList title="Attention" values={session.projection?.attention.active ?? []} />
            <InspectList
              title="Interactions"
              values={session.projection?.interactions.active ?? []}
            />
            <InspectList title="Capabilities" values={session.projection?.capabilities ?? []} />
          </div>
        ) : (
          <div className="space-y-5 font-mono text-label">
            <WireList
              title="Ordered Session events"
              values={session.frames.map((frame) => ({
                sequence: frame.sequence,
                event: frame.event,
              }))}
            />
            <WireList title="Sanitized RPC" values={session.diagnostics} />
          </div>
        )}
      </div>
      <div className="flex gap-2 border-t border-sidebar-border p-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!session.liveAttachmentId}
          onClick={() => void session.refreshCapabilities()}
        >
          Refresh caps
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!session.liveAttachmentId}
          onClick={() => void session.release()}
        >
          Release
        </Button>
      </div>
    </div>
  );
}

function RailSection({ title: heading, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <section className="border-b border-sidebar-border py-4 first:pt-0 last:border-0">
      <h2 className="mb-3 text-label uppercase text-muted-foreground">{heading}</h2>
      {children}
    </section>
  );
}

function KeyValue({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn("truncate text-foreground", mono && "font-mono text-label")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function DebugCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-sidebar-border bg-card/50 p-3">
      <p className="text-label uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-ui text-foreground">{value}</p>
    </div>
  );
}

function InspectList({ title: heading, values }: { title: string; values: readonly unknown[] }) {
  return (
    <section>
      <h3 className="mb-2 text-label uppercase text-muted-foreground">{heading}</h3>
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">None</p>
      ) : (
        <div className="space-y-2">
          {values.map((value) => (
            <pre
              key={debugValueKey(value)}
              className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-label text-foreground"
            >
              {JSON.stringify(value, null, 2)}
            </pre>
          ))}
        </div>
      )}
    </section>
  );
}

function WireList({ title: heading, values }: { title: string; values: readonly unknown[] }) {
  const copy = () => void navigator.clipboard.writeText(JSON.stringify(values, null, 2));
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-label uppercase text-muted-foreground">{heading}</h3>
        <Button size="icon-xs" variant="ghost" onClick={copy}>
          <CopyIcon className="size-3.5" />
          <span className="sr-only">Copy {heading}</span>
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="text-muted-foreground">None</p>
      ) : (
        <div className="space-y-2">
          {values.map((value) => (
            <pre
              key={debugValueKey(value)}
              className="overflow-x-auto whitespace-pre-wrap border-l border-border pl-2 text-foreground"
            >
              {JSON.stringify(value, null, 2)}
            </pre>
          ))}
        </div>
      )}
    </section>
  );
}

function debugValueKey(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" || typeof record.id === "number") {
      return String(record.id);
    }
    if (typeof record.sequence === "number") return `sequence:${record.sequence}`;
  }
  return JSON.stringify(value) ?? String(value);
}
