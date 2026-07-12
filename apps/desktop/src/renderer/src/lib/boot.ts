/**
 * App boot: reads the SQLite bootstrap payload, runs the one-time
 * localStorage → SQLite import on first run (docs/CONCEPT.md decision #29),
 * then hydrates the projects/board/ui/workspace stores from it. Kept out of
 * main.tsx so the flow (envelope-unwrap, sanitization, the
 * always-clear-legacy-storage step) is unit-testable without mounting React.
 */
import {
  sanitizeLegacyProjects,
  type BootstrapPayload,
  type BootstrapResult,
  type LegacyImportRequest,
  type LegacyImportResult,
} from "@volli/shared";

import { seedAppStateCache } from "@renderer/lib/app-state-storage";
import { setBootNotice } from "@renderer/lib/boot-notice";
import { PROJECTS_UI_APP_STATE_KEY, useProjectsStore } from "@renderer/stores/projects";
import { useBoardStore } from "@renderer/stores/board";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

const LEGACY_PROJECTS_KEY = "volli:projects";
const LEGACY_UI_KEY = "volli:ui";
const LEGACY_WORKSPACE_KEY = "volli:workspace";
const LEGACY_PREFIX = "volli:";

/** The subset of the preload API boot() needs — narrow and fake-able for tests. */
export interface BootGateway {
  bootstrap(): Promise<BootstrapResult>;
  importLegacy(req: LegacyImportRequest): Promise<LegacyImportResult>;
}

const defaultGateway: BootGateway = {
  bootstrap: () => window.api.data.bootstrap(),
  importLegacy: (req) => window.api.data.importLegacy(req),
};

/** The minimal localStorage surface boot() needs — narrow enough to fake in tests. */
export interface BootStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export type BootResult = { ok: true } | { ok: false; error: string };

/** Parses the `"volli:projects-ui"` app_state JSON; defensive against a corrupt/missing value. */
function parseSelectedProjectId(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const selectedProjectId = (parsed as Record<string, unknown>).selectedProjectId;
    return typeof selectedProjectId === "string" ? selectedProjectId : null;
  } catch {
    return null;
  }
}

/** Unwraps a zustand-persist envelope (`{state,version}`) into its `state`, or `undefined` for anything else. */
function unwrapPersistEnvelope(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return (parsed as Record<string, unknown>).state;
  } catch {
    return undefined;
  }
}

/** Every `volli:*` key currently in `storage`, so `clearLegacyStorage` is exhaustive. */
function volliKeys(storage: BootStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(LEGACY_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Clears every `volli:*` localStorage key — always, once bootstrap succeeds (decision #29). */
function clearLegacyStorage(storage: BootStorage): void {
  for (const key of volliKeys(storage)) storage.removeItem(key);
}

/**
 * Builds the one-time legacy import request from localStorage, or `null` when
 * there is nothing to import (`volli:projects` absent). `volli:board` (the
 * old demo scaffold) is deliberately never read — decision #29 discards it.
 */
function buildLegacyImportRequest(storage: BootStorage): LegacyImportRequest | null {
  const rawProjects = storage.getItem(LEGACY_PROJECTS_KEY);
  if (rawProjects === null) return null;

  // The persisted `volli:projects` state is `{ projects: [...], selectedProjectId }`
  // (the old store's `partialize` shape) — sanitize the `projects` array, not
  // the envelope's `state` object itself.
  const legacyState = unwrapPersistEnvelope(rawProjects);
  const legacyStateRecord =
    typeof legacyState === "object" && legacyState !== null
      ? (legacyState as Record<string, unknown>)
      : undefined;
  const projects = sanitizeLegacyProjects(legacyStateRecord?.projects);
  const legacySelectedId = legacyStateRecord?.selectedProjectId;

  const appState: Record<string, string> = {
    [PROJECTS_UI_APP_STATE_KEY]: JSON.stringify({
      selectedProjectId: typeof legacySelectedId === "string" ? legacySelectedId : null,
    }),
  };
  const rawUi = storage.getItem(LEGACY_UI_KEY);
  if (rawUi !== null) appState[LEGACY_UI_KEY] = rawUi;
  const rawWorkspace = storage.getItem(LEGACY_WORKSPACE_KEY);
  if (rawWorkspace !== null) appState[LEGACY_WORKSPACE_KEY] = rawWorkspace;

  return { projects, appState };
}

/** The app_state-persisted selection, or `null` when absent/stale (points at a project that no longer exists). */
function resolveSelectedProjectId(
  appState: Record<string, string>,
  projects: BootstrapPayload["projects"],
): string | null {
  const id = parseSelectedProjectId(appState[PROJECTS_UI_APP_STATE_KEY]);
  return id !== null && projects.some((project) => project.id === id) ? id : null;
}

/**
 * Runs the full boot sequence: bootstrap SQLite, one-time legacy import on
 * first run, then hydrates the projects/board/ui/workspace stores. Returns
 * `{ ok: false }` only when `bootstrap()` itself fails — main.tsx renders the
 * DB-failure empty state in that case instead of mounting the app.
 */
export async function boot(
  gateway: BootGateway = defaultGateway,
  storage: BootStorage = localStorage,
): Promise<BootResult> {
  const bootstrapResult = await gateway.bootstrap();
  if (!bootstrapResult.ok) return bootstrapResult;

  let payload = bootstrapResult.data;

  let importFailed = false;
  if (payload.firstRun) {
    const importRequest = buildLegacyImportRequest(storage);
    if (importRequest !== null) {
      const importResult = await gateway.importLegacy(importRequest);
      if (importResult.ok) {
        payload = importResult.data;
      } else {
        // A failed import still boots the app (with the empty bootstrap
        // payload), but — unlike a success — must NOT clear the legacy
        // localStorage: it's the user's only copy of that data, so keep it for
        // a retry next launch and surface the failure (CLAUDE.md: never
        // silently swallow a failed mutation). The Toaster isn't mounted yet,
        // so stash the message; AppShell surfaces it on mount.
        importFailed = true;
        setBootNotice(
          `Couldn't import your existing data (${importResult.error}). It's been left untouched — relaunch to try again.`,
        );
      }
    }
  }

  // Clear the legacy localStorage once we've booted (decision #29) — a clean
  // import, or a first run with nothing importable, discards it. The one
  // exception is a failed import, handled above: never destroy the source.
  if (!importFailed) clearLegacyStorage(storage);

  seedAppStateCache(payload.appState);

  // Resolved BEFORE hydrate (rather than hydrating with `null` and calling
  // `select` afterward) so boot never fires a redundant appState.set — the
  // value already came FROM app_state, there's nothing new to persist.
  const selectedProjectId = resolveSelectedProjectId(payload.appState, payload.projects);
  useProjectsStore.getState().hydrate(payload.projects, selectedProjectId);
  useBoardStore.getState().hydrate(payload.ticketsByProject, payload.labelsByProject);

  await Promise.all([useUiStore.persist.rehydrate(), useWorkspaceStore.persist.rehydrate()]);

  return { ok: true };
}
