import * as React from "react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import {
  presentTranscriptTool,
  type TranscriptToolContext as ToolDisplayContext,
  type TranscriptToolPresentation,
  type BundleRow,
} from "@volli/session-presentation";
import { ChevronRightIcon, GlobeIcon, ErrorIcon } from "@renderer/components/ui/icon";
import { useStopFollowing } from "@renderer/components/ui/ai-elements/conversation";
import { titleWordKeys } from "@renderer/components/ui/title-reveal";
import { TranscriptSourceIconContext } from "./transcript-source-icons";
import { useBrowserPicture } from "@renderer/components/browser/browser-tab-card";
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

/** No network, embedded remote SVG or hover-only name. Real icons await VC-1141. */
function SourceIdentity({ name, url }: { name: string; url?: string }) {
  const context = React.useContext(TranscriptSourceIconContext);
  let origin: string | null = null;
  try {
    if (url) origin = new URL(url).origin;
  } catch {
    /* No supported origin. */
  }
  const record = origin ? context.icons.get(origin) : undefined;
  const picture = useBrowserPicture(context.picture, record?.pictureId ?? null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const label = record ? (record.registrableDomain ?? "?") : name;
  return (
    <span aria-hidden className="transcript-identity">
      {picture.kind === "ready" && record?.pictureId !== failed ? (
        <img
          src={picture.dataUrl}
          alt=""
          className="size-full object-contain"
          onError={() => setFailed(record?.pictureId ?? null)}
        />
      ) : (
        (label.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?")
      )}
    </span>
  );
}

export function PresentedToolRow({
  part,
  presentation,
  onOpenSession,
  children,
}: {
  part: DynamicToolUIPart;
  presentation: TranscriptToolPresentation;
  onOpenSession?(id: string): void;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const stopFollowing = useStopFollowing();
  const sourceKeys = titleWordKeys(presentation.sources.map((source) => JSON.stringify(source)));
  const sectionKeys = titleWordKeys(
    presentation.sections.map((section) => JSON.stringify(section)),
  );
  return (
    <div className="not-prose min-w-0" data-tool-category={presentation.category}>
      <button
        type="button"
        className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md text-left text-ui text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        aria-expanded={open}
        onClick={() => {
          if (window.getSelection()?.toString()) return;
          if (!open) stopFollowing();
          setOpen(!open);
        }}
      >
        {presentation.status === "failed" || presentation.status === "denied" ? (
          <ErrorIcon aria-hidden className="size-4 shrink-0 text-destructive" />
        ) : presentation.identity ? (
          <SourceIdentity name={presentation.identity} />
        ) : (
          <GlobeIcon aria-hidden className="size-4 shrink-0" />
        )}
        <bdi dir="auto" className="min-w-0 truncate">
          {presentation.label}
        </bdi>
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
        <div className="my-1 min-w-0 rounded-md border border-border bg-muted p-3 text-ui text-foreground">
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
            <div className="max-h-72 overflow-auto" role="region" aria-label="Sources" tabIndex={0}>
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
                    <bdi dir="ltr" className="block truncate text-muted-foreground">
                      {source.domain}
                    </bdi>
                    <p className="line-clamp-3 text-muted-foreground">
                      <bdi dir="auto">{source.snippet}</bdi>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {presentation.sections.map((section, index) => (
            <details
              key={sectionKeys[index]}
              open={section.label !== "Program" && section.label !== "Accessibility tree"}
              className="my-2"
            >
              <summary>{section.label}</summary>
              <pre
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-ui"
                tabIndex={0}
              >
                {section.text}
              </pre>
            </details>
          ))}
          {children}
          {presentation.sections.length === 0 && presentation.sources.length === 0 ? (
            <p className="text-muted-foreground">
              {presentation.status === "running" || presentation.status === "pending"
                ? "In progress"
                : "Result details unavailable"}
            </p>
          ) : null}
          <OriginalOutput part={part} />
        </div>
      ) : null}
    </div>
  );
}

/** Consecutive web activity only; expansion preserves call order and outcomes. */
export function WebWorkGroup({ rows }: { rows: readonly Extract<BundleRow, { kind: "tool" }>[] }) {
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
              <bdi dir="ltr" className="truncate">
                {name}
              </bdi>
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
            <PresentedToolRow key={row.key} part={row.part} presentation={models[index]!} />
          ))
        : null}
    </div>
  );
}
