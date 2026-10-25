/**
 * The cloud board through the real transport (VC-889): two windows ("Mac A"
 * and "Mac B") signed in as the same person, each a real Convex React client
 * on the pinned local backend, the first through this window's own client
 * glue (`startCloudClient`), board source and link source.
 *
 * Mac A's WebSocket can be cut: a wrapper over the platform's WebSocket that
 * the test severs and restores, so the real protocol keeps running.
 *
 * The offline relaunch (D3) runs the same way: a first launch keeps its board,
 * a second launches with the backend unreachable (its socket cut from the
 * start: the fixture owns the backend process, so "the backend is down" is a
 * socket that reaches nothing), shows the kept board read-only, and goes live
 * when the socket is restored.
 *
 * Runs only under the fixture, which hands it the backend's URL and the test
 * issuer's key: CI's `Convex (codegen + backend)` lane runs it so (and
 * requires it to run); it skips everywhere else, the desktop lanes included.
 *
 *   pnpm -C convex with-backend --deploy -- \
 *     sh -c 'cd ../apps/desktop && vp test run src/renderer/src/stores/cloud-board/convex.live.test.ts'
 */
import { inviteTestEmail } from "../../../../main/test-helpers/preview";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { api } from "@volli/convex/api";
import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION } from "@volli/shared";
import type { AccountAccessToken, Label, Project, Ticket } from "@volli/shared";

import { DEV_AUDIENCE, DEV_ISSUER, DEV_KEY_ID } from "../../../../main/account/dev-issuer";
import { signEs256Jwt } from "../../../../main/account/jwt";
import {
  closeCloudClient,
  startCloudClient,
  type CloudClientDeps,
  type CloudSession,
} from "@renderer/lib/cloud-client";

import { createCloudHostSource, createCloudLinkInputStore } from "../cloud-link";
import { CLOUD_HOST_ID, createHostConnectionStore, type HostLinkView } from "../host-connection";
import { decodeBoardSnapshot, liveBoardSnapshot, type BoardSnapshot } from "./snapshot";
import { ConvexBoardSource } from "./source";
import { followCloudWorkspace, useCloudWorkspaceStore } from "./workspace";

const url = process.env["VOLLI_CONVEX_URL"];
const privateKeyPem = process.env["VOLLI_CONVEX_TEST_PRIVATE_KEY"];

// CI's Convex lane sets this: there the test must run, never skip.
if (
  process.env["VOLLI_CLOUD_BOARD_LIVE_REQUIRED"] === "1" &&
  (url === undefined || privateKeyPem === undefined)
) {
  throw new Error("The live board test needs the fixture: run it under `with-backend --deploy`.");
}

function token(subject: string, ttlSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  return signEs256Jwt(privateKeyPem!, DEV_KEY_ID, {
    iss: DEV_ISSUER,
    aud: DEV_AUDIENCE,
    sub: subject,
    iat: now,
    exp: now + ttlSeconds,
    name: "Live Dana",
    email: `${subject}@example.com`,
    email_verified: true,
  });
}

/** A WebSocket constructor the test can sever and restore; the real protocol runs over it. */
function cuttableWebSocket() {
  const live = new Set<WebSocket>();
  let cut = false;
  class Cuttable extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      // Cut: every new attempt goes nowhere and fails like a dead network.
      super(cut ? "ws://127.0.0.1:9/" : address, protocols);
      live.add(this);
      this.addEventListener("close", () => live.delete(this));
    }
  }
  return {
    WebSocket: Cuttable as unknown as typeof WebSocket,
    cut() {
      cut = true;
      for (const socket of live) socket.close();
    },
    restore() {
      cut = false;
    },
  };
}

const SERVING = { status: "open" } as const;

