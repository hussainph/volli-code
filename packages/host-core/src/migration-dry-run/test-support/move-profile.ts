/** Move edge cases, opt-in so the small historical dry-run fixture stays cheap. */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { SYNTHETIC_IDS as ids, writeSyntheticProfile } from "./synthetic-profile";

export const MOVE_IDS = {
  project: "7a1f0c2e-0000-4000-8000-000000000003",
  ticket: "7a1f0c2e-0000-4000-8000-000000000026",
  shadowProject: "7a1f0c2e-0000-4000-8000-000000000004",
  shadowTicket: "7a1f0c2e-0000-4000-8000-000000000027",
  drainedSession: "7a1f0c2e-0000-4000-8000-000000000035",
  bornCloudSession: "7a1f0c2e-0000-4000-8000-000000000036",
  attachment: "7a1f0c2e-0000-4000-8000-000000000050",
  shadowAutomation: "7a1f0c2e-0000-4000-8000-000000000044",
};
export type MoveFault = "comment" | "transcript" | "pi" | "piTruncated" | "blob" | "nonUuid";

/**
 * One Pi log line of exactly `bytes` (its newline included): a JSON record
 * holding base64 text, the way an inline image or a large tool output sits
 * in a real Pi log. Deterministic, and about as compressible as real images.
 */
export function longPiLine(bytes: number): string {
  return Buffer.concat([...longPiLinePieces(bytes)]).toString("utf8");
}

/** {@link longPiLine}'s bytes in pieces of at most 64 KiB: a fixture never holds a long line whole. */
export function* longPiLinePieces(bytes: number): Generator<Buffer> {
  const head = '{"type":"message","image":"';
  const tail = '"}\n';
  let fill = bytes - head.length - tail.length;
  if (fill < 0) throw new Error(`A Pi line needs at least ${head.length + tail.length} bytes`);
  const block = Buffer.alloc(48 * 1024);
  for (let at = 0, n = 0; at < block.length; n += 1) {
    const digest = createHash("sha256").update(`pi-line-${n}`).digest();
    at += digest.copy(block, at);
  }
  const text = Buffer.from(block.toString("base64"));
  yield Buffer.from(head);
  for (; fill > 0; fill -= text.length) yield text.subarray(0, Math.min(fill, text.length));
  yield Buffer.from(tail);
}

/** Default: >50 MiB of canonical transcript bodies, thousands of mixed plain /
 * gzip artifacts, one 105 KiB maximum. Tests can select a small count.
 * Faults intentionally construct refusals, never a fixture expected to pass.
 */
