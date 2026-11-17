/**
 * Per-project board: tickets + labels (SQLite-backed, migration 001) plus the
 * board's search/filter and card-selection state, which stay SESSION-ONLY —
 * like the rest of the app's transient UI, they reset on relaunch instead of
 * following the ticket data. Selection lives here rather than in the board
 * component so other surfaces (the sidebar's Active Sessions) can select a
 * card too.
 *
 * `hydrate` is the ONE place `ticketsByProject`/`labelsByProject` are seeded
 * wholesale, from the boot payload (see lib/boot.ts); every mutation after
 * that goes through the project's board source (`board-source.ts`): this
 * Mac's IPC (`local-board-source.ts`), which paints, writes through and
 * reconciles or reverts against these slices, or a source that delivers its
 * own rows and paints them here (`paintBoard`). Every failure is surfaced
 * (CLAUDE.md: never silently swallow a failed mutation).
 */
import {
  EMPTY_TICKET_FILTER,
  errorMessage,
  setTicketPriority as setTicketPriorityOp,
  type ArchivedTicket,
  type DataChangeKind,
  type DeliberateMoveChoice,
  type HarnessId,
  type Label,
  type Ticket,
  type TicketFilter,
  type TicketPriority,
  type TicketStatus,
  type TicketSummary,
} from "@volli/shared";
import { create, type StoreApi } from "zustand";

import { toastError } from "@renderer/lib/toast";
import { killTicketSessions } from "@renderer/terminal/session-lifecycle";

import { boardSourceFor, installLocalBoardSource, type BoardSource } from "./board-source";
import { useChatSessionsStore } from "./chat-sessions";
import {
  LocalBoardSource,
  restoreAt,
  type BoardGateway,
  type LocalBoardView,
} from "./local-board-source";

/**
 * The scope of the last planning refresh the board published — see
 * {@link BoardState.lastPlanningChange}. `ticketId` is `null` for an untargeted
 * (anything-may-have-changed) refresh.
 */
export interface PlanningChange {
  /** Monotonic; a repeat change for the same ticket still reads as new. */
  version: number;
  /** The ticket the change targeted, or `null` when untargeted. */
  ticketId: string | null;
  /** The project the change belonged to, when known. */
  projectId: string | null;
  /**
   * What changed, when the producer said (`DataChangedEvent.kind`). Absent
   * means unknown — a reader must treat it as possibly anything. Present only
   * when known, so a scope with no hint reads exactly as it always has.
   */
  kind?: DataChangeKind;
}

/**
 * Whether a per-ticket reader watching `ticketId` must refire for `change`: true
 * when the change is untargeted (the conservative recovery arm — anything may
 * have changed) OR it targets exactly this ticket. A change provably for a
 * different ticket is the only case a reader may safely skip.
 */
export function planningChangeAffects(change: PlanningChange, ticketId: string): boolean {
  return change.ticketId === null || change.ticketId === ticketId;
}

/**
 * Whether this renderer holds the ticket's CANONICAL Ticket Body (VC-387).
 *
 * A ticket the steady-state roster introduced carries `body: ""` as a
 * PLACEHOLDER, because the roster does not read bodies. `""` is also a
 * perfectly legal body, so the two are indistinguishable by value — and a
 * surface that reads the placeholder as canonical writes an empty body over a
 * real one. Ask this before rendering a body for editing, and before any
 * read-modify-write that derives a new body from the one in the store.
 */
export function isTicketBodyLoaded(state: BoardState, ticketId: string): boolean {
  return state.unloadedTicketBodies[ticketId] === undefined;
}

