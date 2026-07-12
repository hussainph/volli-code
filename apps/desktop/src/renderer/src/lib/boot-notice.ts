/**
 * A one-shot handoff for a boot-time warning (e.g. a failed legacy import).
 * boot() runs before React mounts the Toaster, so it can't toast directly; it
 * stashes the message here and AppShell drains it on mount (see lib/boot.ts and
 * components/app-shell.tsx). Deliberately NOT a store field: the ui store is
 * persisted, so putting it there would write the partialized state back to
 * SQLite on every set — this value is read exactly once and never needs to be
 * reactive.
 */
let pending: string | null = null;

/** Stashes the notice to surface on the next AppShell mount. */
export function setBootNotice(notice: string | null): void {
  pending = notice;
}

/** Returns the stashed notice (or `null`) and clears it, so it surfaces once. */
export function takeBootNotice(): string | null {
  const notice = pending;
  pending = null;
  return notice;
}
