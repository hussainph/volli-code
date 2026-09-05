/**
 * Reading a recovery sidecar written before the Pi 0.85.0 bump.
 *
 * Pi 0.85.0 changed the JSONL session format in three ways at once, and the
 * combination is what makes this module necessary rather than optional:
 *
 * 1. **The header key moved.** 0.84.3 wrote `{"kind":"header","version":4,…}`;
 *    0.85.0 accepts only `{"v":4,"kind":"header","storageVersion":1,…}`. Its
 *    header parser recognises that shape and the much older v3 shape, and
 *    nothing else — and a directory entry whose header does not parse is not an
 *    error, it is simply **not listed**. So without this module, an upgraded
 *    Volli does not report a broken Session; it reports no Session at all, and
 *    the attach fails with "Pi recovery sidecar was not found uniquely for this
 *    workspace" for every conversation a person had before they updated.
 *
 * 2. **Branches replaced lanes.** 0.84.3 tagged each entry with `"lane":"main"`
 *    and kept the lane's head in its own record type. 0.85.0 keeps a branch's
 *    tip in the value store, under `pi.branch.tip`/`<branch>`, and a branch
 *    with no tip value does not exist. The entry lines themselves survive
 *    untouched — 0.85.0's record parser checks `seq` and `timestamp` and passes
 *    every other key through, `lane` included — so the history is intact and
 *    only its head is missing.
 *
 * 3. **The application metadata bag was deleted.** `JsonlSessionMetadata` used
 *    to carry an opaque `metadata` record, which is where this runtime kept the
 *    three ids binding a sidecar to its attachment. 0.85.0 has no such field,
 *    so that binding moves into the value store beside the branch tip.
 *
 * What this module does is therefore narrow and mechanical: rewrite the header
 * line, and append the two value records 0.85.0 needs in order to see what is
 * already in the file. It adds no entries, removes none, and rewrites none —
 * the conversation itself is carried across byte for byte, which is the only
 * way this can be safe to run on a person's durable history.
 *
 * It is deliberately not a general format converter. It runs once per sidecar,
 * recognises exactly one predecessor shape, and leaves anything it does not
 * recognise completely alone.
 */

import { readFile, rename, writeFile } from "node:fs/promises";

/** The three ids that bind a sidecar to the attachment that owns it. */
export interface SidecarIdentityRecord {
  volliSessionId: string;
  volliThreadId: string;
  volliAttachmentId: string;
}

/** Where the branch tip and the identity live in 0.85.0's value store. */
const BRANCH_TIP_NAMESPACE = "pi.branch.tip";
const IDENTITY_NAMESPACE = "volli.identity.v1";
const MAIN_BRANCH = "main";

/** What one migration attempt found. */
export type SidecarMigration =
  /** The file was written by 0.84.3 and now reads as 0.85.0. */
  | { kind: "migrated"; entries: number; identity: SidecarIdentityRecord | null }
  /** Already the current format, or not a session file at all. Untouched. */
  | { kind: "skipped"; reason: "current-format" | "unrecognized" | "empty" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The header pi-agent-core 0.84.3 wrote, and only that.
 *
 * `version: 4` with no `v` is the whole discriminator: 0.85.0 writes `v`, and
 * v3 files use `type: "session"`. Requiring the fields this module goes on to
 * read keeps a malformed line in the `unrecognized` arm rather than half
 * migrating it.
 */
function isLegacyHeader(value: unknown): value is {
  kind: "header";
  version: 4;
  id: string;
  cwd: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
  parentSessionId?: string;
} {
  return (
    isRecord(value) &&
    value["kind"] === "header" &&
    value["version"] === 4 &&
    value["v"] === undefined &&
    typeof value["id"] === "string" &&
    typeof value["cwd"] === "string" &&
    Number.isSafeInteger(value["createdAt"])
  );
}

/** The identity this runtime wrote into 0.84.3's metadata bag, when it is whole. */
function identityFrom(metadata: unknown): SidecarIdentityRecord | null {
  if (!isRecord(metadata)) return null;
  const sessionId = metadata["volliSessionId"];
  const threadId = metadata["volliThreadId"];
  const attachmentId = metadata["volliAttachmentId"];
  if (
    typeof sessionId !== "string" ||
    typeof threadId !== "string" ||
    typeof attachmentId !== "string"
  ) {
    return null;
  }
  return {
    volliSessionId: sessionId,
    volliThreadId: threadId,
    volliAttachmentId: attachmentId,
  };
}

/**
 * The id of the last entry ON THE MAIN LANE, and the highest `seq` any record
 * used.
 *
 * The tip is read off the file because that is the question 0.85.0 asks —
 * "which entry is the head of this branch" — and entries are appended in
 * order, so the last one on a lane is that lane's head.
 *
 * **The lane filter is the load-bearing part.** 0.84.3 tagged every entry with
 * its lane and could hold more than one: `appendEntry(entry, lane)` and
 * `createLane` were public, and a sibling lane's entries sit in the same file,
 * interleaved by write order. Taking the last entry regardless of lane would
 * therefore point `main` at an entry that was never on it, and the branch walk
 * would follow that entry's parents into history this Session had elided —
 * the exact resurrection the branch-not-file read in `runtime.ts` exists to
 * prevent, arrived at from the other direction.
 *
 * This runtime writes one lane and never forks, so in practice every entry
 * says `main`. That is a reason to expect the filter to be a no-op, not a
 * reason to leave it out: this rewrites a person's durable history, and "the
 * file should only contain one lane" is an assumption about files this code
 * did not write. An entry with no lane at all is treated as `main`, which is
 * what a reader with no lane concept would have assumed anyway.
 */
function scanRecords(lines: readonly string[]): { tip: string | null; maxSeq: number } {
  let tip: string | null = null;
  let maxSeq = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isRecord(record)) continue;
      const seq = record["seq"];
      if (typeof seq === "number" && Number.isSafeInteger(seq)) maxSeq = Math.max(maxSeq, seq);
      if (record["kind"] !== "entry" || typeof record["id"] !== "string") continue;
      const lane = record["lane"];
      if (lane !== undefined && lane !== MAIN_BRANCH) continue;
      tip = record["id"];
    }
  }
  return { tip, maxSeq };
}

