/** hostd's answers to the runner composition desktop also composes, and what it serves. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  piHostCredentials,
  piOwnedModelAccess,
  piSignIn,
  type PiModelAccess,
  type CodeModeSandboxAssets,
} from "@volli/agent-runtime";
import {
  parseExperimentEnvironment,
  VOLLI_SOCKET_ENV,
  type SessionExecutionVenue,
} from "@volli/shared";
import type { HostCorePorts, LiveHostCore } from "@volli/host-core";
import type { RetentionReclaimSeams } from "@volli/host-core/maintenance";
import type { BoardChangeFeed } from "@volli/host-core/board";
import type { SessionReadPort } from "@volli/host-core/handlers";
import type { LogRing } from "@volli/host-core/log";
import { SecretService } from "@volli/host-core/secrets";
import {
  createRunnerComposition,
  type RunnerDoorCapabilities,
  type RunnerReady,
  recoveredSessionCommandPorts,
  recoveredRuntimeSessionServices,
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  HostSignIns,
} from "@volli/host-core/session-runtime";
import {
  agentSitesWithin,
  releaseAgentSites,
  liveShellWorktreeSites,
  type BusyWorktreeSites,
  type AgentSiteRuntime,
} from "@volli/host-core/worktree";
import type { HeadlessSecrets } from "./secrets";
import { ownsLegacyHostdVenue } from "./venue";
import { sessionGitEnv } from "./agent-git-env";
import { createHostWorkspaces } from "./host-workspaces";

export interface HeadlessRuntimeOptions {
  binDir: string;
  venue: SessionExecutionVenue;
  codeModeSandbox?: CodeModeSandboxAssets;
  /** A scripted provider replaces only the wire in host-container and integration proofs. */
  modelAccess?: PiModelAccess;
  /**
   * Volli's git credential helper (VC-702), as git's `credential.helper`
   * value: a `!`-command that answers from this host's push-credential
   * store. Set, every Session command's environment installs it as
   * command-scope git configuration; absent or null (the `cloud` flag off),
   * Sessions push exactly as before.
   */
  gitCredentialHelper?: string | null;
  /** The box's platform (`process.platform`): on a Mac, Session git never reaches the keychain. */
  platform?: string;
  /** Host-scope project creation, composed only behind cloud. */
  projectsRoot?: string | null;
  userInstall?: boolean;
}

function headlessHomeDir(env: Readonly<Record<string, string | undefined>>): string {
  return env["HOME"] || homedir();
}

/**
 * The host's model access, built when host-core's runtime services are first
 * read. A service account's Pi auth lives where its own environment says
 * (`PI_CODING_AGENT_DIR`, else `$HOME/.pi/agent`), never the machine user's.
 */
export function headlessModelAccess(
  env: Readonly<Record<string, string | undefined>>,
  options: Pick<HeadlessRuntimeOptions, "modelAccess">,
): PiModelAccess {
  return (
    options.modelAccess ??
    piOwnedModelAccess({
      agentDir: env["PI_CODING_AGENT_DIR"] || join(headlessHomeDir(env), ".pi", "agent"),
    })
  );
}

/** A worktree question asked before boot recovery finished. */
function notReady(): Error {
  return new Error("The headless Session runtime is not ready.");
}

