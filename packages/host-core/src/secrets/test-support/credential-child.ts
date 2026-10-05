/**
 * A second Volli process for the credential module's multi-process tests
 * (VC-642). Run by `processes.ts` as a plain `node` child with
 * `ts-hooks.mjs`, so it shares only the files on disk with the test, as
 * desktop, hostd and `volli-hostd credentials` do. It reads one JSON command
 * from argv, prints JSON lines, and exits.
 */
import { spawn } from "node:child_process";

import { CredentialLock, retryWhileBusy } from "../credential-lock";
import type { PublishStep } from "../durable-file";
import { fileCredentialKeyring } from "../file-key";
import { SealedInventory } from "../inventory";

type Command =
  /** Takes the lock, says `held`, holds it `ms` (forever when absent), then exits. */
  | { kind: "hold"; lock: string; ms?: number; sleeper?: boolean }
  /** Puts each record into the inventory, one locked commit per record. */
  | {
      kind: "put";
      path: string;
      key: string;
      family: string;
      selectors: Record<string, string>[];
      value: string;
    }
  /** Removes one record. */
  | { kind: "remove"; path: string; key: string; family: string; selector: Record<string, string> }
  /** Reads one record for use. */
  | { kind: "get"; path: string; key: string; family: string; selector: Record<string, string> }
  /** Puts one record and dies with SIGKILL at `at`, mid-write. */
  | {
      kind: "crash";
      path: string;
      key: string;
      family: string;
      selector: Record<string, string>;
      value: string;
      at: PublishStep;
    };

function say(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const command = JSON.parse(process.argv[2]!) as Command;

function inventory(path: string, key: string, step?: (at: PublishStep) => void): SealedInventory {
  return new SealedInventory({
    path,
    keyring: fileCredentialKeyring({ path: key }),
    ...(step === undefined ? {} : { document: { step } }),
  });
}

switch (command.kind) {
  case "hold": {
    await new CredentialLock(command.lock).with(async () => {
      if (command.sleeper === true) {
        // A child of the holder: it must not keep the lock once the holder dies.
        const sleeper = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
        say({ held: true, sleeper: sleeper.pid });
      } else {
        say({ held: true });
      }
      // A pending promise alone would let the process exit: keep a timer.
      await new Promise((settle) => setTimeout(settle, command.ms ?? 2 ** 30));
    });
    say({ released: true });
    break;
  }
  case "put": {
    const store = inventory(command.path, command.key);
    // A synchronous change refuses at once while another process holds the
    // lock; a caller that can wait retries asynchronously, as a host would.
    for (const selector of command.selectors) {
      await retryWhileBusy(
        () => store.put(command.family as never, selector, command.value),
        10_000,
      );
    }
    say({ status: store.status().state });
    break;
  }
  case "remove": {
    const store = inventory(command.path, command.key);
    say({
      removed: await retryWhileBusy(
        () => store.remove(command.family as never, command.selector),
        10_000,
      ),
    });
    break;
  }
  case "get": {
    const store = inventory(command.path, command.key);
    say({ record: store.get(command.family as never, command.selector), status: store.status() });
    break;
  }
  case "crash": {
    const store = inventory(command.path, command.key, (at) => {
      if (at === command.at) process.kill(process.pid, "SIGKILL");
    });
    store.put(command.family as never, command.selector, command.value);
    say({ survived: true });
    break;
  }
}
