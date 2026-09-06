/**
 * The tab card under a browse row (VC-238): what one browser action touched,
 * as it stands now.
 *
 * The transcript is durable and the tab is not, so the card is drawn from two
 * sources that agree on the tab id: the row's facet (what the tool reported —
 * URL, title, target, picture, refusal) and the live registry (`useBrowserTabsStore`,
 * fed by `volli:browser-tab-state`). While the tab lives the live record wins
 * for URL, title, loading and error; once it is gone the card says so and
 * keeps the facet's last facts, so a reopened chat still reads.
 *
 * The person decides where a tab is drawn — Show pins it above this chat's
 * composer, Open as tab promotes it into the strip, Hide returns it to
 * headless — and the model never can. Every action here is a request to main
 * through the same preload bridge the Browser pane uses; main answers with a
 * state push, and a refused request is a toast, like every failed mutation.
 *
 * Pictures come by id. The bytes stay in main; one IPC read per id, cached
 * here so a transcript of forty rows does not ask forty times per repaint.
 */
import * as React from "react";
import { errorMessage, type ActivityBrowse } from "@volli/shared";
import { SpinnerGapIcon } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";

import type { BrowserTabPresentation, BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { BrowserTabMark } from "@renderer/components/browser/browser-tab-mark";
import { Button } from "@renderer/components/ui/button";
import { toastError } from "@renderer/lib/toast";
import {
  browserTabDisplayTitle,
  browserTabOwnerLabel,
  useBrowserTabsStore,
} from "@renderer/stores/browser-tabs";
import { cn } from "@renderer/lib/utils";

/** What a card needs from the chat around it; absent (the lab) draws facts alone. */
export interface BrowserCardHost {
  sessionId: string;
  api: BrowserApi;
  /** A Session's title by id, for naming a child that drives a tab. Null when unknown. */
  sessionTitle(sessionId: string): string | null;
}

export const BrowserCardHostContext = React.createContext<BrowserCardHost | null>(null);

/* ---------------------------------------------------------------- pictures */

type PictureState = { kind: "loading" } | { kind: "ready"; dataUrl: string } | { kind: "gone" };

/** Ids already asked for, whatever main said; bounded so a long Session does not hoard frames. */
const PICTURES = new Map<string, Promise<string | null>>();
const PICTURE_CACHE_LIMIT = 64;

/** Test seam: forget every cached picture. */
export function forgetBrowserPictures(): void {
  PICTURES.clear();
}

function pictureOf(api: BrowserApi, pictureId: string): Promise<string | null> {
  const cached = PICTURES.get(pictureId);
  if (cached !== undefined) return cached;
  const pending = api
    .picture({ pictureId })
    .then((result) => (result.ok ? result.dataUrl : null))
    .catch(() => null);
  PICTURES.set(pictureId, pending);
  while (PICTURES.size > PICTURE_CACHE_LIMIT) {
    const oldest = PICTURES.keys().next().value;
    if (oldest === undefined) break;
    PICTURES.delete(oldest);
  }
  return pending;
}

export function useBrowserPicture(api: BrowserApi | null, pictureId: string | null): PictureState {
  const [state, setState] = React.useState<PictureState>({ kind: "loading" });
  React.useEffect(() => {
    if (api === null || pictureId === null) {
      setState({ kind: "gone" });
      return;
    }
    let live = true;
    setState({ kind: "loading" });
    void pictureOf(api, pictureId).then((dataUrl) => {
      if (!live) return;
      setState(dataUrl === null ? { kind: "gone" } : { kind: "ready", dataUrl });
    });
    return () => {
      live = false;
    };
  }, [api, pictureId]);
  return state;
}

/* -------------------------------------------------------------------- card */

/** `example.com/path` for the card's address line, or the raw text when it does not parse. */
function displayUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

export function BrowserTabCard({
  facet,
  note,
}: {
  facet: ActivityBrowse;
  /** Volli's words for a refusal — the tool's own summary — shown beside the rule. */
  note: string | null;
}) {
  const host = React.useContext(BrowserCardHostContext);
  const live = useBrowserTabsStore((state) =>
    facet.tabId === null ? undefined : state.byId[facet.tabId],
  );
  const picture = useBrowserPicture(host?.api ?? null, facet.picture);

  const title = live !== undefined ? browserTabDisplayTitle(live) : facet.title;
  const url = displayUrl(live?.url ?? facet.url);
  // The live record while the tab exists; the transcript's own memory after —
  // which the port stamps into the facet, so a closed agent tab still reads as
  // the Session's rather than falling back to the person's.
  const owner =
    host === null
      ? null
      : browserTabOwnerLabel(
          live ?? { ownerSessionId: facet.ownerSessionId },
          host.sessionId,
          host.sessionTitle,
        );
  const driven = (live?.ownerSessionId ?? facet.ownerSessionId) !== null;

  const request = React.useCallback(
    async (operation: Promise<{ ok: true } | { ok: false; error: string }>, label: string) => {
      try {
        const result = await operation;
        if (!result.ok) toastError(`Could not ${label}: ${result.error}`);
      } catch (reason) {
        toastError(`Could not ${label}: ${errorMessage(reason)}`);
      }
    },
    [],
  );
  const present = (presentation: BrowserTabPresentation, label: string) => {
    if (host === null || live === undefined) return;
    void request(host.api.setPresentation({ tabId: live.tabId, presentation }), label);
  };

  return (
    <div
      data-browser-tab-card={facet.tabId ?? undefined}
      className="my-1 flex flex-col gap-2 rounded-md border border-border/50 bg-muted/30 p-2 text-ui"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BrowserTabMark driven={driven} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-foreground">{title ?? url ?? "Browser Tab"}</div>
          {url !== null ? (
            <div className="truncate font-mono text-muted-foreground">{url}</div>
          ) : null}
        </div>
        <TabStatus live={live} facet={facet} />
      </div>
      {owner !== null ? (
        <div className="text-muted-foreground">
          Driven by <span className="text-foreground">{owner}</span>
        </div>
      ) : null}
      {facet.refusal !== null ? (
        <div className="flex items-start gap-1 text-destructive">
          <WarningCircleIcon aria-hidden weight="fill" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Refused by <span className="font-mono">{facet.refusal}</span>
            {note !== null ? <span className="text-muted-foreground"> · {note}</span> : null}
          </span>
        </div>
      ) : null}
      {facet.picture !== null ? <Picture state={picture} /> : null}
      {host !== null && live !== undefined ? (
        <div className="flex flex-wrap items-center gap-1">
          {live.createdBy === "session" ? (
            live.presentation === "headless" ? (
              <>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => present("preview", "show Browser Tab")}
                >
                  Show
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => present("tab", "open Browser Tab")}
                >
                  Open as tab
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => present("headless", "hide Browser Tab")}
                >
                  Hide
                </Button>
                {live.presentation === "preview" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => present("tab", "open Browser Tab")}
                  >
                    Open as tab
                  </Button>
                ) : null}
              </>
            )
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => void request(host.api.close({ tabId: live.tabId }), "close Browser Tab")}
          >
            Close
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live: loading, a load failure, or nothing. Gone: that it is gone, and still
 * whatever went wrong while it was here — the transcript is durable and the
 * tab is not, so a page that failed to load must not become a clean row the
 * moment the tab closes (§9).
 */
function TabStatus({ live, facet }: { live: BrowserTabState | undefined; facet: ActivityBrowse }) {
  if (live === undefined) {
    if (facet.tabId === null) return null;
    return (
      <span className="flex min-w-0 shrink-0 items-center gap-1 text-muted-foreground">
        {facet.error === null ? null : <PageError error={facet.error} />}
        <span className="shrink-0">Tab closed</span>
      </span>
    );
  }
  if (live.error !== null) return <PageError error={live.error} />;
  if (live.loading) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        <SpinnerGapIcon aria-hidden className="size-3.5 animate-spin text-primary" />
        Loading
      </span>
    );
  }
  return null;
}

/** The page's trouble in Volli's words — the host wrote this string, never the page. */
function PageError({ error }: { error: string }) {
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1 text-destructive" title={error}>
      <WarningCircleIcon aria-hidden weight="fill" className="size-3.5 shrink-0" />
      <span className="max-w-48 truncate">{error}</span>
    </span>
  );
}

function Picture({ state }: { state: PictureState }) {
  if (state.kind === "loading") {
    return <div className="h-24 animate-pulse rounded-sm bg-muted/50" aria-hidden />;
  }
  if (state.kind === "gone") {
    return <div className="text-muted-foreground/70">Picture unavailable</div>;
  }
  return (
    <img
      alt="The page as the agent left it"
      src={state.dataUrl}
      draggable={false}
      className={cn("max-h-64 w-full rounded-sm border border-border/50 object-contain object-top")}
    />
  );
}
