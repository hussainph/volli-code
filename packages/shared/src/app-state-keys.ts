/**
 * Where every `app_state` row belongs once the desktop is a host-protocol
 * client (VC-574).
 *
 * `app_state(key, value, updated_at)` is one string→string table in today's
 * single database file, and it mixes three owners: the viewing device's own
 * layout and preferences, settings of the host as a whole, and (since the
 * VC-574 rulings) a little workspace state. Nothing in the table says which
 * row is which, so this registry does. It is the source of truth; no markdown
 * copy of it exists.
 *
 * The vocabulary is the one `docs/plans/host-protocol.md` §Host operations vs
 * client-local sets as the classification test, with host vs workspace drawn
 * at the file boundary of `docs/plans/host-identity.md` (VC-588):
 *
 * - `client-local`: a presentation or native preference of the viewing device
 *   (BOUNDARIES rule 7's "device-local"). It never becomes host state.
 * - `host`: state of the host as a whole, shared by every workspace on it,
 *   which lives in the host-level file after VC-588.
 * - `workspace`: state of one workspace, which travels when that workspace
 *   moves to another host.
 * - `split`: one row whose meaning has a host half and a client half; `split`
 *   names both.
 * - `retired`: rows an older build wrote and nothing reads. Registered so a
 *   real profile classifies completely; never a live key.
 *
 * `owner` is the ticket that moves the row (or changes how it behaves), or
 * `stays` when no ticket needs to.
 *
 * Enforcement: host-core's `app-state-repo.ts` takes {@link AppStateKey}, so a
 * main or host writer with an unregistered constant does not compile, and the
 * string-typed renderer doors check {@link isAppStateKey} at run time.
 *
 * Pure data: no Node, DOM or Electron imports, so host-core, desktop main and
 * the renderer can all read it.
 */

/** The placements a channel or a live `app_state` key can have. */
export const CLOUD_PLACEMENTS = Object.freeze([
  "client-local",
  "host",
  "workspace",
  "split",
] as const);
export type CloudPlacement = (typeof CLOUD_PLACEMENTS)[number];

/** Every placement an `app_state` key can have: the live ones plus `retired`. */
export const APP_STATE_PLACEMENTS = Object.freeze([...CLOUD_PLACEMENTS, "retired"] as const);
export type AppStatePlacement = (typeof APP_STATE_PLACEMENTS)[number];

/**
 * The tickets that move host or workspace state, or change how a client-local
 * row behaves (M2: VC-564–573 and VC-575–578), plus `stays` for "no ticket
 * needs to".
 */
export const CLOUD_PLACEMENT_OWNERS = Object.freeze([
  "VC-564",
  "VC-565",
  "VC-566",
  "VC-567",
  "VC-568",
  "VC-569",
  "VC-570",
  "VC-571",
  "VC-572",
  "VC-573",
  "VC-575",
  "VC-576",
  "VC-577",
  "VC-578",
  "stays",
] as const);
export type CloudPlacementOwner = (typeof CLOUD_PLACEMENT_OWNERS)[number];

/** The two halves of a `split` row. */
export interface CloudPlacementSplit {
  /** Whether the non-client half is host-level or belongs to one workspace. */
  readonly scope: "host" | "workspace";
  /** What the host (or workspace) owns. */
  readonly host: string;
  /** What stays on the viewing device. */
  readonly client: string;
}

interface AppStateKeyEntryBase {
  readonly owner: CloudPlacementOwner;
  readonly reason: string;
}

/** One registered key or prefix. Only a `split` row carries `split`. */
export type AppStateKeyEntry =
  | (AppStateKeyEntryBase & {
      readonly placement: Exclude<AppStatePlacement, "split">;
      readonly split?: never;
    })
  | (AppStateKeyEntryBase & {
      readonly placement: "split";
      readonly split: CloudPlacementSplit;
    });

