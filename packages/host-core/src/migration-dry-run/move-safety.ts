/** Fail closed before a profile copy or a backend call. No credential discovery. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const LIVE_PROFILE = join(homedir(), "Library/Application Support/Volli Code");

export function rehearsalTarget(raw: string, allowProduction = false): string {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (!loopback && (url.protocol !== "https:" || !url.hostname.endsWith(".convex.cloud"))) ||
    (loopback && !["http:", "https:"].includes(url.protocol))
  )
    throw new Error("target_must_be_a_deployment_origin");
  if (url.hostname === "rosy-cardinal-131.convex.cloud" && !allowProduction)
    throw new Error("production_target_refused_use_allow_production");
  return url.origin;
}

/** Resolve existing ancestors too: a symlink to the live directory is not a copy. */
function canonical(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute)
    ? realpathSync(absolute)
    : join(canonical(dirname(absolute)), absolute.split(sep).at(-1)!);
}
function inside(a: string, b: string): boolean {
  const path = relative(a, b);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

export function assertReportPath(
  source: string,
  scratch: string,
  report: string,
  live = LIVE_PROFILE,
): void {
  const output = canonical(report);
  if ([source, scratch, live].some((path) => inside(canonical(path), output)))
    throw new Error("report_must_be_outside_profile_directories");
  if (existsSync(report)) throw new Error("report_must_be_a_new_file");
}

export function assertCopyPaths(source: string, scratch: string, live = LIVE_PROFILE): void {
  const from = canonical(source);
  const to = canonical(scratch);
  const livePath = canonical(live);
  if (inside(livePath, to) || inside(to, livePath) || inside(from, to) || inside(to, from))
    throw new Error("scratch_must_be_separate_from_source_and_live_profile");
  if (existsSync(scratch)) throw new Error("scratch_profile_must_not_exist");
  if (!lstatSync(source).isDirectory()) throw new Error("source_must_be_a_profile_directory");
}

/** An open SQLite handle, app socket or Chromium singleton marker fails closed.
 * lsof is required (macOS ships it); command failure is not evidence of idleness.
 */
export function assertProfileIdle(path: string): void {
  for (const name of ["volli.sock", "SingletonSocket", "SingletonLock"]) {
    try {
      const file = join(path, name);
      lstatSync(file);
      // Even a stale/unreadable marker needs operator inspection, never deletion here.
      if (name === "SingletonLock") readlinkSync(file);
      throw new Error("profile_has_an_app_marker_quit_the_app_first");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const pids = execFileSync("lsof", ["-t", "--", join(path, "volli.db")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (pids.trim()) throw new Error("profile_database_is_open_quit_the_app_first");
  } catch (error) {
    if (
      (error as { status?: number }).status !== 1 ||
      (error as { stderr?: Buffer }).stderr?.length
    )
      throw error;
  }
}
