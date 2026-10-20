/** Host-owned catalog and registrations. No connection lifetime or operator token participates. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import type Database from "better-sqlite3";
import { createProject, type DetachedWorkPort } from "@volli/host-core/board";
import { listProjects } from "@volli/host-core/db";
import { hostLogger } from "@volli/host-core/log";
import {
  COMMAND_INTENT_CONFLICT,
  HOST_WORKSPACE_BOUNDS as bounds,
  isValidBranchName,
  redactLogText,
  type HostWorkspace,
  type HostWorkspaceCreateInput,
  type HostWorkspaceCreateResult,
  type HostWorkspaceList,
  type Project,
} from "@volli/shared";

// The same pure URL admission rules as the SSH project-creation path (VC-710).
import { gitUrlProblem, repositoryName } from "@volli/host-install";

export interface HostWorkspacesOptions {
  readonly db: Database.Database;
  readonly projectsRoot: string;
  readonly userInstall: boolean;
  readonly env: NodeJS.ProcessEnv;
  /** Git's command-scope helper value, not a token. Empty means no helpers. */
  readonly gitCredentialHelper: string;
  readonly detachedWork?: DetachedWorkPort;
  /** The shared registration's committed new-project announcement. */
  readonly onCreated?: (project: Project) => void;
  /** Internal fixture seam. Never pass this from production composition or protocol input. */
  readonly testOnly?: {
    readonly allowFileUrls?: boolean;
    readonly timeoutMs?: number;
    readonly outputLimit?: number;
    readonly capacity?: number;
    readonly now?: () => number;
    readonly catalogBytes?: number;
    readonly catalogTimeoutMs?: number;
    readonly rowTimeoutMs?: number;
  };
}

// hostd permits 2 MiB frames. Keep 64 KiB for tRPC framing/metadata; measure
// the actual UTF-8 JSON answer, including punctuation and the omitted count.
const CATALOG_MAX_JSON_BYTES = 2 * 1024 * 1024 - 64 * 1024;
const OUTCOME_RETENTION_MS = 60 * 60_000;

type FailureCode = Extract<HostWorkspaceCreateResult, { ok: false }>["failure"]["code"];
const messages: Record<FailureCode, string> = {
  "invalid-source": "Choose an absolute folder path or a supported repository URL.",
  "path-unreadable": "The host cannot read that folder.",
  "target-exists":
    "The clone destination already exists. List projects or choose another repository.",
  "clone-failed": "The host could not clone the repository.",
  "clone-timeout": "The clone exceeded its time limit.",
  "registration-failed": "The host could not register the project.",
  "still-running": "This command is still running. Retry with the same command ID.",
  interrupted: "The host is shutting down. List projects after reconnecting.",
  capacity:
    "The host is at its command capacity. Retry when running work finishes or retained outcomes expire.",
};
const failure = (code: FailureCode): HostWorkspaceCreateResult => ({
  ok: false,
  failure: { code, message: messages[code] },
});

class IntentConflict extends Error {
  readonly [COMMAND_INTENT_CONFLICT] = true as const;
  constructor() {
    super("Command ID was already used for a different workspace intent.");
    this.name = "HostWorkspaceIntentConflict";
  }
}
class GitFailure extends Error {
  constructor(readonly code: "clone-failed" | "clone-timeout" | "interrupted") {
    super(messages[code]);
  }
}

