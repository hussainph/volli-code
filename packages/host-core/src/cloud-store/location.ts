import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SessionLocation, SessionLocationResolver } from "@volli/session-engine";
import { displayTicketId, LOCAL_RUNNER, type Session } from "@volli/shared";
import {
  normalizeGitRemoteUrl,
  type CheckoutMode,
  type JobId,
  type RunnerGithubTokenClaim,
  type SessionId,
  type WorkingCopyState,
} from "@volli/shared/cloud";

import {
  acquireWorktreeStartLease,
  ensureExplicit,
  UNDER_DELETION_REFUSAL,
  type EnsureExplicitPorts,
  type EnsureFacts,
  type EnsureOutcome,
  type RunGitAsync,
} from "../worktree";
import { homeDir } from "../worktree/home";
import { resolveWorktreeIdentity } from "../worktree/identity";
import { isFirstRunPending } from "../worktree/first-run";
import {
  createRunnerGit,
  ManagedCloneUnavailable,
  type ManagedClones,
  type RunnerGit,
} from "./managed-clone";
import type { RunnerPathRegistry } from "./paths";

/** The path-free subset of runnerContext.forSession needed by the machine. */
export interface CloudLocationFacts {
  project: { id: string; name: string; setupCommand?: string | null };
  ticketPrefix: string;
  ticket: {
    id: string;
    projectId: string;
    title: string;
    number: number;
    checkoutMode: CheckoutMode;
    branch: string | null;
    baseBranch: string | null;
    retentionKeep?: boolean;
    status?: string;
    archivedAt?: number | null;
  } | null;
  primaryRepo: {
    id: string;
    projectId: string;
    baseBranch: string | null;
    defaultBranchCache?: string | null;
    /** What a runner with no folder of the person's clones (`managedClones`). */
    remoteUrl?: string | null;
  };
  /** Fresh backend facts; the runner applies the shared rule with its machine TTL. */
  retention?: {
    doneEntryAt: number | null;
    prUrl: string | null;
    prState: "open" | "merged" | "closed" | null;
  } | null;
}

export interface CloudLocationRequest {
  sessionId: string;
  projectId: string;
  ticketId: string | null;
  /**
   * Set when an inbox job (not a Session) is materializing: then `sessionId`
   * holds the job's id. A managed clone's GitHub token is asked for this claim.
   */
  jobId?: string;
}
export interface CloudWorkingCopyReport {
  ticketId: string;
  projectRepoId: string;
  kind: "worktree" | "main_checkout";
  state: WorkingCopyState;
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
}
export interface CloudLocationReports {
  checkout(input: {
    projectId: string;
    projectRepoId: string;
    kind: "main" | "managed_clone";
    headBranch: string | null;
    headSha: string | null;
    /** A main checkout's `origin`, normalized with no credentials; `null` when it has none. */
    remoteUrl?: string | null;
  }): Promise<unknown>;
  workingCopy(input: CloudWorkingCopyReport): Promise<{ workingCopyId: string | null }>;
}

export class CloudFolderRequired extends Error {
  readonly code = "checkout_folder_required";
  constructor(projectName: string) {
    super(`Choose the folder for ${projectName} on this Mac.`);
    this.name = "CloudFolderRequired";
  }
}

/** Why a runner with managed clones cannot clone a project: it has no remote on record. */
export class CloudRemoteRequired extends ManagedCloneUnavailable {
  constructor(projectName: string) {
    super(
      `Volli doesn't know where to clone ${projectName} from yet. Open it on a Mac that has its folder, or connect its GitHub repository.`,
    );
    this.name = "CloudRemoteRequired";
  }
}

/** A main checkout's `origin` as a report carries it: normalized, never a path or a secret. */
export async function readCheckoutRemote(
  git: RunnerGit,
  checkoutPath: string,
): Promise<string | null> {
  try {
    const url = (await git(["remote", "get-url", "origin"], { cwd: checkoutPath })).trim();
    return normalizeGitRemoteUrl(url);
  } catch {
    // No origin, or no repository at all: unknown, never guessed.
    return null;
  }
}

