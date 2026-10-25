/**
 * Ticket keys (`VC-12`) in Volli Cloud.
 *
 * A key belongs to its project and survives moves: the prefix is fixed on the
 * project and the number is allocated from the project's counter document.
 * Neither is part of any id. Links and mentions store ticket UUIDs; the key a
 * reader sees is re-rendered from the ticket's current project.
 *
 * Prefixes are unique per Workspace when a project is CREATED, but a project
 * move or a migration may bring in a duplicate. Resolving a typed key then
 * reports the ambiguity instead of guessing, and the caller asks for a
 * qualified form (`volli-code/VC-12`) or the UUID.
 */

import { displayTicketId } from "../ticket";

/** Renders a ticket's display key from its project's prefix and its number. */
export function renderTicketKey(project: { ticketPrefix: string }, ticketNumber: number): string {
  return displayTicketId(project.ticketPrefix, ticketNumber);
}

/** A typed key, split. `qualifier` is the part before `/` in a qualified key, else `null`. */
export interface TicketKeyReference {
  qualifier: string | null;
  prefix: string;
  number: number;
}

const KEY = /^(?:([^/\s]+)\/)?([A-Za-z][A-Za-z0-9]{0,4})-([1-9][0-9]{0,8})$/;

/**
 * Parses `VC-12` or `volli-code/VC-12` (prefix case-insensitive, normalized to
 * upper case). Returns `null` for anything else, including ticket number 0.
 */
export function parseTicketKey(text: string): TicketKeyReference | null {
  const match = KEY.exec(text.trim());
  if (match === null) return null;
  // The pattern admits exactly the prefixes `isValidPrefix` accepts, in either case.
  return { qualifier: match[1] ?? null, prefix: match[2].toUpperCase(), number: Number(match[3]) };
}

export type TicketPrefixResolution<P> =
  | { kind: "unique"; project: P }
  | { kind: "ambiguous"; projects: P[] }
  | { kind: "none" };

/**
 * Which of a Workspace's projects a bare prefix names. Two projects sharing a
 * prefix (after a move or a migration) resolve as `ambiguous`, never to the
 * first one found.
 */
export function resolveTicketPrefix<P extends { ticketPrefix: string }>(
  prefix: string,
  projects: readonly P[],
): TicketPrefixResolution<P> {
  const wanted = prefix.toUpperCase();
  const matches = projects.filter((project) => project.ticketPrefix === wanted);
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "unique", project: matches[0] };
  return { kind: "ambiguous", projects: matches };
}
