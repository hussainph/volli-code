/** The cloud product store: one owner-scoped local ledger, one shared runner link. No Electron. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { createFollowUpMirror } from "./follow-up-mirror";
import { executeFollowUpJob } from "./follow-up-jobs";
import {
  AUTOMATION_RUN_CAPABILITY,
  registerAutomationRunJob,
  type AutomationRunSessions,
} from "./automation-jobs";
import { createCloudRunAttention } from "./automation-attention";
import { runGitCapturingAsync } from "../worktree/git";
import { getTrimSettings } from "../worktree/trim-settings";
import type { BusyWorktreeSites } from "../worktree/activity";
import { releaseAgentSites } from "../worktree/agent-sites";
import { hostLogger } from "../log/root";
import {
  computeWorktreeReclaim,
  isTicketStatus,
  DEFAULT_AUTHORITY_POLICY,
  type NotificationRequest,
} from "@volli/shared";
import type { AutomationRunContext, JobKind, RunnerId } from "@volli/shared/cloud";
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
import { createCloudRestartRecovery } from "./recovery";
import { createCloudTranscriptPublisher } from "./transcripts";
import { createTranscriptPacking } from "./transcript-packing";
import { startStreamChunks, type StreamChunks } from "../cloud-runner/stream-chunker";

/** How long a claimed Automation Run waits for runtime recovery before it retries. */
export const AUTOMATION_SESSIONS_WAIT_MS = 120_000;

