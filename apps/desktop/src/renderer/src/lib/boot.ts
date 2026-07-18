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
import {
  PROJECTS_UI_APP_STATE_KEY,
  decodeProjectsUiState,
  encodeProjectsUiState,
  useProjectsStore,
} from "@renderer/stores/projects";
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

/** Rehydrates only server-owned planning data after a socket-originated mutation. */
export async function refreshPlanningData(
  gateway: Pick<BootGateway, "bootstrap"> = defaultGateway,
): Promise<BootResult> {
  const result = await gateway.bootstrap();
  if (!result.ok) return result;
  const { projects, ticketsByProject, labelsByProject } = result.data;
  const previousSelection = useProjectsStore.getState().selectedProjectId;
  const selectedProjectId = projects.some(({ id }) => id === previousSelection)
    ? previousSelection
    : (projects[0]?.id ?? null);
  useProjectsStore.getState().hydrate(projects, selectedProjectId);
  useBoardStore.getState().hydrate(ticketsByProject, labelsByProject);
  return { ok: true };
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
 * there is nothing worth importing or preserving — i.e. none of
 * `volli:projects`/`volli:ui`/`volli:workspace` is present. A bare
 * `volli:board` (the old demo scaffold) is deliberately never read — decision
 * #29 discards it, and `clearLegacyStorage` sweeps it away instead.
 *
 * The request also carries `rawBackup`: every `volli:*` string, untouched, so
 * the import transaction can stash the raw source in SQLite before boot clears
 * localStorage (a lossy/unreadable import stays recoverable).
 *
 * `sourceUnreadable` flags that a `volli:projects` blob was present but yielded
 * no importable projects despite *having* project data — i.e. it was corrupt/
 * truncated, or its entries all failed validation. A cleanly-empty project
 * list (`{ projects: [] }`) is readable, just empty, and does NOT set it.
 */
function buildLegacyImportRequest(
  storage: BootStorage,
): { request: LegacyImportRequest; sourceUnreadable: boolean } | null {
  const rawProjects = storage.getItem(LEGACY_PROJECTS_KEY);
  const rawUi = storage.getItem(LEGACY_UI_KEY);
  const rawWorkspace = storage.getItem(LEGACY_WORKSPACE_KEY);
  if (rawProjects === null && rawUi === null && rawWorkspace === null) return null;

  // The persisted `volli:projects` state is `{ projects: [...], selectedProjectId }`
  // (the old store's `partialize` shape) — sanitize the `projects` array, not
  // the envelope's `state` object itself. Absent `volli:projects` yields an
  // empty project list (a prefs-only migration), which is still worth running
  // so the ui/workspace prefs below are carried over rather than discarded.
  const legacyState = rawProjects !== null ? unwrapPersistEnvelope(rawProjects) : undefined;
  const legacyStateRecord =
    typeof legacyState === "object" && legacyState !== null
      ? (legacyState as Record<string, unknown>)
      : undefined;
  const rawProjectsField = legacyStateRecord?.projects;
  const projects = sanitizeLegacyProjects(rawProjectsField);
  const legacySelectedId = legacyStateRecord?.selectedProjectId;

  // "Had project data we couldn't use": a present blob that either didn't parse
  // into a projects array at all, or parsed to a non-empty array none of whose
  // entries survived validation. An empty array is readable-but-empty.
  const hadProjectData = Array.isArray(rawProjectsField)
    ? rawProjectsField.length > 0
    : rawProjects !== null;
  const sourceUnreadable = hadProjectData && projects.length === 0;

  const appState: Record<string, string> = {
    [PROJECTS_UI_APP_STATE_KEY]: encodeProjectsUiState(
      typeof legacySelectedId === "string" ? legacySelectedId : null,
    ),
  };
  if (rawUi !== null) appState[LEGACY_UI_KEY] = rawUi;
  if (rawWorkspace !== null) appState[LEGACY_WORKSPACE_KEY] = rawWorkspace;

  const rawBackup: Record<string, string> = {};
  for (const key of volliKeys(storage)) {
    const raw = storage.getItem(key);
    if (raw !== null) rawBackup[key] = raw;
  }

  return { request: { projects, appState, rawBackup }, sourceUnreadable };
}

/** The app_state-persisted selection, or `null` when absent/stale (points at a project that no longer exists). */
function resolveSelectedProjectId(
  appState: Record<string, string>,
  projects: BootstrapPayload["projects"],
): string | null {
  const id = decodeProjectsUiState(appState[PROJECTS_UI_APP_STATE_KEY]);
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

  // Attempt the one-time legacy import whenever the projects table is still
  // empty and localStorage holds legacy data. Gating on projects-emptiness
  // alone (NOT the old `firstRun`, which also required app_state to be empty)
  // is what makes a transient import failure retriable: normal UI use writes
  // app_state, which used to flip `firstRun` false and both skip the pending
  // import AND destroy its source on the next boot. The main handler is itself
  // idempotent (it no-ops once projects exist), so re-attempting is safe.
  let preserveSource = false;
  if (payload.projects.length === 0) {
    const built = buildLegacyImportRequest(storage);
    if (built !== null) {
      const importResult = await gateway.importLegacy(built.request);
      if (!importResult.ok) {
        // A failed import rolled back its transaction — nothing was persisted,
        // not even the backup, so the localStorage source is the only copy.
        // Keep it for a retry next launch and surface the failure (CLAUDE.md:
        // never silently swallow a failed mutation). The Toaster isn't mounted
        // yet, so stash the message; AppShell surfaces it on mount.
        preserveSource = true;
        setBootNotice(
          `Couldn't import your existing data (${importResult.error}). It's been left untouched — relaunch to try again.`,
        );
      } else {
        payload = importResult.data;
        // A present-but-unreadable `volli:projects` blob imported nothing (the
        // authoritative `imported` count confirms it). The import transaction
        // already backed up the raw source into SQLite, so clearing localStorage
        // below is safe — but tell the user their data couldn't be read rather
        // than discarding it silently.
        if (built.sourceUnreadable && importResult.imported === 0) {
          setBootNotice(
            "Found existing project data we couldn't read. It's been backed up but not imported — reach out if you need it recovered.",
          );
        }
      }
    }
  }

  // Clear the legacy localStorage once we've booted (decision #29) — a clean
  // (or zero-project, already-backed-up) import discards it, as does a boot
  // with nothing importable. The one exception is a failed import, handled
  // above: never destroy the source when nothing was persisted in its place.
  if (!preserveSource) clearLegacyStorage(storage);

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
