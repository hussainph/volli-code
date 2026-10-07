/**
 * A remote host's projects over SSH (VC-710): the scripts the engine runs as
 * the host's login, and the readers that decide what of their answer this Mac
 * believes. Pure: no SSH, no engine state; `remote-hosts.ts` runs them.
 *
 * - **Listing** is `volli project list --json` on the host: anyone in the
 *   socket's group may read it, so it works on a host with no projects, where
 *   no Workspace link can exist yet. Each row's `id` is its Workspace id.
 * - **Creating** is the host's own `volli project add`, the operator's verb
 *   (VC-623): the login's operator token proves the person. With a git URL,
 *   the folder is cloned first, as hostd's own account on a system install
 *   (`sudo -n -u volli`, never a password), so hostd and its Sessions own the
 *   checkout; only into a folder that account can write, with prompts off and
 *   only the https and ssh transports allowed.
 *
 * Every script is plain POSIX sh with its stdin `/dev/null`, names an
 * absolute `volli` and the socket of the host's install mode, and never
 * carries a Session's evidence (a Session's variables are unset), so the
 * CLI presents the login's operator token or nothing.
 */
import {
  remoteHostDiagnostic,
  REMOTE_HOST_PROJECT_TEXT_MAX,
  REMOTE_HOST_PROJECTS_MAX,
  type RemoteHostProject,
  type RemoteProjectFailure,
} from "@volli/shared";

import type { InstallMode } from "./contract";
import { shellQuote } from "./ssh";

/** hostd itself on a system install: Volli's git credential helper is its `git-credential`. */
const MANAGED_SYSTEM_HOSTD = "/opt/volli-hostd/current/bin/volli-hostd";
const FLAT_SYSTEM_HOSTD = "/opt/volli-hostd/bin/volli-hostd";

/** The CLI beside hostd, for each install mode (`install.ts` links it from `current/bin`). */
const MANAGED_SYSTEM_VOLLI = "/opt/volli-hostd/current/bin/volli";
const FLAT_SYSTEM_VOLLI = "/opt/volli-hostd/bin/volli";
const USER_VOLLI = '"${XDG_DATA_HOME:-$HOME/.local/share}/volli-hostd/current/bin/volli"';

/** hostd's agent socket for each install mode (`apps/hostd/src/layout.ts`). */
const SYSTEM_SOCKET = "/run/volli-hostd.sock";
const USER_SOCKET_LINUX = '"${XDG_STATE_HOME:-$HOME/.local/state}/volli-hostd/volli.sock"';
const USER_SOCKET_MAC = '"$HOME/Library/Application Support/volli-hostd/volli.sock"';

/** The account a system install runs hostd and every Session as. */
export const SYSTEM_SERVICE_USER = "volli";

/** Where a clone goes when no folder is named: a system install's checkouts (runbook step 6). */
export const SYSTEM_PROJECTS_DIR = "/srv/volli";

/** The longest git URL this Mac sends to a host. */
export const GIT_URL_MAX = 2048;

/** The command that issues the login an operator token, run once on the host as root. */
export function operatorTokenCommand(login: string): string {
  return `sudo volli-hostd operator-token --for ${shellQuote(login)}`;
}

/** The lines every project script starts with: the CLI, its socket, and no Session's evidence. */
function preamble(mode: InstallMode): string[] {
  const find =
    mode === "system"
      ? [
          `v=${shellQuote(MANAGED_SYSTEM_VOLLI)}`,
          `[ -x "$v" ] || v=${shellQuote(FLAT_SYSTEM_VOLLI)}`,
        ]
      : [`v=${USER_VOLLI}`];
  const socket =
    mode === "system"
      ? [`VOLLI_SOCKET=${shellQuote(SYSTEM_SOCKET)}`]
      : [
          `if [ "$(uname -s)" = Darwin ]; then VOLLI_SOCKET=${USER_SOCKET_MAC}; else VOLLI_SOCKET=${USER_SOCKET_LINUX}; fi`,
        ];
  return [
    ...find,
    ...socket,
    "export VOLLI_SOCKET",
    "unset VOLLI_SESSION VOLLI_SESSION_TOKEN VOLLI_TICKET",
    // Who this is, and whether it holds an operator token yet: read before
    // anything can fail, so every answer can name the one command to run.
    `t=no; [ -s "$HOME/.config/volli/operator-token" ] && t=yes`,
    `printf 'volli-login=%s\\nvolli-token=%s\\n' "$(id -un)" "$t"`,
  ];
}

/** `volli project list --json` on the host, as the login. */
export function projectsListScript(mode: InstallMode): string {
  return [...preamble(mode), `exec "$v" project list --json </dev/null`].join("\n");
}