export interface BoardState {
  ticketsByProject: Record<string, Ticket[]>;
  labelsByProject: Record<string, Label[]>;
  /**
   * Ticket ids whose `body` in {@link BoardState.ticketsByProject} is a
   * PLACEHOLDER rather than the canonical Ticket Body (VC-387) — read through
   * {@link isTicketBodyLoaded}, never directly.
   *
   * Empty after a wholesale {@link BoardState.hydrate}, because the boot payload
   * carries every body. A ticket the scoped roster introduces (created by an
   * agent or another window after this one booted) is marked here until
   * {@link BoardState.adoptTicketBody} fills it, which is what opening that
   * ticket does.
   *
   * A SEPARATE index rather than a nullable `Ticket["body"]`, because `body` is
   * domain vocabulary shared with main, the CLI and the agent brief; only this
   * renderer's cache has a "not read yet" state, so only this renderer carries
   * the flag.
   */
  unloadedTicketBodies: Record<string, true>;
  /**
   * Whether the next board-moving planning refresh must be WHOLESALE whatever
   * its scope (VC-387).
   *
   * A failed refresh may have missed the mutation that triggered it, and a
   * scoped read is exactly the read that cannot repair a slice it does not
   * name. Set by {@link BoardState.notePlanningRefreshFailed}; cleared by the
   * wholesale {@link BoardState.hydrate} that heals it.
   *
   * In the store rather than in a module variable so it resets with the rest of
   * the board, is visible to anything that can read board state, and is reached
   * by tests through the same door as every other board fact.
   */
  planningRecoveryNeeded: boolean;
  /**
   * A project's archived tickets — cold storage for the Archive view, kept OUT
   * of `ticketsByProject` (the board holds only live cards) and loaded on
   * demand via {@link BoardState.loadArchived}, not at boot. A missing entry
   * means "not loaded yet", not "no archived tickets".
   */
  archivedByProject: Record<string, ArchivedTicket[]>;
  /** Session-only — never persisted; see module doc. */
  filterByProject: Record<string, TicketFilter>;
  /** Selected card ids per project. Session-only — never persisted; see module doc. */
  selectedByProject: Record<string, string[]>;
  /**
   * The last server-owned planning refresh, published after `refreshPlanningData`
   * (see lib/boot.ts) re-hydrates the board from SQLite. `version` is monotonic
   * (so a repeat change for the same ticket still reads as new); `ticketId`/
   * `projectId` carry the change's SCOPE from the `volli:data-changed` payload,
   * or `null` for an untargeted "anything may have changed" refresh.
   *
   * Per-ticket surfaces that fetch data NOT carried in `ticketsByProject` — the
   * Activity feed's events/comments, the retention badge, the Done-flow rail's
   * git summary — subscribe to this and refetch only when the change is
   * untargeted OR targets THEIR ticket ({@link planningChangeAffects}); a change
   * provably for another ticket is skipped. Session-only; resets on relaunch.
   */
  lastPlanningChange: PlanningChange;
  /**
   * Publishes a planning refresh with its scope — called after a socket-originated
   * refresh re-hydrates the planning stores (see lib/boot.ts). Always bumps
   * `version`; `change.ticketId`/`projectId` default to `null` (untargeted).
   */
  notePlanningChange(change?: {
    ticketId?: string;
    projectId?: string;
    kind?: DataChangeKind;
  }): void;
  /**
   * Records that a planning refresh read failed, arming the wholesale recovery
   * described on {@link BoardState.planningRecoveryNeeded}.
   */
  notePlanningRefreshFailed(): void;
  /**
   * Seeds tickets/labels from the boot payload — the ONE place state is set
   * wholesale outside a mutation. Also the path a change made OUTSIDE this
   * renderer arrives on (`refreshPlanningData`, lib/boot.ts, after a
   * `volli:data-changed` broadcast), so it re-homes the chat tabs of anything
   * the authoritative snapshot no longer holds, exactly as a local mutation's
   * reconcile does.
   */
  hydrate(
    ticketsByProject: Record<string, Ticket[]>,
    labelsByProject: Record<string, Label[]>,
  ): void;
  /**
   * Seeds ONE project's tickets/labels from the steady-state refresh read
   * (`volli:data-project-roster`, VC-387) — the scoped sibling of
   * {@link BoardState.hydrate}, and the path a socket-originated change that
   * names its project arrives on.
   *
   * Two things it does that a wholesale hydrate cannot. Every OTHER project's
   * slice keeps its identity, so an agent commenting in one project no longer
   * re-renders the boards of the others. And the roster carries no `body`, so
   * each row is completed with the body this store already holds — a ticket
   * this renderer has never seen gets a `""` PLACEHOLDER and is recorded in
   * {@link BoardState.unloadedTicketBodies} until
   * {@link BoardState.adoptTicketBody} fills it, which is what opening that
   * ticket does. The mark is what keeps the placeholder from being mistaken for
   * an empty body a person actually wrote.
   *
   * A no-op for a project this renderer does not hold: bringing one back needs
   * the projects store too, which only a wholesale hydrate carries.
   */
  hydrateProjectRoster(projectId: string, tickets: readonly TicketSummary[], labels: Label[]): void;
  /**
   * Adopts one ticket's body, read on its own because the refresh roster no
   * longer carries it (VC-387). A no-op for a ticket the board does not hold
   * (archived, deleted, or in a project this renderer forgot) and for a body
   * that already matches — an unchanged body must not mint a new ticket object,
   * or every planning change would re-render the open ticket for nothing.
   *
   * It clears the ticket's {@link BoardState.unloadedTicketBodies} mark on EVERY
   * path that reached a real read, the unchanged-body one included: a ticket
   * whose canonical body genuinely is `""` must end up loaded, or it would stay
   * marked forever and no surface would ever let a person edit it.
   */
  adoptTicketBody(projectId: string, ticketId: string, body: string): void;
  /**
   * Paints one project's board as its board source holds it
   * (`board-source.ts`): Volli Cloud's rows in a cloud launch (VC-889), or a
   * remote host's confirmed rows with this window's pending writes replayed
   * over them (`board-sync.ts`, VC-711). Every ticket and label that did not
   * change keeps its object identity, so a repaint re-renders only the cards
   * it moved. `unloadedBodies` are the rows whose body this window has not
   * read (VC-387).
   */
  paintBoard(
    projectId: string,
    tickets: Ticket[],
    labels: Label[],
    unloadedBodies: ReadonlySet<string>,
  ): void;
  /**
   * Seeds empty `ticketsByProject`/`labelsByProject` slices for a project that
   * didn't exist at boot — mirroring the wholesale seed `hydrate` does from
   * the bootstrap payload (see lib/boot.ts), for the one path that bypasses
   * it: a project created mid-session. Every ticket mutation reconciles
   * through a guard that refuses to write into a missing slice (never
   * resurrect a forgotten project's data), so without this seed a freshly
   * created project's first ticket would land in SQLite but never reach the
   * board. A no-op when the slice already exists, so calling this for a
   * project this renderer already knows about never clobbers its live data.
   */
  seedProject(projectId: string): void;
  /**
   * A Deliberate move this window makes. `choice` is what the ⌥ drag picker
   * named on release (VC-132) and is passed straight through to the one
   * observer below — the board's drop is the only caller that has one, and an
   * absent choice is the plain move every other surface makes.
   */
  moveTicket(
    projectId: string,
    ticketId: string,
    toStatus: TicketStatus,
    toIndex: number,
    choice?: DeliberateMoveChoice,
  ): Promise<void>;
  /** Moves the current selection as one contiguous, atomically-persisted group. */
  moveTickets(
    projectId: string,
    ticketIds: string[],
    toStatus: TicketStatus,
    toIndex: number,
    choice?: DeliberateMoveChoice,
  ): Promise<void>;
  /**
   * Creates a ticket in `status`'s column via its board source. Returns the created
   * {@link Ticket}, or `null` when the trimmed title is empty (no-op, no IPC
   * call) or the creation failed (already toasted) — callers that need the
   * new ticket (e.g. the global New-ticket dialog, to toast its display id)
   * can await the return value; the inline column composers ignore it.
   */
  addTicket(
    projectId: string,
    status: TicketStatus,
    title: string,
    options?: {
      priority?: TicketPriority;
      body?: string;
      labels?: string[];
      usesWorktree?: boolean;
      preferredHarnessId?: HarnessId;
      /** The ref the worktree branches from; omitted leaves it to worktree-time detection. */
      baseBranch?: string | null;
    },
  ): Promise<Ticket | null>;
  setTicketPriority(projectId: string, ticketId: string, priority: TicketPriority): Promise<void>;
  /**
   * Patches a ticket's title/body/branch fields through its board source
   * (ticket-detail-mvp step 3). Ticket-scoped, not project-scoped — the ticket's
   * project is located by scanning `ticketsByProject` for it, so callers (the
   * properties rail's branch/baseBranch fields, the title/body autosave) only
   * need the ticket's id. Optimistic; reverts to the pre-patch ticket on
   * failure. A no-op for an unknown ticket id. A worktree's path is the
   * host's to stamp, never this call's.
   */
  updateTicket(input: {
    ticketId: string;
    title?: string;
    body?: string;
    branch?: string | null;
    baseBranch?: string | null;
    /** Worktree scoping — honored by main only while no worktree has materialized (VC-16). */
    usesWorktree?: boolean;
  }): Promise<void>;
  /**
   * Replaces a ticket's labels wholesale via `api.tickets.setLabels`. Same
   * ticket-scoped shape as {@link BoardState.updateTicket}. Optimistic;
   * reverts to the pre-edit label set on failure.
   */
  setLabels(ticketId: string, labels: string[]): Promise<void>;
  /**
   * Sets (or clears, via `color: null`) a project label's stored color via
   * `api.labels.setColor` — a stored color always wins over the hash
   * fallback (`labelColor`/`resolveLabelColor`), so this is what a picked
   * swatch persists. Optimistic; reverts to the pre-edit color on failure. A
   * no-op (no IPC) for an unknown project/label id or an unchanged color.
   */
  setLabelColor(projectId: string, labelId: string, color: string | null): Promise<void>;
  /**
   * Fetches the project's archived tickets into `archivedByProject` (the
   * Archive view calls this on open). Resolves `false` when the fetch failed
   * (already toasted) so the view can show a retry state instead of an
   * indefinite "Loading…", and also when the project was forgotten while the
   * fetch was in flight — `projectId in ticketsByProject` is the liveness
   * signal (seeded by `hydrate`/`seedProject`, dropped by `forget`), so a
   * project removed mid-fetch can't have its Archive slice resurrected.
   */
  loadArchived(projectId: string): Promise<boolean>;
  /** Archives a ticket: optimistically removes it from the board, reverting (and toasting) on failure. */
  archiveTicket(projectId: string, ticketId: string): Promise<void>;
  /** Returns an archived ticket to the board: drops it from the Archive slice and appends the revived live ticket. */
  unarchiveTicket(projectId: string, ticketId: string): Promise<void>;
  /** Permanently deletes an archived ticket (the only destructive act); optimistic, reverts on failure. */
  deleteArchivedTicket(projectId: string, ticketId: string): Promise<void>;
  setSearch(projectId: string, search: string): void;
  togglePriority(projectId: string, priority: TicketPriority): void;
  toggleLabel(projectId: string, label: string): void;
  clearFilter(projectId: string): void;
  /** Replaces the project's selection with one ticket, or clears it. */
  selectTicket(projectId: string, ticketId: string | null): void;
  /** Replaces the project's selection with the given de-duplicated ids. */
  selectTickets(projectId: string, ticketIds: readonly string[]): void;
  forget(projectId: string, options?: { preserveDrafts: boolean }): void;
}

