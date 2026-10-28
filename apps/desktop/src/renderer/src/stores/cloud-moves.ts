import { create } from "zustand";
import type { CloudMoveSnapshot, CloudMovesApi } from "@volli/shared";

export type MoveSheet =
  | { kind: "prepare"; projectIds?: string[]; key: number }
  | { kind: "progress"; queueId?: string; key: number };

interface State {
  api: CloudMovesApi | null;
  snapshot: CloudMoveSnapshot | null;
  error: string | null;
  sheet: MoveSheet | null;
  refresh(): void;
}

/** Only view state lives here. Restart recovery always reads main's durable journal. */
export const useCloudMovesStore = create<State>(() => ({
  api: null,
  snapshot: null,
  error: null,
  sheet: null,
  refresh: () => {},
}));
let sheetKey = 0;
export function prepareCloudMove(projectId?: string): void {
  useCloudMovesStore.setState({
    sheet: {
      kind: "prepare",
      ...(projectId === undefined ? {} : { projectIds: [projectId] }),
      key: ++sheetKey,
    },
  });
}
export function showCloudMoves(queueId?: string): void {
  useCloudMovesStore.setState({
    sheet: { kind: "progress", ...(queueId === undefined ? {} : { queueId }), key: ++sheetKey },
  });
}
export function closeCloudMoves(): void {
  useCloudMovesStore.setState({ sheet: null });
}

/** Subscribe before reading; a delayed read may never replace a newer journal revision. */
export function bindCloudMoves(api: CloudMovesApi): () => void {
  let active = true;
  let request = 0;
  let subscription = 0;
  let streamFailed = false;
  useCloudMovesStore.setState({ api, snapshot: null, error: null });
  const load = async () => {
    const mine = ++request;
    try {
      const snapshot = await api.snapshot();
      if (!active) return;
      const current = useCloudMovesStore.getState().snapshot;
      if (current === null || snapshot.revision >= current.revision) {
        useCloudMovesStore.setState({
          snapshot,
          error: streamFailed ? useCloudMovesStore.getState().error : null,
        });
      }
    } catch {
      if (active && mine === request) {
        useCloudMovesStore.setState({ error: "Couldn't read move progress. Try again." });
      }
    }
  };
  let stop: (() => void) | null = null;
  const subscribe = () => {
    const mine = ++subscription;
    streamFailed = false;
    stop?.();
    stop = api.onChanged(
      () => {
        if (active && mine === subscription) void load();
      },
      () => {
        if (active && mine === subscription) {
          streamFailed = true;
          useCloudMovesStore.setState({ error: "Couldn't follow move progress. Try again." });
        }
      },
    );
  };
  useCloudMovesStore.setState({
    refresh: () => {
      subscribe();
      void load();
    },
  });
  subscribe();
  void load();
  return () => {
    active = false;
    stop?.();
    useCloudMovesStore.setState({
      api: null,
      snapshot: null,
      error: null,
      sheet: null,
      refresh: () => {},
    });
  };
}
