/**
 * The ticket detail's tab plane (ticket-detail-mvp decision #6): `Doc |
 * Artifacts | <session tabs…>`, all sharing one plane inside the ticket view
 * — the docking point for future split view and an embedded preview browser.
 * Data-driven by design: `TicketTabDescriptor` is the one shape a tab needs
 * to render in the strip, so step 6 can append one `"session"`-kind
 * descriptor per linked terminal session (id = session id) to the array
 * ticket-detail.tsx builds, with zero changes to this file. Content routing
 * stays with the caller (ticket-detail.tsx), keyed off each tab's `kind`.
 */
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { cn } from "@renderer/lib/utils";

export type TicketTabKind = "doc" | "artifacts" | "session";

export interface TicketTabDescriptor {
  /** Stable tab identity — a session tab's id is its session id. */
  id: string;
  kind: TicketTabKind;
  label: string;
}

interface TicketTabStripProps {
  tabs: readonly TicketTabDescriptor[];
  activeTabId: string;
  onSelectTab(tabId: string): void;
  /** Closes a session tab (kill-on-close). Only session tabs render the close affordance. */
  onCloseSessionTab(tabId: string): void;
}

/** Purely presentational tab strip — content lives in the caller. */
export function TicketTabStrip({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseSessionTab,
}: TicketTabStripProps) {
  return (
    <div role="tablist" className="flex items-center gap-1 border-b border-border">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={cn(
              "group -mb-px flex items-center border-b-2 transition-colors duration-150 ease-out",
              active ? "border-primary" : "border-transparent",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelectTab(tab.id)}
              className={cn(
                "py-2 pl-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground",
                active && "text-foreground",
                tab.kind === "session" ? "pr-1.5" : "pr-3",
              )}
            >
              {tab.label}
            </button>
            {tab.kind === "session" ? (
              <button
                type="button"
                aria-label={`Close ${tab.label}`}
                onClick={() => onCloseSessionTab(tab.id)}
                className="mr-1.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-border hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