/** Client glue over `socket`, signed in as `subject`, its token door always answering. */
function windowDeps(
  socket: ReturnType<typeof cuttableWebSocket>,
  inputs: ReturnType<typeof createCloudLinkInputStore>,
  subject: string,
): CloudClientDeps {
  return {
    load: async () => ({
      ConvexReactClient: class extends ConvexReactClient {
        constructor(address: string, options: { unsavedChangesWarning: boolean }) {
          super(address, { ...options, webSocketConstructor: socket.WebSocket });
        }
      } as never,
      api,
    }),
    account: {
      accessToken: async (): Promise<AccountAccessToken> => ({
        kind: "token",
        token: token(subject),
        expiresAt: Date.now() + 3_600_000,
      }),
      subscribe: () => ({ unsubscribe: () => {} }),
    },
    window: {
      navigator: { onLine: true },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    inputs: inputs.getState(),
    reportUnsavedWrites: vi.fn(),
    clock: {
      now: () => Date.now(),
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
  };
}

/**
 * One launch's cloud board, as boot wires it: the client, the board source,
 * the Workspace follower and Volli Cloud's link, over in-test stores.
 */
async function launchWindow(
  subject: string,
  socket: ReturnType<typeof cuttableWebSocket>,
  kept: string | null,
) {
  const inputs = createCloudLinkInputStore();
  const session = await startCloudClient(
    { store: "cloud", userId: subject, backendUrl: url! },
    windowDeps(socket, inputs, subject),
  );
  const boards = new Map<string, { tickets: Ticket[]; labels: Label[] }>();
  const projectState = {
    projects: [] as Project[],
    selectedProjectId: null as string | null,
    hydrateCloud: (_workspaceId: string, projects: Project[], selected: string | null) => {
      projectState.projects = projects;
      projectState.selectedProjectId = selected;
    },
    clearCloud: () => {
      projectState.projects = [];
      projectState.selectedProjectId = null;
    },
    showCloudSnapshot: (_workspaceId: string, projects: Project[], selected: string | null) => {
      projectState.projects = projects;
      projectState.selectedProjectId = selected;
    },
  };
  const projects = { getState: () => projectState, subscribe: () => () => {} };
  const hosts = createHostConnectionStore();
  const stopHosts = hosts.getState().attach(createCloudHostSource({ projects, inputs }));
  const view = {
    paint: (id: string, tickets: Ticket[], labels: Label[]) =>
      void boards.set(id, { tickets, labels }),
    notePlanningChange: vi.fn(),
    failed: vi.fn(),
    refused: vi.fn(),
    unconfirmed: vi.fn(),
    readOnly: (id: string) =>
      hosts.getState().projects[id]?.link.status === "open" ? null : "Read-only",
    dropped: vi.fn(),
  };
  const source = new ConvexBoardSource(view, subject);
  source.attach(session);
  const stopFollowing = followCloudWorkspace({
    follow: (listener: (next: CloudSession | null) => void) => {
      listener(session);
      return () => {};
    },
    projects,
    board: {
      seedProject: (projectId) => void source.open(projectId),
      forget: (projectId) => {
        boards.delete(projectId);
        source.close(projectId);
      },
      paintBoard: (projectId, tickets, labels) => void boards.set(projectId, { tickets, labels }),
    },
    workspace: useCloudWorkspaceStore,
    persisted: null,
    failed: vi.fn(),
    notice: vi.fn(),
    offline: {
      afterMs: 1_000,
      snapshot: async () => decodeBoardSnapshot(kept, subject),
      shown: (savedAt) => inputs.getState().update({ snapshotAt: savedAt }),
      follow: (projectId) => void source.open(projectId),
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  const close = () => {
    stopFollowing();
    source.closeAll();
    stopHosts();
    closeCloudClient();
    useCloudWorkspaceStore.setState({ workspace: null });
  };
  return {
    session,
    source,
    view,
    boards,
    projectState,
    close,
    link: (projectId: string): HostLinkView => hosts.getState().projects[projectId]!.link,
    /** The board this window would keep now, if it is the live one. */
    keep: (): BoardSnapshot | null =>
      liveBoardSnapshot({
        userId: subject,
        savedAt: Date.now(),
        link: inputs.getState().input,
        workspace: useCloudWorkspaceStore.getState().workspace,
        projects: projectState.projects,
        ticketsByProject: Object.fromEntries([...boards].map(([id, board]) => [id, board.tickets])),
        labelsByProject: Object.fromEntries([...boards].map(([id, board]) => [id, board.labels])),
        painted: (projectId) => source.painted(projectId),
      }),
  };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe.skipIf(url === undefined || privateKeyPem === undefined)(
  "the cloud board against the pinned local backend",
  () => {
    it("shows two windows the same live board, writes optimistically, and goes read-only when cut", async () => {
      const subject = `live-board-${randomUUID()}`;
      // Setup, as the person: their account, their Workspace, a project and a ticket.
      const http = new ConvexHttpClient(url!);
      http.setAuth(token(subject));
      await inviteTestEmail(url!, `${subject}@example.com`);
      await http.mutation(api.accounts.ensureViewer, {
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
      });
      const [workspace] = await http.query(api.workspaces.listMine, {});
      const projectId = randomUUID();
      await http.mutation(api.projects.create, {
        commandId: randomUUID(),
        workspaceId: workspace!.workspaceId,
        projectId,
        name: "Live board",
        ticketPrefix: "LIVE",
        origin: "promoted_local",
      });
      const first = randomUUID();
      await http.mutation(api.board.createTicket, {
        commandId: randomUUID(),
        projectId,
        ticketId: first,
        status: "todo",
        title: "On both Macs",
        labels: ["shared"],
      });

      // Mac B: a plain client, watching the roster.
      const macB = new ConvexReactClient(url!, { unsavedChangesWarning: false });
      cleanups.push(() => macB.close());
      macB.setAuth(async () => token(subject));
      const watchB = macB.watchQuery(api.board.roster, { projectId });
      const rosterB = () => watchB.localQueryResult();
      cleanups.push(watchB.onUpdate(() => {}));

      // Mac A: this window's own glue, with a cuttable socket and main's token door.
      const socket = cuttableWebSocket();
      const inputs = createCloudLinkInputStore();
      let offlineTokens = false;
      let askedWhileCut = 0;
      const deps: CloudClientDeps = {
        load: async () => ({
          ConvexReactClient: class extends ConvexReactClient {
            constructor(address: string, options: { unsavedChangesWarning: boolean }) {
              super(address, { ...options, webSocketConstructor: socket.WebSocket });
            }
          } as never,
          api,
        }),
        account: {
          accessToken: async (): Promise<AccountAccessToken> => {
            // While cut, main cannot refresh: unavailable, never signed out.
            if (offlineTokens) {
              askedWhileCut += 1;
              return { kind: "unavailable", retryAfterMs: 500 };
            }
            // Short-lived, so the client asks for a fresh one while it is cut.
            return { kind: "token", token: token(subject, 12), expiresAt: Date.now() + 12_000 };
          },
          subscribe: (handlers) => {
            handlers.onData({
              state: "signed-in",
              provider: "dev",
              signingInWith: null,
              account: {
                displayName: "Live Dana",
                email: null,
                userId: null,
                deletionPurgeAfter: null,
                backend: "synced",
              },
              failure: null,
            });
            return { unsubscribe: () => {} };
          },
        },
        window: {
          navigator: { onLine: true },
          addEventListener: () => {},
          removeEventListener: () => {},
        },
        inputs: inputs.getState(),
        reportUnsavedWrites: vi.fn(),
        clock: {
          now: () => Date.now(),
          setTimeout: (run, ms) => setTimeout(run, ms),
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
          setInterval: (run, ms) => setInterval(run, ms),
          clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
        },
      };
      const session = await startCloudClient(
        { store: "cloud", userId: "unchecked", backendUrl: url! },
        deps,
      );
      cleanups.push(() => closeCloudClient());
      const mutation = vi.spyOn(session.client, "mutation");

      const projects = {
        getState: () => ({ projects: [{ id: projectId }] }),
        subscribe: () => () => {},
      };
      const hosts = createHostConnectionStore();
      cleanups.push(hosts.getState().attach(createCloudHostSource({ projects, inputs })));
      const link = (): HostLinkView => hosts.getState().projects[projectId]!.link;

      const painted = new Map<string, { tickets: Ticket[]; labels: Label[] }>();
      const view = {
        paint: (id: string, tickets: Ticket[], labels: Label[]) =>
          void painted.set(id, { tickets, labels }),
        notePlanningChange: vi.fn(),
        failed: vi.fn(),
        refused: vi.fn(),
        unconfirmed: vi.fn(),
        readOnly: (id: string) =>
          hosts.getState().projects[id]?.link.status === "open" ? null : "Read-only",
        dropped: vi.fn(),
      };
      const source = new ConvexBoardSource(view, subject);
      source.attach(session);
      await source.open(projectId);
      cleanups.push(() => source.closeAll());

      // Both Macs see the same roster.
      await vi.waitFor(() => expect(painted.get(projectId)?.tickets).toHaveLength(1), {
        timeout: 15_000,
      });
      await vi.waitFor(() => expect(rosterB()?.tickets).toHaveLength(1), { timeout: 15_000 });
      expect(painted.get(projectId)!.tickets[0]).toMatchObject({
        id: first,
        title: "On both Macs",
        labels: ["shared"],
        ticketNumber: 1,
        worktreePath: null,
      });
      await vi.waitFor(() => expect(link()).toEqual(SERVING), { timeout: 15_000 });
      expect(hosts.getState().hosts[0]!.id).toBe(CLOUD_HOST_ID);

      // A change made elsewhere reaches both.
      const third = randomUUID();
      await http.mutation(api.board.createTicket, {
        commandId: randomUUID(),
        projectId,
        ticketId: third,
        status: "doing",
        title: "From a third client",
      });
      await vi.waitFor(() => expect(painted.get(projectId)?.tickets).toHaveLength(2), {
        timeout: 15_000,
      });
      await vi.waitFor(() => expect(rosterB()?.tickets).toHaveLength(2), { timeout: 15_000 });

      // Cut Mac A: reconnecting, then offline (read-only) after the grace; the cache stays.
      offlineTokens = true;
      socket.cut();
      await vi.waitFor(() => expect(link().status).toBe("reconnecting"), { timeout: 5_000 });
      await vi.waitFor(() => expect(link().status).toBe("offline"), { timeout: 10_000 });
      expect(painted.get(projectId)?.tickets).toHaveLength(2);
      expect(hosts.getState().projects[projectId]!.link.status).toBe("offline");
      // Every write refuses, and none reaches the client.
      await source.moveTickets(projectId, [first], "done", 0);
      expect(view.refused).toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();

      // Meanwhile the board moves on without Mac A; its token expires while cut.
      await http.mutation(api.board.moveTickets, {
        commandId: randomUUID(),
        projectId,
        ticketIds: [first],
        toStatus: "done",
      });
      await vi.waitFor(() => expect(askedWhileCut).toBeGreaterThan(0), { timeout: 15_000 });
      expect(painted.get(projectId)!.tickets.find(({ id }) => id === first)?.status).toBe("todo");
      expect(painted.get(projectId)?.tickets).toHaveLength(2);

      // Restore: Mac A re-authenticates, reconnects, catches up, and serves again.
      offlineTokens = false;
      socket.restore();
      await vi.waitFor(() => expect(link()).toEqual(SERVING), { timeout: 30_000 });
      await vi.waitFor(
        () =>
          expect(painted.get(projectId)!.tickets.find(({ id }) => id === first)?.status).toBe(
            "done",
          ),
        { timeout: 15_000 },
      );
      expect(view.failed).not.toHaveBeenCalled();
      expect(inputs.getState().input.authenticated).toBe(true);

      // A move paints at once, with the keys the backend then confirms; Mac B sees it.
      const position = () => painted.get(projectId)!.tickets.find(({ id }) => id === first)!;
      const moving = source.moveTickets(projectId, [first], "todo", 0);
      const optimistic = { ...position() };
      expect(optimistic.status).toBe("todo");
      await moving;
      expect(view.failed).not.toHaveBeenCalled();
      const confirmed = await http.query(api.board.getTicket, { ticketId: first });
      expect(confirmed.ticket.status).toBe("todo");
      await vi.waitFor(
        () =>
          expect(rosterB()?.tickets.find(({ id }) => id === first)?.position).toBe(
            confirmed.ticket.position,
          ),
        { timeout: 15_000 },
      );
      // The confirmed rows replaced the optimistic ones with nothing moving.
      expect(position()).toMatchObject({ status: optimistic.status, order: optimistic.order });

      // A write in flight when the socket drops lands exactly once after the restore.
      const inFlight = source.moveTickets(projectId, [third], "done", 0);
      socket.cut();
      await new Promise((resolve) => setTimeout(resolve, 500));
      socket.restore();
      await inFlight;
      await vi.waitFor(
        () => expect(rosterB()?.tickets.find(({ id }) => id === third)?.status).toBe("done"),
        { timeout: 30_000 },
      );
      const history = await http.query(api.board.ticketEvents, { ticketId: third });
      expect(
        history.filter(({ payload }) => (payload as { kind: string }).kind === "status_changed"),
      ).toHaveLength(1);
      expect(view.failed).not.toHaveBeenCalled();
    }, 120_000);

    it("shows the last-seen board when a relaunch cannot reach the backend, then goes live", async () => {
      const subject = `live-snapshot-${randomUUID()}`;
      const http = new ConvexHttpClient(url!);
      http.setAuth(token(subject));
      await inviteTestEmail(url!, `${subject}@example.com`);
      await http.mutation(api.accounts.ensureViewer, {
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
      });
      const [workspace] = await http.query(api.workspaces.listMine, {});
      const projectId = randomUUID();
      await http.mutation(api.projects.create, {
        commandId: randomUUID(),
        workspaceId: workspace!.workspaceId,
        projectId,
        name: "Snapshot board",
        ticketPrefix: "SNAP",
        origin: "blank",
      });
      const ticketId = randomUUID();
      await http.mutation(api.board.createTicket, {
        commandId: randomUUID(),
        projectId,
        ticketId,
        status: "todo",
        title: "Seen before the outage",
      });

      // Launch 1, online: the live board settles, and its snapshot is kept.
      const first = await launchWindow(subject, cuttableWebSocket(), null);
      cleanups.push(() => first.close());
      await vi.waitFor(() => expect(first.boards.get(projectId)?.tickets).toHaveLength(1), {
        timeout: 15_000,
      });
      await vi.waitFor(() => expect(first.keep()).not.toBeNull(), { timeout: 15_000 });
      // The writer's text: the board as JSON (its cards carry no bodies here).
      const kept = JSON.stringify(first.keep()!);
      const savedAt = decodeBoardSnapshot(kept, subject)!.savedAt;
      first.close();

      // The board moves on while this Mac is away.
      await http.mutation(api.board.moveTickets, {
        commandId: randomUUID(),
        projectId,
        ticketIds: [ticketId],
        toStatus: "done",
      });

      // Launch 2, the backend unreachable: the kept board, read-only, saying how old.
      const socket = cuttableWebSocket();
      socket.cut();
      const second = await launchWindow(subject, socket, kept);
      cleanups.push(() => second.close());
      await vi.waitFor(() => expect(second.projectState.projects).toHaveLength(1), {
        timeout: 10_000,
      });
      expect(second.projectState.selectedProjectId).toBe(projectId);
      expect(useCloudWorkspaceStore.getState().workspace?.id).toBe(workspace!.workspaceId);
      expect(second.boards.get(projectId)?.tickets).toMatchObject([
        { id: ticketId, title: "Seen before the outage", status: "todo", body: "" },
      ]);
      expect(second.link(projectId)).toMatchObject({ status: "offline", asOf: savedAt });
      // Nothing is written from the snapshot, and every write refuses.
      expect(second.keep()).toBeNull();
      const mutation = vi.spyOn(second.session.client, "mutation");
      await second.source.moveTickets(projectId, [ticketId], "doing", 0);
      expect(second.view.refused).toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();

      // The backend is back: the live board replaces the snapshot, no relaunch.
      socket.restore();
      await vi.waitFor(() => expect(second.link(projectId)).toEqual(SERVING), { timeout: 30_000 });
      await vi.waitFor(
        () => expect(second.boards.get(projectId)?.tickets[0]?.status).toBe("done"),
        { timeout: 15_000 },
      );
      expect(second.source.painted(projectId)).toBe(true);
      expect(second.keep()?.boards[projectId]?.tickets[0]?.status).toBe("done");
      expect(second.view.failed).not.toHaveBeenCalled();
    }, 120_000);
  },
);