const EXACT = {
  // ── client-local ──────────────────────────────────────────────────────────
  theme: {
    placement: "client-local",
    owner: "stays",
    reason:
      "The global authored canvas (shared/theme/app-state.ts). host-protocol.md's Theme row: the theme is a client preference unless VC-574 reclassifies it, and it does not.",
  },
  appearance: {
    placement: "client-local",
    owner: "stays",
    reason:
      "Global light/dark/auto, resolved against this device's OS appearance (shared/theme/app-state.ts).",
  },
  "first-paint": {
    placement: "client-local",
    owner: "stays",
    reason:
      "Window background and mode main reads before the window exists (host-core db/theme-repo.ts); a cache of this device's resolved theme, meaningless off-device.",
  },
  "volli:ui": {
    placement: "client-local",
    owner: "stays",
    reason:
      "The renderer's ui persist store (stores/ui.ts): rail widths, zoom, pins, default external app, dismissed faults. Per-device layout; VC-361 owns its write path.",
  },
  "volli:workspace": {
    placement: "client-local",
    owner: "stays",
    reason:
      "The renderer's workspace persist store (stores/workspace.ts): per-project view memory (open ticket, tabs, file views). Keyed by project, owned by the viewer.",
  },
  "volli:projects-ui": {
    placement: "client-local",
    owner: "stays",
    reason:
      "The selected project (stores/projects.ts); with several hosts it is this client's choice.",
  },
  "volli:chat-drafts": {
    placement: "client-local",
    owner: "VC-567",
    reason:
      "Composer drafts on this device (shared/blob.ts). Main reads the row at boot so draft attachments survive blob GC; VC-567 replaces that read with attachment pins clients publish to the host.",
  },
  "volli:new-ticket-draft": {
    placement: "client-local",
    owner: "VC-567",
    reason:
      "The new-ticket composer draft on this device (shared/blob.ts). Main reads the row at boot so draft attachments survive blob GC; VC-567 replaces that read with attachment pins clients publish to the host.",
  },
  "volli:automation-editor-draft": {
    placement: "client-local",
    owner: "stays",
    reason: "Unsaved Automation editor drafts on this device (automations/editor-draft.ts).",
  },
  "volli:update-allow-prerelease": {
    placement: "client-local",
    owner: "stays",
    reason:
      "The desktop updater's channel (main/auto-update.ts); host-protocol.md's Update row. hostd's version follows the desktop (Decided 1).",
  },
  "volli:notification-preferences": {
    placement: "client-local",
    owner: "VC-578",
    reason:
      "Notification preferences of this device (main/notification-preferences.ts). Each client filters what it shows; the host delivers attention to clients per VC-578.",
  },
  "volli:model-picker-view": {
    placement: "client-local",
    owner: "VC-572",
    reason:
      "Which list the model pickers open on: a presentation preference. Written through host-core today (model-access-preferences.ts); VC-572 moves it to the client.",
  },

  // ── split ─────────────────────────────────────────────────────────────────
  "volli:experimental-flags": {
    placement: "split",
    owner: "VC-577",
    reason:
      "Experiment switches (main/experiments.ts). The `cloud` flag decides whether this desktop attaches to a host at all, so the client must read it before any host is reachable.",
    split: {
      scope: "host",
      host: "hostd takes its own experiments from its launch arguments or config, never from a client's app_state row.",
      client:
        "The desktop's gates (cloud UI, whether to attach) stay in the client's own store, which VC-577 builds.",
    },
  },

  // ── host ──────────────────────────────────────────────────────────────────
  "volli:installation-id": {
    placement: "host",
    owner: "VC-572",
    reason:
      "The id Pi's Sign in with ChatGPT sends OpenAI as the agent host (main/installation-id.ts). It names the install holding the model credentials, and those live where the runtime runs, so it belongs to the host whose sign-in VC-572 moves. Never hostId (host-identity.md).",
  },
  "volli:agent-tools-removed": {
    placement: "host",
    owner: "VC-572",
    reason:
      "Tombstone for the `volli` CLI shim and agent skills install (main/index.ts). Agents need the install where they run, so the tombstone is the host's; the menu that sets it is a client action.",
  },
  "volli:min-reader-version": {
    placement: "host",
    owner: "stays",
    reason:
      "The oldest build allowed to open this database file (host-core db/schema-compatibility.ts), owned by the migration runner. After VC-588 every file carries its own.",
  },
  "volli:legacy-backup": {
    placement: "host",
    owner: "VC-573",
    reason:
      "The raw pre-SQLite localStorage strings stashed once by the legacy import (shared/legacy-import.ts): profile data in the host's file. VC-573 owns the legacy-import door.",
  },
  "volli:retention": {
    placement: "host",
    owner: "VC-573",
    reason: "The global Done-ticket TTL (host-core worktree/retention.ts).",
  },
  "volli:worktree-trim": {
    placement: "host",
    owner: "VC-566",
    reason:
      "Trim allowlist and auto-trim opt-out over every worktree the host owns (host-core worktree/trim-settings.ts).",
  },
  "volli:orphan-processes": {
    placement: "host",
    owner: "VC-573",
    reason:
      "Auto-reap policy for the host's process table (host-core process/auto-reap-settings.ts).",
  },
  "volli:agent-observability": {
    placement: "host",
    owner: "VC-573",
    reason: "The host's agent observability settings (host-core observability/settings.ts).",
  },
  "volli:decision-model": {
    placement: "host",
    owner: "VC-572",
    reason: "The decision model the host calls (host-core decision/settings.ts).",
  },
  "volli:model-access-default": {
    placement: "host",
    owner: "VC-572",
    reason:
      "The pre-purpose single model default, read only as a migration source for the per-purpose defaults (host-core session-runtime/model-access-preferences.ts).",
  },
  "volli:model-access-defaults": {
    placement: "host",
    owner: "VC-572",
    reason:
      "Per-purpose model defaults the host resolves (host-core session-runtime/model-access-preferences.ts).",
  },
  "volli:model-access-hidden-models": {
    placement: "host",
    owner: "VC-572",
    reason:
      "The curated model list, which every client of the host should agree on (host-core session-runtime/model-access-preferences.ts).",
  },
  "volli:compaction-policy": {
    placement: "host",
    owner: "VC-572",
    reason:
      "The runtime's compaction switch, applied on the host (host-core session-runtime/model-access-preferences.ts).",
  },
  "volli:code-mode-policy": {
    placement: "host",
    owner: "VC-572",
    reason:
      "Code Mode's switch and per-model pins, applied on the host (host-core session-runtime/model-access-preferences.ts).",
  },

  // ── workspace ─────────────────────────────────────────────────────────────
  "volli:automations-enabled": {
    placement: "workspace",
    owner: "VC-569",
    reason:
      "The projection of `automation.set-enabled` (host-core automations/enablement.ts). Its comment says it names a host; VC-574 rules it workspace state that a workspace move carries (M4), which VC-569 implements.",
  },
  "volli:automation-schedule-cursors": {
    placement: "workspace",
    owner: "VC-569",
    reason:
      "Which due times the scheduler has seen pass (host-core automations/schedule-cursor.ts). Its comment says it is per host; VC-574 rules it workspace state that a workspace move carries (M4), which VC-569 implements.",
  },

  // ── retired ───────────────────────────────────────────────────────────────
  theme_editor: {
    placement: "retired",
    owner: "stays",
    reason:
      "The editor theme id from builds before VC-123; nothing reads it (shared/theme/app-state.ts).",
  },
  "volli:agent-tools-consent": {
    placement: "retired",
    owner: "stays",
    reason:
      "The old first-boot agent tools consent answer, deliberately ignored since VC-52 (main/index.ts).",
  },
  "volli:authority-reason-source": {
    placement: "retired",
    owner: "stays",
    reason:
      "Authority review setting from VC-28, shipped in v0.2.1 canaries and removed by VC-504. Nothing reads it.",
  },
  "volli:authority-shadow-review-enabled": {
    placement: "retired",
    owner: "stays",
    reason:
      "Auto mode's shadow review switch from VC-498, shipped in v0.2.1 canaries and removed by VC-504. Nothing reads it.",
  },
  "volli:protection-policy-migration:v1": {
    placement: "retired",
    owner: "stays",
    reason:
      "Protection's policy migration backup from VC-480, shipped in v0.2.1 canaries and removed by VC-504. Nothing reads it.",
  },
  "volli:protection-policy-rollout:v1": {
    placement: "retired",
    owner: "stays",
    reason:
      "Protection's rollout marker from VC-480, shipped in v0.2.1 canaries and removed by VC-504. Nothing reads it.",
  },
} as const satisfies Readonly<Record<string, AppStateKeyEntry>>;