/** The create options a caller actually supplied: `undefined` means "the host's default". */
function definedOptions<Options extends object>(options: Options | undefined): Partial<Options> {
  if (options === undefined) return {};
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as Partial<Options>;
}

/** Toggles `value` in `values`: drops it if present, appends it otherwise. */
function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/** De-duplicates ids without turning click order into persistence semantics. */
function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Reconciles chat-tab owners with the live-ticket transition. A departure moves
 * its tabs onto the project and records their exact ticket origin; an arrival
 * restores only project-hosted tabs from that same ticket. The Chat Store owns
 * the provenance and single-owner mutation, so ticketless tabs and tabs from
 * other departed tickets cannot be swept into the returning ticket.
 */
function reconcileTicketChatTabOwners(
  projectId: string,
  before: readonly Ticket[],
  after: readonly Ticket[],
): void {
  const beforeIds = new Set(before.map((ticket) => ticket.id));
  const afterIds = new Set(after.map((ticket) => ticket.id));
  const departed = [...beforeIds].filter((ticketId) => !afterIds.has(ticketId));
  const returned = [...afterIds].filter((ticketId) => !beforeIds.has(ticketId));
  if (departed.length === 0 && returned.length === 0) return;
  useChatSessionsStore.getState().reconcileTicketChatTabs(projectId, departed, returned);
}