export interface CreateProjectScript {
  readonly mode: InstallMode;
  /** The folder: absolute, or under `~/`. */
  readonly path: string;
  readonly name: string | null;
  /** Clone this first (a URL {@link gitUrlProblem} accepts), into `path`. */
  readonly gitUrl: string | null;
  /**
   * Whether the script's stdin carries the login's sudo password (one line),
   * for `sudo -S` when `sudo -n` needs one. Only sudo ever reads it.
   */
  readonly sudoPassword?: boolean;
  /**
   * Volli's git credential helper (`!<program> git-credential --data-dir
   * <dir>`), for a test; by default a system install's own hostd, and none
   * for a user install.
   */
  readonly credentialHelper?: string;
}

/** The hostd a system install runs, and its data directory: the helper's store is there. */
const SYSTEM_DATA_DIR = "/var/lib/volli-hostd";

/**
 * The clone, as whoever the outer script runs it as: `$1` the folder, `$2`
 * the URL, `$3` the URL's https host (empty for ssh), `$4` Volli's credential
 * helper (empty for none). It says what it found (`volli-credential=`: a
 * token stored for the host, read through the helper into a pipe and never
 * printed) and how it ended (`volli-cloned=` or `volli-fail=`). The helper
 * is command-scope configuration for this one clone; the token itself is
 * only ever on the helper's stdout, read by git.
 */
const CLONE_SCRIPT = [
  `d=$1 u=$2 h=$3 c=$4`,
  `if [ -d "$d/.git" ]; then echo volli-cloned=existing; exit 0; fi`,
  `if [ -e "$d" ]; then echo volli-fail=destination-exists; exit 0; fi`,
  `if [ ! -w "$(dirname -- "$d")" ]; then echo volli-fail=destination-unwritable; exit 0; fi`,
  `k=no`,
  `if [ -n "$c" ] && [ -n "$h" ] && printf 'protocol=https\nhost=%s\n\n' "$h" | sh -c "\${c#!} get" 2>/dev/null | grep -q '^password='; then k=yes; fi`,
  `echo volli-credential=$k`,
  `if [ -n "$c" ]; then set -- -c "credential.helper=$c"; else set --; fi`,
  `if GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true SSH_ASKPASS=true GIT_ALLOW_PROTOCOL=https:ssh GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' git "$@" clone --quiet --no-recurse-submodules -- "$u" "$d" </dev/null; then echo volli-cloned=yes; else echo volli-fail=clone-failed; fi`,
].join("\n");

/** The https host a token would be stored under for `url`; `""` for ssh. */
export function credentialHost(url: string): string {
  return url.startsWith("https://") ? new URL(url).host.toLowerCase() : "";
}

/**
 * `volli project add` on the host, as the login, after a clone when given a
 * URL. A step that cannot go on prints `volli-fail=<code>` and stops; the
 * add's own answer is the CLI's JSON (stdout) or its error (stderr).
 *
 * On a system install the clone runs as hostd's own account, so hostd and
 * its Sessions own the checkout: `sudo -n -u volli` when that needs no
 * password, else `sudo -S` with the password on stdin when one was given,
 * else it stops (`needs-password`, or `needs-sudo` where the login has no
 * sudo at all).
 */
export function createProjectScript(input: CreateProjectScript): string {
  const lines = [
    ...preamble(input.mode),
    `fail() { printf 'volli-fail=%s\\n' "$1"; exit 0; }`,
    `d=${shellQuote(input.path)}`,
    `case "$d" in "~/"*) d="$HOME/\${d#"~/"}" ;; esac`,
  ];
  if (input.gitUrl !== null) {
    const user = SYSTEM_SERVICE_USER;
    lines.push(
      `u=${shellQuote(input.gitUrl)}`,
      `h=${shellQuote(credentialHost(input.gitUrl))}`,
      ...(input.credentialHelper !== undefined
        ? [`c=${shellQuote(input.credentialHelper)}`]
        : input.mode === "system"
          ? [
              `b=${shellQuote(MANAGED_SYSTEM_HOSTD)}`,
              `[ -x "$b" ] || b=${shellQuote(FLAT_SYSTEM_HOSTD)}`,
              `c="!'$b' git-credential --data-dir '${SYSTEM_DATA_DIR}'"`,
            ]
          : [`c=`]),
      ...(input.mode === "system"
        ? [
            `if sudo -n -u ${user} true </dev/null 2>/dev/null; then set -- sudo -n -u ${user} -H`,
            `else`,
            `  case "$(sudo -n -u ${user} true 2>&1 </dev/null)" in *"password is required"*) ;; *) fail needs-sudo ;; esac`,
            input.sudoPassword ? `  set -- sudo -S -p '' -u ${user} -H` : `  fail needs-password`,
            `fi`,
          ]
        : [`set --`]),
      // Only sudo -S reads stdin (the password); the clone itself reads /dev/null.
      `r="$("$@" sh -c ${shellQuote(CLONE_SCRIPT)} volli-clone "$d" "$u" "$h" "$c")"`,
      `printf '%s\\n' "$r"`,
      `case "$r" in *volli-cloned=*) ;; *volli-fail=*) exit 0 ;; *) fail sudo-failed ;; esac`,
    );
  }
  // Inline (`--name=…`): a name that starts with a dash is never read as an option.
  const name = input.name === null ? "" : ` --name=${shellQuote(input.name)}`;
  lines.push(`exec "$v" project add "$d"${name} --json </dev/null`);
  return lines.join("\n");
}

