/**
 * Saved tool output goes when its ticket does (VC-469).
 *
 * A long MCP result is cut for the model and saved whole beside its Pi
 * sidecar, under `pi-sessions`. The runtime bounds the total and removes the
 * oldest first; this is the other end of the lifetime. A ticket that is
 * archived or deleted is finished work, and what its Sessions saved is a copy
 * of something the model already read the ends of — so it goes then, rather
 * than waiting to be the oldest. The Sessions themselves, their transcripts
 * and their sidecars stay exactly as they are: a later read of a removed file
 * fails as a missing file, which the model can act on, and unarchiving gets the
 * ticket back without its scratch.
 *
 * Paths come from the durable attachment record, never from anything a
 * Session said, and each is checked to be a sidecar inside the owned root
 * before the directory beside it is touched.
 */

import { existsSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type Database from "better-sqlite3";
import { toolOutputDirectoryFor } from "@volli/agent-runtime";

import { PI_ADAPTER_ID } from "./session-runtime/pi-adapter";

const NATIVE_BINDING_KIND = "volli.native-binding.v1";

/** A sidecar path the record names, if it is one inside `root` in Pi's layout. */
function ownedSidecarPath(root: string, detail: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const binding = parsed as { kind?: unknown; locator?: unknown };
  if (binding.kind !== NATIVE_BINDING_KIND) return undefined;
  const locator = binding.locator as { runtime?: unknown; sessionFilePath?: unknown } | null;
  if (locator === null || typeof locator !== "object" || locator.runtime !== "pi") return undefined;
  if (typeof locator.sessionFilePath !== "string") return undefined;
  const path = resolve(locator.sessionFilePath);
  const within = relative(resolve(root), path);
  if (within.startsWith("..") || isAbsolute(within)) return undefined;
  const parts = within.split(sep);
  if (parts.length !== 2 || !parts[0]!.startsWith("--") || !parts[0]!.endsWith("--")) {
    return undefined;
  }
  return parts[1]!.endsWith(".jsonl") ? path : undefined;
}

/**
 * Removes the saved tool output of every Pi attachment of the ticket's
 * Sessions, and reports how many directories went. Run before a delete: the
 * delete detaches the Sessions from the ticket, and they could not be found by
 * it afterwards.
 */
export function removeTicketToolOutput(
  db: Database.Database,
  root: string,
  ticketId: string,
): number {
  const rows = db
    .prepare(
      `SELECT a.native_detail AS detail
         FROM session_attachments a
         JOIN sessions s ON s.id = a.session_id
        WHERE s.ticket_id = ? AND a.adapter_id = ? AND a.native_detail IS NOT NULL`,
    )
    .all(ticketId, PI_ADAPTER_ID) as Array<{ detail: string }>;
  let removed = 0;
  for (const { detail } of rows) {
    const sidecar = ownedSidecarPath(root, detail);
    if (sidecar === undefined) continue;
    const directory = toolOutputDirectoryFor(sidecar);
    if (!existsSync(directory)) continue;
    // `rmSync` does not follow a link standing in the directory's place.
    rmSync(directory, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