export interface CloudSessionLocationOptions {
  registry: RunnerPathRegistry;
  /** A query port, not a transport; the backend checks owner/claim/membership. */
  forSession(input: CloudLocationRequest): Promise<CloudLocationFacts>;
  reports: CloudLocationReports;
  gitAsync: RunGitAsync;
  home?: string;
  environmentRecipes?: () => boolean;
  materializeAttachments?: EnsureExplicitPorts["materializeAttachments"];
  /**
   * Runner-managed clones (`managed-clone.ts`): set on a runner with no folder
   * of the person's. A project with no registered checkout is then cloned
   * from its `primaryRepo.remoteUrl` instead of refused as
   * {@link CloudFolderRequired}. Absent (the Mac) keeps that refusal.
   */
  managedClones?: ManagedClones;
  /** Reads a main checkout's `origin` for its report. Defaults to {@link readCheckoutRemote}. */
  readRemote?(checkoutPath: string): Promise<string | null>;
  /**
   * The host's setup/resume runner. It must write machine facts only, never
   * frozen ticket events. A pending setup without this port fails closed.
   */
  prepareEnvironment?(input: {
    request: CloudLocationRequest;
    facts: CloudLocationFacts;
    directory: string;
    outcome: EnsureOutcome;
  }): Promise<void>;
}

/** The claim a managed clone's own fetch authenticates under: the job's, else the Session's. */
function claimOf(request: CloudLocationRequest): RunnerGithubTokenClaim {
  return request.jobId === undefined
    ? { kind: "session", sessionId: request.sessionId as SessionId }
    : { kind: "job", jobId: request.jobId as JobId };
}

function requestFor(session: Session): CloudLocationRequest {
  return { sessionId: session.id, projectId: session.projectId, ticketId: session.ticketId };
}

