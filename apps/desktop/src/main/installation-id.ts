/**
 * This Volli installation's stable id (VC-469).
 *
 * Pi 0.99's "Sign in with ChatGPT" sends OpenAI a UUID naming the
 * installation that signs in (the "agent host"), and refuses to start without
 * one. Volli had no such id, so it gets one here: minted on first use, kept in
 * `app_state`, and the same on every later call. Nothing else reads it.
 *
 * `app_state` is in Volli's backup bundle, so a profile restored on another
 * Mac keeps its id: the restored profile is the same installation, moved. A
 * stored value that is not a UUID is replaced rather than handed on, because
 * the sign-in refuses anything else.
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { getAppState, setAppState } from "./db/app-state-repo";

export const INSTALLATION_ID_APP_STATE_KEY = "volli:installation-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function installationId(
  db: Database.Database,
  options: { now?: () => number; mint?: () => string } = {},
): string {
  const stored = getAppState(db, INSTALLATION_ID_APP_STATE_KEY);
  let parsed: unknown;
  try {
    parsed = stored === undefined ? undefined : JSON.parse(stored);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === "string" && UUID.test(parsed)) return parsed;
  const minted = (options.mint ?? randomUUID)();
  setAppState(
    db,
    INSTALLATION_ID_APP_STATE_KEY,
    JSON.stringify(minted),
    (options.now ?? Date.now)(),
  );
  return minted;
}