const PREFIXES = {
  "volli:vc354-perf:": {
    placement: "client-local",
    owner: "stays",
    reason:
      "Measurement rows of the UI lab's sidebar performance scratch (renderer/lab/scratches/sidebar-performance.tsx), written and removed in one run. The lab is dev-only and never built.",
  },
  "volli:runtime-preferences:": {
    placement: "retired",
    owner: "stays",
    reason:
      "Per-adapter global runtime preferences (`volli:runtime-preferences:<adapterId>`, named by migration 019). The runtime catalog that read them is gone; old profiles may still hold rows.",
  },
} as const satisfies Readonly<Record<string, AppStateKeyEntry>>;

function freezeEntries<T extends Readonly<Record<string, AppStateKeyEntry>>>(entries: T): T {
  for (const entry of Object.values(entries)) {
    if (entry.split !== undefined) Object.freeze(entry.split);
    Object.freeze(entry);
  }
  return Object.freeze(entries);
}

/**
 * The registry: `exact` keys, and `prefixes` that cover every key starting
 * with them. No exact key starts with a registered prefix, and no prefix
 * starts with another, so any key matches at most one entry.
 */
export const APP_STATE_KEYS = Object.freeze({
  exact: freezeEntries(EXACT),
  prefixes: freezeEntries(PREFIXES),
});

