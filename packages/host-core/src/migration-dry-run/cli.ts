/**
 * `migration:dry-run`: the command a person runs to rehearse migrating a
 * profile. Usage and safety rules: `README.md` in this directory.
 *
 * Reads the backend from the environment `with-backend.ts` sets
 * (`CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`), prints progress
 * on stderr and the report as JSON on stdout, and exits 1 when any check
 * failed. Interrupted, it removes its temporary workspace before exiting.
 */
import { rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { parseArgs } from "node:util";
import { connectConvexAdmin } from "./convex-admin";
import { DEFAULT_HOT_DAYS, runMigrationDryRun } from "./dry-run";

const USAGE = `usage: migration-dry-run --profile <volli.db> [--blobs <dir>] [--hot-days <n>]
                         [--include-removed-projects] [--no-rerun] [--report <file>]
                         [--app-version <v>] [--home-dir <dir>]`;

/** The operator's terminal, not a log: progress and errors for the person running it. */
function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      profile: { type: "string" },
      project: { type: "string", multiple: true },
      blobs: { type: "string" },
      "hot-days": { type: "string" },
      "include-removed-projects": { type: "boolean" },
      "no-rerun": { type: "boolean" },
      report: { type: "string" },
      "app-version": { type: "string" },
      "home-dir": { type: "string" },
    },
  });
  const url = process.env.CONVEX_SELF_HOSTED_URL ?? process.env.VOLLI_CONVEX_URL;
  const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? process.env.VOLLI_CONVEX_ADMIN_KEY;
  if (values.profile === undefined || url === undefined || adminKey === undefined) {
    say(USAGE);
    say("Run it under `pnpm -C convex with-backend --deploy -- …` for a backend.");
    return 2;
  }
  const hotDays = values["hot-days"] === undefined ? DEFAULT_HOT_DAYS : Number(values["hot-days"]);
  if (!Number.isFinite(hotDays) || hotDays < 0) {
    say("--hot-days must be a non-negative number");
    return 2;
  }

  let workspace: string | null = null;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      if (workspace !== null) {
        rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
      say(`migration dry run: ${signal}, temporary workspace removed`);
      process.exit(128 + constants.signals[signal]);
    });
  }

  const report = await runMigrationDryRun({
    profilePath: values.profile,
    projectIds: values.project,
    ...(values.blobs === undefined ? {} : { blobsDir: values.blobs }),
    ...(values["home-dir"] === undefined ? {} : { homeDir: values["home-dir"] }),
    backend: connectConvexAdmin(url, adminKey),
    appVersion: values["app-version"] ?? "dry-run",
    hotDays,
    includeRemovedProjects: values["include-removed-projects"] === true,
    rerun: values["no-rerun"] !== true,
    onProgress: (line) => say(`migration dry run: ${line}`),
    onWorkspace: (path) => (workspace = path),
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (values.report !== undefined) writeFileSync(values.report, text);
  process.stdout.write(text);
  say(
    report.ok
      ? "migration dry run: OK"
      : `migration dry run: FAILED\n  ${report.failures.join("\n  ")}`,
  );
  return report.ok ? 0 : 1;
}
