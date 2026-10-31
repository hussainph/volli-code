/**
 * The two texts that add a Linux box as a runner: the one-line install command
 * for its terminal, and the `#cloud-config` user-data that installs the same
 * runner on an always-on server. Pure, so every shape is asserted without a
 * window.
 *
 * Both point at one immutable release asset per app version — no `latest`, no
 * redirect — so a command someone pasted into a box cannot be swapped for a
 * different script later, and the token never rides in the URL. The script's
 * flags are the release contract (C3): `--token` or `VOLLI_RUNNER_TOKEN`,
 * `--name` (the box's own hostname when absent), `--server` for a deployment
 * that is not the packaged default, and `--user` / `--system`.
 *
 * Everything a person typed is single-quoted before it can reach a shell, and
 * is refused outright if it holds a control character or a line break. No
 * value is ever logged, and no refusal message repeats one: the token is a
 * one-hour single-use secret, but these texts carry it by design, so what this
 * module owes is silence — the sentence that says it lasts an hour is the
 * caller's, not this module's.
 *
 * The install script itself (BYO-7) downloads, verifies and links; nothing
 * here reaches the network at generation time.
 */

/** Where the token travels, which is all the three variants differ in. */
export type RunnerInstallVariant = "token" | "environment" | "sudo";

export interface RunnerInstallOptions {
  /** The app's own version, bare: `0.3.0`, `0.3.0-canary.1`. Never `v0.3.0`. */
  appVersion: string;
  /**
   * The one-time install token (`vrt_…`). The generated text carries it by
   * design; nothing here logs it, and no refusal message repeats it.
   */
  token: string;
  /** What the person typed. Blank means the installer keeps the box's hostname. */
  name: string;
  /** A deployment's site URL when it is not the packaged default; `null` for none. */
  server?: string | null;
  /** `token` (the default) is the plain user install. */
  variant?: RunnerInstallVariant;
}

/**
 * Cloud-init's `runcmd` is root already, so it takes no variant: the install is
 * always a system one, and the token goes to the installer's environment.
 */
export type RunnerCloudInitOptions = Omit<RunnerInstallOptions, "variant">;

/** The release download root and asset: one script per version, never rebuilt. */
const INSTALLER_ROOT = "https://github.com/hussainph/volli-code/releases/download";
const INSTALLER_ASSET = "volli-runner-install.sh";

/** The sheet's name input accepts this much; the backend slugs it to its own limit. */
const NAME_MAX_LENGTH = 80;
/** Today a token is `vrt_` plus 256 random bits; the bound is only a guard. */
const TOKEN_MAX_LENGTH = 512;
const SERVER_MAX_LENGTH = 2048;
const VERSION_MAX_LENGTH = 64;

/** A release tag's version: `0.3.0`, `0.3.0-canary.1`, with optional build metadata. */
const VERSION_SHAPE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * C0, DEL, C1, and the two Unicode separators a YAML 1.1 reader also breaks a
 * line on: every character that could end a quoted field early or split one
 * command into two.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point: they must never reach a shell.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Fixtures and local backends answer on loopback over plain HTTP; nothing else may. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A refusal names the field and never its value, because the value may be the
 * token — and this message can end up in a toast, a log, or a bug report.
 */
function refuse(problem: string): never {
  throw new Error(`Runner install: ${problem}.`);
}

function checkPlain(value: string, field: string, maxLength: number): void {
  if (CONTROL_CHARACTER.test(value)) {
    refuse(`the ${field} holds a control character or a line break`);
  }
  if (value.length > maxLength) refuse(`the ${field} is longer than ${maxLength} characters`);
}

/**
 * POSIX single-quoting: between `'…'` a shell expands nothing, and the one
 * character that can end that run — the quote itself — is closed, escaped and
 * reopened. A value that holds a line break never gets this far.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The pinned script's URL, or a refusal: the version is pasted into a path. */
function installerUrl(appVersion: string): string {
  if (appVersion.length > VERSION_MAX_LENGTH || !VERSION_SHAPE.test(appVersion)) {
    refuse("the app version is not a release version");
  }
  return `${INSTALLER_ROOT}/v${appVersion}/${INSTALLER_ASSET}`;
}

