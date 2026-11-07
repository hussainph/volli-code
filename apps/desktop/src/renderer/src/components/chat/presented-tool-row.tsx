import * as React from "react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import {
  presentTranscriptTool,
  activityDescriptor,
  type TranscriptToolContext as ToolDisplayContext,
  type TranscriptToolPresentation,
  type BundleRow,
  type TranscriptToolSection,
} from "@volli/session-presentation";
import {
  ChevronRightIcon,
  GlobeIcon,
  ErrorIcon,
  CopyIcon,
  SuccessIcon,
  CodeIcon,
  BrowserIcon,
  TeamIcon,
  ToolsIcon,
} from "@renderer/components/ui/icon";
import { isBrowserTraceAction } from "@volli/shared";
import { useStopFollowing } from "@renderer/components/ui/ai-elements/conversation";
import { titleWordKeys } from "@renderer/components/ui/title-reveal";
import { TranscriptSourceIconContext } from "./transcript-source-icons";
import {
  BrowserCardHostContext,
  BrowserPicture,
  useBrowserPicture,
} from "@renderer/components/browser/browser-tab-card";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { GlassSurface, PaperSurface } from "@renderer/components/ui/surface";
import { Button } from "@renderer/components/ui/button";
import { toastError } from "@renderer/lib/toast";
import { copyText, COPY_FEEDBACK_MS } from "./transcript-copy";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import "./transcript-presentation.css";

export const TranscriptToolContext = React.createContext<ToolDisplayContext>({});