type ExactEntries = typeof EXACT;
type PrefixEntries = typeof PREFIXES;
type LiveKeysOf<T extends Readonly<Record<string, AppStateKeyEntry>>> = {
  [K in keyof T & string]: T[K]["placement"] extends "retired" ? never : K;
}[keyof T & string];

/** A registered exact key that is still live. */
export type AppStateExactKey = LiveKeysOf<ExactEntries>;
/** A registered prefix that is still live. */
export type AppStateKeyPrefix = LiveKeysOf<PrefixEntries>;

/**
 * Every key a current build may read or write: a live exact key, or a live
 * prefix followed by anything. Retired rows are not in it, so nothing can
 * write one again.
 */
export type AppStateKey = AppStateExactKey | `${AppStateKeyPrefix}${string}`;

/** A registry row matched to a key, with how it matched. */
export type AppStateKeyClassification = AppStateKeyEntry & {
  /** The exact key or prefix that matched. */
  readonly pattern: string;
  readonly match: "exact" | "prefix";
};

const EXACT_ENTRIES: Readonly<Record<string, AppStateKeyEntry>> = EXACT;
const PREFIX_ENTRIES: ReadonlyArray<readonly [string, AppStateKeyEntry]> = Object.entries(PREFIXES);

/**
 * The registry row for `key`, retired rows included, or `undefined` when the
 * key is unregistered. Inherited object names (`constructor`, `__proto__`) are
 * unregistered, not lookups into `Object.prototype`.
 */
export function classifyAppStateKey(key: string): AppStateKeyClassification | undefined {
  if (Object.hasOwn(EXACT_ENTRIES, key)) {
    return { ...EXACT_ENTRIES[key], pattern: key, match: "exact" };
  }
  for (const [prefix, entry] of PREFIX_ENTRIES) {
    if (key.startsWith(prefix)) return { ...entry, pattern: prefix, match: "prefix" };
  }
  return undefined;
}

/**
 * Whether a current build may read or write `key`: registered and not
 * retired. The run-time twin of {@link AppStateKey}, for doors whose key
 * arrives as a string (the renderer's generic app_state write, the legacy
 * import).
 */
export function isAppStateKey(key: string): key is AppStateKey {
  const classification = classifyAppStateKey(key);
  return classification !== undefined && classification.placement !== "retired";
}