function checkedToken(token: string): string {
  if (token === "") refuse("the token is empty");
  checkPlain(token, "token", TOKEN_MAX_LENGTH);
  if (/\s/.test(token)) refuse("the token holds whitespace");
  return token;
}

/** `null` for a blank name: the box names itself, and the backend keeps that name. */
function checkedName(name: string): string | null {
  checkPlain(name, "name", NAME_MAX_LENGTH);
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

function parseServerUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    return refuse("the server address is not a URL");
  }
}

/** The URL as typed, or `null`; plain HTTP only where a fixture answers locally. */
function checkedServer(server: string | null | undefined): string | null {
  if (server == null) return null;
  checkPlain(server, "server address", SERVER_MAX_LENGTH);
  const trimmed = server.trim();
  if (trimmed === "") return null;
  if (/\s/.test(trimmed)) refuse("the server address holds whitespace");
  const url = parseServerUrl(trimmed);
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    refuse("the server address must be https, or http on this machine");
  }
  if (url.username !== "" || url.password !== "") {
    refuse("the server address carries a user name or password");
  }
  if (url.hash !== "") refuse("the server address carries a fragment");
  return trimmed;
}

/** The installer's arguments. The token is absent when the environment carries it. */
function installFlags(parts: {
  token: string | null;
  name: string | null;
  server: string | null;
  system: boolean;
}): string {
  const flags: string[] = [];
  if (parts.token !== null) flags.push("--token", shellQuote(parts.token));
  if (parts.name !== null) flags.push("--name", shellQuote(parts.name));
  if (parts.server !== null) flags.push("--server", shellQuote(parts.server));
  flags.push(parts.system ? "--system" : "--user");
  return flags.join(" ");
}

/**
 * The command for the box's terminal. `token` passes `--token`, `environment`
 * hands `VOLLI_RUNNER_TOKEN` to the installer's own shell (never to curl,
 * whose environment is the pipeline's left side), and `sudo` runs the whole
 * install as root and asks for `--system` instead of the user service.
 */
export function runnerInstallCommand(options: RunnerInstallOptions): string {
  const variant = options.variant ?? "token";
  const token = checkedToken(options.token);
  const name = checkedName(options.name);
  const server = checkedServer(options.server);
  const download = `curl -fsSL ${installerUrl(options.appVersion)}`;
  if (variant === "environment") {
    const flags = installFlags({ token: null, name, server, system: false });
    return `${download} | VOLLI_RUNNER_TOKEN=${shellQuote(token)} sh -s -- ${flags}`;
  }
  const system = variant === "sudo";
  const flags = installFlags({ token, name, server, system });
  return `${download} | ${system ? "sudo sh" : "sh"} -s -- ${flags}`;
}

/**
 * The `#cloud-config` user-data for an always-on server: curl from the distro
 * (an always-on image need not carry it), then the pinned script downloaded
 * into a private temporary file and removed again. Root's `runcmd` needs no
 * sudo, and the token is the installer's environment rather than one of its
 * arguments, with no xtrace to echo it. That narrows the token's exposure; it
 * does not remove it — an environment is readable by the same user, and the
 * user-data itself holds the token until the person deletes it at the
 * provider.
 */
export function runnerCloudInit(options: RunnerCloudInitOptions): string {
  const url = installerUrl(options.appVersion);
  const token = checkedToken(options.token);
  const flags = installFlags({
    token: null,
    name: checkedName(options.name),
    server: checkedServer(options.server),
    system: true,
  });
  return [
    "#cloud-config",
    "package_update: true",
    "packages:",
    "  - curl",
    "runcmd:",
    "  - |",
    "    set -eu",
    "    umask 077",
    "    script=$(mktemp)",
    "    trap 'rm -f \"$script\"' 0",
    `    curl -fsSL ${url} -o "$script"`,
    `    VOLLI_RUNNER_TOKEN=${shellQuote(token)} sh "$script" ${flags}`,
    "",
  ].join("\n");
}
