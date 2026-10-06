/**
 * volli-drive core: the pure, unit-tested rules every other file leans on.
 *
 *   • where things live    — a per-user registry dir, short scratch roots
 *                            (the app's unix socket must fit sun_path), and
 *                            evidence that outlives the instance.
 *   • the instance registry — a lock, a hard cap of MAX_INSTANCES live
 *                            instances on this machine, liveness by pid.
 *   • the environments     — what the supervisor inherits (the outer agent's
 *                            Volli addressing, provider keys and agent sockets
 *                            stripped) and what Electron gets on top (harness
 *                            mode, isolated HOME/Pi dir/git config, quiet
 *                            windows, no gh, no ssh-agent).
 *   • read-only state      — which SQL the `state sql` door accepts.
 *   • snapshot search      — `find`, the same literal, case-insensitive match
 *                            Volli's browser_find makes, with ancestor paths.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, promises as fs, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: this file lives at apps/desktop/e2e/volli-drive/lib/. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
export const APP_DIR = join(REPO, "apps", "desktop");
export const BUILT_MAIN = join(APP_DIR, "dist-electron", "main.cjs");
export const BUILT_CLI = join(APP_DIR, "dist-electron", "volli-cli.cjs");

/** The guard's bundled marker (apps/desktop/src/main/harness/keychain-guard.ts). */
export const HARNESS_GUARD_MARKER = "volli-harness-keychain-guard:v1";
export const HARNESS_TRAP_SYMBOL = "volli.harness.keychainTrap";
export const HARNESS_VIOLATION_EXIT_CODE = 86;
export const SAFE_STORAGE_METHODS = [
  "isEncryptionAvailable",
  "encryptString",
  "decryptString",
  "getSelectedStorageBackend",
  "setUsePlainTextEncryption",
  "isAsyncEncryptionAvailable",
  "encryptStringAsync",
  "decryptStringAsync",
];

/** At most this many live instances on the machine, across every checkout. */
export const MAX_INSTANCES = 3;
/** A forgotten instance stops itself after this long without a command. */
export const DEFAULT_IDLE_MS = 20 * 60 * 1000;
/** A registry lock older than this belongs to a dead CLI. */
const STALE_LOCK_MS = 30_000;

// ---- where things live -----------------------------------------------------

/**
 * The machine-wide registry: per user, under /tmp (not os.tmpdir(), which is
 * per-session-ish on macOS and long), mode 0700 and owned by us — a directory
 * another user pre-created is refused, never trusted.
 */
export function driveHome(env = process.env) {
  return env.VOLLI_DRIVE_HOME ?? join("/tmp", `volli-drive-${os.userInfo().uid}`);
}

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(dir);
  if (stat.uid !== os.userInfo().uid) throw new Error(`${dir} is not owned by this user`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `${dir} is accessible to other users (mode ${(stat.mode & 0o777).toString(8)})`,
    );
  }
  return dir;
}

/** Where an instance's evidence lands: inside the checkout, git-excluded. */
export function evidenceRoot(env = process.env) {
  return env.VOLLI_DRIVE_EVIDENCE ?? join(REPO, ".scratch", "volli-drive");
}

export function newInstanceId(random = randomBytes) {
  return `vd-${random(3).toString("hex")}`;
}

export function isInstanceId(value) {
  return typeof value === "string" && /^vd-[0-9a-f]{6}$/.test(value);
}

/** Every path an instance owns, under one short scratch root. */
export function instanceLayout(scratch, evidence) {
  return {
    scratch,
    userDataDir: join(scratch, "ud"),
    dbPath: join(scratch, "ud", "volli.db"),
    appSocket: join(scratch, "ud", "volli.sock"),
    cliShim: join(scratch, "ud", "bin", "volli"),
    home: join(scratch, "home"),
    piAgentDir: join(scratch, "home", ".pi", "agent"),
    harnessDir: join(scratch, "harness"),
    worktreeHome: join(scratch, "wt"),
    projectsDir: join(scratch, "projects"),
    binDir: join(scratch, "bin"),
    zdotDir: join(scratch, "zdot"),
    driveSocket: join(scratch, "drive.sock"),
    evidence,
    logsDir: join(evidence, "logs"),
    mainLog: join(evidence, "logs", "main.log"),
    consoleLog: join(evidence, "logs", "console.jsonl"),
    supervisorLog: join(evidence, "logs", "supervisor.log"),
    transcript: join(evidence, "transcript.jsonl"),
    snapshotsDir: join(evidence, "snapshots"),
    screenshotsDir: join(evidence, "screenshots"),
    manifest: join(evidence, "manifest.json"),
    readyFile: join(evidence, "ready.json"),
  };
}