/** Shared by Session starts and inbox materialization; never writes SQLite board rows. */
export function createCloudSessionLocationResolver(options: CloudSessionLocationOptions) {
  const { registry, gitAsync, reports, managedClones } = options;
  const readRemote =
    options.readRemote ?? ((path: string) => readCheckoutRemote(createRunnerGit(), path));
  // Registry reservation happens synchronously before the git pipeline's first
  // await; Session and inbox services then share its path-scoped flight.
  const ensurePorts: EnsureExplicitPorts = {
    gitAsync,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.environmentRecipes === undefined
      ? {}
      : { environmentRecipes: options.environmentRecipes }),
    ...(options.materializeAttachments === undefined
      ? {}
      : { materializeAttachments: options.materializeAttachments }),
  };

  async function factsFor(request: CloudLocationRequest): Promise<CloudLocationFacts> {
    // Only the Session's identity crosses: the backend's read takes no job id.
    const facts = await options.forSession({
      sessionId: request.sessionId,
      projectId: request.projectId,
      ticketId: request.ticketId,
    });
    if (
      facts.project.id !== request.projectId ||
      facts.primaryRepo.projectId !== request.projectId ||
      (request.ticketId === null ? facts.ticket !== null : facts.ticket?.id !== request.ticketId) ||
      (facts.ticket !== null && facts.ticket.projectId !== request.projectId)
    )
      throw new Error("Volli Cloud returned a location for another project or ticket.");
    return facts;
  }
  /**
   * The registered checkout, or with managed clones the clone's planned
   * checkout, registered here so every later read finds it; `materialize`
   * makes it exist.
   */
  function checkoutOf(facts: CloudLocationFacts): string {
    const repoId = facts.primaryRepo.id;
    const registered = registry.checkouts.pathOf(facts.project.id, repoId);
    if (registered) return registered;
    if (managedClones === undefined) throw new CloudFolderRequired(facts.project.name);
    if (!facts.primaryRepo.remoteUrl) throw new CloudRemoteRequired(facts.project.name);
    return registry.checkouts.register({
      projectId: facts.project.id,
      projectRepoId: repoId,
      absPath: managedClones.checkoutPath(repoId),
      kind: "managed_clone",
      adoptedFromFrozen: false,
    }).absPath;
  }
  function locate(facts: CloudLocationFacts) {
    const repoId = facts.primaryRepo.id;
    const checkoutPath = checkoutOf(facts);
    const ticket = facts.ticket;
    if (!ticket) return { checkoutPath, directory: checkoutPath };
    if (ticket.checkoutMode === "main_checkout") {
      // The checkout already owns the shared-mode path. Once an isolated copy
      // has a stamp, retain it while shared mode is active: a later switch back
      // must reuse that exact directory/branch, including adopted worktrees.
      registry.workingCopies.pathOf(ticket.id, repoId);
      if (registry.workingCopies.get(ticket.id, repoId)?.kind !== "worktree")
        registry.workingCopies.register({
          ticketId: ticket.id,
          projectRepoId: repoId,
          absPath: checkoutPath,
          kind: "main_checkout",
        });
      return { checkoutPath, directory: checkoutPath };
    }
    const generated = resolveWorktreeIdentity({
      home: homeDir(ensurePorts),
      projectId: facts.project.id,
      projectPath: checkoutPath,
      displayId: displayTicketId(facts.ticketPrefix, ticket.number),
      title: ticket.title,
      persistedPath: null,
      persistedBranch: ticket.branch,
    }).path;
    const known = registry.workingCopies.get(ticket.id, repoId);
    const path =
      (known?.kind === "main_checkout" ? null : registry.workingCopies.pathOf(ticket.id, repoId)) ??
      join(dirname(generated), encodeURIComponent(registry.runnerId), basename(generated));
    // Collision refusal happens BEFORE git, copy, markers or environment work.
    registry.workingCopies.register({
      ticketId: ticket.id,
      projectRepoId: repoId,
      absPath: path,
      kind: "worktree",
      ...(known?.kind === "main_checkout"
        ? { branch: ticket.branch, baseBranch: ticket.baseBranch, headSha: null }
        : {}),
    });
    return { checkoutPath, directory: path };
  }
  async function head(
    directory: string,
  ): Promise<{ branch: string | null; headSha: string | null }> {
    // Project Sessions may use an ordinary folder or an unborn repository.
    // Missing git metadata is reported as unknown, never a guessed branch.
    const read = (args: readonly string[]) =>
      gitAsync(args, directory).then(
        (out) => out.trim() || null,
        () => null,
      );
    const [headSha, branch] = await Promise.all([
      read(["rev-parse", "HEAD"]),
      read(["branch", "--show-current"]),
    ]);
    return { branch, headSha };
  }
  async function report(
    facts: CloudLocationFacts,
    directory: string,
    state: WorkingCopyState,
    baseBranch: string | null = facts.ticket?.baseBranch ?? facts.primaryRepo.baseBranch,
  ) {
    const known = facts.ticket
      ? registry.workingCopies.get(facts.ticket.id, facts.primaryRepo.id)
      : null;
    const reportingKnownKind = known?.kind === facts.ticket?.checkoutMode;
    const current =
      state === "reclaimed" || (state === "failed" && !existsSync(directory))
        ? {
            branch: (reportingKnownKind ? known?.branch : null) ?? facts.ticket?.branch ?? null,
            headSha: reportingKnownKind ? (known?.headSha ?? null) : null,
          }
        : await head(directory);
    baseBranch = (reportingKnownKind ? known?.baseBranch : null) ?? baseBranch;
    if (facts.ticket) {
      const input: CloudWorkingCopyReport = {
        ticketId: facts.ticket.id,
        projectRepoId: facts.primaryRepo.id,
        kind: facts.ticket.checkoutMode,
        state,
        branch: current.branch,
        baseBranch,
        headSha: current.headSha,
      };
      const preserveIsolated =
        facts.ticket.checkoutMode === "main_checkout" && known?.kind === "worktree";
      const stamp = preserveIsolated
        ? known
        : {
            ticketId: facts.ticket.id,
            projectRepoId: facts.primaryRepo.id,
            absPath: directory,
            kind: facts.ticket.checkoutMode,
            branch: current.branch,
            baseBranch,
            headSha: current.headSha,
          };
      registry.workingCopies.register(stamp);
      const answer = await reports.workingCopy(input);
      // A report's current mode is cloud metadata, not permission to replace
      // the isolated machine stamp with the shared checkout's path or HEAD.
      const currentStamp = registry.workingCopies.get(facts.ticket.id, facts.primaryRepo.id);
      if (currentStamp?.absPath === stamp.absPath && currentStamp.kind === stamp.kind)
        registry.workingCopies.register({
          ...currentStamp,
          workingCopyId: answer.workingCopyId,
        });
      return { ...input, workingCopyId: answer.workingCopyId };
    }
    return current;
  }
  async function materialize(
    request: CloudLocationRequest,
    expectedDirectory?: string,
  ): Promise<
    SessionLocation & {
      workingCopy: Awaited<ReturnType<typeof report>>;
    }
  > {
    const facts = await factsFor(request);
    const { checkoutPath, directory } = locate(facts);
    if (expectedDirectory !== undefined && directory !== expectedDirectory)
      throw new Error("The bound working copy cannot be relocated.");
    const lease = acquireWorktreeStartLease(directory);
    if (!lease) throw new Error(UNDER_DELETION_REFUSAL);
    try {
      const checkoutKind = registry.checkouts.get(facts.project.id, facts.primaryRepo.id)!.kind;
      if (checkoutKind === "managed_clone" && managedClones !== undefined) {
        if (!facts.primaryRepo.remoteUrl) throw new CloudRemoteRequired(facts.project.name);
        await managedClones.ensure({
          projectRepoId: facts.primaryRepo.id,
          remoteUrl: facts.primaryRepo.remoteUrl,
          claim: claimOf(request),
        });
      }
      if (!existsSync(checkoutPath)) throw new CloudFolderRequired(facts.project.name);
      const checkoutHead = await head(checkoutPath);
      await reports.checkout({
        projectId: facts.project.id,
        projectRepoId: facts.primaryRepo.id,
        kind: checkoutKind,
        headBranch: checkoutHead.branch,
        headSha: checkoutHead.headSha,
        // Only the person's own checkout names the project's remote.
        ...(checkoutKind === "main" ? { remoteUrl: await readRemote(checkoutPath) } : {}),
      });
      const ticket = facts.ticket;
      let baseBranch = ticket?.baseBranch ?? facts.primaryRepo.baseBranch;
      if (ticket?.checkoutMode === "worktree") {
        const known = registry.workingCopies.get(ticket.id, facts.primaryRepo.id);
        const input: EnsureFacts = {
          ticketId: ticket.id,
          projectId: facts.project.id,
          checkoutPath,
          displayId: displayTicketId(facts.ticketPrefix, ticket.number),
          title: ticket.title,
          usesWorktree: true,
          worktreePath: directory,
          branch: known?.branch ?? ticket.branch,
          baseBranch: known?.baseBranch ?? ticket.baseBranch,
          projectBaseBranch:
            facts.primaryRepo.baseBranch ?? facts.primaryRepo.defaultBranchCache ?? null,
          setupCommand: facts.project.setupCommand ?? null,
        };
        const result = await ensureExplicit(ensurePorts, input);
        if (!result.ok)
          throw new Error(`Couldn't prepare the worktree at ${directory} — ${result.error}`);
        baseBranch = result.value.identity.baseBranch;
        registry.workingCopies.register({
          ticketId: ticket.id,
          projectRepoId: facts.primaryRepo.id,
          absPath: directory,
          branch: result.value.identity.branch,
          baseBranch,
        });
        if (options.prepareEnvironment) {
          await options.prepareEnvironment({ request, facts, directory, outcome: result.value });
        } else if (result.value.setupPending) {
          throw new Error(
            "This working copy still needs setup; its environment runner is unavailable.",
          );
        }
      }
      const workingCopy = await report(facts, directory, "ready", baseBranch);
      // LOCAL_RUNNER is the durable executor venue, NOT a cloud runner UUID.
      return { directory, venue: LOCAL_RUNNER, workingCopy };
    } catch (error) {
      if (facts.ticket) {
        try {
          await report(facts, directory, "failed");
        } catch (reportError) {
          const message = error instanceof Error ? error.message : String(error);
          throw new AggregateError(
            [error, reportError],
            `${message}; the failed state could not be reported.`,
            { cause: reportError },
          );
        }
      }
      throw error;
    } finally {
      lease.release();
    }
  }
  /** An already-briefed Session can attach offline, but never around setup gates or wake resume. */
  async function prepareRegistered(request: CloudLocationRequest): Promise<SessionLocation | null> {
    const facts = await factsFor(request);
    const { directory } = locate(facts);
    const lease = acquireWorktreeStartLease(directory);
    if (lease === null) throw new Error(UNDER_DELETION_REFUSAL);
    try {
      if (!existsSync(directory)) return null;
      if (facts.ticket?.checkoutMode === "worktree") {
        const known = registry.workingCopies.get(facts.ticket.id, facts.primaryRepo.id);
        const outcome: EnsureOutcome = {
          identity: {
            worktreePath: directory,
            branch: known?.branch ?? facts.ticket.branch,
            baseBranch: known?.baseBranch ?? facts.ticket.baseBranch,
          },
          created: false,
          restamped: false,
          setupPending: isFirstRunPending(ensurePorts, directory, "setup"),
        };
        if (options.prepareEnvironment !== undefined)
          await options.prepareEnvironment({ request, facts, directory, outcome });
        else if (outcome.setupPending)
          throw new Error("This working copy's environment runner is unavailable.");
      }
      return { directory, venue: LOCAL_RUNNER };
    } finally {
      lease.release();
    }
  }
  const resolver: SessionLocationResolver = {
    async resolve(session) {
      const facts = await factsFor(requestFor(session));
      return { directory: locate(facts).directory, venue: LOCAL_RUNNER };
    },
    prepare: (session) => materialize(requestFor(session)),
    async reaffirm(session, directory) {
      const lease = acquireWorktreeStartLease(directory);
      if (!lease) throw new Error(UNDER_DELETION_REFUSAL);
      try {
        if (existsSync(directory)) return;
        const location = await materialize(requestFor(session), directory);
        if (location.directory !== directory)
          throw new Error("The bound working copy cannot be relocated.");
      } finally {
        lease.release();
      }
    },
  };
  return { ...resolver, materialize, prepareRegistered, factsFor, locate, report, readHead: head };
}

export type CloudSessionLocationService = ReturnType<typeof createCloudSessionLocationResolver>;
