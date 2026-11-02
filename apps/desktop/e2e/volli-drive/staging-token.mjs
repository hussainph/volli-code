#!/usr/bin/env node
/**
 * Keeps a staging WorkOS access token fresh in a 0600 file for the MOVE-11
 * rehearsal (`VOLLI_MOVE_TOKEN_FILE`). Runs in the foreground until Ctrl-C,
 * which removes the file. Staging only; the client id comes from the same
 * `.scratch/deployments/staging.json` profile `rehearsal-ui.mjs` reads.
 * Rules and design: `lib/staging-token.mjs`; usage:
 * `packages/host-core/src/migration-dry-run/README.md` ("Staging rehearsal").
 *
 *   node apps/desktop/e2e/volli-drive/staging-token.mjs \
 *     --out "$REHEARSAL_ROOT/token" --connection github|google
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

import { REPO } from "./lib/core.mjs";
import { readDeployment } from "./lib/deployment.mjs";
import { runTokenFile, workosProvider } from "./lib/staging-token.mjs";

const log = (line) => process.stderr.write(`staging-token ${new Date().toISOString()}: ${line}\n`);

async function main() {
  const { values } = parseArgs({
    options: { out: { type: "string" }, connection: { type: "string" } },
    strict: true,
  });
  const deployment = await readDeployment({ deployment: "staging" }, REPO);
  const controller = new AbortController();
  // `on`, not `once`: a repeated Ctrl-C while a refresh is in flight must not
  // kill the process before it removes the file.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      if (controller.signal.aborted) return;
      log("stopping; removing the token file");
      controller.abort();
    });
  await runTokenFile({
    provider: workosProvider({ clientId: deployment.workosClientId }),
    out: values.out,
    connection: values.connection,
    signal: controller.signal,
    log,
    openUrl: (url) => {
      // The authorization URL carries only public values (client id, PKCE
      // challenge, state); no token.
      log(`sign in as the rehearsal account in the browser:\n  ${url}`);
      if (process.platform === "darwin")
        spawn("open", [url], { stdio: "ignore", detached: true })
          .on("error", () => log("could not open a browser; open the URL above"))
          .unref();
    },
  });
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    log(`failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  },
);