/**
 * Bring one sidecar file up to the 0.85.0 format, if it needs it.
 *
 * Written through a temporary file and a rename, the way Pi publishes its own
 * storage: a half-written session file is a destroyed conversation, and a
 * rename is the only step here that a crash can interrupt without loss.
 */
export async function migrateLegacySidecar(path: string): Promise<SidecarMigration> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { kind: "skipped", reason: "unrecognized" };
  }
  const lines = content.split("\n").filter((line) => line.length > 0);
  const [headerLine, ...recordLines] = lines;
  if (headerLine === undefined) return { kind: "skipped", reason: "empty" };

  let header: unknown;
  try {
    header = JSON.parse(headerLine);
  } catch {
    return { kind: "skipped", reason: "unrecognized" };
  }
  // The current format and anything else both mean "leave it alone". Only the
  // one predecessor shape is touched.
  if (!isLegacyHeader(header)) {
    return {
      kind: "skipped",
      reason: isRecord(header) && header["kind"] === "header" ? "current-format" : "unrecognized",
    };
  }

  const identity = identityFrom(header["metadata"]);
  const { tip, maxSeq } = scanRecords(recordLines);

  // Everything the old header said that the new one still has a place for.
  // `metadata` is dropped from the header because 0.85.0 has no field for it —
  // its contents move to the value record written below.
  const migratedHeader = {
    v: 4,
    kind: "header",
    id: header.id,
    storageVersion: 1,
    createdAt: header.createdAt,
    cwd: header.cwd,
    ...(typeof header["parentSessionId"] === "string"
      ? { parentSessionId: header["parentSessionId"] }
      : {}),
  };

  let seq = maxSeq;
  const appended: string[] = [];
  // The branch tip 0.85.0 needs in order to see this history at all. Written
  // even when the file holds no entries: a branch that exists and is empty is
  // what a fresh session has, and it is what lets the attach append to it.
  appended.push(
    JSON.stringify({
      kind: "value",
      op: "set",
      seq: ++seq,
      namespace: BRANCH_TIP_NAMESPACE,
      key: MAIN_BRANCH,
      value: tip,
    }),
  );
  if (identity !== null) {
    appended.push(
      JSON.stringify({
        kind: "value",
        op: "set",
        seq: ++seq,
        namespace: IDENTITY_NAMESPACE,
        key: "",
        value: identity,
      }),
    );
  }

  const migrated = [JSON.stringify(migratedHeader), ...recordLines, ...appended].join("\n");
  const temporaryPath = `${path}.volli-migration`;
  await writeFile(temporaryPath, `${migrated}\n`, "utf8");
  await rename(temporaryPath, path);
  return { kind: "migrated", entries: recordLines.length, identity };
}
