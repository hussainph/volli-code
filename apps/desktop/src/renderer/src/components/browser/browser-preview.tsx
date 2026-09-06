/**
 * The pinned live view of a Session's tab, above the owning chat's composer
 * (VC-238's option (a)).
 *
 * It is the same `BrowserPane` the workspace strip draws — same chrome, same
 * `BrowserPlaneController`, same overlay-freeze path — inside a fixed-height
 * frame that does not scroll with the transcript. That is what makes a live
 * native view possible here at all: a WebContentsView cannot be clipped by the
 * chat's scroll area, so the one place it can sit is the one place that does
 * not move. Because it is the same pane, a menu or dialog over the chat
 * detaches this plane onto frozen pixels exactly as it does for a strip tab.
 *
 * The header says who is driving it, and offers the three things a person can
 * do about it: hide it again, open it as a strip tab, or close it. Nothing here
 * changes what the agent sees — the tab, its generation and its cookies are
 * what they were; the person can also click in it, and a ref the agent minted
 * before they navigated refuses on its own.
 */
import * as React from "react";
import { errorMessage } from "@volli/shared";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import type { BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { BrowserPane } from "@renderer/components/browser/browser-pane";
import { BrowserTabMark } from "@renderer/components/browser/browser-tab-mark";
import { Button } from "@renderer/components/ui/button";
import { toastError } from "@renderer/lib/toast";
import { browserTabDisplayTitle, useBrowserTabsStore } from "@renderer/stores/browser-tabs";

/**
 * How tall the pinned pane is. Fixed rather than proportional: the transcript
 * pads itself by the measured composer block, and a pane whose height chased
 * the window would move the reader's last line on every resize.
 */
export const BROWSER_PREVIEW_HEIGHT_CLASS = "h-72";

export function BrowserPreview({
  tab,
  api,
  ownerLabel,
  visible,
}: {
  tab: BrowserTabState;
  api: BrowserApi;
  /** Who is driving it, in the chat's words: "this Session" or a child's title. */
  ownerLabel: string;
  /** Whether the chat around it is on screen; a hidden chat detaches the plane. */
  visible: boolean;
}) {
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
  return (
    <div
      data-browser-preview={tab.tabId}
      className="pointer-events-auto mb-2 flex flex-col overflow-hidden rounded-lg border border-border/60 bg-background shadow-raised"
    >
      <div className="flex h-7 items-center gap-2 border-b border-border/50 px-2 text-ui">
        <BrowserTabMark driven />
        <span className="min-w-0 flex-1 truncate text-foreground" title={browserTabDisplayTitle(tab)}>
          {browserTabDisplayTitle(tab)}
        </span>
        <span className="shrink-0 truncate text-muted-foreground">Driven by {ownerLabel}</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void request(
              api.setPresentation({ tabId: tab.tabId, presentation: "tab" }),
              "open Browser Tab",
            )
          }
        >
          Open as tab
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void request(
              api.setPresentation({ tabId: tab.tabId, presentation: "headless" }),
              "hide Browser Tab",
            )
          }
        >
          Hide
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close Browser Tab"
          onClick={() => void request(api.close({ tabId: tab.tabId }), "close Browser Tab")}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      <div className={`flex min-h-0 flex-col ${BROWSER_PREVIEW_HEIGHT_CLASS}`}>
        <BrowserPane
          key={tab.tabId}
          tab={tab}
          visible={visible}
          api={api}
          onTabState={useBrowserTabsStore.getState().receive}
        />
      </div>
    </div>
  );
}
