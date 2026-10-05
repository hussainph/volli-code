/**
 * The release before VC-643 (N-1) acting on a profile, for
 * `n1-compatibility.test.ts`. Run as a plain `node` child with `n1-hooks.mjs`,
 * which swaps in main's exact copy of every host-core file this ticket
 * changed, so what runs here is the shipped code: main's database open and
 * migrations (schema head 58), main's Web Access settings and credential
 * store, and main's backup bundle and restore. Reads one JSON command from
 * argv, runs its steps in order, prints one JSON line, exits. Never prints a
 * key: a read reports only whether it matched what the test expected.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { blobsRoot } from "../../blob-store";
import { createBackupBundle } from "../../backup/bundle";
import { restoreBackupBundle } from "../../backup/restore";
import { openVolliDb } from "../../db/database-file";
import { SCHEMA_HEAD } from "../../db/migrations";
import { readMinReaderVersion } from "../../db/schema-compatibility";
import { sessionTranscriptsRoot } from "../../session-runtime/transcript-artifacts";
import { BRAVE_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_SECRET, WebCredentialStore } from "../credential";
import { webSearchProviderFor } from "../ports";
import { WebAccessSettings } from "../settings";

type Provider = "brave" | "exa";

type Step =
  /** Opens the database as N-1 boots it. */
  | { kind: "open" }
  | { kind: "provider"; provider: Provider }
  | { kind: "save"; provider: Provider; value: string }
  | { kind: "clear"; provider: Provider }
  /** What a Session attaching now is given: does the search provider carry `expect`? */
  | { kind: "attach"; expect: string | null }
  | { kind: "bundle"; profileRoot: string; out: string }
  | { kind: "restore"; profileRoot: string; bundle: string };

interface Command {
  dbPath: string;
  steps: Step[];
}

const command = JSON.parse(process.argv[2]!) as Command;
const results: unknown[] = [];

function withSettings<T>(fn: (settings: WebAccessSettings) => T): T {
  const db = openVolliDb(command.dbPath);
  try {
    return fn(
      new WebAccessSettings({
        db,
        credentials: {
          brave: new WebCredentialStore({ db, secretName: BRAVE_SEARCH_KEY_SECRET }),
          exa: new WebCredentialStore({ db, secretName: EXA_SEARCH_KEY_SECRET }),
        },
      }),
    );
  } finally {
    db.close();
  }
}

for (const step of command.steps) {
  switch (step.kind) {
    case "open": {
      const db = openVolliDb(command.dbPath);
      results.push({
        head: SCHEMA_HEAD,
        userVersion: db.pragma("user_version", { simple: true }),
        floor: readMinReaderVersion(db),
      });
      db.close();
      break;
    }
    case "provider":
      results.push(
        withSettings((settings) =>
          settings.setProvider({ provider: step.provider, searxngUrl: null }),
        ).provider,
      );
      break;
    case "save":
      results.push(withSettings((settings) => settings.saveKey(step.provider, step.value).keys));
      break;
    case "clear":
      results.push(withSettings((settings) => settings.clearKey(step.provider).keys));
      break;
    case "attach":
      results.push(
        withSettings((settings) => {
          const resolved = settings.resolve();
          const provider = webSearchProviderFor(resolved);
          if (provider === null) return { configured: false, carriesExpected: false };
          const request = provider.describe({ query: "volli", limit: 3 });
          return {
            configured: true,
            provider: provider.id,
            carriesExpected:
              step.expect !== null && JSON.stringify(request.headers ?? {}).includes(step.expect),
          };
        }),
      );
      break;
    case "bundle": {
      const db = openVolliDb(command.dbPath);
      try {
        const bundle = createBackupBundle({
          db,
          blobsRoot: blobsRoot(step.profileRoot),
          transcriptsRoot: sessionTranscriptsRoot(step.profileRoot),
          appVersion: "n-1",
          now: 1_791_000_000_000,
        });
        writeFileSync(step.out, bundle.bytes);
        results.push({
          schemaVersion: bundle.document.schemaVersion,
          tables: Object.keys(bundle.document.tables).toSorted(),
        });
      } finally {
        db.close();
      }
      break;
    }
    case "restore": {
      const result = await restoreBackupBundle({
        bundle: readFileSync(step.bundle),
        profileRoot: step.profileRoot,
        projectPaths: {},
        now: 1_791_000_000_001,
      });
      results.push(result.ok ? { ok: true } : { ok: false, problems: result.problems });
      break;
    }
  }
}

process.stdout.write(
  `${JSON.stringify({
    results,
    loaded: [...(globalThis as unknown as { volliN1Loaded: Set<string> }).volliN1Loaded].toSorted(),
  })}\n`,
);
