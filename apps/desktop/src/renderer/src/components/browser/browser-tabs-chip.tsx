/**
 * The one place a person sees every tab a chat's Sessions hold (VC-238 §8).
 *
 * Headless tabs are in no strip, so without this they would be invisible: a
 * fleet of agent tabs nobody asked to see, and nobody could close. The chip
 * says `2 tabs` and only exists while the count is non-zero; it opens an
 * inventory of this Session's and its children's tabs — title, URL, owner —
 * with Show and Close per row and one Close all.
 *
 * Show pins a tab as the chat's preview; a tab already on screen offers Hide.
 * Every action is a request to main, and a refusal is a toast. The popover is a
 * Radix portal, so opening it over a previewed tab freezes that plane onto
 * pixels for as long as it is open — the same rule every menu obeys.
 */
import * as React from "react";
import { errorMessage } from "@volli/shared";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";

import type { BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { BrowserTabMark } from "@renderer/components/browser/browser-tab-mark";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { toastError } from "@renderer/lib/toast";
import { browserTabDisplayTitle, browserTabOwnerLabel } from "@renderer/stores/browser-tabs";
import { cn } from "@renderer/lib/utils";

export function BrowserTabsChip({
  tabs,
  api,
  sessionId,
  sessionTitle,
  className,
}: {
  tabs: readonly BrowserTabState[];
  api: BrowserApi;
  sessionId: string;
  sessionTitle(sessionId: string): string | null;
  className?: string;
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
  if (tabs.length === 0) return null;
  const label = `${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Browser Tabs: ${label}`}
          data-browser-tabs-chip={tabs.length}
          className={cn("gap-1.5 px-1.5 tabular-nums text-muted-foreground", className)}
        >
          <BrowserIcon aria-hidden weight="bold" className="size-3" />
          <span>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-80 p-2">
        <ul className="flex flex-col gap-1" aria-label="Browser Tabs this chat holds">
          {tabs.map((tab) => (
            <li
              key={tab.tabId}
              className="flex items-center gap-2 text-ui"
              data-browser-inventory-tab={tab.tabId}
            >
              <BrowserTabMark driven />
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground">{browserTabDisplayTitle(tab)}</div>
                <div className="truncate font-mono text-muted-foreground">
                  {tab.url}
                  <span className="text-muted-foreground/60">
                    {" · "}
                    {browserTabOwnerLabel(tab, sessionId, sessionTitle)}
                  </span>
                </div>
              </div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void request(
                    api.setPresentation({
                      tabId: tab.tabId,
                      presentation: tab.presentation === "headless" ? "preview" : "headless",
                    }),
                    tab.presentation === "headless" ? "show Browser Tab" : "hide Browser Tab",
                  )
                }
              >
                {tab.presentation === "headless" ? "Show" : "Hide"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void request(api.close({ tabId: tab.tabId }), "close Browser Tab")}
              >
                Close
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex justify-end border-t border-border/50 pt-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              for (const tab of tabs) {
                void request(api.close({ tabId: tab.tabId }), "close Browser Tab");
              }
            }}
          >
            Close all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