/* ── Git URLs ───────────────────────────────────────────────────────── */

const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u;

/** Why this Mac will not ask a host to clone `url`, or `null`. Only https, ssh and scp-like. */
export function gitUrlProblem(url: string): string | null {
  if (url.length === 0 || url.length > GIT_URL_MAX) return "length";
  // Whitespace, a control character, or anything a shell or git reads as an option.
  if (/[\s\p{Cc}]/u.test(url) || url.startsWith("-")) return "characters";
  // A query or fragment (or either encoded) is where a token rides: never cloned.
  if (/[?#%]/u.test(url)) return "query";
  if (SCP_LIKE.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not-a-url";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return "transport";
  // A password in the URL would be printed, logged and copied into every worktree's config.
  if (parsed.password !== "") return "credentials";
  if (parsed.protocol === "https:" && parsed.username !== "") return "credentials";
  if (parsed.hostname === "" || parsed.pathname.length <= 1) return "not-a-repository";
  return null;
}

/** The folder a clone of `url` is named for: its last path segment, less `.git`; `null` if none. */
export function repositoryName(url: string): string | null {
  const path = SCP_LIKE.test(url) ? url.slice(url.indexOf(":") + 1) : safePath(url);
  if (path === null) return null;
  const last = path.replace(/\/+$/u, "").split("/").pop()!;
  const name = last.replace(/\.git$/u, "");
  return /^[A-Za-z0-9._-]+$/u.test(name) && name !== "." && name !== ".." ? name : null;
}

function safePath(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/* ── Reading the answers ────────────────────────────────────────────── */

/** What every project script said before its command: the login, and whether it holds a token. */
export interface ScriptFacts {
  readonly login: string | null;
  readonly token: boolean;
  /** A step the create script stopped at (`volli-fail=`), or `null`. */
  readonly fail: string | null;
  /** Whether a token was stored for the URL's host when it cloned; `null` before that. */
  readonly credential: boolean | null;
}

export function scriptFacts(stdout: string): ScriptFacts {
  const said = (key: string): string | null => {
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(`volli-${key}=`));
    return line === undefined ? null : line.slice(key.length + 7).trim();
  };
  const login = said("login");
  return {
    login: login !== null && /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/u.test(login) ? login : null,
    token: said("token") === "yes",
    fail: said("fail"),
    credential: said("credential") === null ? null : said("credential") === "yes",
  };
}

/** The last line of `text` that parses as a JSON object, or `null`. */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split("\n").map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Not the CLI's; keep looking above it.
    }
  }
  return null;
}

/** The CLI's `--json` error (`{"error":{code,reason}}`), or `null`. */
export function cliError(stderr: string): { code: string; reason: string } | null {
  const said = lastJsonObject(stderr)?.["error"];
  if (typeof said !== "object" || said === null) return null;
  const { code, reason, message } = said as Record<string, unknown>;
  if (typeof code !== "string") return null;
  const text = typeof reason === "string" ? reason : typeof message === "string" ? message : "";
  return { code, reason: oneLine(text) };
}

/**
 * A host's words, made one bounded line a person may read: a URL's
 * credentials, query and fragment cut, credential-shaped text redacted
 * (`redactLogText`), control characters gone. A sudo password a host might
 * echo is the engine's to scrub by value before this.
 */
export function oneLine(text: string, max = 240): string {
  return remoteHostDiagnostic(text, max);
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= REMOTE_HOST_PROJECT_TEXT_MAX;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One project row as the CLI says it, or `null` when it is not believed. */
export function readProject(value: unknown): RemoteHostProject | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name, prefix, path, tickets } = value as Record<string, unknown>;
  if (!isText(id) || id.length === 0 || !isText(name) || !isText(prefix) || !isText(path)) {
    return null;
  }
  return { id, name, prefix, path, tickets: isCount(tickets) ? tickets : 0 };
}

/**
 * The host's project list: every row believed, or a reason it is not. A
 * host whose rows carry no `id` predates listing (N−1): `outdated`.
 */
