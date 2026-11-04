import type * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowSquareInIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareIn";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";

import type { BrowserTabHolder } from "@volli/shared";

import { BrowserHolderPill } from "@renderer/components/browser/browser-holder-pill";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { browserTabDisplayTitle } from "@renderer/stores/browser-tabs";
import type { BrowserTabState } from "../../../../ipc/contract";

/** Turns browser-style address input into an absolute product target. */
export function normalizeBrowserAddress(raw: string): string {
  const target = raw.trim();
  if (target === "") return "";
  if (target.startsWith("//")) return `https:${target}`;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(target)) {
    return `http://${target}`;
  }
  // Keep explicit schemes intact, including ones main will deliberately
  // refuse. Renderer normalization must never turn `file:` or `javascript:`
  // into an apparently safe HTTPS hostname.
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return target;
  return `https://${target}`;
}

/** The chrome's name for sending a Session's tab back to its Activity Island. */
const HIDE_TO_ISLAND_LABEL = "Hide to Island";

export interface BrowserChromeProps {
  tab: BrowserTabState;
  address: string;
  /**
   * Handle on the address input, so the pane that knows a tab is blank can put
   * the caret there. The aiming lives in the pane rather than here because this
   * component is deliberately hook-free — its tests call it as a plain function
   * to reach the handlers.
   */
  addressRef?: React.Ref<HTMLInputElement>;
  error: string | null;
  /**
   * Who holds the tab (VC-239), or null for a free tab. Present only while
   * someone does: the address row carries the hold indicator and the
   * person's Take over / Ask to leave / Hand back controls.
   */
  holder?: BrowserTabHolder | null;
  onAddressChange(value: string): void;
  onNavigate(url: string): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onToggleDevTools(): void;
  /**
   * Sends a Session's tab back to its Activity Island (VC-1118). Present only
   * for a tab that can go there; absent, the control is not drawn, which is
   * how a person's own tab keeps the chrome it always had.
   */
  onHide?(): void;
  onTakeOver?(): void;
  onAskToLeave?(): void;
  onHandBack?(): void;
}

/** Renderer-owned controls for a main-owned Browser Tab native surface. */
export function BrowserChrome({
  tab,
  address,
  addressRef,
  error,
  holder = null,
  onAddressChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onToggleDevTools,
  onHide,
  onTakeOver,
  onAskToLeave,
  onHandBack,
}: BrowserChromeProps) {
  const displayTitle = browserTabDisplayTitle(tab);
  return (
    // Keep narrow-pane overflow local to the toolbar, never the native plane.
    <div
      data-slot="browser-chrome"
      data-direction="classic"
      aria-label={displayTitle}
      className="min-w-0 shrink-0 border-b border-border bg-background"
    >
      <div
        data-slot="browser-address-row"
        className="flex h-control-default min-w-0 items-center gap-0.5 overflow-x-auto px-1"
      >
        <Button
          type="button"
          variant="toolbar"
          size="icon-sm"
          aria-label="Back"
          disabled={!tab.canGoBack}
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          type="button"
          variant="toolbar"
          size="icon-sm"
          aria-label="Forward"
          disabled={!tab.canGoForward}
          onClick={onForward}
        >
          <ArrowRightIcon />
        </Button>
        <Button
          type="button"
          variant="toolbar"
          size="icon-sm"
          aria-label="Reload"
          onClick={onReload}
        >
          {tab.loading ? <Spinner className="size-3.5" /> : <ArrowClockwiseIcon />}
        </Button>
        <form
          className="min-w-12 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            const target = normalizeBrowserAddress(address);
            if (target.length > 0) onNavigate(target);
          }}
        >
          <Input
            ref={addressRef}
            aria-label="Address"
            placeholder="Enter a URL"
            value={address}
            onChange={(event) => onAddressChange(event.currentTarget.value)}
            variant="search"
            className="h-control-xs min-w-0 bg-card px-2 text-ui"
            spellCheck={false}
          />
        </form>
        {holder !== null ? (
          <BrowserHolderPill
            holder={holder}
            onTakeOver={() => onTakeOver?.()}
            onAskToLeave={() => onAskToLeave?.()}
            onHandBack={() => onHandBack?.()}
          />
        ) : null}
        <Button
          type="button"
          variant="toolbar"
          size="icon-sm"
          aria-label="Toggle DevTools"
          title="Toggle DevTools"
          onClick={onToggleDevTools}
        >
          <CodeIcon />
        </Button>
        {onHide !== undefined ? (
          // The Island's own pair: its rows reveal with ArrowSquareOut, and
          // this is the way back in.
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="toolbar"
                  size="icon-sm"
                  aria-label={HIDE_TO_ISLAND_LABEL}
                  onClick={onHide}
                >
                  <ArrowSquareInIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{HIDE_TO_ISLAND_LABEL}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {error !== null ? (
        <div
          role="alert"
          className="border-t border-destructive/30 px-4 py-1 text-ui text-destructive"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