/**
 * Retires every chat a vanished project leaves behind: its own key, plus every
 * live ticket still holding one directly (a departed ticket's tabs already
 * moved onto the project key via {@link reconcileTicketChatTabOwners}). This
 * is shared by direct project removal and wholesale re-hydration so no client
 * depends on a view unmount to be disposed.
 */
function teardownProjectChatTabs(
  projectId: string,
  slice: readonly Ticket[],
  options?: { preserveDrafts: boolean },
): void {
  const openTabs = useChatSessionsStore.getState().openTabs;
  const orphaned = [projectId, ...slice.map((ticket) => ticket.id)].filter((id) => id in openTabs);
  if (orphaned.length > 0) {
    if (options === undefined) useChatSessionsStore.getState().dropChatTabs(orphaned);
    else useChatSessionsStore.getState().dropChatTabs(orphaned, options);
  }
}

/** Whether two tickets hold the same values: their label lists compared by element. */
function sameTicket(left: Ticket, right: Ticket): boolean {
  const keys = Object.keys(right) as (keyof Ticket)[];
  if (Object.keys(left).length !== keys.length) return false;
  return keys.every((key) =>
    key === "labels" ? sameIds(left.labels, right.labels) : left[key] === right[key],
  );
}

/**
 * `next`, with every element that equals its predecessor (by `id`) replaced by
 * that predecessor's object, and `previous` itself when nothing changed at
 * all (VC-447): a refresh that read back the same rows mints no new objects,
 * so a memoized card or row re-renders only when its own data moved.
 */
export function preserveIdentities<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
  same: (left: T, right: T) => boolean,
): T[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  let unchanged = previous.length === next.length;
  const kept = next.map((item, index) => {
    const prior = byId.get(item.id);
    const reused = prior !== undefined && same(prior, item) ? prior : item;
    if (reused !== previous[index]) unchanged = false;
    return reused;
  });
  return unchanged ? (previous as T[]) : kept;
}

function sameLabel(left: Label, right: Label): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.name === right.name &&
    left.color === right.color
  );
}

/**
 * The `unloadedTicketBodies` record with `ticketId` removed, or `undefined`
 * when it was not marked — so a caller can skip writing an identical record
 * and leave the reference (and every subscriber reading it) untouched.
 */
function withoutMark(
  unloaded: Record<string, true>,
  ticketId: string,
): Record<string, true> | undefined {
  if (unloaded[ticketId] === undefined) return undefined;
  const next = { ...unloaded };
  delete next[ticketId];
  return next;
}

/** A board store: the singleton below, or a test's. */
export type BoardStore = ReturnType<typeof createBoardStore>;

/**
 * The board store's slices as this Mac's board writes paint and reconcile
 * them ({@link LocalBoardSource}).
 */
function localBoardView(
  store: Pick<StoreApi<BoardState>, "getState" | "setState">,
): LocalBoardView {
  const get = store.getState;
  const set = store.setState;
  return {
    tickets: (projectId) => get().ticketsByProject[projectId],
    setTickets(projectId, tickets) {
      set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: tickets } });
    },
    reconcileTickets(projectId, update) {
      // Read FRESH from state (so a mutation that landed on another card
      // mid-flight isn't clobbered), guarding a slice the project's removal
      // (`forget`) dropped while the IPC was in flight — never resurrect a
      // slice SQLite no longer has. The single reconcile path behind every
      // ticket mutation's success and revert.
      const byProject = get().ticketsByProject;
      const slice: Ticket[] | undefined = byProject[projectId];
      if (!slice) return;
      const next = update(slice);
      set({ ticketsByProject: { ...byProject, [projectId]: next } });
      reconcileTicketChatTabOwners(projectId, slice, next);
    },
    labels: (projectId) => get().labelsByProject[projectId],
    reconcileLabels(projectId, update) {
      // The label-slice analog: never resurrect label data `forget` dropped
      // while a color IPC was in flight.
      const byProject = get().labelsByProject;
      const slice: Label[] | undefined = byProject[projectId];
      if (!slice) return;
      set({ labelsByProject: { ...byProject, [projectId]: update(slice) } });
    },
    findTicket(ticketId) {
      for (const [projectId, tickets] of Object.entries(get().ticketsByProject)) {
        const ticket = tickets.find((candidate) => candidate.id === ticketId);
        if (ticket) return { projectId, ticket };
      }
      return undefined;
    },
    markBodyLoaded(ticketId) {
      const loaded = withoutMark(get().unloadedTicketBodies, ticketId);
      if (loaded !== undefined) set({ unloadedTicketBodies: loaded });
    },
  };
}

/** Puts this Mac's board, over its own IPC (or a test's `gateway`), behind `store`'s slices. */
export function installLocalBoard(store: BoardStore, gateway?: BoardGateway): void {
  installLocalBoardSource(new LocalBoardSource(localBoardView(store), gateway));
}

