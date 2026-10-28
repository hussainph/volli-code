/** The Session-side twin of the cloud board binding. Installed only in a cloud launch. */
import type { CloudListingRow, CloudSessionRow } from "./cloud-session-listing";
import { followCloudSession } from "./cloud-client";
import { bindCloudPlaces, forgetProjectPlaces, noteProjectPlaces } from "./cloud-places";
import { sessionRpcClient } from "./session-rpc-ipc-link";
import { CloudSessionSource } from "./cloud-session-source";
import type { SessionListingReader } from "./session-listing-reader";
import { useProjectsStore } from "@renderer/stores/projects";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

let source: CloudSessionSource | null = null;

function paint(
  projectId: string,
  rows: CloudListingRow[],
  sent: readonly CloudSessionRow[] | null = null,
): void {
  if (sent === null) forgetProjectPlaces(projectId);
  else noteProjectPlaces(projectId, sent);
  const chat = rows.map((row) => row.record);
  // Workspace switches retire clients, but keep tab intent. Re-adopt only
  // Sessions the new scope's live listing actually authorizes, never cached ids.
  const chats = useChatSessionsStore.getState();
  const open = new Set(Object.values(chats.openTabs).flat());
  for (const row of chat) {
    if (open.has(row.sessionId)) chats.adoptChatSession(row.sessionId, projectId);
  }
  const provenance = Object.fromEntries(
    rows.flatMap((row) =>
      row.provenance.kind !== "user" ? [[row.record.sessionId, row.provenance]] : [],
    ),
  );
  useProjectSessionsStore.setState((state) => ({
    byProject: { ...state.byProject, [projectId]: { terminal: [], chat, provenance, read: {} } },
    listingState: { ...state.listingState, [projectId]: "loaded" },
  }));
  const tickets = new Set([
    ...rows.flatMap((row) => (row.record.ticketId === null ? [] : [row.record.ticketId])),
    ...Object.keys(useTicketSessionRecordsStore.getState().byTicket).filter((id) =>
      useTicketSessionRecordsStore
        .getState()
        .byTicket[id]?.some((row) => row.record.projectId === projectId),
    ),
  ]);
  useTicketSessionRecordsStore.setState((state) => ({
    byTicket: {
      ...state.byTicket,
      ...Object.fromEntries(
        [...tickets].map((id) => [id, rows.filter((row) => row.record.ticketId === id)]),
      ),
    },
    listingState: {
      ...state.listingState,
      ...Object.fromEntries([...tickets].map((id) => [id, "loaded" as const])),
    },
    listingError: {
      ...state.listingError,
      ...Object.fromEntries([...tickets].map((id) => [id, null])),
    },
  }));
}

/** A cloud launch never hands a Session id to the local SQLite listing door. */
export function cloudSessionReader(projectId: string | null): SessionListingReader {
  const read = async (ticketId?: string) => {
    if (source === null || projectId === null)
      return { ok: false as const, error: "Cloud sessions are not connected yet" };
    const inWorkspace = () => useProjectsStore.getState().projects.some((p) => p.id === projectId);
    if (!inWorkspace())
      return { ok: false as const, error: "The project is not in this Workspace." };
    const reading = source;
    try {
      const rows = await reading.open(projectId);
      if (source !== reading || !inWorkspace())
        return { ok: false as const, error: "The Workspace changed." };
      return {
        ok: true as const,
        sessions:
          ticketId === undefined ? rows : rows.filter((row) => row.record.ticketId === ticketId),
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };
  return { list: () => read(), listForTicket: ({ ticketId }) => read(ticketId) };
}

/** Boot owns this follower; teardown removes every query and clears cloud rows. */
export function bindCloudSessions(): () => void {
  let followed = new Set<string>();
  const sync = () => {
    const projects = new Set(useProjectsStore.getState().projects.map((project) => project.id));
    for (const id of followed)
      if (!projects.has(id)) {
        source?.close(id);
        paint(id, []);
      }
    followed = projects;
    for (const id of projects) void source?.open(id).catch(() => {});
  };
  const stopProjects = useProjectsStore.subscribe(sync);
  // Where each listed Session runs, for "Waiting for <Mac>".
  const stopPlaces = bindCloudPlaces({
    follow: followCloudSession,
    thisMac: sessionRpcClient().runners.subscribeThisMac,
    warn: (message, error) => console.warn(message, error),
  });
  const stopSession = followCloudSession((session) => {
    source?.closeAll();
    for (const id of followed) paint(id, []);
    source =
      session === null
        ? null
        : new CloudSessionSource(session, paint, (error) =>
            console.warn("[volli] cloud Session listing:", error),
          );
    sync();
    useChatSessionsStore.getState().rebindChatSessions([...followed]);
  });
  sync();
  return () => {
    stopProjects();
    stopPlaces();
    stopSession();
    source?.closeAll();
    source = null;
    for (const id of followed) paint(id, []);
  };
}
