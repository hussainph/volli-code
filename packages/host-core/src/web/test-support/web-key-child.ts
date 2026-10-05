/**
 * A second Volli process for the web keys' step-E tests (VC-643). Run by
 * `secrets/test-support/processes.ts` as a plain `node` child, so it shares
 * only the database and the credential files with the test, as desktop and
 * another desktop window's process would. Reads one JSON command from argv,
 * prints JSON lines, exits. Never prints a key.
 */
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { fileCredentialKeyring } from "../../secrets/file-key";
import type { PublishStep } from "../../secrets/durable-file";
import { CREDENTIAL_INVENTORY_FILE_NAME, SealedInventory } from "../../secrets/inventory";
import { BRAVE_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_SECRET, WebCredentialStore } from "../credential";
import { WebCredentialMirror } from "../credential-mirror";
import { WebAccessSettings } from "../settings";

type Provider = "brave" | "exa";

type Command =
  /** Saves each value in turn, one commit and one reseal each; then reconciles once more. */
  | { kind: "churn"; dbPath: string; keyPath: string; provider: Provider; values: string[] }
  /**
   * Saves (or clears, with `value: null`) and dies with SIGKILL at `at`: a
   * publish step of the reseal, or `sql-committed`, after the SQLite commit
   * and before any reseal.
   */
  | {
      kind: "crash";
      dbPath: string;
      keyPath: string;
      provider: Provider;
      value: string | null;
      at: PublishStep | "sql-committed";
    };

function say(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const command = JSON.parse(process.argv[2]!) as Command;

function open(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

function settings(
  db: Database.Database,
  dbPath: string,
  keyPath: string,
  step?: (at: PublishStep) => void,
): { settings: WebAccessSettings; stores: Record<Provider, WebCredentialStore> } {
  const stores = {
    brave: new WebCredentialStore({ db, secretName: BRAVE_SEARCH_KEY_SECRET }),
    exa: new WebCredentialStore({ db, secretName: EXA_SEARCH_KEY_SECRET }),
  };
  const inventory = new SealedInventory({
    path: join(dirname(dbPath), CREDENTIAL_INVENTORY_FILE_NAME),
    keyring: fileCredentialKeyring({ path: keyPath }),
    families: ["web-search"],
    ...(step === undefined ? {} : { document: { step } }),
  });
  return {
    settings: new WebAccessSettings({
      db,
      credentials: stores,
      mirror: new WebCredentialMirror({ db, inventory }),
    }),
    stores,
  };
}

switch (command.kind) {
  case "churn": {
    const db = open(command.dbPath);
    const { settings: web } = settings(db, command.dbPath, command.keyPath);
    const sealing: string[] = [];
    for (const value of command.values) sealing.push(web.saveKey(command.provider, value).sealing);
    const final = await web.reconcileSealing();
    say({ saves: sealing.length, final: final?.sealing });
    db.close();
    break;
  }
  case "crash": {
    const db = open(command.dbPath);
    const at = command.at;
    const { settings: web, stores } = settings(db, command.dbPath, command.keyPath, (step) => {
      if (step === at) process.kill(process.pid, "SIGKILL");
    });
    if (at === "sql-committed") {
      if (command.value === null) stores[command.provider].clear();
      else stores[command.provider].save(command.value);
      process.kill(process.pid, "SIGKILL");
    }
    if (command.value === null) web.clearKey(command.provider);
    else web.saveKey(command.provider, command.value);
    say({ survived: true });
    break;
  }
}