/** Strip URL authority secrets; do not clip a locator into a different locator. */
function safeRemote(text: string): string | null {
  const raw = text.trim();
  try {
    const scp = /^[^\s/@:]+@([A-Za-z0-9.-]+):([^\s?#]+)$/u.exec(raw);
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : raw);
    if (!["https:", "ssh:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const safe = url.toString();
    if (safe.length > bounds.gitUrl || /[\p{Cc}\s%]/u.test(safe)) return null;
    return redactLogText(safe, Number.MAX_SAFE_INTEGER) === safe ? safe : null;
  } catch {
    return null;
  }
}

function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    // The process group includes credential/transport children, not just git.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function createHostWorkspaces(options: HostWorkspacesOptions) {
  let closed = false;
  let closing: Promise<void> | undefined;
  let releaseOwnership!: () => void;
  const ownershipEnded = new Promise<void>((done) => {
    releaseOwnership = done;
  });
  const children = new Set<ChildProcess>();
  const active = new Set<Promise<HostWorkspaceCreateResult>>();
  // Settled outcomes are replayable for one hour. Running work never expires.
  // Outside that horizon the operation's natural idempotency decides the result.
  const outcomes = new Map<
    string,
    { intent: string; result?: HostWorkspaceCreateResult; expiresAt?: number }
  >();
  const capacity = options.testOnly?.capacity ?? 1000;
  const now = options.testOnly?.now ?? Date.now;
  const catalogBytes = options.testOnly?.catalogBytes ?? CATALOG_MAX_JSON_BYTES;
  // One coalesced catalog plus at most four creates: each runs git serially,
  // so dropped transports cannot leave an unbounded number of children.
  const maxCreates = 4;
  let catalog: Promise<HostWorkspaceList> | undefined;
  const env = Object.fromEntries(
    Object.entries(options.env).filter(([key]) => !key.startsWith("GIT_") && key !== "SSH_ASKPASS"),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    GIT_ALLOW_PROTOCOL: options.testOnly?.allowFileUrls ? "https:ssh:file" : "https:ssh",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
  });
  const config = [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${options.gitCredentialHelper}`,
  ];

  function assertOpen() {
    if (closed) throw new GitFailure("interrupted");
  }
  // Core's registration awaits filesystem/branch reads. Fence its actual synchronous
  // write too: close can run in a microtask between a detector's return and core's resume.
  // Statements prepared through this facade are not shared with other DB consumers.
  const registrationDb = new Proxy(options.db, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => {
        assertOpen();
        const statement = target.prepare(sql);
        const run = statement.run.bind(statement);
        statement.run = (...params: unknown[]) => {
          assertOpen();
          return run(...params);
        };
        return statement;
      };
    },
  });
  function git(args: string[], cwd: string, timeoutMs = 10_000): Promise<string> {
    assertOpen();
    return new Promise((resolve, reject) => {
      const child = spawn("git", [...config, ...args], {
        cwd,
        env: { ...env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let reason: GitFailure["code"] | undefined;
      let output = "";
      let bytes = 0;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = (code: GitFailure["code"]) => {
        if (reason !== undefined) return;
        reason = code;
        stop(child, "SIGTERM");
        killTimer = setTimeout(() => stop(child, "SIGKILL"), 250);
      };
      const timer = setTimeout(() => cancel("clone-timeout"), timeoutMs);
      const read = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length;
        if (bytes > (options.testOnly?.outputLimit ?? 64 * 1024)) cancel("clone-failed");
        else if (stdout) output += chunk.toString("utf8");
      };
      child.stdout!.on("data", (chunk: Buffer) => read(chunk, true));
      child.stderr!.on("data", (chunk: Buffer) => read(chunk, false));
      child.on("error", () => {
        reason = "clone-failed";
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        children.delete(child);
        if (closed) reject(new GitFailure("interrupted"));
        else if (reason !== undefined || code !== 0)
          reject(new GitFailure(reason ?? "clone-failed"));
        else resolve(output);
      });
    });
  }

  let catalogGitBusy = false;
  async function row(project: Project, deadline = Infinity): Promise<HostWorkspace | null> {
    if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(project.id))
      return null;
    if (
      !isAbsolute(project.path) ||
      project.path.length > bounds.path ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(project.path)
    )
      return null;
    let path: string;
    try {
      path = await realpath(project.path);
    } catch {
      return null;
    }
    if (path.length > bounds.path || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(path)) return null;
    const name = project.name.slice(0, bounds.name);
    if (!name || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return null;
    // A timed-out filesystem read may finish later. It must not start new work.
    if (Date.now() >= deadline || (deadline !== Infinity && catalogGitBusy)) return null;
    let gitRemoteUrl: string | null = null;
    if (deadline !== Infinity) catalogGitBusy = true;
    try {
      gitRemoteUrl = safeRemote(
        await git(
          ["config", "--get", "remote.origin.url"],
          path,
          Math.min(10_000, deadline - Date.now()),
        ),
      );
    } catch (error) {
      if (error instanceof GitFailure && error.code === "clone-timeout") return null;
      /* No readable origin. */
    } finally {
      if (deadline !== Infinity) catalogGitBusy = false;
    }
    return { id: project.id, name, path, gitRemoteUrl };
  }
  async function readCatalog(): Promise<HostWorkspaceList> {
    assertOpen();
    const projects = listProjects(options.db).toSorted(
      (a, b) =>
        a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en"),
    );
    const workspaces: HostWorkspace[] = [];
    // Reserve the widest possible omitted count even when fewer rows are excluded.
    let bytes = Buffer.byteLength(
      JSON.stringify({ workspaces: [], omitted: projects.length }),
      "utf8",
    );
    let omitted = 0;
    const deadline = Date.now() + (options.testOnly?.catalogTimeoutMs ?? 10_000);
    for (const project of projects) {
      if (workspaces.length === bounds.rows || Date.now() >= deadline) {
        omitted++;
        continue;
      }
      const rowDeadline = Math.min(deadline, Date.now() + (options.testOnly?.rowTimeoutMs ?? 1000));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const workspace = await Promise.race([
        row(project, rowDeadline),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(0, rowDeadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
      assertOpen();
      if (workspace === null) {
        omitted++;
        continue;
      }
      const added =
        Buffer.byteLength(JSON.stringify(workspace), "utf8") + (workspaces.length === 0 ? 0 : 1);
      if (bytes + added > catalogBytes) {
        omitted++;
        continue;
      }
      bytes += added;
      workspaces.push(workspace);
    }
    return { workspaces, omitted };
  }
  function list(): Promise<HostWorkspaceList> {
    if (catalog !== undefined) return catalog;
    catalog = readCatalog().finally(() => {
      catalog = undefined;
    });
    return catalog;
  }

  async function execute(input: HostWorkspaceCreateInput): Promise<HostWorkspaceCreateResult> {
    let owned: { path: string; stats: Stats } | undefined;
    let registered = false;
    let unexpected: FailureCode = "clone-failed";
    try {
      assertOpen();
      if (
        input.name !== undefined &&
        (!input.name.trim() ||
          input.name.length > bounds.name ||
          /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input.name))
      )
        return failure("invalid-source");
      let path: string;
      if ("path" in input.source) {
        if (
          !isAbsolute(input.source.path) ||
          input.source.path.length > bounds.path ||
          input.source.path.includes("\0")
        )
          return failure("invalid-source");
        try {
          path = await realpath(input.source.path);
          if (!(await stat(path)).isDirectory()) return failure("path-unreadable");
          await access(path, constants.R_OK | constants.X_OK);
        } catch {
          return failure("path-unreadable");
        }
      } else {
        const url = input.source.gitUrl;
        const fileFixture =
          options.testOnly?.allowFileUrls &&
          url.startsWith("file:///") &&
          !/[\s\p{Cc}?#%]/u.test(url);
        const directory = repositoryName(url);
        if ((!fileFixture && gitUrlProblem(url) !== null) || directory === null)
          return failure("invalid-source");
        if (!isAbsolute(options.projectsRoot)) return failure("invalid-source");
        await mkdir(options.projectsRoot, {
          recursive: true,
          mode: options.userInstall ? 0o700 : 0o755,
        });
        path = join(await realpath(options.projectsRoot), directory);
        if (path.length > bounds.path) return failure("invalid-source");
        assertOpen();
        try {
          await mkdir(path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return failure("target-exists");
          throw new GitFailure("clone-failed");
        }
        owned = { path, stats: await lstat(path) };
        await git(
          ["clone", "--quiet", "--no-recurse-submodules", "--", url, path],
          options.projectsRoot,
          options.testOnly?.timeoutMs ?? 600_000,
        );
      }
      if (path.length > bounds.path) return failure("invalid-source");
      assertOpen();
      unexpected = "registration-failed";
      const result = await createProject(
        {
          db: registrationDb,
          onCreated: (project) => {
            // The insert committed even if its notification fails: keep its clone.
            registered = true;
            try {
              options.onCreated?.(project);
            } catch {
              hostLogger("host-workspaces").warn(
                "Project registered, but its change announcement failed",
                { projectId: project.id },
              );
            }
          },
          detectBaseBranch: async (directory) => {
            // This awaited port is also the final shutdown fence before core's synchronous DB write.
            let branch: string | null = null;
            for (const args of [
              ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
              ["branch", "--show-current"],
            ]) {
              assertOpen();
              try {
                const value = (await git(args, directory))
                  .trim()
                  .replace(/^refs\/remotes\/origin\//u, "");
                if (value && isValidBranchName(value)) {
                  branch = value;
                  break;
                }
              } catch {
                /* Missing origin / non-git folder. */
              }
            }
            assertOpen();
            return branch;
          },
        },
        { path, name: input.name?.trim() ?? basename(path) },
      );
      if (!result.ok) return failure("registration-failed");
      registered = true;
      const workspace = await row(result.project);
      return workspace === null ? failure("registration-failed") : { ok: true, workspace };
    } catch (error) {
      return failure(
        closed ? "interrupted" : error instanceof GitFailure ? error.code : unexpected,
      );
    } finally {
      if (owned !== undefined && !registered) {
        try {
          const current = await lstat(owned.path);
          if (
            current.dev === owned.stats.dev &&
            current.ino === owned.stats.ino &&
            !current.isSymbolicLink()
          ) {
            await rm(owned.path, { recursive: true, force: true });
          }
        } catch {
          /* Cleanup is best effort; a surviving destination is refused on the next command. */
        }
      }
    }
  }
  function create(input: HostWorkspaceCreateInput): Promise<HostWorkspaceCreateResult> {
    const at = now();
    for (const [id, retained] of outcomes) {
      if (retained.expiresAt !== undefined && retained.expiresAt <= at) outcomes.delete(id);
    }
    const intent = createHash("sha256")
      .update(JSON.stringify([input.source, input.name ?? null]))
      .digest("hex");
    const prior = outcomes.get(input.commandId);
    if (prior !== undefined) {
      if (prior.intent !== intent) throw new IntentConflict();
      return Promise.resolve(prior.result ?? failure("still-running"));
    }
    if (closed) return Promise.resolve(failure("interrupted"));
    if (outcomes.size >= capacity || active.size >= maxCreates)
      return Promise.resolve(failure("capacity"));
    const entry: { intent: string; result?: HostWorkspaceCreateResult; expiresAt?: number } = {
      intent,
    };
    outcomes.set(input.commandId, entry);
    const work = execute(input)
      .then((result) => {
        entry.result = result;
        entry.expiresAt = now() + OUTCOME_RETENTION_MS;
        return result;
      })
      .finally(() => {
        active.delete(work);
      });
    active.add(work);
    // The host tracker observes our bounded ownership, not an abandoned
    // filesystem promise that would re-block its drain after close returned.
    // Late work remains fenced against registration by the closed service.
    options.detachedWork?.track(Promise.race([work, ownershipEnded]));
    return work;
  }
  function close(): Promise<void> {
    if (closing !== undefined) return closing;
    closed = true;
    for (const child of children) stop(child, "SIGTERM");
    closing = new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        for (const child of children) stop(child, "SIGKILL");
      }, 250);
      const deadline = setTimeout(resolve, 3000);
      void Promise.allSettled([...active, ...(catalog === undefined ? [] : [catalog])]).then(() => {
        // Both creates and the coalesced catalog settled; their git close
        // events have released every child before resolving their promises.
        clearTimeout(kill);
        clearTimeout(deadline);
        resolve();
      });
    });
    closing = closing.then(() => {
      releaseOwnership();
    });
    return closing;
  }
  return { list, create, close };
}
