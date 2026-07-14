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
}

/** Purely presentational tab strip — content lives in the caller. */
export function TicketTabStrip({ tabs, activeTabId, onSelectTab }: TicketTabStripProps) {
  return (
    <div role="tablist" className="flex items-center gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === activeTabId}
          onClick={() => onSelectTab(tab.id)}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground",
            tab.id === activeTabId ? "border-primary text-foreground" : "border-transparent",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
