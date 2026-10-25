/**
 * The cloud board through the real transport (VC-889): two windows ("Mac A"
 * and "Mac B") signed in as the same person, each a real Convex React client
 * on the pinned local backend, the first through this window's own client
 * glue (`startCloudClient`), board source and link source.
 *
 * Mac A's WebSocket can be cut: a wrapper over the platform's WebSocket that
 * the test severs and restores, so the real protocol keeps running.
 *
 * Runs only under the fixture, which hands it the backend's URL and the test
 * issuer's key: CI's `Convex (codegen + backend)` lane runs it so (and
 * requires it to run); it skips everywhere else, the desktop lanes included.
 *
 *   pnpm -C convex with-backend --deploy -- \
 *     sh -c 'cd ../apps/desktop && vp test run src/renderer/src/stores/cloud-board/convex.live.test.ts'
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { api } from "@volli/convex/api";
import type { AccountAccessToken, Label, Ticket } from "@volli/shared";

import { DEV_AUDIENCE, DEV_ISSUER, DEV_KEY_ID } from "../../../../main/account/dev-issuer";
import { signEs256Jwt } from "../../../../main/account/jwt";
import {
  closeCloudClient,
  startCloudClient,
  type CloudClientDeps,
} from "@renderer/lib/cloud-client";

import { createCloudHostSource, createCloudLinkInputStore } from "../cloud-link";
import { CLOUD_HOST_ID, createHostConnectionStore, type HostLinkView } from "../host-connection";
import { ConvexBoardSource } from "./source";

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

const SERVING = { status: "incompatible", reason: "writes-unavailable" } as const;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe.skipIf(url === undefined || privateKeyPem === undefined)(
  "the cloud board against the pinned local backend",
  () => {
    it("shows two windows the same live board, and goes read-only, cache intact, when cut", async () => {
      const subject = `live-board-${randomUUID()}`;
      // Setup, as the person: their account, their Workspace, a project and a ticket.
      const http = new ConvexHttpClient(url!);
      http.setAuth(token(subject));
      await http.mutation(api.accounts.ensureViewer, {});
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

      const painted = new Map<string, { tickets: Ticket[]; labels: Label[] }>();
      const view = {
        paint: (id: string, tickets: Ticket[], labels: Label[]) =>
          void painted.set(id, { tickets, labels }),
        notePlanningChange: vi.fn(),
        failed: vi.fn(),
        refused: vi.fn(),
        dropped: vi.fn(),
      };
      const source = new ConvexBoardSource(view);
      source.attach(session);
      await source.open(projectId);
      cleanups.push(() => source.closeAll());

      const projects = {
        getState: () => ({ projects: [{ id: projectId }] }),
        subscribe: () => () => {},
      };
      const hosts = createHostConnectionStore();
      cleanups.push(hosts.getState().attach(createCloudHostSource({ projects, inputs })));
      const link = (): HostLinkView => hosts.getState().projects[projectId]!.link;

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
      // Serving, read-only until this build writes to cloud boards.
      await vi.waitFor(() => expect(link()).toEqual(SERVING), { timeout: 15_000 });
      expect(hosts.getState().hosts[0]!.id).toBe(CLOUD_HOST_ID);

      // A change made elsewhere reaches both.
      await http.mutation(api.board.createTicket, {
        commandId: randomUUID(),
        projectId,
        ticketId: randomUUID(),
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
    }, 90_000);
  },
);
