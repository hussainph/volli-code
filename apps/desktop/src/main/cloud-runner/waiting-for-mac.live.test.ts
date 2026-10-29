/**
 * A live two-client runner integration against the pinned local backend
 * (VC-895 N2-3): "Waiting for <Mac>", and back. Plain Node, not Electron:
 * the two-window UI acceptance journey is a separate volli-drive smoke.
 *
 * - **Mac A** is this Mac as a runner, composed the way desktop main composes
 *   it: the dev sign-in, `createDesktopMacRunner` (registration with the
 *   person's token, the sealed link in a real inventory, the `/runner/token`
 *   exchange, presence, the power cycle under `watchSleep`) and, as its
 *   `sync`, the real fact drain and inbox worker under `startRunnerSync` over
 *   the runner's own backend link. Its Session is written by the real Session
 *   Engine (an in-memory ledger stands in for SQLite) and reaches the backend
 *   only through that drain's `sessions.accept`.
 * - **Mac B** is the same person's other client: a Convex React client with
 *   the app's own `CloudSessionSource` for the listing and `runners.places`
 *   for the Session's Place, read through the shared `sessionPlaceState` /
 *   `pendingCommandLabel` words the renderer shows.
 *
 * 1. A Session started on Mac A shows on Mac B, "Running on <Mac A>".
 * 2. Mac A sleeps. **SIMULATED**: the desktop's dual-locked smoke seam
 *    (`smoke-power.ts`, the same code main installs under
 *    `VOLLI_SMOKE_CLOUD_RUNNER_POWER=1`) emits the real `suspend`, lets the
 *    `asleep` report land, then holds Mac A's runner transport down. The
 *    process is not frozen and no OS sleep happens; a real lid test is the
 *    owner's, on hardware. Mac B reads "Waiting for <Mac A> — asleep since …".
 * 3. Mac B sends a command; it waits in the inbox ("Sent — waiting for
 *    <Mac A>") and is not claimed. This isolates `session.retitle` control
 *    delivery; the two-window UI smoke separately covers a real chat message.
 * 4. Mac A wakes (the seam releases its transport and emits the real
 *    `resume`): it is online again, claims the command, applies it through
 *    its Session Engine, and the drain ships the facts. Mac B catches up.
 *
 * The command's executor is this test's: it applies the intent the way the
 * cloud store's `registerSessionCommandJob` does for `session.retitle`
 * (`engine.submit`), without a live Pi runtime.
 *
 * Runs only under the fixture, which hands it the backend's URLs, the test
 * issuer's key and the admin key (preview enrollment only). CI's
 * `Convex (codegen + backend)` lane runs it with
 * `VOLLI_CLOUD_SESSION_LIVE_REQUIRED=1` (it then fails rather than skips);
 * it skips everywhere else.
 *
 *   pnpm -C convex with-backend --deploy -- \
 *     sh -c 'cd ../apps/desktop && vp test run src/main/cloud-runner/waiting-for-mac.live.test.ts'
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@volli/convex/api";
import {
  acceptOverLink,
  createFactDrain,
  createInboxWorker,
  inboxOverLink,
  startRunnerSync,
  type CloudRunnerSyncConnection,
  type DrainCursor,
  type FactDrain,
  type InboxWake,
  type JobJournalEntry,
} from "@volli/host-core/cloud-runner";
import type { PowerPort } from "@volli/host-core/ports";
import { createSessionEngine } from "@volli/session-engine";
import { createInMemorySessionLedger } from "@volli/session-engine/testing";
import {
  decodeSessionCommandIntent,
  PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  type SessionAttachment,
  type SessionEvent,
  type SessionEventProvenance,
  type ThisMacRunnerSnapshot,
} from "@volli/shared";
import {
  parseJobPayload,
  pendingCommandLabel,
  SESSION_COMMAND_FORMAT,
  sessionPlaceState,
  type RunnerPlace,
} from "@volli/shared/cloud";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CloudSessionRow } from "@renderer/lib/cloud-session-listing";
import { CloudSessionSource } from "@renderer/lib/cloud-session-source";
import { convexAccountBackend } from "../account/backend";
import { devIssuerProvider } from "../account/dev-issuer";
import { createAccountService } from "../account/service";
import { inventoryAccountSessionStore } from "../account/session-store";
import { tempInventory } from "../account/test-support";
import { inviteTestEmail } from "../test-helpers/preview";
import { createDesktopMacRunner } from "./index";
import type { MacRunner } from "./mac-runner";
import { runnerSleepSimulation } from "./smoke-power";

const url = process.env["VOLLI_CONVEX_URL"];
const siteUrl = process.env["VOLLI_CONVEX_SITE_URL"];
const privateKeyPem = process.env["VOLLI_CONVEX_TEST_PRIVATE_KEY"];
const fixture =
  url !== undefined &&
  siteUrl !== undefined &&
  privateKeyPem !== undefined &&
  process.env["VOLLI_CONVEX_ADMIN_KEY"] !== undefined;

// CI's Convex lane sets this: there the test must run, never skip.
if (process.env["VOLLI_CLOUD_SESSION_LIVE_REQUIRED"] === "1" && !fixture) {
  throw new Error(
    "The live Waiting-for-Mac test needs the fixture: run it under `with-backend --deploy`.",
  );
}

const WAIT = { timeout: 20_000, interval: 50 };
/** How long a command must sit unclaimed while Mac A sleeps. */
const ASLEEP_HOLD_MS = 3_000;
const RENAMED = "Renamed on Mac B";

