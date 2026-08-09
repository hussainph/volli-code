/**
 * The app's chat surface, driven over the lab's HTTP edge.
 *
 * Everything on screen is the shipped component — the tab strip, the plane, the
 * composer, the cards. What the lab supplies is only what the app cannot: a
 * transport that is not Session IPC, and a scripted harness profile so a state
 * OpenCode raises when it feels like it can be put on screen on purpose.
 *
 * A scenario is an EXECUTOR, not a mode. It rides `createChatSession` as an
 * adapter/profile pair the runtime already validates, which is why nothing below
 * the shell knows one exists.
 */
import * as React from "react";

import { racingFlushScheduler } from "@renderer/chat/client";
import { AppShell } from "@renderer/components/app-shell";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import {
  chatTabId,
  chatTabStatus,
  CHAT_TAB_FALLBACK_LABEL,
} from "@renderer/components/ticket/ticket-chat-tab";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

import { LAB_SCENARIO_ADAPTER_ID } from "../../../lab-scenarios";
import { LAB_SESSION_PROJECT_ID, LAB_SESSION_TICKET_ID } from "../../../lab-session-rpc-path";
import { LabScenarioPicker } from "../chat/scenario-picker";
import { LabModelAccessProvider } from "../model-access-client";
import { createSessionRpcClient } from "../session-rpc-client";
import { appApi, seedApp } from "../seed";

export const title = "Ticket chat · OpenCode";
export const note = "The app's chat Session surface over the lab's HTTP edge";
export const viewport = "window" as const;
export const seed = seedApp;
export const api = appApi;

export default function ChatSessionScratch() {
  return (
    <LabModelAccessProvider>
      <AppShell mainContent={<LabChatMain />} />
    </LabModelAccessProvider>
  );
}

/** Keeps the Session alive while Settings takes over the canvas. */
function LabChatMain() {
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const [scenario, setScenario] = React.useState<string | null>(null);

  return (
    <>
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", settingsOpen && "hidden")}>
        {/* Keyed on the pick so a scenario gets a Session of its own rather than
            a second attachment on the last one's history. */}
        <LabChatSession key={scenario ?? "live"} scenarioId={scenario} />
      </div>
      {settingsOpen ? <SettingsPage initialCategoryKey="harness" /> : null}
      <LabScenarioPicker value={scenario} onChange={setScenario} />
    </>
  );
}

function LabChatSession({ scenarioId }: { scenarioId: string | null }) {
  // One store per mount, over one client. The app's singleton reaches for
  // `window.api.sessionRpc`, which the lab does not have and must not fake: the
  // point of this surface is the real components, not a second transport.
  const store = React.useMemo(() => {
    const rpc = createSessionRpcClient();
    const executor = labExecutor(scenarioId);
    return createChatSessionsStore(() => ({
      rpc,
      scheduler: racingFlushScheduler(window),
      newCommandId: () => crypto.randomUUID(),
      startSession: async (input) => {
        const created = await rpc.session.command.mutate({
          commandId: input.operationId,
          command: {
            kind: "session.create",
            projectId: input.projectId,
            ticketId: input.ticketId,
            title: input.title,
          },
        });
        return attachLabSession(rpc, created.sessionId, crypto.randomUUID(), executor);
      },
      attachSession: (input) => attachLabSession(rpc, input.sessionId, input.operationId, executor),
    }));
  }, [scenarioId]);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void store
      .getState()
      .createChatSession({
        projectId: LAB_SESSION_PROJECT_ID,
        ticketId: LAB_SESSION_TICKET_ID,
        title: "Chat 1",
      })
      .then(setSessionId);
  }, [scenarioId, store]);

  React.useEffect(() => {
    if (sessionId === null) return;
    return () => store.getState().closeChatSession(sessionId);
  }, [sessionId, store]);

  const label = useLabChatTitle(store, sessionId);
  const status = useLabChatStatus(store, sessionId);
  const tabs: TicketTabDescriptor[] =
    sessionId === null ? [] : [{ id: chatTabId(sessionId), kind: "chat", label, status }];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TicketTabStrip
        tabs={tabs}
        activeTabId={sessionId === null ? "" : chatTabId(sessionId)}
        creating={sessionId === null}
        // The lab hosts exactly one Session, and the scenario picker is how you
        // get another. Every control that would mint or retire a tab is a no-op
        // rather than a second tab model living here.
        onSelectTab={() => undefined}
        onCloseTab={() => undefined}
        onRenameSessionTab={() => undefined}
        onNewSession={() => undefined}
        onNewChat={() => undefined}
        canFocusTerminal={false}
        onEnterTerminalFocus={() => undefined}
      />
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {sessionId === null ? null : (
          <ChatPlane
            sessionId={sessionId}
            projectId={LAB_SESSION_PROJECT_ID}
            store={store}
            onOpenFile={() => undefined}
          />
        )}
      </main>
    </div>
  );
}

type LabChatStore = ReturnType<typeof createChatSessionsStore>;

function useLabChatTitle(store: LabChatStore, sessionId: string | null): string {
  return store((state) =>
    sessionId === null
      ? CHAT_TAB_FALLBACK_LABEL
      : (state.sessions[sessionId]?.projection?.session.title ?? CHAT_TAB_FALLBACK_LABEL),
  );
}

function useLabChatStatus(store: LabChatStore, sessionId: string | null) {
  return store((state) =>
    chatTabStatus(sessionId === null ? undefined : state.sessions[sessionId]?.lifecycle),
  );
}

function labExecutor(scenarioId: string | null): { adapterId: string; profileId: string } {
  return scenarioId === null
    ? { adapterId: "opencode", profileId: "native" }
    : { adapterId: LAB_SCENARIO_ADAPTER_ID, profileId: scenarioId };
}

async function attachLabSession(
  rpc: ReturnType<typeof createSessionRpcClient>,
  sessionId: string,
  commandId: string,
  executor: { adapterId: string; profileId: string },
) {
  const attached = await rpc.session.command.mutate({
    commandId,
    sessionId,
    command: { kind: "adapter.attach", ...executor, continuity: "fresh" },
  });
  return {
    sessionId,
    state:
      attached.receipt?.status === "rejected" ? ("needs-recovery" as const) : ("ready" as const),
    receipt: attached.receipt,
    throughSequence: attached.throughSequence,
  };
}
