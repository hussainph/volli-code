/**
 * The probe (VC-700 flow step 3): one POSIX `sh` script over the shared SSH
 * connection, answering `key=value` lines, read into typed facts.
 *
 * It looks; it changes nothing. OS, architecture and glibc (the artifact
 * needs 2.36+), systemd and the user manager, lingering, free disk where a
 * system or a user install would go, memory, what sudo allows without a
 * prompt, and any hostd already here: where, which version, and its
 * `status --json` when it speaks one (VC-700 hostds and later), which says
 * whether this Mac's key is already enrolled.
 */
import { readHostdJson, type HostdManagedStatus, type InstallMode } from "./contract";
import type { SshTransport } from "./ssh";

/** What sudo allows this login without a prompt. */
export type SudoAccess =
  /** `sudo -n true` works: a system install needs nothing more. */
  | "nopasswd"
  /** Sudo will ask for a password (this login is in sudo, wheel or admin). */
  | "password"
  /** No sudo for this login. A user unit is the only install. */
  | "none";

export interface ExistingHostd {
  /** The binary found, absolute. */
  readonly binary: string;
  readonly version: string;
  readonly mode: InstallMode;
  /** The M1 runbook's hand-made layout. */
  readonly flat: boolean;
  /** Its `status --json`, or `null` for a hostd from before VC-700 (not manageable as it is). */
  readonly status: HostdManagedStatus | null;
}

export interface ProbeFacts {
  readonly kernel: string;
  /** `uname -m`: `x86_64`, `aarch64`… */
  readonly arch: string;
  readonly os: { readonly id: string; readonly version: string; readonly name: string };
  readonly user: string;
  readonly home: string;
  /** systemd's version, or `null` when systemd is not PID 1. */
  readonly systemd: number | null;
  /** Whether this login has a systemd user manager (user units run in it). */
  readonly userManager: boolean;
  readonly linger: boolean | null;
  readonly glibc: string | null;
  /** Free bytes where each install would write; `null` when df would not say. */
  readonly disk: { readonly home: number | null; readonly system: number | null };
  readonly memoryBytes: number | null;
  readonly sudo: SudoAccess;
  readonly existing: ExistingHostd | null;
}

const CANDIDATES = [
  ["/opt/volli-hostd/current/bin/volli-hostd", "system", "managed"],
  ["/opt/volli-hostd/bin/volli-hostd", "system", "flat"],
  ['"${XDG_DATA_HOME:-$HOME/.local/share}/volli-hostd/current/bin/volli-hostd"', "user", "managed"],
] as const;

/** The probe script: plain POSIX sh, every check allowed to fail. */
export const PROBE_SCRIPT = [
  'echo "kernel=$(uname -s)"',
  'echo "arch=$(uname -m)"',
  "if [ -r /etc/os-release ]; then . /etc/os-release; fi",
  'echo "os_id=${ID:-}"',
  'echo "os_version=${VERSION_ID:-}"',
  'echo "os_name=${PRETTY_NAME:-}"',
  'echo "user=$(id -un)"',
  'echo "home=$HOME"',
  'echo "groups=$(id -nG)"',
  "if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then",
  "  echo \"systemd=$(systemctl --version 2>/dev/null | awk 'NR==1{print $2}')\"",
  "fi",
  'if systemctl --user show-environment >/dev/null 2>&1; then echo "user_manager=yes"; fi',
  'echo "linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"',
  "echo \"glibc=$(ldd --version 2>/dev/null | awk 'NR==1{print $NF}')\"",
  'echo "disk_home=$(df -Pk "$HOME" 2>/dev/null | awk \'NR==2{print $4}\')"',
  "echo \"disk_system=$(df -Pk /opt 2>/dev/null | awk 'NR==2{print $4}')\"",
  "echo \"mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)\"",
  'if sudo -n true >/dev/null 2>&1; then echo "sudo=nopasswd"; fi',
  "found=",
  ...CANDIDATES.flatMap(([path, mode, layout]) => [
    `b=${path}`,
    'if [ -z "$found" ] && [ -x "$b" ]; then',
    "  found=1",
    `  echo "hostd=${mode} ${layout} $("$b" --version 2>/dev/null | head -n1)"`,
    '  echo "hostd_path=$b"',
    mode === "system"
      ? '  if sudo -n true >/dev/null 2>&1; then s=$(sudo -n -u volli "$b" status --json --system 2>/dev/null | tail -n1); else s=$("$b" status --json --system 2>/dev/null | tail -n1); fi'
      : '  s=$("$b" status --json --user 2>/dev/null | tail -n1)',
    '  echo "status=$s"',
    "fi",
  ]),
].join("\n");