export function OriginalOutput({ part }: { part: DynamicToolUIPart | UIMessage }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="my-2 text-ui text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        className="focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setOpen(!open)}
      >
        Original output
      </button>
      {open ? (
        <pre
          className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-ui"
          tabIndex={0}
          aria-label="Original tool evidence"
        >
          {JSON.stringify(part, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function canonicalOrigin(url: string | null | undefined): string | null {
  try {
    const parsed = new URL(url ?? "");
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** No renderer network. Unknown registrable roots never borrow a subdomain's initial. */
function SourceIdentity({
  name,
  url,
  site = true,
}: {
  name: string;
  url?: string | null;
  site?: boolean;
}) {
  const context = React.useContext(TranscriptSourceIconContext);
  const origin = canonicalOrigin(url);
  const record = origin ? context.icons.get(origin) : undefined;
  const label = site && origin ? (record?.registrableDomain ?? "?") : name;
  const fallback = label.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
  return (
    <span aria-hidden className="transcript-identity">
      {record?.pictureId && context.picture ? (
        <CachedSourceImage
          key={`${context.sessionId}:${origin}:${record.pictureId}`}
          api={context.picture}
          pictureId={record.pictureId}
          fallback={fallback}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

function CachedSourceImage({
  api,
  pictureId,
  fallback,
}: {
  api: Pick<BrowserApi, "picture">;
  pictureId: string;
  fallback: string;
}) {
  const picture = useBrowserPicture(api, pictureId);
  const [failed, setFailed] = React.useState(false);
  return picture.kind === "ready" && !failed ? (
    <img
      src={picture.dataUrl}
      alt=""
      className="size-full object-contain"
      onError={() => setFailed(true)}
    />
  ) : (
    fallback
  );
}

/** The root has the real text baseline; an empty prefix never gets a layout box. */
function DomainLabel({ domain, url }: { domain: string; url?: string | null }) {
  const { icons } = React.useContext(TranscriptSourceIconContext);
  const origin = canonicalOrigin(url);
  const root = origin ? icons.get(origin)?.registrableDomain : null;
  if (!root || (domain !== root && !domain.endsWith(`.${root}`)))
    return (
      <bdi dir="ltr" className="transcript-domain truncate">
        {domain}
      </bdi>
    );
  const prefix = domain.slice(0, -root.length);
  return (
    <bdi dir="ltr" className="transcript-domain">
      {prefix ? <span className="transcript-domain-prefix">{prefix}</span> : null}
      <span className="transcript-domain-root">{root}</span>
    </bdi>
  );
}

function ToolIdentity({ presentation }: { presentation: TranscriptToolPresentation }) {
  if (presentation.status === "failed" || presentation.status === "denied")
    return <ErrorIcon aria-hidden className="size-4 shrink-0 text-destructive" />;
  if (presentation.identity && presentation.category !== "session")
    return (
      <SourceIdentity
        name={presentation.identity}
        url={presentation.originUrl}
        site={presentation.category !== "mcp"}
      />
    );
  const Icon =
    presentation.category === "browser"
      ? BrowserIcon
      : presentation.category === "session"
        ? TeamIcon
        : presentation.category === "code"
          ? CodeIcon
          : presentation.category === "mcp"
            ? ToolsIcon
            : GlobeIcon;
  return <Icon aria-hidden className="size-4 shrink-0" />;
}

function CopyDisplayedOutput({ text }: { text: string }) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  React.useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  const label =
    state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy displayed output";
  const Icon = state === "copied" ? SuccessIcon : state === "failed" ? ErrorIcon : CopyIcon;
  return (
    <span className="inline-flex items-center">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={label}
        onClick={() => void copyText(text).then(setState)}
      >
        <Icon aria-hidden className="size-3.5" />
        {label}
      </Button>
      <span className="sr-only" aria-live="polite" role={state === "idle" ? undefined : "status"}>
        {state === "idle" ? "" : label}
      </span>
    </span>
  );
}

function ResultSection({ section }: { section: TranscriptToolSection }) {
  const content =
    section.format === "prose" || section.format === "note" ? (
      <div
        className="transcript-result-prose"
        tabIndex={section.format === "prose" ? 0 : undefined}
        role={section.format === "prose" ? "region" : undefined}
        aria-label={section.format === "prose" ? section.label : undefined}
      >
        {section.text}
      </div>
    ) : (
      <pre
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-ui"
        tabIndex={0}
      >
        {section.text}
      </pre>
    );
  return (
    <details open={section.collapsed !== true} className="transcript-result-section">
      <summary>{section.label}</summary>
      {content}
    </details>
  );
}

function RecordedBrowserPicture({
  api,
  pictureId,
}: {
  api: Pick<BrowserApi, "picture"> | null;
  pictureId: string;
}) {
  const picture = useBrowserPicture(api, pictureId);
  return <BrowserPicture state={picture} alt="Recorded page screenshot" />;
}

function BrowserEvidence({ part }: { part: DynamicToolUIPart }) {
  const host = React.useContext(BrowserCardHostContext);
  const facet = activityDescriptor(part).browse;
  const live = useBrowserTabsStore((state) => (facet?.tabId ? state.byId[facet.tabId] : undefined));
  if (!facet) return null;
  const canReplay =
    host?.openTrace !== undefined &&
    facet.tabId !== null &&
    facet.ownerSessionId !== null &&
    isBrowserTraceAction(facet.action);
  const show = async () => {
    if (!host || !live) return;
    try {
      if (host.openBeside) await host.openBeside(live.tabId);
      else {
        const result = await host.api.setPresentation({ tabId: live.tabId, presentation: "tab" });
        if (!result.ok) toastError("Couldn't show this tab.");
      }
    } catch {
      toastError("Couldn't show this tab.");
    }
  };
  return (
    <div className="space-y-2">
      {facet.picture ? (
        <RecordedBrowserPicture
          key={facet.picture}
          api={host?.api ?? null}
          pictureId={facet.picture}
        />
      ) : null}
      {live || canReplay ? (
        <div className="flex flex-wrap items-center gap-2">
          {live && host ? (
            <Button type="button" size="xs" variant="secondary" onClick={() => void show()}>
              Show tab
            </Button>
          ) : null}
          {canReplay && host ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() =>
                host.openTrace?.({
                  sessionId: host.sessionId,
                  tabId: facet.tabId!,
                  pictureId: facet.picture,
                })
              }
            >
              Replay
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DelegationRelations({
  relations,
  onOpenSession,
}: {
  relations: NonNullable<TranscriptToolPresentation["relations"]>;
  onOpenSession?: (id: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const visible = expanded ? relations : relations.slice(0, 5);
  if (relations.length < 2) return null;
  return (
    <section className="transcript-result-section">
      <h4 className="mb-2 text-ui font-medium">Related Sessions</h4>
      <div
        className="max-h-72 overflow-auto"
        role="region"
        aria-label="Delegation relations"
        tabIndex={0}
      >
        <ol className="m-0 list-none p-0">
          {visible.map((relation, index) => (
            <li key={relation.sessionId} className="flex min-w-0 items-start gap-2 py-1 text-ui">
              <span dir="ltr" className="shrink-0 tabular-nums">
                <span>{index + 1}</span>
                <span>.</span>
              </span>
              <div className="min-w-0">
                {onOpenSession ? (
                  <button
                    type="button"
                    className="block max-w-full rounded-sm text-start underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpenSession(relation.sessionId)}
                  >
                    <bdi dir="auto" className="line-clamp-2 break-words">
                      {relation.name}
                    </bdi>
                  </button>
                ) : (
                  <bdi dir="auto" className="line-clamp-2 break-words">
                    {relation.name}
                  </bdi>
                )}
                {relation.parentName ? (
                  <div className="text-muted-foreground">
                    Delegated by <bdi dir="auto">{relation.parentName}</bdi>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
      {relations.length > 5 ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          className="mt-2"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show fewer Sessions" : `${relations.length - 5} more Sessions`}
        </Button>
      ) : null}
    </section>
  );
}

export function PresentedToolRow({
  part,
  presentation,
  onOpenSession,
  onOpenFile,
  children,
}: {
  part: DynamicToolUIPart;
  presentation: TranscriptToolPresentation;
  onOpenSession?(id: string): void;
  onOpenFile?(path: string): void;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const stopFollowing = useStopFollowing();
  const sourceKeys = titleWordKeys(presentation.sources.map((source) => source.url));
  const sectionKeys = titleWordKeys(presentation.sections.map((section) => section.label));
  const outputText = [
    ...presentation.sources.map((source) => `${source.title}\n${source.url}\n${source.snippet}`),
    ...presentation.sections
      .filter(
        (section) =>
          !["Program", "Arguments", "Query", "Message", "Task", "Retrieved URL"].includes(
            section.label,
          ),
      )
      .map((section) => section.text),
  ].join("\n\n");
  return (
    <div className="not-prose min-w-0" data-tool-category={presentation.category}>
      <button
        type="button"
        className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md text-left text-ui text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        aria-expanded={open}
        aria-label={`${presentation.label}${presentation.meta ? ` · ${presentation.meta}` : ""}`}
        onClick={() => {
          if (window.getSelection()?.toString()) return;
          if (!open) stopFollowing();
          setOpen(!open);
        }}
      >
        <ToolIdentity presentation={presentation} />
        {presentation.caption ? (
          <span className="transcript-row-caption">
            <span className="shrink-0">{presentation.caption.verb}</span>
            <DomainLabel domain={presentation.caption.domain} url={presentation.caption.url} />
          </span>
        ) : (
          <bdi dir="auto" className="min-w-0 truncate">
            {presentation.label}
          </bdi>
        )}
        {presentation.meta ? (
          <span className="ml-auto shrink-0 tabular-nums">{presentation.meta}</span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        />
      </button>
      {open ? (
        <GlassSurface className="transcript-result-frame">
          <div className="transcript-result-heading">
            <span className="transcript-card-mark">
              <ToolIdentity presentation={presentation} />
            </span>
            <div className="min-w-0">
              <bdi dir="auto" className="line-clamp-2 font-medium">
                {presentation.identity ?? presentation.label}
              </bdi>
              {presentation.originUrl &&
              presentation.identity &&
              ["web", "browser"].includes(presentation.category) ? (
                <DomainLabel domain={presentation.identity} url={presentation.originUrl} />
              ) : null}
            </div>
            {presentation.meta ? (
              <span className="transcript-result-meta">{presentation.meta}</span>
            ) : null}
          </div>
          <PaperSurface className="transcript-result-document">
            {presentation.sessionId && onOpenSession ? (
              <button
                type="button"
                className="mb-2 underline"
                onClick={() => onOpenSession(presentation.sessionId!)}
              >
                Open <bdi>{presentation.identity}</bdi>
              </button>
            ) : null}
            {presentation.sources.length > 0 ? (
              <div
                className="max-h-72 overflow-auto"
                role="region"
                aria-label="Sources"
                tabIndex={0}
              >
                {presentation.sources.map((source, index) => (
                  <div
                    key={sourceKeys[index]}
                    className="flex min-w-0 gap-2 border-b border-border py-2 last:border-0"
                  >
                    <SourceIdentity name={source.domain} url={source.url} />
                    <div className="min-w-0">
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate font-medium"
                      >
                        <bdi dir="auto">{source.title}</bdi>
                      </a>
                      <DomainLabel domain={source.domain} url={source.url} />
                      <p className="line-clamp-3 text-muted-foreground">
                        <bdi dir="auto">{source.snippet}</bdi>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {presentation.relations ? (
              <DelegationRelations
                key={presentation.sessionId}
                relations={presentation.relations}
                onOpenSession={onOpenSession}
              />
            ) : null}
            {presentation.sections.map((section, index) => (
              <ResultSection key={sectionKeys[index]} section={section} />
            ))}
            {presentation.category === "browser" ? <BrowserEvidence part={part} /> : null}
            {children}
            {presentation.sections.length === 0 && presentation.sources.length === 0 ? (
              <p className="text-muted-foreground">
                {presentation.status === "running" || presentation.status === "pending"
                  ? "In progress"
                  : "Result details unavailable"}
              </p>
            ) : null}
          </PaperSurface>
          <div className="transcript-result-actions">
            {outputText ? <CopyDisplayedOutput text={outputText} /> : null}
            {presentation.savedOutputs?.map((saved) =>
              onOpenFile ? (
                <Button
                  key={saved.path}
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpenFile(saved.path)}
                >
                  Saved output
                </Button>
              ) : null,
            )}
            <OriginalOutput part={part} />
          </div>
        </GlassSurface>
      ) : null}
    </div>
  );
}

/** Consecutive web activity only; expansion preserves call order and outcomes. */
export function WebWorkGroup({
  rows,
  onOpenFile,
}: {
  rows: readonly Extract<BundleRow, { kind: "tool" }>[];
  onOpenFile?(path: string): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [more, setMore] = React.useState(false);
  const [domain, setDomain] = React.useState<string | null>(null);
  const context = React.useContext(TranscriptToolContext);
  const stopFollowing = useStopFollowing();
  const models = rows.map((row) => presentTranscriptTool(row.part, context)!);
  const sources = [
    ...new Map(
      models.flatMap((model) => model.sources).map((source) => [source.url, source]),
    ).values(),
  ];
  const domains = [...new Set(sources.map((source) => source.domain))];
  const running = models.some((model) => model.status === "running" || model.status === "pending");
  const failed = models.filter(
    (model) => model.status === "failed" || model.status === "denied",
  ).length;
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-7 w-full min-w-0 items-center gap-2 text-ui text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => {
          if (!open) stopFollowing();
          setOpen(!open);
        }}
      >
        <GlobeIcon aria-hidden className="size-4 shrink-0" />
        <span>{running ? "Searching the web" : "Searched the web"}</span>
        {sources.length > 0 ? <span>{sources.length} sources</span> : null}
        {failed > 0 ? <span>{failed} failed</span> : null}
        <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
      </button>
      {domains.length > 0 ? (
        <div className="my-1 flex max-h-40 flex-wrap gap-1 overflow-auto">
          {domains.slice(0, more ? undefined : 7).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={domain === name}
              className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border px-2 py-1 text-ui"
              onClick={() => {
                stopFollowing();
                setDomain(domain === name ? null : name);
              }}
            >
              <SourceIdentity
                name={name}
                url={sources.find((source) => source.domain === name)?.url}
              />
              <DomainLabel
                domain={name}
                url={sources.find((source) => source.domain === name)?.url}
              />
            </button>
          ))}
          {domains.length > 7 ? (
            <button type="button" className="text-ui" onClick={() => setMore(!more)}>
              {more ? "Show fewer sources" : `+${domains.length - 7} more`}
            </button>
          ) : null}
        </div>
      ) : null}
      {domain ? (
        <div
          className="max-h-72 overflow-auto"
          role="region"
          aria-label={`Sources from ${domain}`}
          tabIndex={0}
        >
          {sources
            .filter((source) => source.domain === domain)
            .map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-ui"
              >
                <bdi dir="auto">{source.title}</bdi>
              </a>
            ))}
        </div>
      ) : null}
      {open
        ? rows.map((row, index) => (
            <PresentedToolRow
              key={row.key}
              part={row.part}
              presentation={models[index]!}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </div>
  );
}
