/**
 * Which Workspace a board resource belongs to (VC-565): the board router's
 * half of a composition root's `resourceWorkspace` port (HP § Command
 * catalog, "Resources, open per area"). A ticket's Workspace is its project;
 * a comment's, its ticket's; a label's, its own project. Any other kind, or an
 * absent id, answers null, which the router refuses exactly as it refuses a
 * foreign one.
 */
import type Database from "better-sqlite3";
import { BOARD_RESOURCE_KINDS } from "@volli/shared";

import { prepared } from "../db/prepared";

export function boardResourceWorkspace(
  db: Database.Database,
): (resource: { readonly kind: string; readonly id: string }) => string | null {
  return ({ kind, id }) => {
    switch (kind) {
      case BOARD_RESOURCE_KINDS.ticket:
        return (
          prepared<[string], { project_id: string }>(
            db,
            "SELECT project_id FROM tickets WHERE id = ?",
          ).get(id)?.project_id ?? null
        );
      case BOARD_RESOURCE_KINDS.comment:
        return (
          prepared<[string], { project_id: string }>(
            db,
            `SELECT t.project_id FROM ticket_comments c JOIN tickets t ON t.id = c.ticket_id
             WHERE c.id = ?`,
          ).get(id)?.project_id ?? null
        );
      case BOARD_RESOURCE_KINDS.label:
        return (
          prepared<[string], { project_id: string }>(
            db,
            "SELECT project_id FROM labels WHERE id = ?",
          ).get(id)?.project_id ?? null
        );
      default:
        return null;
    }
  };
}
