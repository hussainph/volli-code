/** The Session-side twin of the cloud board binding. Installed only in a cloud launch. */
import type { CloudListingRow } from "./cloud-session-listing";
import { followCloudSession } from "./cloud-client";
import { CloudSessionSource } from "./cloud-session-source";
import type { SessionListingReader } from "./session-listing-reader";
import { useProjectsStore } from "@renderer/stores/projects";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

let source: CloudSessionSource | null = null;

function paint(projectId: string, rows: CloudListingRow[]): void {
  const chat = rows.map((row) => row.record);
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
    try {
      const rows = await source.open(projectId);
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
    stopSession();
    source?.closeAll();
    source = null;
    for (const id of followed) paint(id, []);
  };
}
