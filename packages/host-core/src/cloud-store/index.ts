/** The cloud product store: one owner-scoped local ledger, one shared runner link. No Electron. */
import { randomUUID } from "node:crypto";
import type {
  HostedSessionRuntime,
  SessionLocationResolver,
  TranscriptArtifactStore,
} from "@volli/session-engine";
import type { LiveHostCore } from "../index";
import type { BackendLink } from "../cloud-runner/backend-link";
import { createFactDrain } from "../cloud-runner/drain";
import { createInboxWorker, type JobExecutor } from "../cloud-runner/inbox";
import { sqliteDrainCursorStore, sqliteJobJournalStore } from "../cloud-runner/sqlite-stores";
import {
  acceptOverLink,
  inboxOverLink,
  startRunnerSync,
  wakeOverLink,
  type RunnerSync,
} from "../cloud-runner/sync";
import type { RunnerPresence } from "../cloud-runner/presence";
import { sqliteDrainLedger } from "../session-control/sqlite-ledger";
import { createRunnerPathRegistry, type RunnerPathRegistry } from "./paths";
import { createCloudContext, type CloudRunnerContext } from "./context";
import { createCloudSessionOwner } from "./owner";
import { createCloudSessionLocationResolver, type CloudSessionLocationOptions } from "./location";
import { registerWorkingCopyJobs } from "./jobs";
import { registerSessionCommandJob, ownerGuardedInbox } from "./session-jobs";
import { registerSessionNoticeJob, type SessionNoticeOutbox } from "./notice-jobs";
import { runGitCapturingAsync } from "../worktree/git";
import { getTrimSettings } from "../worktree/trim-settings";
import type { BusyWorktreeSites } from "../worktree/activity";
import { releaseAgentSites } from "../worktree/agent-sites";
import { hostLogger } from "../log/root";
import { computeWorktreeReclaim, isTicketStatus, DEFAULT_AUTHORITY_POLICY } from "@volli/shared";
import { retentionTtlMs } from "../worktree/retention";
import { createCloudReportPublisher } from "./reports";
import { createAgentBackend, runnerTokenBefore } from "../cloud-agent/agent-backend";
import {
  createCloudFunctionsClient,
  CloudOfflineError,
  CloudFunctionError,
} from "../cloud-agent/functions-client";
import { createCloudBoardVerbs, CLOUD_VERB_BUDGET_MS } from "../cloud-agent/board-verbs";
import { createCloudSessionVerbs } from "../cloud-agent/session-verbs";
import { getProjectById } from "../db/projects-repo";

export interface CloudRunnerSyncConnection {
  start(): void;
  stop(): Promise<void>;
  /** Close a lost identity without attempting one last presence report. */
  close(): Promise<void>;
  waiting(): number;
}