// ---- registry --------------------------------------------------------------

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function createRegistry(home = driveHome(), { alive = pidAlive, now = Date.now } = {}) {
  const instancesDir = join(home, "instances");
  const lockDir = join(home, "registry.lock");
  const entryPath = (id) => join(instancesDir, `${id}.json`);

  async function withLock(fn) {
    ensurePrivateDir(home);
    ensurePrivateDir(instancesDir);
    const deadline = now() + 10_000;
    for (;;) {
      try {
        await fs.mkdir(lockDir);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const stat = await fs.stat(lockDir).catch(() => null);
        if (stat && now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (now() > deadline) throw new Error(`registry lock ${lockDir} is held`, { cause: error });
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  async function readAll() {
    let names = [];
    try {
      names = await fs.readdir(instancesDir);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names.filter((n) => n.endsWith(".json")).toSorted()) {
      try {
        entries.push(JSON.parse(await fs.readFile(join(instancesDir, name), "utf8")));
      } catch {
        // A half-written entry is skipped, never trusted.
      }
    }
    return entries;
  }

  // A slot reserved by a launch that has not spawned its supervisor yet still
  // counts toward the cap, for long enough to boot.
  const live = (entry) =>
    alive(entry.supervisorPid) ||
    alive(entry.electronPid) ||
    (!entry.supervisorPid && now() - (entry.reservedAt ?? 0) < 180_000);

  return {
    instancesDir,
    async list() {
      return (await readAll()).map((entry) => Object.assign(entry, { live: live(entry) }));
    },
    async get(id) {
      try {
        const entry = JSON.parse(await fs.readFile(entryPath(id), "utf8"));
        return { ...entry, live: live(entry) };
      } catch {
        return null;
      }
    },
    /** Reserve a slot, or refuse when MAX_INSTANCES are already live. */
    async reserve(entry, max = MAX_INSTANCES) {
      return withLock(async () => {
        const running = (await readAll()).filter(live);
        if (running.length >= max) {
          throw new Error(
            `${running.length} volli-drive instances are already running (max ${max}): ` +
              `${running.map((e) => e.id).join(", ")}. Stop one first.`,
          );
        }
        await fs.writeFile(entryPath(entry.id), `${JSON.stringify(entry, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        return entry;
      });
    },
    async update(id, patch) {
      return withLock(async () => {
        const current = JSON.parse(await fs.readFile(entryPath(id), "utf8"));
        const next = { ...current, ...patch };
        await fs.writeFile(entryPath(id), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        return next;
      });
    },
    async remove(id) {
      return withLock(() => fs.rm(entryPath(id), { force: true }));
    },
  };
}

// ---- environments ----------------------------------------------------------

/**
 * Inherited names an instance must never see. The outer agent's own Volli
 * addressing would point the scratch app (and every CLI it spawns) at the
 * OWNER's app; agent sockets and provider keys are credentials.
 */
const ALWAYS_SCRUBBED = [
  /^VOLLI_/, // VOLLI_SESSION, VOLLI_TICKET, VOLLI_SESSION_TOKEN, VOLLI_SOCKET, …
  /^ELECTRON_/, // ELECTRON_RUN_AS_NODE / ELECTRON_RENDERER_URL turn the launch into something else
  /^SSH_AUTH_SOCK$/, // no agent, so no keychain-backed ssh identities
  /^SSH_AGENT_PID$/,
  /^GH_TOKEN$/,
  /^GITHUB_TOKEN$/,
  /^GH_ENTERPRISE_TOKEN$/,
  /^PI_CODING_AGENT_DIR$/,
  /^GIT_/, // a GIT_DIR or GIT_CONFIG_* from the outer shell must not reach the fixture
  /^NODE_OPTIONS$/,
];
/** Kept even though they match a scrub rule: they configure volli-drive itself. */
const DRIVE_OWN = new Set(["VOLLI_DRIVE_HOME", "VOLLI_DRIVE_EVIDENCE", "VOLLI_DRIVE_IDLE_MS"]);
/** Provider credentials and endpoints: stripped unless `--model env` asks for them. */
const PROVIDER_ENV =
  /(_API_KEY|_AUTH_TOKEN|_ACCESS_KEY|_SECRET_ACCESS_KEY|_SESSION_TOKEN)$|^(AZURE_OPENAI_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AWS_|MISTRAL_|GROQ_|XAI_|OPENROUTER_|CEREBRAS_|DEEPSEEK_)/;

/** The environment the detached supervisor starts with. */
export function supervisorEnv(parent, { model = "fake" } = {}) {
  const env = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (!DRIVE_OWN.has(name) && ALWAYS_SCRUBBED.some((rule) => rule.test(name))) continue;
    if (model !== "env" && PROVIDER_ENV.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * What Electron gets over the supervisor's environment. Everything a launch
 * could reach outside its scratch tree is pinned inside it.
 */
export function electronExtraEnv(layout, { loginShell, path, providerEnv = {} }) {
  return {
    // The keychain guard (keychain-guard.ts). Nothing else sets these.
    VOLLI_HARNESS: "1",
    VOLLI_HARNESS_DIR: layout.harnessDir,
    VOLLI_QUIET_WINDOWS: "1",
    VOLLI_SKIP_AGENT_TOOLS: "1",
    VOLLI_SKIP_CLOSE_CONFIRM: "1",
    VOLLI_WORKTREE_HOME_DIR: layout.worktreeHome,
    HOME: layout.home,
    // The one app.getPath("home") reader (the agent-tools / harness manifest
    // home) ignores $HOME on macOS; this dev-only seam redirects it.
    VOLLI_AGENT_HOME: layout.home,
    PI_CODING_AGENT_DIR: layout.piAgentDir,
    XDG_CONFIG_HOME: join(layout.home, ".config"),
    XDG_DATA_HOME: join(layout.home, ".local", "share"),
    XDG_CACHE_HOME: join(layout.home, ".cache"),
    ZDOTDIR: layout.zdotDir,
    SHELL: loginShell,
    PATH: path,
    // Git reads no system config (Xcode's names the osxkeychain credential
    // helper) and a global config of our own; it never prompts.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(layout.home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    // The fake provider is loopback; an inherited proxy must not swallow it.
    NO_PROXY: "127.0.0.1,localhost",
    ...providerEnv,
  };
}

// ---- read-only state -------------------------------------------------------

/**
 * The `state sql` door takes one read statement. sqlite3 also opens the file
 * read-only; this is the earlier, clearer refusal, and it keeps dot-commands
 * (`.shell`, `.output`) out entirely.
 */
export function readOnlySql(sql) {
  const text = String(sql ?? "").trim();
  if (text.length === 0) return { ok: false, reason: "empty statement" };
  if (text.startsWith(".")) return { ok: false, reason: "sqlite dot-commands are refused" };
  const body = text.replace(/;\s*$/, "");
  if (body.includes(";")) return { ok: false, reason: "one statement only" };
  if (
    !/^(select|with|pragma\s+(table_info|table_list|index_list|foreign_key_list)\b)/i.test(body)
  ) {
    return { ok: false, reason: "only SELECT, WITH and schema PRAGMAs are allowed" };
  }
  if (
    /\b(insert|update|delete|replace|drop|alter|create|attach|detach|vacuum|reindex)\b/i.test(
      body.replace(/'[^']*'/g, "''"),
    )
  ) {
    return { ok: false, reason: "statement contains a write keyword" };
  }
  return { ok: true, sql: body };
}

// ---- snapshot search -------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Literal, case-insensitive search over an aria "ai" snapshot. Returns the
 * matching lines, each under its chain of ancestors (by indentation), so a
 * ref can be acted on without printing the whole tree.
 */
export function findInSnapshot(snapshot, query) {
  const needle = String(query).toLowerCase();
  const lines = snapshot.split("\n");
  const keep = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    keep.add(i);
    let indent = indentOf(lines[i]);
    for (let j = i - 1; j >= 0 && indent > 0; j--) {
      const candidate = indentOf(lines[j]);
      if (candidate < indent && lines[j].trim().length > 0) {
        keep.add(j);
        indent = candidate;
      }
    }
  }
  return [...keep].toSorted((a, b) => a - b).map((i) => lines[i]);
}

/** The refs a snapshot minted, for refusing one it never showed. */
export function snapshotRefs(snapshot) {
  return new Set([...snapshot.matchAll(/\[ref=([a-z0-9]+)\]/g)].map((m) => m[1]));
}

// ---- static guard check ----------------------------------------------------

/** Whether a built main bundle carries the keychain guard. */
export function bundleCarriesGuard(path = BUILT_MAIN) {
  try {
    const source = readFileSync(path, "utf8");
    return (
      source.includes(HARNESS_GUARD_MARKER) &&
      source.includes("installHarnessGuard") &&
      source.includes("use-mock-keychain")
    );
  } catch {
    return false;
  }
}
