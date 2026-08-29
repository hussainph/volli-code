import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";
import type { BrowserTabState } from "../../../../ipc/contract";

export interface BrowserChromeProps {
  tab: BrowserTabState;
  address: string;
  error: string | null;
  onAddressChange(value: string): void;
  onNavigate(url: string): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onOpenDevTools(): void;
}

/** Renderer-owned controls for a main-owned Browser Tab native surface. */
export function BrowserChrome({
  tab,
  address,
  error,
  onAddressChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onOpenDevTools,
}: BrowserChromeProps) {
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
            const target = address.trim();
            if (target.length > 0) onNavigate(target);
          }}
        >
          <Input
            aria-label="Address"
            value={address}
            onChange={(event) => onAddressChange(event.currentTarget.value)}
            className="h-6 bg-background px-3 font-mono shadow-none"
            spellCheck={false}
          />
        </form>
        <span className="max-w-48 truncate px-2 text-ui text-muted-foreground" title={tab.title}>
          {tab.title || tab.url}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open DevTools"
          title="Open DevTools"
          onClick={onOpenDevTools}
        >
          <CodeIcon />
        </Button>
      </div>
      {error !== null ? (
        <div
          role="alert"
          className="border-t border-destructive/30 px-3 py-1 text-ui text-destructive"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