export function writeMoveProfile(
  root: string,
  options: {
    artifacts?: number;
    fault?: MoveFault;
    now?: number;
    /** One Pi line this long (newline included) in the middle of the moved Session's Pi log. */
    piLongLineBytes?: number;
  } = {},
) {
  const now = options.now ?? Date.now();
  const profile = writeSyntheticProfile(root, now);
  const db = new Database(profile.dbPath);
  const insert = (table: string, row: Record<string, unknown>) => {
    row = {
      ...(table === "projects"
        ? { color_index: 0, sort_order: 2 }
        : table === "tickets"
          ? { position: 1, preferred_harness_id: "pi" }
          : {}),
      ...row,
    };
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    ).run(...(keys.map((k) => row[k]) as never[]));
  };
  try {
    db.pragma("foreign_keys = ON");
    insert("projects", {
      id: MOVE_IDS.project,
      name: "Cafe\u0301 🧭 العربية",
      path: join(root, "code", "cafe\u0301"),
      ticket_prefix: "AL",
      created_at: now,
      updated_at: now,
    });
    insert("tickets", {
      id: MOVE_IDS.ticket,
      project_id: MOVE_IDS.project,
      ticket_number: 1,
      title: "日本語 🧭",
      body: "AL-1 stays verbatim · café / cafe\u0301",
      status: "todo",
      priority: "low",
      position: 1,
      created_at: now,
      updated_at: now,
    });
    db.prepare("UPDATE sessions SET project_id=?,ticket_id=? WHERE id=?").run(
      MOVE_IDS.project,
      MOVE_IDS.ticket,
      ids.childSession,
    );
    db.prepare("DELETE FROM session_delegations WHERE session_id=?").run(ids.childSession);
    insert("session_delegations", {
      session_id: ids.childSession,
      ticket_id: MOVE_IDS.ticket,
      parent_session_id: ids.hotSession,
      depth: 1,
    });
    const blob = db.prepare("SELECT hash FROM blobs ORDER BY hash LIMIT 1").get() as {
      hash: string;
    };
    insert("blob_links", {
      id: "7a1f0c2e-0000-4000-8000-000000000302",
      blob_hash: blob.hash,
      ticket_id: MOVE_IDS.ticket,
      session_id: null,
      label: "résumé 🧭.png",
      created_at: now,
    });
    db.prepare("UPDATE labels SET name=? WHERE id=?").run("é / e\u0301 · العربية 🧭", ids.label);
    insert("labels", {
      id: "7a1f0c2e-0000-4000-8000-000000000011",
      project_id: ids.project,
      name: "Merged",
      created_at: now,
      updated_at: now,
      merged_into_id: ids.label,
      merged_at: now,
      merged_by: JSON.stringify({ kind: "user" }),
    });
    // SQLite has archive/merge/removed markers, not cloud deletedAt columns.
    // Its archived ticket and removed project remain in the base fixture.
    insert("ticket_comments", {
      id: "deleted-comment",
      ticket_id: MOVE_IDS.ticket,
      actor: "user",
      body: "deleted",
      created_at: now,
      updated_at: now,
    });
    db.prepare("DELETE FROM ticket_comments WHERE id='deleted-comment'").run();
    insert("automation_pending_armed_runs", {
      id: "7a1f0c2e-0000-4000-8000-000000000043",
      ticket_id: ids.tickets[0],
      project_id: ids.project,
      ticket_display_id: "AL-1",
      automation_id: ids.automation,
      automation_name: "Review",
      status: "needs_review",
      origin: "armed",
      opened_at: now,
      start_at: now + 10000,
    });
    insert("app_state", {
      key: "volli:automation-schedule-cursors",
      value: JSON.stringify({ [ids.automation]: now, [MOVE_IDS.shadowAutomation]: now }),
      updated_at: now,
    });
    insert("projects", {
      id: MOVE_IDS.shadowProject,
      name: "Volli Cloud project",
      path: join(root, "shadow"),
      ticket_prefix: "SH",
      created_at: now,
      updated_at: now,
    });
    insert("automations", {
      id: MOVE_IDS.shadowAutomation,
      project_id: MOVE_IDS.shadowProject,
      name: "Cloud-only",
      instructions: "never export",
      created_at: now,
      updated_at: now,
    });
    insert("cloud_shadow_rows", {
      kind: "project",
      id: MOVE_IDS.shadowProject,
      owner_user_id: "cloud-owner",
    });
    insert("tickets", {
      id: MOVE_IDS.shadowTicket,
      project_id: ids.project,
      ticket_number: 900,
      title: "Shadow",
      body: "must not move",
      status: "todo",
      priority: "low",
      created_at: now,
      updated_at: now,
    });
    insert("cloud_shadow_rows", {
      kind: "ticket",
      id: MOVE_IDS.shadowTicket,
      owner_user_id: "cloud-owner",
    });
    for (const id of [MOVE_IDS.drainedSession, MOVE_IDS.bornCloudSession])
      insert("sessions", { id, project_id: ids.project, role: "project", created_at: now });
    insert("session_drain_cursors", {
      session_id: MOVE_IDS.drainedSession,
      owner_user_id: "cloud-owner",
      claim_generation: 1,
      accepted_through: 0,
      updated_at: now,
    });
    insert("session_follow_up_queue", {
      session_id: MOVE_IDS.drainedSession,
      state: "{}",
      pending_count: 1,
    });
    insert("session_read_receipts", { session_id: MOVE_IDS.drainedSession, unread_since: now });
    insert("session_events", {
      id: `birth:${MOVE_IDS.bornCloudSession}`,
      session_id: MOVE_IDS.bornCloudSession,
      sequence: 1,
      occurred_at: now,
      recorded_at: now,
      provenance_id: 1,
      payload: JSON.stringify({ kind: "session.created", session: { ownerUserId: "cloud-owner" } }),
    });
    // The production event-order index is maintained by its trigger.
    const transcripts = join(root, "session-transcripts");
    mkdirSync(transcripts, { recursive: true });
    const count = options.artifacts ?? 2048;
    const event = db.prepare(
      "INSERT INTO session_events (id,session_id,sequence,occurred_at,recorded_at,provenance_id,payload) VALUES (?,?,?,?,?,1,?)",
    );
    for (let i = 0; i < count; i++) {
      const text = "x".repeat(i === 0 ? 105 * 1024 - 250 : 26 * 1024);
      const bytes = Buffer.from(
        JSON.stringify({
          version: 1,
          threadId: "thread",
          branchId: "branch",
          attemptId: "attempt",
          turnId: "turn",
          message: { id: `m-${i}`, role: "assistant", parts: [{ type: "text", text }] },
        }),
      );
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (!(options.fault === "transcript" && i === 0))
        writeFileSync(
          join(transcripts, `${digest.slice(7)}.json${i % 2 ? ".gz" : ""}`),
          i % 2 ? gzipSync(bytes) : bytes,
        );
      event.run(
        `transcript:${i}`,
        ids.hotSession,
        i + 6,
        now + i,
        now + i,
        JSON.stringify({
          kind: "transcript.referenced",
          attachmentId: MOVE_IDS.attachment,
          turnId: "turn",
          reference: { id: digest, digest, mediaType: "application/vnd.volli.ui-message+json" },
        }),
      );
    }
    const piDir = join(root, "pi-sessions", "--move--");
    mkdirSync(piDir, { recursive: true });
    const piFile = join(piDir, "move-fixture.jsonl");
    if (options.fault !== "pi") {
      const lines = `${JSON.stringify({ type: "message", text: "Pi continuity 🧭" })}\n`;
      writeFileSync(piFile, lines.repeat(15000));
      if (options.piLongLineBytes !== undefined)
        for (const piece of longPiLinePieces(options.piLongLineBytes))
          appendFileSync(piFile, piece);
      appendFileSync(piFile, lines.repeat(15000));
      // Pi stopped partway through writing its last line.
      if (options.fault === "piTruncated") appendFileSync(piFile, '{"type":"message","te');
    }
    insert("session_attachments", {
      id: MOVE_IDS.attachment,
      session_id: ids.hotSession,
      adapter_id: "pi",
      venue_id: "local",
      venue_kind: "local",
      continuity: "fresh",
      native_id: "pi-fixture",
      native_detail: JSON.stringify({
        kind: "volli.native-binding.v1",
        locator: { runtime: "pi", sessionId: "pi-fixture", sessionFilePath: piFile },
      }),
      observed_kind: "opened",
      created_sequence: 1,
    });
    if (options.fault === "comment") {
      db.pragma("foreign_keys = OFF");
      insert("ticket_comments", {
        id: "orphan-comment",
        ticket_id: "missing-ticket",
        actor: "user",
        body: "orphan",
        created_at: now,
        updated_at: now,
      });
    }
    if (options.fault === "blob") db.prepare("UPDATE blobs SET size_bytes=size_bytes+1").run();
    if (options.fault === "nonUuid")
      insert("labels", {
        id: "not-a-uuid",
        project_id: ids.project,
        name: "Invalid id",
        created_at: now,
        updated_at: now,
      });
    return profile;
  } finally {
    db.close();
  }
}
