/**
 * The runner's link on a Linux box: a sealed file, `<configDir>/credential`.
 *
 * It holds the `runnerId`, its name, the rotating refresh credential, its
 * `generation`, and the deployment it was linked to, as versioned JSON sealed
 * (AES-256-GCM) under the key file beside it, `<configDir>/credential.key`
 * (host-core's `fileSecretKey`: 32 random bytes, mode 0600, made on the first
 * save, refused when other users can read it). Both live in the config dir,
 * never the data dir, so a copied data dir or a backup does not carry the
 * link. Both files are mode 0600, and a config dir the first save creates is
 * 0700 (an existing one keeps its mode; the key file's own check refuses a
 * key other users can read).
 *
 * The rules host-core's `RunnerLinkStore` asks for:
 *
 * - **Durable before it resolves.** A save writes a temporary file, fsyncs it,
 *   renames it over the old one and fsyncs the directory (`durableWrite`):
 *   a crash right after finds the new credential, never half of one.
 * - **Never rolled back.** A save for the runner already stored whose
 *   `generation` is not newer is refused ({@link StaleRunnerLinkError}), so a
 *   stale writer cannot put back a credential the backend has rotated past.
 *   One token source per link per box is the daemon's instance lock's job.
 * - **Never replaced.** A save for a different runner than the one stored is
 *   refused too: two `link`s racing must not leave one live runner with no
 *   credential on the box. Linking anew is `clear()` first (`unlink`).
 * - **Never guessed at.** A file this build cannot open (a missing or wrong
 *   key, a damaged file, a newer build's format) is an error that names it,
 *   never "not linked": linking again over it would orphan a live runner.
 *
 * The threat model is the key file's (host-core `secrets/file-key.ts`): it
 * keeps the link from other users and from a copy of the file alone, not
 * from root or from anything running as the runner's own user.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { RunnerLink, RunnerLinkStore } from "@volli/host-core/cloud-runner";
import { SecretKeyUnavailableError } from "@volli/host-core/ports";
import { fileSecretKey, type SecretKeyPort } from "@volli/host-core/secrets";
import { readId, type RunnerId } from "@volli/shared/cloud";

import { durableWrite } from "../shell/write-file";
import type { RunnerDeployment } from "./deployment";

/** The sealed link's file in the config dir. Durable: an installed box holds it by this name. */
export const LINK_FILE_NAME = "credential";

/** The key it is sealed under, beside it. Durable too, and never the data dir's secrets key. */
export const LINK_KEY_FILE_NAME = "credential.key";

const LINK_VERSION = 1;

/** A link and the deployment it belongs to. */
export interface StoredRunnerLink {
  readonly link: RunnerLink;
  readonly deployment: RunnerDeployment;
}

/** A save the store refused: the stored link is as new or newer. */
export class StaleRunnerLinkError extends Error {
  readonly code = "stale-runner-link";
  constructor(message: string) {
    super(message);
    this.name = "StaleRunnerLinkError";
  }
}

/** The sealed file is there, and this build cannot read it. */
export class UnreadableRunnerLinkError extends Error {
  readonly code = "unreadable-runner-link";
  constructor(message: string) {
    super(message);
    this.name = "UnreadableRunnerLinkError";
  }
}

export interface RunnerLinkFile extends RunnerLinkStore {
  /** The link with its deployment, or `null` when this box is not linked. */
  read(): Promise<StoredRunnerLink | null>;
}

export interface FileRunnerLinkStoreOptions {
  readonly configDir: string;
  /**
   * Where a newly linked runner belongs. A save for the runner already
   * stored keeps the stored deployment; a save for another runner (or none
   * stored) needs this, and refuses without it.
   */
  readonly deployment?: RunnerDeployment | null;
  /** The sealing key; by default the key file beside the link. */
  readonly key?: SecretKeyPort;
}

export function fileRunnerLinkStore(options: FileRunnerLinkStoreOptions): RunnerLinkFile {
  const { configDir } = options;
  const path = join(configDir, LINK_FILE_NAME);
  const keyPath = join(configDir, LINK_KEY_FILE_NAME);
  const key = options.key ?? fileSecretKey({ path: keyPath });

  const read = async (): Promise<StoredRunnerLink | null> => {
    let sealed: Buffer;
    try {
      sealed = readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new UnreadableRunnerLinkError(
        `The runner link ${path} could not be read: ${(error as Error).message}`,
      );
    }
    let text: string;
    try {
      text = key.decryptString(sealed);
    } catch (error) {
      throw new UnreadableRunnerLinkError(
        error instanceof SecretKeyUnavailableError
          ? `The runner link ${path} could not be opened with its key ${keyPath} (${error.reason}).`
          : `The runner link ${path} could not be opened: it is damaged.`,
      );
    }
    return parseStoredLink(text, path);
  };

  return {
    read,
    async load() {
      return (await read())?.link ?? null;
    },
    async save(link) {
      const stored = await read();
      let deployment: RunnerDeployment | null | undefined = options.deployment;
      if (stored !== null) {
        if (stored.link.runnerId !== link.runnerId) {
          throw new StaleRunnerLinkError(
            `This box is already linked as ${stored.link.name} (${stored.link.runnerId}); ` +
              "forget that link before saving another.",
          );
        }
        if (link.generation <= stored.link.generation) {
          throw new StaleRunnerLinkError(
            `The runner link is at generation ${stored.link.generation}; ${link.generation} is not newer.`,
          );
        }
        deployment = stored.deployment;
      }
      if (deployment === undefined || deployment === null) {
        throw new Error("A new runner link needs the deployment it was linked to.");
      }
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      const sealed = key.encryptString(
        JSON.stringify({
          v: LINK_VERSION,
          runnerId: link.runnerId,
          name: link.name,
          credential: link.credential,
          generation: link.generation,
          deployment: { url: deployment.url, siteUrl: deployment.siteUrl },
        }),
      );
      durableWrite(path, sealed, 0o600);
    },
    async clear() {
      rmSync(path, { force: true });
      // Durable too: a crash after an unlink must not bring the link back.
      let directory;
      try {
        directory = openSync(configDir, "r");
      } catch {
        return;
      }
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    },
  };
}

function parseStoredLink(text: string, path: string): StoredRunnerLink {
  const unreadable = (why: string) =>
    new UnreadableRunnerLinkError(
      `The runner link ${path} is not one this build can read: ${why}.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unreadable("it is not JSON");
  }
  if (parsed === null || typeof parsed !== "object") throw unreadable("it is not an object");
  const record = parsed as Record<string, unknown>;
  if (typeof record["v"] === "number" && record["v"] > LINK_VERSION) {
    throw unreadable(`a newer volli-runner wrote it (format ${record["v"]})`);
  }
  const runnerId = readId("runner", record["runnerId"]);
  const { name, credential, generation, deployment } = record;
  const target = deployment as Partial<Record<string, unknown>> | null | undefined;
  if (
    record["v"] !== LINK_VERSION ||
    runnerId === null ||
    typeof name !== "string" ||
    typeof credential !== "string" ||
    credential === "" ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof target !== "object" ||
    target === null ||
    typeof target["url"] !== "string" ||
    typeof target["siteUrl"] !== "string"
  ) {
    throw unreadable("a field is missing or malformed");
  }
  return {
    link: { runnerId: runnerId as RunnerId, name, credential, generation },
    deployment: { url: target["url"], siteUrl: target["siteUrl"] },
  };
}