export function readProjectList(
  said: Record<string, unknown> | null,
): readonly RemoteHostProject[] | "outdated" | null {
  const projects = said?.["projects"];
  if (!Array.isArray(projects) || projects.length > REMOTE_HOST_PROJECTS_MAX) return null;
  const read: RemoteHostProject[] = [];
  for (const row of projects as unknown[]) {
    if (typeof row === "object" && row !== null && !("id" in row)) return "outdated";
    const project = readProject(row);
    if (project === null) return null;
    read.push(project);
  }
  return read;
}

/** What sudo says to a password it would not take. */
const WRONG_PASSWORD = /incorrect password|Sorry, try again/u;

/** What a git host says to a clone it would not let in without (other) credentials. */
const AUTH_REFUSED =
  /could not read Username|could not read Password|Authentication failed|terminal prompts disabled|Repository not found|Invalid username or password|returned error: 40[13]/iu;

/**
 * A clone the git host turned away, in words that say how to let it in:
 * a token in Sign-ins for an https URL (none stored, or the stored one
 * refused), or the https URL instead of an ssh one this box has no key for.
 * `null` when the failure was something else.
 */
function cloneRefused(
  hostName: string,
  facts: ScriptFacts,
  stderr: string,
  gitUrl: string,
): RemoteProjectFailure | null {
  const gitHost = gitUrl.startsWith("https://") ? new URL(gitUrl).host.toLowerCase() : null;
  if (gitHost === null) {
    return /Permission denied \(publickey/u.test(stderr)
      ? {
          code: "clone-failed",
          message: `${hostName} has no SSH key its git host accepts: use the https URL, with a token in Sign-ins on ${hostName}.`,
          command: null,
        }
      : null;
  }
  if (!AUTH_REFUSED.test(stderr)) return null;
  const token = gitHost === "github.com" ? "a GitHub token" : `a token for ${gitHost}`;
  return {
    code: "needs-credential",
    message:
      facts.credential === true
        ? `${gitHost} refused the token on ${hostName}: replace it in Sign-ins on ${hostName}, then try again.`
        : `Add ${token} in Sign-ins on ${hostName}, then try again.`,
    command: null,
  };
}

/** How a create that did not add a project reads, from what its script said. */
export function createFailure(
  hostName: string,
  facts: ScriptFacts,
  error: { code: string; reason: string } | null,
  stderr: string,
  context: { readonly path: string; readonly gitUrl: string | null },
): RemoteProjectFailure {
  const login = facts.login ?? "<your login>";
  switch (facts.fail) {
    case "needs-password":
      return {
        code: "needs-password",
        message: `Cloning on ${hostName} runs as its ${SYSTEM_SERVICE_USER} account: enter your password on ${hostName} to go on.`,
        command: null,
      };
    case "sudo-failed":
      return WRONG_PASSWORD.test(stderr)
        ? {
            code: "wrong-password",
            message: `That password didn’t work on ${hostName}.`,
            command: null,
          }
        : {
            code: "unavailable",
            message: `sudo didn’t run the clone on ${hostName}.`,
            command: null,
          };
    case "needs-sudo":
      return {
        code: "needs-sudo",
        message: `Cloning on ${hostName} needs sudo, which this login can’t use: clone it there, then add it by its path.`,
        command: `sudo -u ${SYSTEM_SERVICE_USER} -H git clone -- ${shellQuote(context.gitUrl ?? "")} ${shellQuote(context.path)}`,
      };
    case "destination-exists":
      return {
        code: "destination-exists",
        message: `${context.path} is already on ${hostName}, and isn’t a git checkout.`,
        command: null,
      };
    case "destination-unwritable":
      return {
        code: "refused",
        message: `${hostName} can’t write to the folder above ${context.path}.`,
        command: null,
      };
    case "clone-failed": {
      const refused = cloneRefused(hostName, facts, stderr, context.gitUrl ?? "");
      if (refused !== null) return refused;
      const said = oneLine(stderr.trim().split("\n").filter(Boolean).slice(-1).join(" "));
      return {
        code: "clone-failed",
        message: `git couldn’t clone it on ${hostName}${said === "" ? "." : `: ${said}`}`,
        command: null,
      };
    }
    default:
      break;
  }
  switch (error?.code) {
    case "FORBIDDEN_ACTOR":
      return {
        code: "not-operator",
        message: `This Mac can’t add projects on ${hostName} yet. Run this there once, then try again.`,
        command: operatorTokenCommand(login),
      };
    case "APP_UNREACHABLE":
      return {
        code: "hostd-unreachable",
        message: `Volli isn’t answering on ${hostName}.`,
        command: null,
      };
    case "INVALID_REQUEST":
      return {
        code: "refused",
        message:
          error.reason === ""
            ? `${hostName} didn’t add it.`
            : `${hostName} didn’t add it: ${error.reason}`,
        command: null,
      };
    default:
      return { code: "unavailable", message: `${hostName} didn’t answer.`, command: null };
  }
}
