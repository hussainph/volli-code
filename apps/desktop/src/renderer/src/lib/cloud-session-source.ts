/** Live, paginated Session listings for one cloud launch. No IPC fallback. */
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { CloudSession } from "./cloud-client";
import {
  cloudSessionListing,
  type CloudSessionRow,
  type CloudListingRow,
} from "./cloud-session-listing";

export class CloudSessionSource {
  private readonly projects = new Map<
    string,
    { rows: CloudListingRow[] | null; stop(): void; ready: Promise<CloudListingRow[]> }
  >();

  constructor(
    private readonly session: CloudSession,
    private readonly paint: (
      projectId: string,
      rows: CloudListingRow[],
      /** The same rows as the backend sent them, for what the listing shape drops (the Place). */
      sent: readonly CloudSessionRow[],
    ) => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Follows all pages; a changed cursor replaces its suffix, never appends stale pages. */
  open(projectId: string): Promise<CloudListingRow[]> {
    const existing = this.projects.get(projectId);
    if (existing !== undefined)
      return existing.rows === null ? existing.ready : Promise.resolve(existing.rows);
    const pages: {
      rows: CloudSessionRow[];
      cursor: string;
      done: boolean;
      valid: boolean;
      stop(): void;
    }[] = [];
    let closed = false;
    let resolve!: (rows: CloudListingRow[]) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<CloudListingRow[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A source may be opened by the project follower before any view awaits it.
    void ready.catch(() => {});
    const entry = {
      rows: null as CloudListingRow[] | null,
      ready,
      stop: () => {
        closed = true;
        for (const page of pages) page.stop();
        resolve([]);
      },
    };
    this.projects.set(projectId, entry);
    const follow = (at: number, cursor: string | null) => {
      // `watch` defers its initial cache read, so teardown is assigned before any paint.
      const page: (typeof pages)[number] = {
        rows: [],
        cursor: "",
        done: false,
        valid: false,
        stop: undefined!,
      };
      pages[at] = page;
      page.stop = this.watch(
        this.session.api.sessions.list,
        {
          projectId,
          paginationOpts: { cursor, numItems: 100 },
        },
        (result) => {
          if (closed || pages[at] !== page) return;
          const changed = result.continueCursor !== page.cursor || result.isDone !== page.done;
          page.valid = true;
          page.rows = result.page;
          page.cursor = result.continueCursor;
          page.done = result.isDone;
          if (changed) {
            for (const obsolete of pages.splice(at + 1)) obsolete.stop();
            if (!page.done) follow(at + 1, page.cursor);
          }
          if (!pages.at(-1)!.done || pages.some((part) => !part.valid)) return;
          // A page boundary can move while the adjacent page is catching up.
          const unique = new Map<string, CloudSessionRow>();
          for (const row of pages.flatMap((part) => part.rows)) {
            if (!unique.has(row.id)) unique.set(row.id, row);
          }
          const sent = [...unique.values()];
          entry.rows = sent.map(cloudSessionListing);
          this.paint(projectId, entry.rows, sent);
          resolve(entry.rows);
        },
        (error) => {
          page.valid = false;
          const code = (error as { data?: { code?: string } } | null)?.data?.code;
          if (code === "not_found" || code === "not_a_member" || code === "unauthenticated") {
            entry.rows = [];
            this.paint(projectId, [], []);
          }
          reject(error);
          this.failed(error);
        },
      );
    };
    follow(0, null);
    return ready;
  }

  close(projectId: string): void {
    this.projects.get(projectId)?.stop();
    this.projects.delete(projectId);
  }

  closeAll(): void {
    for (const projectId of this.projects.keys()) this.close(projectId);
  }

  private watch<Q extends FunctionReference<"query">>(
    query: Q,
    args: FunctionArgs<Q>,
    receive: (value: FunctionReturnType<Q>) => void,
    failed: (error: unknown) => void,
  ): () => void {
    const watch = this.session.client.watchQuery(query, args);
    const update = () => {
      try {
        const result = watch.localQueryResult();
        if (result !== undefined) receive(result);
      } catch (error) {
        failed(error);
      }
    };
    const stop = watch.onUpdate(update);
    queueMicrotask(update);
    return stop;
  }
}