function fields(stdout: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    map.set(key, [...(map.get(key) ?? []), line.slice(at + 1).trim()]);
  }
  return map;
}

const kib = (value: string | undefined): number | null =>
  value !== undefined && /^\d+$/u.test(value) ? Number(value) * 1024 : null;

/** Reads the probe's answer into facts. */
export function parseProbe(stdout: string): ProbeFacts {
  const map = fields(stdout);
  const one = (key: string): string => map.get(key)?.[0] ?? "";
  const groups = one("groups").split(/\s+/u);
  // The first hostd found: a managed system install, the runbook's, then a user unit.
  const found = map.get("hostd")?.[0];
  let existing: ExistingHostd | null = null;
  if (found !== undefined) {
    const [mode, layout, version] = found.split(" ");
    const parsed = readHostdJson(one("status"));
    existing = {
      binary: one("hostd_path"),
      version: version ?? "",
      mode: mode as InstallMode,
      flat: layout === "flat",
      status:
        parsed !== null && typeof parsed.management === "number"
          ? (parsed as unknown as HostdManagedStatus)
          : null,
    };
  }
  const systemd = /^\d+$/u.test(one("systemd")) ? Number(one("systemd")) : null;
  const linger = one("linger");
  return {
    kernel: one("kernel"),
    arch: one("arch"),
    os: { id: one("os_id"), version: one("os_version"), name: one("os_name") },
    user: one("user"),
    home: one("home"),
    systemd,
    userManager: one("user_manager") === "yes",
    linger: linger === "yes" ? true : linger === "no" ? false : null,
    glibc: /^\d+\.\d+/u.test(one("glibc")) ? one("glibc") : null,
    disk: { home: kib(map.get("disk_home")?.[0]), system: kib(map.get("disk_system")?.[0]) },
    memoryBytes: kib(map.get("mem_kb")?.[0]),
    sudo:
      one("sudo") === "nopasswd"
        ? "nopasswd"
        : groups.some((group) => group === "sudo" || group === "wheel" || group === "admin")
          ? "password"
          : "none",
    existing,
  };
}

export async function probeHost(
  ssh: SshTransport,
): Promise<
  | { readonly ok: true; readonly facts: ProbeFacts }
  | { readonly ok: false; readonly code: number; readonly stderr: string }
> {
  const result = await ssh.exec(PROBE_SCRIPT, { label: "probe", timeoutMs: 60_000 });
  if (result.code !== 0 && !result.stdout.includes("kernel=")) {
    return { ok: false, code: result.code, stderr: result.stderr };
  }
  return { ok: true, facts: parseProbe(result.stdout) };
}

/** The artifact target for an architecture: `linux-x64`, `linux-arm64`, or `null`. */
export function artifactTarget(facts: Pick<ProbeFacts, "kernel" | "arch">): string | null {
  if (facts.kernel !== "Linux") return null;
  if (facts.arch === "x86_64" || facts.arch === "amd64") return "linux-x64";
  if (facts.arch === "aarch64" || facts.arch === "arm64") return "linux-arm64";
  return null;
}

/** The facts a finished check shows: "Ubuntu 24.04 · x86-64 · 8 GB". */
export function describeSystem(facts: ProbeFacts): string[] {
  const arch = { x86_64: "x86-64", amd64: "x86-64", aarch64: "arm64" }[facts.arch] ?? facts.arch;
  const system = facts.os.name.replace(/ LTS$/u, "").replace(/^(\S+ \d+\.\d+)\.\d+$/u, "$1");
  const memory =
    facts.memoryBytes === null ? [] : [`${Math.round(facts.memoryBytes / 1024 ** 3)} GB`];
  return [system || facts.kernel, arch, ...memory];
}

/** Compares dotted versions numerically; a prerelease sorts before its release. */
function versionParts(value: string): { parts: number[]; pre: string | undefined } {
  const [core, pre] = value.replace(/^v/u, "").split("-", 2) as [string, string | undefined];
  return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}