/**
 * Factory so tests can hand the store their own board sources; by default
 * every project's goes where `board-source.ts` says.
 */
export function createBoardStore(sourceFor: (projectId: string) => BoardSource = boardSourceFor) {
  return create<BoardState>()((set, get) => {
    const view = localBoardView({ getState: get, setState: set });

    /**
     * Merges a change into the project's filter record (initializing from
     * {@link EMPTY_TICKET_FILTER}) — the one write path behind the four
     * facet actions, mirroring project-ui.ts's `patchProjectUi`.
     */
    function patchFilter(
      projectId: string,
      changes: (current: TicketFilter) => Partial<TicketFilter>,
    ): void {
      const { filterByProject } = get();
      const current = filterByProject[projectId] ?? EMPTY_TICKET_FILTER;
      set({
        filterByProject: {
          ...filterByProject,
          [projectId]: { ...current, ...changes(current) },
        },
      });
    }

    /**
     * The Archive-slice analog of the view's ticket reconcile: applies
     * `update` to the project's archived list read FRESH from state, guarding
     * a slice that was never loaded (or was dropped by `forget` while a write
     * was in flight) — never resurrect Archive data the store isn't holding.
     */
    function reconcileArchived(
      projectId: string,
      update: (slice: ArchivedTicket[]) => ArchivedTicket[],
    ): void {
      const byProject = get().archivedByProject;
      const slice: ArchivedTicket[] | undefined = byProject[projectId];
      if (!slice) return;
      set({ archivedByProject: { ...byProject, [projectId]: update(slice) } });
    }

    /**
     * What a confirmed archive does after its terminals end and it leaves the
     * board, on every source: drops the stale Archive slice, and takes the card
     * out of the selection.
     */
    function afterArchived(projectId: string, ticketId: string): void {
      // The ticket is now archived; any cached Archive slice is stale, so drop
      // it — the next `loadArchived` (on Archive-view open) refetches it in.
      const { archivedByProject } = get();
      if (projectId in archivedByProject) {
        const next = { ...archivedByProject };
        delete next[projectId];
        set({ archivedByProject: next });
      }
      // An archived card can't stay in a multi-selection. Keep its selected
      // siblings; drop the project record only when this was the last one.
      const { selectedByProject } = get();
      const selected = selectedByProject[projectId];
      if (selected?.includes(ticketId)) {
        const remaining = selected.filter((id) => id !== ticketId);
        const next = { ...selectedByProject };
        if (remaining.length === 0) delete next[projectId];
        else next[projectId] = remaining;
        set({ selectedByProject: next });
      }
    }

    return {
      ticketsByProject: {},
      labelsByProject: {},
      archivedByProject: {},
      filterByProject: {},
      selectedByProject: {},
      unloadedTicketBodies: {},
      planningRecoveryNeeded: false,
      lastPlanningChange: { version: 0, ticketId: null, projectId: null },

      notePlanningChange(change) {
        set({
          lastPlanningChange: {
            version: get().lastPlanningChange.version + 1,
            ticketId: change?.ticketId ?? null,
            projectId: change?.projectId ?? null,
            ...(change?.kind === undefined ? {} : { kind: change.kind }),
          },
        });
      },

      notePlanningRefreshFailed() {
        set({ planningRecoveryNeeded: true });
      },

      hydrateProjectRoster(projectId, tickets, labels) {
        // Never resurrect a forgotten project, the rule every ticket mutation
        // reconciles under: a scoped read answers about one project, and a
        // project this renderer has dropped must come back through a wholesale
        // hydrate (which carries the projects store with it) or not at all.
        const previous = get().ticketsByProject[projectId];
        if (previous === undefined) return;
        const bodyById = new Map(previous.map((ticket) => [ticket.id, ticket.body]));
        // Every row the read answered unchanged keeps its object (VC-447): an
        // agent's comment no longer re-renders every card on the board.
        const next = preserveIdentities(
          previous,
          tickets.map((row) => ({ ...row, body: bodyById.get(row.id) ?? "" })),
          sameTicket,
        );
        // A row this renderer has not seen before got a PLACEHOLDER body above,
        // not a read one. Marked here so no surface mistakes it for an empty
        // body a person wrote. A row already on the board keeps whatever mark it
        // had: the roster did not read its body either way.
        const unloaded = { ...get().unloadedTicketBodies };
        // The marks move only when the board's membership does: an arrival or
        // a departure. Neither happens on a refresh that read back the same rows.
        let membershipChanged = false;
        for (const row of tickets) {
          if (bodyById.has(row.id)) continue;
          unloaded[row.id] = true;
          membershipChanged = true;
        }
        // And a ticket that LEFT the board takes its mark with it, so an archive
        // and an unarchive cannot leave a stale entry behind forever.
        const survivingIds = new Set(tickets.map((row) => row.id));
        for (const ticket of previous) {
          if (survivingIds.has(ticket.id)) continue;
          delete unloaded[ticket.id];
          membershipChanged = true;
        }
        const previousLabels = get().labelsByProject[projectId] ?? [];
        const nextLabels = preserveIdentities(previousLabels, labels, sameLabel);
        const sliceChanged = next !== previous;
        const labelsChanged =
          !(projectId in get().labelsByProject) || nextLabels !== previousLabels;
        // Nothing changed, nothing written (VC-447): a new outer map would
        // re-render every whole-map subscriber (the command palette reads all
        // of `ticketsByProject`) even with every slice inside it kept.
        if (!sliceChanged && !labelsChanged && !membershipChanged) return;
        set({
          ...(sliceChanged
            ? { ticketsByProject: { ...get().ticketsByProject, [projectId]: next } }
            : {}),
          ...(labelsChanged
            ? { labelsByProject: { ...get().labelsByProject, [projectId]: nextLabels } }
            : {}),
          ...(membershipChanged ? { unloadedTicketBodies: unloaded } : {}),
        });
        // The same re-home a wholesale hydrate does, for the same reason: a CLI
        // archive or another window's mutation drops a ticket here with no local
        // action to hang owner reconciliation off.
        reconcileTicketChatTabOwners(projectId, previous, next);
      },

      adoptTicketBody(projectId, ticketId, body) {
        // A board source keeps the bodies it has read beside its rows, so its
        // next repaint keeps this one.
        sourceFor(projectId).adoptBody(ticketId, body);
        const slice = get().ticketsByProject[projectId];
        if (slice === undefined) return;
        const index = slice.findIndex((ticket) => ticket.id === ticketId);
        const current = slice[index];
        if (current === undefined) return;
        // The mark clears whatever the body turned out to be — BEFORE the
        // unchanged-body return below, because a ticket whose canonical body
        // really is "" has now been read and must not stay a placeholder.
        if (current.body === body) {
          view.markBodyLoaded(ticketId);
          return;
        }
        // One replaced entry in a copied array, rather than a mapped rebuild:
        // every OTHER ticket keeps its object identity, so adopting one body
        // cannot re-render the cards beside it.
        const next = [...slice];
        next[index] = { ...current, body };
        const loaded = withoutMark(get().unloadedTicketBodies, ticketId);
        set({
          ticketsByProject: { ...get().ticketsByProject, [projectId]: next },
          ...(loaded === undefined ? {} : { unloadedTicketBodies: loaded }),
        });
      },

      paintBoard(projectId, tickets, labels, unloadedBodies) {
        const previous = get().ticketsByProject[projectId] ?? [];
        const next = preserveIdentities(previous, tickets, sameTicket);
        const previousLabels = get().labelsByProject[projectId] ?? [];
        const nextLabels = preserveIdentities(previousLabels, labels, sameLabel);
        const unloaded = { ...get().unloadedTicketBodies };
        let marksChanged = false;
        for (const ticket of next) {
          const marked = unloaded[ticket.id] !== undefined;
          if (unloadedBodies.has(ticket.id) === marked) continue;
          marksChanged = true;
          if (marked) delete unloaded[ticket.id];
          else unloaded[ticket.id] = true;
        }
        const sliceChanged = !(projectId in get().ticketsByProject) || next !== previous;
        const labelsChanged =
          !(projectId in get().labelsByProject) || nextLabels !== previousLabels;
        if (!sliceChanged && !labelsChanged && !marksChanged) return;
        set({
          ...(sliceChanged
            ? { ticketsByProject: { ...get().ticketsByProject, [projectId]: next } }
            : {}),
          ...(labelsChanged
            ? { labelsByProject: { ...get().labelsByProject, [projectId]: nextLabels } }
            : {}),
          ...(marksChanged ? { unloadedTicketBodies: unloaded } : {}),
        });
        if (sliceChanged) reconcileTicketChatTabOwners(projectId, previous, next);
      },

      hydrate(bootTickets, bootLabels) {
        const previous = get().ticketsByProject;
        // This Mac's bootstrap knows nothing of a board whose source delivers
        // its own rows (a remote host's, VC-711): each such slice stays as its
        // source painted it.
        const followed = Object.keys(previous).filter(
          (projectId) => !(projectId in bootTickets) && sourceFor(projectId).deliversOwnRows,
        );
        const ticketsByProject =
          followed.length === 0
            ? bootTickets
            : {
                ...bootTickets,
                ...Object.fromEntries(followed.map((id) => [id, previous[id]!])),
              };
        const labelsByProject =
          followed.length === 0
            ? bootLabels
            : {
                ...bootLabels,
                ...Object.fromEntries(followed.map((id) => [id, get().labelsByProject[id] ?? []])),
              };
        // The boot payload carries every live ticket's body, so nothing is a
        // placeholder after a wholesale hydrate — and this read is also the one
        // that heals a board a failed refresh may have left stale, which is what
        // retires `planningRecoveryNeeded`.
        // A followed board's placeholder bodies are still placeholders: its
        // marks stay, or a "" would read as a body a person wrote.
        const marks = get().unloadedTicketBodies;
        const kept: Record<string, true> = {};
        for (const projectId of followed) {
          for (const ticket of previous[projectId]!) {
            if (marks[ticket.id] !== undefined) kept[ticket.id] = true;
          }
        }
        set({
          ticketsByProject,
          labelsByProject,
          unloadedTicketBodies: kept,
          planningRecoveryNeeded: false,
        });
        // The removal path a write's reconcile cannot see: a CLI archive, a
        // retention sweep, or another window's mutation reaches this renderer as
        // a wholesale re-hydrate, dropping the ticket without any local action
        // to hang owner reconciliation off. Projects the snapshot no longer
        // names use the same client-disposing teardown as `forget`. Boot
        // hydrates into an empty map, so this walks nothing there.
        for (const [projectId, slice] of Object.entries(previous)) {
          const next = ticketsByProject[projectId];
          if (next === undefined) teardownProjectChatTabs(projectId, slice);
          else reconcileTicketChatTabOwners(projectId, slice, next);
        }
      },

      seedProject(projectId) {
        const { ticketsByProject, labelsByProject } = get();
        if (projectId in ticketsByProject) return; // already live — never clobber
        set({
          ticketsByProject: { ...ticketsByProject, [projectId]: [] },
          labelsByProject: { ...labelsByProject, [projectId]: [] },
        });
        // Its board source follows the new project's board.
        const source = sourceFor(projectId);
        if (!source.follows(projectId)) {
          void source.open(projectId).catch((error: unknown) => {
            toastError(`Couldn't open the board: ${errorMessage(error)}`);
          });
        }
      },

      async addTicket(projectId, status, title, options) {
        const trimmed = title.trim();
        if (trimmed === "") return null;
        // This Mac's appends the confirmed row; a source that delivers its
        // own rows shows a placeholder at once, replaced when confirmed (T5).
        return sourceFor(projectId).createTicket(projectId, {
          status,
          title: trimmed,
          ...definedOptions(options),
        });
      },

      async moveTicket(projectId, ticketId, toStatus, toIndex, choice) {
        await sourceFor(projectId).moveTicket(projectId, ticketId, toStatus, toIndex, choice);
      },

      async moveTickets(projectId, ticketIds, toStatus, toIndex, choice) {
        const ids = uniqueIds(ticketIds);
        await sourceFor(projectId).moveTickets(projectId, ids, toStatus, toIndex, choice);
      },

      async setTicketPriority(projectId, ticketId, priority) {
        const previous = get().ticketsByProject[projectId] ?? [];
        const original = previous.find((ticket) => ticket.id === ticketId);
        const optimistic = setTicketPriorityOp(previous, ticketId, priority, Date.now());
        if (!original || optimistic === previous) return; // unknown id or unchanged priority (the shared op's no-op guard)
        await sourceFor(projectId).setPriority(projectId, ticketId, priority);
      },

      async updateTicket(input) {
        const found = view.findTicket(input.ticketId);
        if (found === undefined) return; // unknown ticket id — nothing to update
        const updated = await sourceFor(found.projectId).updateTicket(found.projectId, input);
        // The authoritative ticket always carries the real body, whatever
        // field this call edited — so landing it retires any placeholder mark.
        if (updated !== null) view.markBodyLoaded(input.ticketId);
      },

      async setLabels(ticketId, labels) {
        const found = view.findTicket(ticketId);
        if (found === undefined) return; // unknown ticket id — nothing to update
        await sourceFor(found.projectId).setLabels(found.projectId, ticketId, labels);
      },

      async setLabelColor(projectId, labelId, color) {
        const previous = get().labelsByProject[projectId] ?? [];
        const original = previous.find((label) => label.id === labelId);
        if (!original || original.color === color) return; // unknown id or unchanged color
        await sourceFor(projectId).setLabelColor(projectId, labelId, color);
      },

      async loadArchived(projectId) {
        const tickets = await sourceFor(projectId).archivedTickets(projectId);
        if (tickets === null) return false;
        // The project may have been forgotten (removed) while the fetch was in
        // flight — `ticketsByProject` is the liveness signal now that every
        // project's slice is seeded on creation (see `seedProject`) and
        // dropped by `forget`, so this guards the same "never resurrect a
        // forgotten project's data" invariant every write's reconcile and
        // `reconcileArchived` enforce for mutations.
        if (!(projectId in get().ticketsByProject)) return false;
        // Wholesale-set this ONE project's archived slice from the authoritative
        // fetch — the Archive view is a fresh read each open, so a snapshot
        // replace (not a merge) is exactly right here.
        set({ archivedByProject: { ...get().archivedByProject, [projectId]: tickets } });
        return true;
      },

      async archiveTicket(projectId, ticketId) {
        const previous = get().ticketsByProject[projectId] ?? [];
        const target = previous.find((ticket) => ticket.id === ticketId);
        if (!target) return; // unknown id — nothing to archive
        // The source drops the card at once and keeps it off the board once
        // confirmed; a failure or refusal puts it back.
        if (!(await sourceFor(projectId).archiveTicket(projectId, ticketId))) return;
        // The ticket is archived now, so its live terminal sessions must die —
        // an archived ticket has no surface to reach them, and nothing else
        // tears them down (killTicketSessions was only reachable via project
        // removal, which skips archived tickets). Do it on SUCCESS only: a
        // failed archive left the ticket live, so its sessions must survive.
        killTicketSessions(ticketId);
        afterArchived(projectId, ticketId);
      },

      async unarchiveTicket(projectId, ticketId) {
        const previousArchived = get().archivedByProject[projectId] ?? [];
        const target = previousArchived.find((ticket) => ticket.id === ticketId);
        if (!target) return; // not in the loaded Archive slice (e.g. a double-fired Restore) — no write

        const index = previousArchived.indexOf(target);
        // Optimistically drop it from the Archive slice.
        reconcileArchived(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));

        // The source puts the revived ticket on the board, appended to its column.
        const revived = await sourceFor(projectId).unarchiveTicket(projectId, target);
        if (revived === null) {
          // Revert: restore it to its old Archive slot unless already back.
          reconcileArchived(projectId, (slice) => restoreAt(slice, target, index));
          return;
        }
        // Success — drop it from the Archive slice AGAIN: a `loadArchived`
        // refetch in flight (snapshotted before the unarchive committed) can
        // have wholesale-set the slice with this ticket still listed; responses
        // arrive in send order, so this later word wins.
        reconcileArchived(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));
      },

      async deleteArchivedTicket(projectId, ticketId) {
        const previousArchived = get().archivedByProject[projectId] ?? [];
        const target = previousArchived.find((ticket) => ticket.id === ticketId);
        // Not in the loaded Archive slice (e.g. a double-fired Delete after the
        // optimistic drop) — no write, which would throw "Unknown ticket" and
        // toast a spurious error for an operation that already succeeded.
        if (!target) return;

        const index = previousArchived.indexOf(target);
        // Optimistically drop it from the Archive slice.
        reconcileArchived(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));

        if (!(await sourceFor(projectId).deleteTicket(projectId, ticketId))) {
          // Revert: restore it to its old Archive slot unless already back.
          reconcileArchived(projectId, (slice) => restoreAt(slice, target, index));
          return;
        }
        // Its Board chats remain resident, but their temporary
        // restoration path cannot outlive a permanent ticket deletion.
        useChatSessionsStore.getState().clearRehomedTicketProvenance(ticketId);
        // Any live terminal sessions the ticket still owns must die with it —
        // belt-and-suspenders alongside archiveTicket's own teardown (a ticket
        // reachable here should already be sessionless, but never leak a PTY).
        killTicketSessions(ticketId);
        // Success — drop it AGAIN: an in-flight `loadArchived` refetch can have
        // re-listed it (see unarchiveTicket); the later response wins.
        reconcileArchived(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));
      },

      setSearch(projectId, search) {
        patchFilter(projectId, () => ({ search }));
      },

      togglePriority(projectId, priority) {
        patchFilter(projectId, (current) => ({
          priorities: toggleValue(current.priorities, priority),
        }));
      },

      toggleLabel(projectId, label) {
        patchFilter(projectId, (current) => ({ labels: toggleValue(current.labels, label) }));
      },

      // Drops the project's filter record entirely rather than writing back
      // EMPTY_TICKET_FILTER: a missing record already reads as "no filter"
      // everywhere above (see the `?? EMPTY_TICKET_FILTER` fallbacks), so
      // clearing is just forgetting.
      clearFilter(projectId) {
        const { filterByProject } = get();
        if (!(projectId in filterByProject)) return;
        const next = { ...filterByProject };
        delete next[projectId];
        set({ filterByProject: next });
      },

      // Clearing drops the project's record: a missing record already reads as
      // an empty selection everywhere. Single-ticket callers (opening a detail
      // view, sidebar navigation) deliberately collapse any board multi-select.
      selectTicket(projectId, ticketId) {
        const selectedByProject = get().selectedByProject;
        const selected = ticketId === null ? [] : [ticketId];
        const current = selectedByProject[projectId] ?? [];
        if (sameIds(current, selected)) return;
        const next = { ...selectedByProject };
        if (selected.length === 0) delete next[projectId];
        else next[projectId] = selected;
        set({ selectedByProject: next });
      },

      selectTickets(projectId, ticketIds) {
        const selectedByProject = get().selectedByProject;
        const selected = uniqueIds(ticketIds);
        const current = selectedByProject[projectId] ?? [];
        if (sameIds(current, selected)) return;
        const next = { ...selectedByProject };
        if (selected.length === 0) delete next[projectId];
        else next[projectId] = selected;
        set({ selectedByProject: next });
      },

      forget(projectId, options) {
        const {
          ticketsByProject,
          labelsByProject,
          archivedByProject,
          filterByProject,
          selectedByProject,
        } = get();
        const hasTickets = projectId in ticketsByProject;
        const hasLabels = projectId in labelsByProject;
        const hasArchived = projectId in archivedByProject;
        const hasFilter = projectId in filterByProject;
        const hasSelection = projectId in selectedByProject;
        const openTabs = useChatSessionsStore.getState().openTabs;
        const chatOwnerIds = [
          projectId,
          ...(ticketsByProject[projectId] ?? []).map((ticket) => ticket.id),
        ];
        const hasChatTabs = chatOwnerIds.some((ownerId) => ownerId in openTabs);
        if (
          !hasTickets &&
          !hasLabels &&
          !hasArchived &&
          !hasFilter &&
          !hasSelection &&
          !hasChatTabs
        )
          return;

        teardownProjectChatTabs(projectId, ticketsByProject[projectId] ?? [], options);
        sourceFor(projectId).close(projectId);

        const nextTickets = { ...ticketsByProject };
        delete nextTickets[projectId];
        const nextLabels = { ...labelsByProject };
        delete nextLabels[projectId];
        const nextArchived = { ...archivedByProject };
        delete nextArchived[projectId];
        const nextFilter = { ...filterByProject };
        delete nextFilter[projectId];
        const nextSelected = { ...selectedByProject };
        delete nextSelected[projectId];
        set({
          ticketsByProject: nextTickets,
          labelsByProject: nextLabels,
          archivedByProject: nextArchived,
          filterByProject: nextFilter,
          selectedByProject: nextSelected,
        });
      },
    };
  });
}

/** App-wide singleton; components import this directly. */
export const useBoardStore = createBoardStore();
installLocalBoard(useBoardStore);