/** Synchronous ownership first; ready() is the only public ledger-consuming door. */
export function createHeadlessSessionRuntime(input: {
  host: LiveHostCore;
  version: string;
  ports: HostCorePorts;
  /** The host's board change feeds (VC-565): its bus already feeds them. */
  boardFeed?: BoardChangeFeed;
  secrets: HeadlessSecrets;
  env: Readonly<Record<string, string | undefined>>;
  /** The agent socket this host serves; every Session command is pointed at it. */
  socketPath: string;
  options: HeadlessRuntimeOptions;
  /** The host's recent log (VC-699), when the process keeps one: what `host.logs` reads. */
  logs?: LogRing | null;
}) {
  const { host, ports, env, options } = input;
  const db = host.database.db;
  const homeDir = headlessHomeDir(env);
  // hostd keeps no stored experiments: the `cloud` flag is the environment's
  // opt-in, read once at boot. (Not `host-protocol.ts`' twin: that module is
  // the superseded WebSocket surface, and this one must not load it.)
  const cloud = parseExperimentEnvironment(env["VOLLI_EXPERIMENTAL"]).ids.includes("cloud");
  const cloudFlag = (): boolean => cloud;
  // One lazy module: its model access is `headlessModelAccess`, handed to host-core.
  const { modelAccess } = host.runtimeServices;
  const gitHelper = options.gitCredentialHelper ?? null;
  let workspaces: ReturnType<typeof createHostWorkspaces> | undefined;
  /**
   * The runner composition (VC-671), the same one desktop composes. A
   * headless host answers no secret cards (they need a secure field on the
   * box's side) and drives no browser; remote chat answers questions through
   * `session.command` → `interaction.resolve`, and VC-9 still withholds
   * ask_user from children in the shared Role policy. Its drain follows the
   * host's `drain-and-close`: shells close before SQLite, Automations settle.
   */
  const runner = createRunnerComposition({
    store: { kind: "local", host },
    ports,
    version: input.version,
    venue: options.venue,
    ownsLegacyVenue: ownsLegacyHostdVenue,
    homeDir,
    binDir: options.binDir,
    env,
    packaged: true,
    cloudEnabled: cloudFlag,
    ...(options.codeModeSandbox === undefined ? {} : { codeModeSandbox: options.codeModeSandbox }),
    secrets: new SecretService(input.secrets.store),
    capabilities: { askUser: true, requestSecret: false },
    // systemd/launchd environment is operator-owned; no rc files are executed.
    beforeExecution: async () => {},
    // Every command a Session runs, through `execute` and background shells
    // alike, is handed this record (VC-563). Beside the concurrency budget it
    // names this host's socket: desktop bakes its socket into the generated
    // `volli` shim, while the artifact's `bin/volli` is one launcher shared
    // with operators and bakes nothing. Without it the agent's `volli` answers
    // APP_UNREACHABLE and `session done` cannot reach the host that runs it.
    // The Session's identity is still composed after this, never from here.
    // A Session's git (VC-700, VC-702): on a Mac the keychain helper is reset
    // first, and Volli's push-credential helper (behind `cloud`) is appended
    // after it, never over it.
    sessionEnvironment: (budget) =>
      sessionGitEnv(
        { ...budget, [VOLLI_SOCKET_ENV]: input.socketPath },
        options.platform ?? process.platform,
        gitHelper,
      ),
    // What only this host's doors know, for the one handler map (VC-668).
    doors: (ready) => hostdDoors(ready),
    installQuitHold: () => {},
  });
  const { shells, tokens, automations } = runner;
  /** Set once recovery has finished; until then every worktree question refuses. */
  let recovered: { busyWorktreeSites: BusyWorktreeSites; runtime: AgentSiteRuntime } | undefined;
  /**
   * The retention reclaim's seams (VC-113). Fail closed: before recovery
   * there is no answer to "is this worktree busy", so the question throws and
   * the automatic reclaim and trim skip rather than delete.
   */
  const reclaim: Required<RetentionReclaimSeams> = {
    busyWorktreeSites: async (target) => {
      if (recovered === undefined) throw notReady();
      return recovered.busyWorktreeSites(target);
    },
    releaseAgentSites: async (directory) => {
      if (recovered === undefined) throw notReady();
      return releaseAgentSites(recovered.runtime, directory, {
        newCommandId: randomUUID,
        onError: (sessionId, error) =>
          ports.log.error("could not release session from directory", {
            sessionId,
            directory,
            error,
          }),
      });
    },
  };
  /** The agent command service's Session reads, which the map forwards to once served. */
  let sessionReads: SessionReadPort | undefined;
  /**
   * What only this host's doors know, for the one handler map the runner
   * builds over the recovered services (once, when the runner binds this
   * host's doors, or by the tool door if a recovered Session calls a tool
   * first).
   */
  function hostdDoors(ready: RunnerReady): RunnerDoorCapabilities {
    const { sessions, runtime, piRuntimeHost } = recoveredRuntimeSessionServices(ready);
    if (sessions === null || runtime === null)
      throw new Error("The headless Session runtime is unavailable.");
    const busyWorktreeSites: BusyWorktreeSites = async (target) => {
      // No terminals are composed on this host. When a terminal port lands,
      // its live cwds must join this supplier rather than bypassing the guard.
      const sites = liveShellWorktreeSites(shells);
      for (const binding of agentSitesWithin(runtime, target)) {
        // An unreadable Session refuses automatic trim; no fail-open deletion.
        if ((await runtime.projection({ sessionId: binding.sessionId })).projection.turnActive) {
          sites.push({ directory: binding.directory, surface: "agent" });
        }
      }
      return sites;
    };
    recovered = { busyWorktreeSites, runtime };
    // Sign-ins on this host (VC-702): keys and push credentials a Client
    // sends land in the host's own stores (Pi's auth storage; the
    // push-credential file under the data directory), and subscription
    // logins run here, over the same Pi collection the runtime reads.
    const signIns =
      modelAccess === null || piRuntimeHost === null
        ? null
        : new HostSignIns({
            pi: piSignIn(modelAccess.models, {
              // Sign in with ChatGPT names the installation to OpenAI: on
              // a host, its persisted host id, a UUID.
              deviceId: () => options.venue.id,
            }),
            inspect: () => piRuntimeHost.inspectModelAccess({}),
            keys: {
              models: piHostCredentials(modelAccess.credentials),
              git: fileGitCredentialStore(join(host.dataDir, GIT_CREDENTIALS_FILE)),
            },
          });
    workspaces ??=
      options.projectsRoot == null
        ? undefined
        : createHostWorkspaces({
            db,
            projectsRoot: options.projectsRoot,
            userInstall: options.userInstall ?? true,
            env: input.env,
            gitCredentialHelper: options.gitCredentialHelper ?? "",
            detachedWork: host.detachedWork,
            onCreated: (project) => ports.events.publish("data-changed", { projectId: project.id }),
          });
    // hostd keeps no experiments and composes no terminals, so those
    // handlers answer unavailable and a backward move interrupts nothing a
    // terminal holds.
    return {
      experiments: null,
      busyWorktreeSites,
      // Served before any door opens: hostd hands it over before it
      // settles the socket or starts the listener.
      sessionReads: (verb, workspaceId, args) => sessionReads!(verb, workspaceId, args),
      signIns,
      workspaces,
      logs: input.logs ?? null,
      ...(input.boardFeed === undefined ? {} : { boardFeed: input.boardFeed }),
    };
  }
  /** What a recovered host serves, from the recovered proof. */
  const serve = (ready: RunnerReady) => ({
    ...recoveredSessionCommandPorts(ready),
    /**
     * Hands the map its Session reads (VC-663, D4): the agent command
     * service's Workspace-scoped `executeInWorkspace`, which is built
     * after this map, so the map forwards to it once served.
     */
    serveSessionReads(read: SessionReadPort): void {
      sessionReads = read;
    },
    venue: options.venue,
    verifySessionToken: tokens.verify,
    automationsAvailable: automations.kind === "live" && automations.execution.kind === "ready",
    // Built before the tool door serves its verbs into it (VC-923).
    handlers: runner.handlers(ready),
  });
  const owner = runner.owner({
    // The map is built before the tool door serves its verbs into it.
    bind: (ready) => void runner.handlers(ready),
    // The Workspace service closes before the Session drain it reads through.
    beforeClose: async () => {
      await workspaces?.close();
    },
  });
  let starting: Promise<ReturnType<typeof serve>> | undefined;
  return {
    /** The Workspace service, then the Session drain, shells and Automation settlement. */
    close: () => owner.close(),
    /** The scheduler and armed Runs: the host lifecycle's synchronous first step. */
    stopProducers: () => owner.stopProducers(),
    /** Sessions holding a live attachment token, read on every orphan scan. */
    liveSessionIds: () => tokens.liveSessionIds(),
    reclaim,
    /** Recovery, then Automations, then this host's services, then the tool door. */
    ready(): Promise<ReturnType<typeof serve>> {
      starting ??= (async () => {
        await owner.start();
        return serve(await runner.ready());
      })();
      return starting;
    },
  };
}
export type HeadlessSessionRuntime = ReturnType<typeof createHeadlessSessionRuntime>;