export interface CloudRunnerSyncConnection {
  start(): void;
  stop(): Promise<void>;
  /** Close a lost identity without attempting one last presence report. */
  close(): Promise<void>;
  waiting(): number;
  /** Sleep fences new inbox claims until the wake presence sequence finishes. */
  suspend?(): void;
  resume?(): Promise<void>;
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
   * Specialized follow-up executor override; the default and notice executor
   * are composed here behind the same owner gate.
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
    startStreams(): void;
    stopStreams(): Promise<void>;
    packing: ReturnType<typeof createTranscriptPacking>;
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
  // A restart resume's first-connect wait and sibling reads (N2-3).
  const recovery = createCloudRestartRecovery({ currentLink: () => active?.link ?? null });
  const publishTranscriptFacts = createCloudTranscriptPublisher({
    current: () => active,
    artifacts: () => artifacts,
    engine: {
      getBaseSession: (query) => owner.engine.getBaseSession(query),
      getSession: (query) => owner.engine.getSession(query),
    },
    ownerUserId,
    piDirectory: () => join(host.dataDir, "pi-sessions"),
    ledger: sqliteDrainLedger(db),
    cursors: sqliteDrainCursorStore(db),
    backendUrl: options.backendUrl,
    redaction: {
      step: (window, from, final) => host.secretStore.redactStreamStep(window, from, final),
      complete: () => {
        const state = host.secretStore.status().state;
        return state === "ready" || state === "empty";
      },
    },
  });
  const drain = createFactDrain({
    ownerUserId,
    ledger: sqliteDrainLedger(db),
    cursors: sqliteDrainCursorStore(db),
    accept: publishTranscriptFacts,
    onBlocked: (sessionId, block) =>
      log.warn("Session cloud drain stopped", { sessionId, code: block.code }),
    onRetry: (sessionId) => log.warn("Session cloud drain will retry", { sessionId }),
    onAccepted: (sessionId, through) => active?.packing.accepted(sessionId, through),
  });
  const context = createCloudContext({
    db,
    ownerUserId,
    engine: host.sessionEngine,
    registry,
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
  /** `attention.raiseFromRunner` for a Session this runner holds: `volli notify` and run-attention. */
  async function raiseFromRunner(
    sessionId: string,
    args: { notifyId: string; title: string; detail: string },
  ): Promise<{ displayName: string }> {
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
  }
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
    notify: raiseFromRunner,
  });
  // Shadow project paths are inert FK placeholders. Every machine-facing
  // consumer resolves the checkout through this registry, never the shadow.
  const projectPath = (projectId: string): string | null =>
    (active?.runnerId ?? options.runnerId()) === null
      ? null
      : (registry().checkouts.ofProject(projectId)?.absPath ?? null);
  const agentCommands = {
    // Cloud project policies have not shipped; never borrow a frozen local policy.
    readAuthorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
    projects: () =>
      owner.projectIds().flatMap((id) => {
        const project = getProjectById(db, id);
        const path = projectPath(id);
        // An unlocated Session has no executable project folder to report.
        return project === undefined || path === null ? [] : [{ ...project, path }];
      }),
    cloudBoardVerbs: createCloudBoardVerbs({ backend: agentBackend }),
    cloudSessionVerbs,
  };
  // Cloud Automation Runs: `automation.run` jobs run once runtime recovery
  // has bound the Session services (`bindAutomations`); a job claimed before
  // then waits for them under its renewed lease instead of spending an attempt.
  let automationSessions: AutomationRunSessions | null = null;
  const automationWaiters = new Set<() => void>();
  async function boundAutomationSessions(
    signal: AbortSignal,
  ): Promise<AutomationRunSessions | null> {
    if (automationSessions !== null) return automationSessions;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(wake, AUTOMATION_SESSIONS_WAIT_MS);
      timer.unref?.();
      function wake() {
        clearTimeout(timer);
        automationWaiters.delete(wake);
        signal.removeEventListener("abort", wake);
        resolve();
      }
      automationWaiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
    return automationSessions;
  }
  const runAttention = createCloudRunAttention({
    db,
    ownerUserId,
    engine: owner.engine,
    subscribe: host.sessionWakeBus.subscribe,
    raise: raiseFromRunner,
  });
  const followUpMirror = createFollowUpMirror({
    runtime: () => runtime,
    link: () => active?.link ?? null,
    generation: (sessionId) => sqliteDrainCursorStore(db).get(sessionId)?.generation ?? null,
    owns: owner.owns,
    onError: (error) => log.warn("Follow-up live view could not publish", { error }),
  });
  const followUpSessions = () =>
    (db.prepare("SELECT session_id FROM session_follow_up_queue").all() as { session_id: string }[])
      .map((row) => row.session_id)
      .filter(owner.owns);
  const refreshFollowUps = () => {
    void followUpMirror.refresh(followUpSessions());
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
    projectPath,
    agentCommands,
    cloudSessionVerbs,
    sessionBirth: { beforeCreate: context.beforeCreate },
    ticketDisplayIdOf: context.ticketDisplayIdOf,
    brief: context.brief,
    recovery,
    locations,
    drain,
    registry,
    /**
     * "Choose the folder for <project> on this Mac" (N2-3): the checkout a
     * cloud project's Sessions start from. The path stays in this runner's
     * registry; the backend hears only path-free checkout metadata.
     */
    checkouts: {
      /**
       * Whether this runner can locate the project's folder: registered, or
       * adoptable from a frozen local project with the same id, and still on
       * disk. `null` when this Mac has no runner identity to hold one.
       */
      located(projectId: string): boolean | null {
        if ((active?.runnerId ?? options.runnerId()) === null) return null;
        const checkout = registry().checkouts.ofProject(projectId);
        return checkout !== null && existsSync(checkout.absPath);
      },
      /**
       * The project and its primary repository as Volli Cloud answers this
       * runner (`runnerContext.forProject`: the owner's current membership).
       * A read: nothing is reserved or minted, and no path is sent.
       */
      async site(
        projectId: string,
      ): Promise<{ projectId: string; projectRepoId: string; projectName: string }> {
        if (active === null)
          throw new Error("Volli Cloud is unreachable. Choose the folder once this Mac connects.");
        if (active.link.query === undefined)
          throw new Error("Runner context reads are unavailable.");
        const facts = (await active.link.query("runnerContext:forProject", { projectId })) as {
          ownerUserId: string;
          project: { id: string; name: string };
          primaryRepo: { id: string; projectId: string };
        };
        if (
          facts.ownerUserId !== ownerUserId ||
          facts.project.id !== projectId ||
          facts.primaryRepo.projectId !== projectId
        )
          throw new Error("Volli Cloud returned another owner's project.");
        return { projectId, projectRepoId: facts.primaryRepo.id, projectName: facts.project.name };
      },
      /** Registers the folder locally, then queues its path-free checkout report. */
      async choose(input: {
        projectId: string;
        projectRepoId: string;
        absPath: string;
      }): Promise<void> {
        const paths = registry();
        const checkout = paths.checkouts.register({ ...input, adoptedFromFrozen: false });
        const read = (args: readonly string[]) =>
          runGitCapturingAsync(args, input.absPath).then(
            (out) => out.trim() || null,
            () => null,
          );
        // A folder project may be no repository at all: unknown, never guessed.
        const [headSha, headBranch] = await Promise.all([
          read(["rev-parse", "HEAD"]),
          read(["branch", "--show-current"]),
        ]);
        await publisher(paths).reports.checkout({
          projectId: input.projectId,
          projectRepoId: input.projectRepoId,
          kind: checkout.kind,
          headBranch,
          headSha,
        });
      },
    },
    bindEnvironment(prepare: NonNullable<CloudSessionLocationOptions["prepareEnvironment"]>): void {
      prepareEnvironment = prepare;
    },
    bindRuntime(value: HostedSessionRuntime | null, store: TranscriptArtifactStore): void {
      runtime = value;
      artifacts = store;
      active?.startStreams();
      followUpMirror.bind();
      refreshFollowUps();
      active?.packing.refresh();
    },
    /**
     * The job kinds beyond Sessions and Working copies this store executes,
     * for the runner's capability report (`runners.capabilities.tools`): the
     * backend queues `automation.run` only for a runner that names it.
     */
    jobCapabilities: [AUTOMATION_RUN_CAPABILITY] as readonly JobKind[],
    /**
     * The recovered Session services a cloud Automation Run starts through,
     * and this Mac's notification delivery for an unattended Run's alert.
     */
    bindAutomations(
      ports: AutomationRunSessions & { notify(request: NotificationRequest): void },
    ): void {
      const { notify, ...sessions } = ports;
      automationSessions = sessions;
      runAttention.bindLocal(notify);
      for (const wake of automationWaiters) wake();
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
      let started = false;
      let ended = false;
      let streams: StreamChunks | null = null;
      const startStreams = () => {
        if (!started || ended || runtime === null || active?.link !== parts.link) return;
        streams ??= startStreamChunks({
          link: parts.link,
          runtime,
          onError: (_error, sessionId) =>
            log.warn("Session live chunks were not sent", { sessionId }),
        });
      };
      const stopStreams = async () => {
        ended = true;
        await streams?.stop();
      };
      const packing = createTranscriptPacking({
        ownerUserId,
        link: parts.link,
        cursors: sqliteDrainCursorStore(db),
        ledger: sqliteDrainLedger(db),
        pack: publishTranscriptFacts.pack,
        artifactBytes: async (reference) => artifacts?.byteLength?.(reference) ?? null,
        onError: (sessionId, code) =>
          log.warn("Session history upload was retained", { sessionId, code }),
        onReport: (sessionId, report) => {
          for (const segment of report.transcript) {
            if (segment.missing.length > 0)
              log.warn("Session history pack has missing bodies", {
                sessionId,
                missing: segment.missing,
              });
          }
          if (
            report.piLogs.missing.length ||
            report.piLogs.truncated.length ||
            report.piLogs.oversized.length
          )
            log.warn("Session Pi history could not be fully uploaded", {
              sessionId,
              missing: report.piLogs.missing,
              truncated: report.piLogs.truncated,
              oversized: report.piLogs.oversized,
            });
        },
      });
      // A replaced registration cannot keep a timer or an upload alive.
      active?.packing.close();
      active = {
        link: parts.link,
        runnerId: parts.runnerId,
        ...(parts.runnerToken === undefined ? {} : { runnerToken: parts.runnerToken }),
        startStreams,
        stopStreams,
        packing,
      };
      recovery.observe(parts.link);
      const reports = publisher(registry());
      const offReports = parts.link.onStatus((status) => {
        if (status.state === "connected") {
          void reports.flush();
          refreshFollowUps();
        }
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
      const followUps = {
        runtime: () => runtime,
        artifacts: () => artifacts,
        publish: followUpMirror.publish,
        commandArtifact: async ({ sessionId, digest }: { sessionId: string; digest: string }) => {
          const cursor = sqliteDrainCursorStore(db).get(sessionId);
          if (!owner.owns(sessionId) || cursor === null)
            throw new Error("This runner does not own the command's Session.");
          if (parts.link.query === undefined)
            throw new Error("Runner artifact reads are unavailable.");
          const result = await parts.link.query("transcripts:commandArtifact", {
            sessionId,
            generation: cursor.generation,
            digest,
          });
          return (result as { body: string } | null)?.body ?? null;
        },
      };
      registerSessionCommandJob(guarded, {
        engine: owner.engine,
        runtime: () => runtime,
        artifacts: () => artifacts,
        commandArtifact: followUps.commandArtifact,
        followUps,
      });
      if (options.sessionJobs?.["session.followUp"] === undefined)
        guarded.register(
          "session.followUp",
          async (job, jobContext) => (await executeFollowUpJob(job, jobContext, followUps))!,
        );
      // A watcher's notice: composed here, then handed to the durable outbox.
      registerSessionNoticeJob(guarded, { outbox: () => notices });
      // A cloud Automation Run, on the runner its armer (or caller) chose.
      registerAutomationRunJob(guarded, {
        // The id this runner's registration was issued.
        runnerId: parts.runnerId as RunnerId,
        engine: owner.engine,
        sessions: boundAutomationSessions,
        runContext: async (request) => {
          if (parts.link.query === undefined)
            throw new Error("Runner context reads are unavailable.");
          return (await parts.link.query("automationRunner:runContext", {
            ...request,
          })) as AutomationRunContext;
        },
        onSessionBorn: (born) => runAttention.track(born),
      });
      // Optional specialized executors still cross the same owner gate.
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
          started = true;
          sync ??= startRunnerSync({ link: parts.link, drain, inbox, presence: parts.presence });
          startStreams();
          packing.start();
          void reports.flush();
          refreshFollowUps();
        },
        waiting: () => drain.status().waiting + reports.pending(),
        suspend: () => sync?.suspend(),
        resume: async () => {
          await sync?.resume();
        },
        async stop() {
          offReports();
          try {
            const packingStopped = packing.stop();
            await stopStreams();
            await packingStopped;
            if (sync !== null) await sync.stop();
          } finally {
            if (active?.link === parts.link) active = null;
          }
        },
        async close() {
          offReports();
          packing.close();
          await stopStreams();
          inbox.stop();
          drain.stop();
          await parts.link.close();
          await parts.presence.stop();
          if (active?.link === parts.link) active = null;
        },
      };
    },
    dispose() {
      runAttention.dispose();
      for (const wake of automationWaiters) wake();
      followUpMirror.close();
      offWake();
      active?.packing.close();
      void active?.stopStreams().catch(() => log.warn("Session live chunks did not close"));
      drain.stop();
      for (const reports of publishers.values()) reports.stop();
    },
  };
}

export type CloudProductStore = ReturnType<typeof createCloudProductStore>;
