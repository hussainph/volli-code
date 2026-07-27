/**
 * The window chrome band — the real `ChromeBar`, with switches for every state
 * that changes it.
 *
 * The band is the app's hardest surface to iterate on, because almost nothing
 * about it is reachable from a static render. Its controls appear and disappear
 * on app state (a ticket open, a terminal focused), and its geometry moves on
 * *window* state (fullscreen hides the traffic lights, so the 78px spacer
 * collapses and everything slides left over 300ms). In the app you would have
 * to open a ticket, start an agent, and hit ⌃⌘F to see all of that; here it is
 * five switches.
 *
 * The switches drive the REAL stores, not props — `ChromeBar` takes none. So
 * what you are watching is the same state transition the app performs, at the
 * same speed, including the eased spacer collapse.
 *
 * One deliberate cheat, and it is the interesting one: fullscreen is not store
 * state. `useFullScreen` seeds itself from the bridge and then listens for
 * pushes from main. So the stub below CAPTURES main's push callback and the
 * switch calls it — which is exactly the path the real main process uses, so
 * the transition is real even though the window never moves.
 */
import * as React from "react";

import { ChromeBar } from "@renderer/components/chrome-bar";
import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { Switch } from "@renderer/components/ui/switch";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

import { project, ticketById } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Chrome band";
export const note = "The 40px window band — every state that changes it, on a switch";

export const seed = seedApp;

/**
 * Main's fullscreen push, captured from the subscription the band sets up on
 * mount. `null` whenever the band is unmounted, which is also when nothing can
 * legitimately be pushed to it.
 */
let pushFullScreen: ((fullScreen: boolean) => void) | null = null;

export const api = {
  ...appApi,
  window: {
    ...(appApi["window"] as object),
    onFullScreenChange: (callback: (fullScreen: boolean) => void): (() => void) => {
      pushFullScreen = callback;
      return () => {
        pushFullScreen = null;
      };
    },
  },
};

const FOCUS_TARGET = {
  projectId: project.id,
  ticketId: "tkt-14",
  sessionId: "ses-14a",
};

/** The band's right-rail toggle only exists while a ticket is open. */
function setOpenTicket(open: boolean): void {
  useWorkspaceStore.setState({
    byProject: {
      [project.id]: {
        ...DEFAULT_WORKSPACE_UI,
        nav: "board",
        openTicketId: open ? ticketById("tkt-14").id : null,
      },
    },
  });
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className="flex items-start gap-3">
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="text-ui text-foreground">{label}</span>
        <span className="text-label text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

export default function ChromeScratch() {
  const workspaceRailHidden = useUiStore((state) => state.workspaceRailHidden);
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const terminalFocused = useUiStore((state) => state.terminalFocusTarget !== null);
  const openTicketId = useWorkspaceStore(
    (state) => state.byProject[project.id]?.openTicketId ?? null,
  );
  // Not derived from a store: the window's own state has no renderer-side
  // record, so the switch owns it and pushes it the way main would.
  const [fullScreen, setFullScreen] = React.useState(false);

  return (
    <div className="flex flex-col gap-6">
      {/* The band is `shrink-0` inside a column and positions its ⌘K pill
          against its own width, so it needs a real window-width host to be
          judged in — not the intrinsic width it would take on its own. The
          provider is required, not decorative: the band's sidebar toggle is a
          real `SidebarTrigger` and reads `useSidebar()`. */}
      <SidebarProvider className="min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-rail">
        <ChromeBar />
        <div className="flex h-40 items-center justify-center border-t border-border/60 bg-background">
          <p className="text-label text-muted-foreground">
            content area — the band owns the 40px above this line
          </p>
        </div>
      </SidebarProvider>

      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
        <Toggle
          label="Fullscreen"
          hint="Traffic lights hide, so the 78px spacer collapses (300ms)"
          checked={fullScreen}
          onChange={(next) => {
            setFullScreen(next);
            pushFullScreen?.(next);
          }}
        />
        <Toggle
          label="Ticket open"
          hint="Reveals the right-rail toggle at the band's right edge"
          checked={openTicketId !== null}
          onChange={setOpenTicket}
        />
        <Toggle
          label="Terminal focus"
          hint="Replaces all navigation with the breadcrumb + exit control"
          checked={terminalFocused}
          onChange={(next) =>
            useUiStore.getState().setTerminalFocusTarget(next ? FOCUS_TARGET : null)
          }
        />
        <Toggle
          label="Workspace rail hidden"
          hint="Presses the leftmost toggle — the rail's own visibility"
          checked={workspaceRailHidden}
          onChange={(next) => useUiStore.getState().setWorkspaceRailHidden(next)}
        />
        <Toggle
          label="Details rail collapsed"
          hint="Only visible while a ticket is open"
          checked={railCollapsed}
          onChange={(next) => useUiStore.getState().setRailCollapsed(next)}
        />
      </div>

      <p className="text-label text-muted-foreground">
        The band is a drag region in the app; here it is inert. Traffic lights are drawn by macOS,
        so the spacer holds room for lights that aren&apos;t there — that gap is the thing to judge,
        not the emptiness in it.
      </p>
    </div>
  );
}
