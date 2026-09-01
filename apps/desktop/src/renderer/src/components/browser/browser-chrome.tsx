import type * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";
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
  onAddressChange(value: string): void;
  onNavigate(url: string): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onToggleDevTools(): void;
}

/** Renderer-owned controls for a main-owned Browser Tab native surface. */
export function BrowserChrome({
  tab,
  address,
  addressRef,
  error,
  onAddressChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onToggleDevTools,
}: BrowserChromeProps) {
  const displayTitle = browserTabDisplayTitle(tab);
  return (
    <div className="shrink-0 border-b border-border bg-rail">
      <div className="flex h-9 items-center gap-1 px-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!tab.canGoBack}
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!tab.canGoForward}
          onClick={onForward}
        >
          <ArrowRightIcon />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Reload" onClick={onReload}>
          {tab.loading ? <Spinner className="size-3.5" /> : <ArrowClockwiseIcon />}
        </Button>
        <form
          className="min-w-0 flex-1"
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
            className="bg-background font-mono shadow-none"
            spellCheck={false}
          />
        </form>
        <span className="max-w-48 truncate px-2 text-ui text-muted-foreground" title={displayTitle}>
          {displayTitle}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Toggle DevTools"
          title="Toggle DevTools"
          onClick={onToggleDevTools}
        >
          <CodeIcon />
        </Button>
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
