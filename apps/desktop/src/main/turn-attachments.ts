/**
 * Turning one chat turn's attachments into something a model can use (VC-50).
 *
 * A file attached mid-conversation has to reach the agent two different ways,
 * because a model can only see one of them:
 *
 *  - **Every file materializes** into `.volli/attachments/` and is named by
 *    path in the prompt, so the agent can open it with a tool whatever its
 *    type. This is the only channel a PDF has.
 *  - **Images additionally inline** as base64 image content, because Pi has no
 *    document block and a path is not something a model can look at.
 *
 * Kept out of `pi-adapter.ts` deliberately. The adapter is delicate, and this
 * is the part with real branching in it — so it lives where it can be tested
 * against a temp directory and a real database, and the adapter gains a call
 * rather than a limb.
 *
 * Nothing here writes base64 anywhere durable. The bytes are read at send time
 * and handed straight to the runtime; what persists is the `volli-blob:` hash
 * in the message parts.
 */
import type Database from "better-sqlite3";
import {
  isImageMime,
  materializedBlobNames,
  parseBlobUrl,
  SESSION_ATTACHMENTS_REL_DIR,
  type RuntimeImageInput,
  type UIMessageLike,
} from "@volli/shared";
import { materializeBlobs } from "./blob-materialize";
import { readBlob } from "./blob-store";
import { getBlob, listMaterializableLinks } from "./db/blobs-repo";

export interface TurnAttachments {
  /**
   * A line per attached file naming where it landed, appended to the prompt.
   * Empty when the turn carried no files.
   */
  note: string;
  /** Images to hand the model as content for this turn only. */
  images: RuntimeImageInput[];
}

const EMPTY: TurnAttachments = { note: "", images: [] };

/**
 * The Blob hashes one message's file parts refer to, in order.
 *
 * Parts whose URL is not a `volli-blob:` one are skipped rather than rejected:
 * the transcript is a durable record that older and newer builds both read, and
 * a part this build does not recognise is not a reason to fail a turn.
 */
export function messageBlobHashes(message: UIMessageLike): string[] {
  const hashes: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "file" || typeof part.url !== "string") continue;
    const hash = parseBlobUrl(part.url);
    if (hash !== null) hashes.push(hash);
  }
  return hashes;
}

/**
 * Materializes this turn's attachments and reads back what the model needs.
 *
 * Materialization runs over the Session's whole link set rather than just this
 * turn's, because the naming has to be decided across all of it at once —
 * that is what keeps `spec-2.png` meaning the same file it meant last turn.
 * It is skip-if-exists, so re-running costs a stat per file.
 */
export async function prepareTurnAttachments(
  db: Database.Database,
  blobsRootPath: string,
  message: UIMessageLike,
  owner: { sessionId: string; ticketId: string | null; workspacePath: string },
): Promise<TurnAttachments> {
  const hashes = messageBlobHashes(message);
  if (hashes.length === 0) return EMPTY;

  await materializeBlobs(db, blobsRootPath, owner.sessionId, owner.ticketId, owner.workspacePath);

  // Re-derive the same names materialization just used, so the path in the
  // prompt is the path on disk. Both come from `materializedBlobNames` over the
  // same ordered link list, which is what makes them agree without being
  // passed between the two.
  const links = listMaterializableLinks(db, owner.sessionId, owner.ticketId);
  const names = materializedBlobNames(links);
  const relPathByHash = new Map<string, string>();
  for (const link of links) {
    // Never misses: materializedBlobNames maps every link in the list it was
    // just given, which is this one.
    const name = names.get(link.linkId)!;
    // First link wins. One Blob can be linked to both the Ticket and the
    // Session — spec material the user then hands over again mid-chat — and
    // that is still one file on disk, which the prompt should name once.
    if (!relPathByHash.has(link.blobHash)) {
      relPathByHash.set(link.blobHash, `${SESSION_ATTACHMENTS_REL_DIR}/${name}`);
    }
  }

  const lines: string[] = [];
  const images: RuntimeImageInput[] = [];
  const seen = new Set<string>();
  for (const hash of hashes) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    const blob = getBlob(db, hash);
    const relPath = relPathByHash.get(hash);
    // A hash with no row or no link is a message referring to something already
    // collected — an older turn re-read after the attachment was removed. Say
    // nothing about it rather than inventing a path.
    if (blob === undefined || relPath === undefined) continue;
    lines.push(`- \`${relPath}\``);
    if (!isImageMime(blob.mime)) continue;
    images.push({
      data: Buffer.from(readBlob(blobsRootPath, hash)).toString("base64"),
      mimeType: blob.mime,
    });
  }
  if (lines.length === 0) return EMPTY;
  return {
    note: ["", "Attached to this message:", ...lines].join("\n"),
    images,
  };
}