const venue = { id: "local", kind: "local" } as const;
const userProvenance: SessionEventProvenance = {
  source: { kind: "user", id: "desktop", detail: { sessionOrigin: { kind: "user" } } },
  venue,
};
const adapterProvenance: SessionEventProvenance = {
  source: { kind: "adapter", id: "pi", detail: { channel: "rpc" } },
  venue,
};

/** The test executor's refusal of a job it was not written for. */
const unexpected = (detail: string) =>
  ({ status: "failed", code: "unexpected", detail, retryable: false }) as const;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Resolves once the runner's snapshot satisfies `test`. */
function until(
  runner: MacRunner,
  test: (snapshot: ThisMacRunnerSnapshot) => boolean,
  timeoutMs = 20_000,
): Promise<ThisMacRunnerSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out at ${JSON.stringify(runner.snapshot())}`)),
      timeoutMs,
    );
    const off = runner.subscribe((snapshot) => {
      if (!test(snapshot)) return;
      clearTimeout(timer);
      queueMicrotask(() => off());
      resolve(snapshot);
    });
  });
}

/**
 * Mac A's Session ledger: the real Session Engine over an in-memory ledger,
 * mirrored into the synchronous reads the drain makes (SQLite's, in the app).
 */
function macALedger() {
  let now = Date.now();
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock: { now: () => now++ },
    ids: { next: () => randomUUID() },
  });
  const mirror = new Map<string, readonly SessionEvent[]>();
  return {
    engine,
    tick: () => now++,
    /** Re-reads a Session's events after a write, for the drain. */
    async refresh(sessionId: string) {
      mirror.set(sessionId, await engine.listEvents({ sessionId }));
    },
    drainLedger: {
      listEvents: ({
        sessionId,
        afterSequence,
        limit,
      }: {
        sessionId: string;
        afterSequence: number;
        limit: number;
      }) =>
        (mirror.get(sessionId) ?? [])
          .filter(({ sequence }) => sequence > afterSequence)
          .slice(0, limit),
      latestEventSequence: (sessionId: string) => mirror.get(sessionId)?.at(-1)?.sequence ?? 0,
    },
  };
}

describe.skipIf(!fixture)(
  "Waiting for <Mac>, and back, against the pinned local backend (SIMULATED sleep: power events + held runner transport)",
  () => {
    it("Mac B sees Mac A's Session live, waiting while it sleeps, its command queued, then caught up on wake", async () => {
      const subject = `live-wake-${randomUUID()}`;
      const email = `${subject}@example.com`;
      await inviteTestEmail(url!, email);

      // The person signs in on Mac A, as Settings → Account does.
      const temp = tempInventory();
      cleanups.push(temp.dispose);
      const account = createAccountService({
        enabled: () => true,
        provider: devIssuerProvider({
          privateKeyPem: privateKeyPem!,
          subject,
          displayName: "Live Wake",
          email,
        }),
        backend: convexAccountBackend({ url: url! }),
        store: inventoryAccountSessionStore(temp.inventory, async () => {}),
        openBrowser: async (target) => {
          const location = (await fetch(target, { redirect: "manual" })).headers.get("location");
          if (location !== null) await fetch(location);
        },
      });
      cleanups.push(() => account.dispose());
      account.snapshot();
      await account.settled();
      await account.signIn("github", undefined, PREVIEW_ENROLLMENT_AGREEMENT_VERSION);
      await account.settled();
      const userId = account.snapshot().account!.userId!;

      // Setup as the person: a project in their Workspace.
      const person = new ConvexHttpClient(url!);
      person.setAuth((await account.accessToken())!);
      const [workspace] = await person.query(api.workspaces.listMine, {});
      const projectId = randomUUID();
      await person.mutation(api.projects.create, {
        commandId: randomUUID(),
        workspaceId: workspace!.workspaceId,
        projectId,
        name: "Waiting for Mac",
        ticketPrefix: "WAIT",
        origin: "blank",
      });

      // Mac A: the runner, with the real drain and inbox as its sync.
      const ledger = macALedger();
      // A holder, not a `let`: the runner assigns it from inside its connection.
      const composed: { sync: { drain: FactDrain; inboxRuns: string[] } | null } = { sync: null };
      const cursors = new Map<string, DrainCursor>();
      const journal = new Map<string, JobJournalEntry>();
      const syncFor: Parameters<typeof createDesktopMacRunner>[0]["sync"] = (parts) => {
        const drain = createFactDrain({
          ledger: ledger.drainLedger,
          cursors: {
            list: () => [...cursors.values()],
            get: (sessionId) => cursors.get(sessionId) ?? null,
            save: (cursor) => void cursors.set(cursor.sessionId, cursor),
            update: (cursor, expected) => {
              const row = cursors.get(cursor.sessionId);
              if (
                row?.ownerUserId !== cursor.ownerUserId ||
                row.generation !== expected.generation ||
                row.acceptedThrough !== expected.acceptedThrough
              ) {
                return false;
              }
              cursors.set(cursor.sessionId, cursor);
              return true;
            },
          },
          accept: acceptOverLink(parts.link),
          ownerUserId: userId,
        });
        const inbox = createInboxWorker({
          backend: inboxOverLink(parts.link),
          journal: {
            get: (jobId) => journal.get(jobId) ?? null,
            save: (entry) => void journal.set(entry.jobId, { ...entry }),
            unreported: () => [...journal.values()].filter(({ outcome }) => outcome !== null),
            remove(jobId, attempt) {
              if (journal.get(jobId)?.lease.attempt === attempt) journal.delete(jobId);
            },
          },
          // `wakeOverLink`: the backend's ready-jobs subscription.
          wake: (onChange) =>
            parts.link.subscribe("runnerJobs:wake", {}, (value) => onChange(value as InboxWake)),
          bootId: parts.bootId,
        });
        const inboxRuns: string[] = [];
        // As `registerSessionCommandJob` applies `session.retitle`: through the engine.
        inbox.register("session.command", async (claimed) => {
          const { job } = claimed;
          inboxRuns.push(job.id);
          const payload = parseJobPayload("session.command", job.payload);
          if (payload.format !== SESSION_COMMAND_FORMAT) return unexpected(payload.format);
          const intent = decodeSessionCommandIntent(JSON.parse(payload.intent), "test job intent");
          if (intent.kind !== "session.retitle" || job.sessionId === null || job.commandId === null)
            return unexpected(intent.kind);
          await ledger.engine.submit({
            commandId: job.commandId,
            sessionId: job.sessionId,
            intent,
            provenance: userProvenance,
          });
          await ledger.refresh(job.sessionId);
          drain.nudge(job.sessionId);
          return { status: "done", result: null };
        });
        composed.sync = { drain, inboxRuns };
        let running: ReturnType<typeof startRunnerSync> | null = null;
        const connection: CloudRunnerSyncConnection = {
          start() {
            running ??= startRunnerSync({
              link: parts.link,
              drain,
              inbox,
              presence: parts.presence,
            });
          },
          waiting: () => drain.status().waiting,
          // As the cloud store's: the connector pauses claims before the asleep
          // report and resumes (renew, then claim, then drain) after the wake.
          suspend: () => running?.suspend(),
          async resume() {
            await running?.resume();
          },
          async stop() {
            await running?.stop();
          },
          async close() {
            inbox.stop();
            drain.stop();
            await parts.link.close();
            await parts.presence.stop();
          },
        };
        return connection;
      };

      const power = new EventEmitter() as EventEmitter & PowerPort;
      // The smoke seam main installs under its two locks; here, both given.
      const simulation = runnerSleepSimulation({
        dev: true,
        env: { VOLLI_SMOKE_CLOUD_RUNNER_POWER: "1" },
        emit: (event) => void power.emit(event),
      })!;
      let row: string | undefined;
      const macA = createDesktopMacRunner({
        deployment: "cloud",
        userId,
        backendUrl: url!,
        siteUrl: siteUrl!,
        convex: { ConvexClient, makeFunctionReference },
        account,
        inventory: temp.inventory,
        unlockInventory: async () => {},
        recordRow: () => ({ read: () => row, write: (value) => void (row = value) }),
        power,
        liveWork: () => ({ turns: 0, shells: 0 }),
        dataDir: temp.dir,
        appVersion: "0.0.0-live",
        packaged: false,
        browser: () => ({ state: "available", backend: "electron" }),
        sync: syncFor,
        connectionTransform: simulation.wrap,
        log: { info: () => {}, warn: () => {} },
      });
      cleanups.push(() => macA.stop());
      macA.start();
      const online = await until(macA, (snapshot) => snapshot.state === "online");
      const runnerId = online.runnerId!;
      const runnerName = online.runnerName!;
      expect(runnerName).toMatch(/-dev$/u);
      expect(composed.sync).not.toBeNull();
      const { drain, inboxRuns } = composed.sync!;

      // 1. A Session on Mac A: born, attached; its facts reach the backend only
      //    through the drain (the first accept registers it, runner-originated).
      const sessionId = randomUUID();
      await ledger.engine.createSession({
        commandId: randomUUID(),
        requestedSessionId: sessionId,
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Started on Mac A",
        provenance: userProvenance,
      });
      const start = await ledger.engine.submit({
        commandId: randomUUID(),
        sessionId,
        intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
        provenance: userProvenance,
      });
      const attachment: SessionAttachment = {
        id: randomUUID(),
        sessionId,
        adapterId: "pi",
        venue,
        continuity: "fresh",
        native: { id: "native-1", detail: { file: "pi.jsonl" } },
        authority: null,
      };
      await ledger.engine.observe({
        id: randomUUID(),
        sessionId,
        occurredAt: ledger.tick(),
        provenance: adapterProvenance,
        kind: "attachment.opened",
        commandId: start.command.id,
        attachment,
      } as never);
      await ledger.refresh(sessionId);
      drain.adopt(sessionId, 1);
      drain.nudge(sessionId);

      // Mac B: the same person's window, its listing and the Session's Place.
      const macB = new ConvexReactClient(url!, { unsavedChangesWarning: false });
      cleanups.push(() => macB.close());
      macB.setAuth(async () => account.accessToken());
      const sent = new Map<string, readonly CloudSessionRow[]>();
      const listingFailed = vi.fn();
      const source = new CloudSessionSource(
        { client: macB, api },
        (id, _rows, rows) => void sent.set(id, rows),
        listingFailed,
      );
      cleanups.push(() => source.closeAll());
      await source.open(projectId);
      const listed = () => sent.get(projectId)?.find(({ id }) => id === sessionId);
      await vi.waitFor(() => expect(listed()).toMatchObject({ title: "Started on Mac A" }), WAIT);
      expect(listed()!.placeRunnerId).toBe(runnerId);

      const placesWatch = macB.watchQuery(api.runners.places, { sessionIds: [sessionId] });
      const stopPlaces = placesWatch.onUpdate(() => {});
      cleanups.push(stopPlaces);
      const placeNow = () => {
        const answer = placesWatch.localQueryResult();
        const runner = answer?.find((entry) => entry.sessionId === sessionId)?.place;
        if (runner === undefined || runner === null) return null;
        return sessionPlaceState({
          session: { turnActive: listed()?.turnActive ?? false },
          runner: runner as RunnerPlace,
          // Mac B is not this Session's Place.
          viewerRunnerId: null,
          now: Date.now(),
          formatSince: (at) => new Date(at).toISOString().slice(11, 16),
        });
      };
      await vi.waitFor(
        () =>
          expect(placeNow()).toMatchObject({ kind: "online", label: `Running on ${runnerName}` }),
        WAIT,
      );

      // 2. Mac A sleeps (SIMULATED): the real suspend, the asleep report acked, the link held.
      const suspendAt = Date.now();
      await simulation.suspend();
      expect(macA.snapshot().state).toBe("asleep");
      await vi.waitFor(() => {
        const place = placeNow();
        expect(place).toMatchObject({ kind: "waiting", reason: "asleep" });
        expect(place!.since).toBeGreaterThanOrEqual(suspendAt - 1_000);
        expect(place!.label).toMatch(
          new RegExp(`^Waiting for ${runnerName} — asleep since \\d\\d:\\d\\d$`, "u"),
        );
      }, WAIT);

      // 3. Mac B sends; the command waits in the inbox, unclaimed.
      const commandId = randomUUID();
      const intent = JSON.stringify({ kind: "session.retitle", title: RENAMED });
      const command = () => person.mutation(api.sessions.command, { sessionId, commandId, intent });
      const queued = await command();
      expect(queued).toMatchObject({
        commandId,
        status: "queued",
        runner: { id: runnerId, status: "asleep" },
      });
      expect(pendingCommandLabel(placeNow())).toBe(`Sent — waiting for ${runnerName}`);
      await new Promise((done) => setTimeout(done, ASLEEP_HOLD_MS));
      // The same command again is the same job (idempotent by id): still queued.
      await expect(command()).resolves.toMatchObject({ status: "queued" });
      expect(inboxRuns).toEqual([]);
      expect(listed()!.title).toBe("Started on Mac A");

      // 4. Mac A wakes: the seam releases the transport and emits the real resume.
      simulation.resume();
      await until(macA, (snapshot) => snapshot.state === "online");
      await vi.waitFor(
        () =>
          expect(placeNow()).toMatchObject({ kind: "online", label: `Running on ${runnerName}` }),
        WAIT,
      );
      // The command is claimed and applied once; the facts drain; Mac B catches up.
      await vi.waitFor(() => expect(inboxRuns).toEqual([commandId]), WAIT);
      await vi.waitFor(() => expect(listed()).toMatchObject({ title: RENAMED }), WAIT);
      await vi.waitFor(
        () => expect(drain.status()).toMatchObject({ waiting: 0, blocked: 0 }),
        WAIT,
      );
      await vi.waitFor(async () => expect(await command()).toMatchObject({ status: "done" }), WAIT);
      expect(pendingCommandLabel(placeNow())).toBeNull();
      expect(listingFailed).not.toHaveBeenCalled();
    }, 150_000);
  },
);