export function createCloudProductStore(options: {
  host: LiveHostCore;
  ownerUserId: string;
  backendUrl: string;
  /** Saved registration id remains available during an offline launch. */
  runnerId(): string | null;
  home?: string;
  busySites: BusyWorktreeSites;
  prepareEnvironment?: CloudSessionLocationOptions["prepareEnvironment"];
  environmentRecipes?: () => boolean;
  /**
   * Receiving seam: S5 supplies the follow-up executor when it lands. The
   * notice executor is this store's own (`notice-jobs.ts`).
   */
  sessionJobs?: Partial<Record<"session.followUp", JobExecutor>>;
}) {
  const { host, ownerUserId } = options;
  const db = host.database.db;
  const log = hostLogger("cloud-store");
  let active: {
    link: BackendLink;
    runnerId: string;
    runnerToken?: () => Promise<string | null>;
  } | null = null;
  let runtime: HostedSessionRuntime | null = null;
  let artifacts: TranscriptArtifactStore | null = null;
  let notices: SessionNoticeOutbox | null = null;
  let prepareEnvironment = options.prepareEnvironment;
  const registries = new Map<string, RunnerPathRegistry>();
  const registry = () => {
    const id = active?.runnerId ?? options.runnerId();
    if (id === null)
      throw new Error("Add this Mac as a runner before starting a Volli Cloud Session.");
    let paths = registries.get(id);
    if (paths === undefined) {
      paths = createRunnerPathRegistry(db, { runnerId: id });
      registries.set(id, paths);
    }
    return paths;
  };
  const link = () => {
    if (active === null)
      throw new Error("Volli Cloud is unreachable; this ticket's brief can't be read.");
    return active.link;
  };
  const drain = createFactDrain({
    ownerUserId,
    ledger: sqliteDrainLedger(db),
    cursors: sqliteDrainCursorStore(db),
    accept: (args, callOptions) => {
      try {
        return acceptOverLink(link())(args, callOptions);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    onBlocked: (sessionId, block) =>
      log.warn("Session cloud drain stopped", { sessionId, code: block.code }),
    onRetry: (sessionId) => log.warn("Session cloud drain will retry", { sessionId }),
  });
  const context = createCloudContext({
    db,
    ownerUserId,
    engine: host.sessionEngine,
    registry,
    runnerId: () => active?.runnerId ?? options.runnerId(),
    query: async (input) => {
      const live = link();
      if (live.query === undefined) throw new Error("Runner context reads are unavailable.");
      return (await live.query("runnerContext:forSession", { ...input })) as CloudRunnerContext;
    },
  });
  const owner = createCloudSessionOwner({
    db,
    engine: host.sessionEngine,
    ownerUserId,
    adopt: (sessionId) => drain.adopt(sessionId),
    onCreated: context.created,
  });
  const functions = createCloudFunctionsClient({ url: options.backendUrl });
  const agentBackend = createAgentBackend({
    functions,
    connected: () => active?.link.status.state === "connected",
    runnerToken: () => active?.runnerToken?.() ?? Promise.resolve(null),
    nudgeDrain: (sessionId) => drain.nudge(sessionId),
  });
  const cloudSessionVerbs = createCloudSessionVerbs({
    backend: agentBackend,
    engine: owner.engine,
    projectIds: owner.projectIds,
    claimedHere: (sessionId) => {
      const cursor = sqliteDrainCursorStore(db).get(sessionId);
      return (
        owner.owns(sessionId) &&
        cursor?.blocked?.code !== "fenced" &&
        cursor?.blocked?.code !== "not_your_runner"
      );
    },
    ticketDisplayIdOf: context.ticketDisplayIdOf,
    async notify(sessionId, args) {
      const current = active;
      if (current?.link.status.state !== "connected")
        throw new CloudOfflineError("link_down", "This runner is offline.", "not_sent");
      const cursor = sqliteDrainCursorStore(db).get(sessionId);
      if (!owner.owns(sessionId) || cursor === null)
        throw new CloudFunctionError("forbidden", "This Session is not claimed by this runner.");
      const deadline = Date.now() + CLOUD_VERB_BUDGET_MS;
      const token = await runnerTokenBefore(
        () => current.runnerToken?.() ?? Promise.resolve(null),
        deadline,
      );
      if (token == null || active !== current)
        throw new CloudOfflineError("link_down", "This runner is not linked.", "not_sent");
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0)
        throw new CloudOfflineError(
          "timeout",
          "Out of time before queuing the notification.",
          "not_sent",
        );
      return (await functions.call(
        "mutation",
        "attention:raiseFromRunner",
        { sessionId, generation: cursor.generation, ...args },
        token,
        { timeoutMs },
      )) as { displayName: string };
    },
  });
  const agentCommands = {
    // Cloud project policies have not shipped; never borrow a frozen local policy.
    readAuthorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
    projects: () =>
      owner.projectIds().flatMap((id) => {
        const project = getProjectById(db, id);
        return project === undefined ? [] : [project];
      }),
    cloudBoardVerbs: createCloudBoardVerbs({ backend: agentBackend }),
    cloudSessionVerbs,
  };
  const offWake = host.sessionWakeBus.subscribe(({ event }) => {
    if (!owner.owns(event.sessionId)) return;
    drain.nudge(event.sessionId);
    // Tokens are in-memory only. A closing attachment ends its cached grant;
    // a subsequent call can mint anew only while this runner still owns the claim.
    if (event.payload.kind === "attachment.closed" || event.payload.kind === "attachment.failed")
      agentBackend.forget(event.sessionId);
  });
  const publishers = new Map<string, ReturnType<typeof createCloudReportPublisher>>();
  function publisher(paths: RunnerPathRegistry) {
    let reports = publishers.get(paths.runnerId);
    if (reports === undefined) {
      reports = createCloudReportPublisher({
        db,
        ownerUserId,
        runnerId: paths.runnerId,
        registry: paths,
        currentLink: () => (active?.runnerId === paths.runnerId ? active.link : null),
        onError: (error) => log.warn("Runner machine report was retained", { error }),
      });
      publishers.set(paths.runnerId, reports);
    }
    return reports;
  }
  const locationServices = new Map<string, ReturnType<typeof createCloudSessionLocationResolver>>();
  function location(current = false) {
    const paths = registry();
    const key = `${paths.runnerId}:${current}`;
    let service = locationServices.get(key);
    if (service !== undefined) return service;
    service = createCloudSessionLocationResolver({
      registry: paths,
      forSession: current ? context.currentSite : context.site,
      reports: publisher(paths).reports,
      gitAsync: runGitCapturingAsync,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.environmentRecipes === undefined
        ? {}
        : { environmentRecipes: options.environmentRecipes }),
      prepareEnvironment: async (input) => {
        if (prepareEnvironment === undefined) {
          if (input.outcome.setupPending)
            throw new Error("This working copy's environment runner is unavailable.");
          return;
        }
        await prepareEnvironment(input);
      },
    });
    locationServices.set(key, service);
    return service;
  }
  const locations: SessionLocationResolver = {
    resolve: (session) => location().resolve(session),
    async prepare(session) {
      const events = await owner.engine.listEvents({ sessionId: session.id });
      if (
        events.some(
          (event) =>
            event.payload.kind === "session.input.recorded" &&
            event.payload.input.kind === "runtime-brief",
        )
      ) {
        const existing = await location().prepareRegistered({
          sessionId: session.id,
          projectId: session.projectId,
          ticketId: session.ticketId,
        });
        if (existing !== null) return existing;
      }
      return location().prepare(session);
    },
    reaffirm: (session, directory) => location().reaffirm(session, directory),
  };
  return {
    kind: "cloud" as const,
    host,
    ownerUserId,
    engine: owner.engine,
    ownsSession: owner.owns,
    projectIds: owner.projectIds,
    agentCommands,
    cloudSessionVerbs,
    sessionBirth: { beforeCreate: context.beforeCreate },
    ticketDisplayIdOf: context.ticketDisplayIdOf,
    brief: context.brief,
    locations,
    drain,
    registry,
    bindEnvironment(prepare: NonNullable<CloudSessionLocationOptions["prepareEnvironment"]>): void {
      prepareEnvironment = prepare;
    },
    bindRuntime(value: HostedSessionRuntime | null, store: TranscriptArtifactStore): void {
      runtime = value;
      artifacts = store;
    },
    /** The runtime lifecycle's durable outbox door, for `session.notice` jobs. */
    bindNotices(outbox: SessionNoticeOutbox): void {
      notices = outbox;
    },
    connect(parts: {
      link: BackendLink;
      presence: RunnerPresence;
      bootId: string;
      runnerId: string;
      runnerToken?(): Promise<string | null>;
    }): CloudRunnerSyncConnection {
      active = {
        link: parts.link,
        runnerId: parts.runnerId,
        ...(parts.runnerToken === undefined ? {} : { runnerToken: parts.runnerToken }),
      };
      const reports = publisher(registry());
      const offReports = parts.link.onStatus((status) => {
        if (status.state === "connected") void reports.flush();
      });
      const inbox = createInboxWorker({
        backend: inboxOverLink(parts.link),
        journal: sqliteJobJournalStore(db, ownerUserId),
        wake: wakeOverLink(parts.link),
        bootId: parts.bootId,
        onError: () => log.warn("Runner inbox will retry"),
      });
      const guarded = ownerGuardedInbox(inbox, {
        engine: owner.engine,
        ownerUserId,
        owns: owner.owns,
      });
      registerSessionCommandJob(guarded, {
        engine: owner.engine,
        runtime: () => runtime,
        artifacts: () => artifacts,
        async commandArtifact({ sessionId, digest }) {
          const cursor = sqliteDrainCursorStore(db).get(sessionId);
          if (!owner.owns(sessionId) || cursor === null)
            throw new Error("This runner does not own the command's Session.");
          if (parts.link.query === undefined)
            throw new Error("Runner artifact reads are unavailable.");
          const row = (await parts.link.query("transcripts:commandArtifact", {
            sessionId,
            generation: cursor.generation,
            digest,
          })) as { body: string } | null;
          return row?.body ?? null;
        },
      });
      // A watcher's notice: composed here, then handed to the durable outbox.
      registerSessionNoticeJob(guarded, { outbox: () => notices });
      // S5's follow-up executor is not invented here; its production
      // composition passes it through this same owner gate.
      for (const [kind, executor] of Object.entries(options.sessionJobs ?? {}))
        guarded.register(kind, executor);
      registerWorkingCopyJobs(inbox, {
        registry: registry(),
        location: location(true),
        gitAsync: runGitCapturingAsync,
        trimSettings: () => getTrimSettings(db),
        // Retention dates/PR state are fresh backend facts, not frozen board
        // rows or birth hints. The shared rule uses this machine's existing TTL.
        retentionReclaimAllowed: async (facts) => {
          const ticket = facts.ticket;
          const retention = facts.retention;
          if (ticket === null || !isTicketStatus(ticket.status) || retention == null) return false;
          return computeWorktreeReclaim({
            status: ticket.status,
            keep: ticket.retentionKeep !== false,
            ...retention,
            now: Date.now(),
            ttlMs: retentionTtlMs(db),
          }).reclaim;
        },
        busySites: options.busySites,
        releaseAgentSites: async (directory) => {
          // No runtime has attached anything before bindRuntime. Read the live
          // binding here: connect can precede runtime assembly.
          if (runtime === null) return { released: [], stillOpen: [] };
          const report = await releaseAgentSites(runtime, directory, {
            newCommandId: randomUUID,
            onError: (sessionId, error) =>
              log.warn("Working copy attachment release failed", { sessionId, directory, error }),
          });
          // Unlike a confirmed manual removal, an inbox reclaim must not delete
          // the directory underneath a binding that refused to close.
          if (report.stillOpen.length > 0) {
            log.warn("Working copy still has structured attachments", {
              directory,
              sessionIds: report.stillOpen,
            });
            throw new Error(
              "An agent is still attached to this working copy; refusing to reclaim.",
            );
          }
          return report;
        },
      });
      let sync: RunnerSync | null = null;
      return {
        start() {
          sync ??= startRunnerSync({ link: parts.link, drain, inbox, presence: parts.presence });
          void reports.flush();
        },
        waiting: () => drain.status().waiting + reports.pending(),
        async stop() {
          offReports();
          try {
            if (sync !== null) await sync.stop();
          } finally {
            if (active?.link === parts.link) active = null;
          }
        },
        async close() {
          offReports();
          inbox.stop();
          drain.stop();
          await parts.link.close();
          await parts.presence.stop();
          if (active?.link === parts.link) active = null;
        },
      };
    },
    dispose() {
      offWake();
      drain.stop();
      for (const reports of publishers.values()) reports.stop();
    },
  };
}

export type CloudProductStore = ReturnType<typeof createCloudProductStore>;
