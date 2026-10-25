/**
 * Config resolution: the one precedence rule every configuration surface reads
 * (VC-40, P3).
 *
 * Configuration comes in levels. Volli Cloud's target order (Q57) is
 * **personal > project > workspace**, admin **policy** over all of them, and
 * **repo** files — `AGENTS.md`, `.agents/*`, `.volli/commands/`, `.mcp.json`,
 * read from the Working copy and never stored — always apply: no level can
 * switch a repo entry off (only policy can deny it), but a same-named entry at
 * any configured level replaces it. So repo sits last in the order.
 *
 * Each surface declares two things here and nowhere else:
 *
 *  - its **merge**: `override` (one value; the highest level that sets it
 *    wins, `null`/`undefined` meaning "inherit") or `union` (a keyed
 *    collection; every level contributes, and for a key several levels define
 *    the highest wins outright). A union also takes **deny lists**: a key a
 *    level denies is removed from that level and every level below it, which
 *    is how admin policy will override all.
 *  - its **order**: the levels it reads, highest first. A surface that still
 *    resolves in its pre-cloud order declares that order literally and says
 *    why; a surface that moves to Q57 under the `cloud` flag declares both, so
 *    flag-off behaviour stays byte-identical.
 *
 * Today only local levels exist: `personal` (this person's machine-wide
 * settings and `~/.agents/skills`), `project` (the project row), and `repo`.
 * `workspace` and `policy` are absent until their Convex rows land; they plug
 * into the same declarations.
 *
 * Pure: no Node/DOM imports.
 */

/** Every configuration level, in Volli Cloud's target precedence (Q57), highest first. */
const CONFIG_PRECEDENCE = ["policy", "personal", "project", "workspace", "repo"] as const;

/** One configuration level. */
export type ConfigLevel = (typeof CONFIG_PRECEDENCE)[number];

/** How a surface combines its levels; see the module comment. */
export type ConfigMerge = "override" | "union";

/**
 * A resolved precedence: what to merge, and the levels to read, highest first.
 * Generic over the level vocabulary so a surface with its own local scopes
 * (the secret store's `session > project > always`) resolves through the same
 * code until its levels become config levels.
 */
export interface ConfigPlan<M extends ConfigMerge, L extends string = ConfigLevel> {
  readonly merge: M;
  readonly order: readonly L[];
}

/** The given levels in target order — a declaration that cannot drift from Q57. */
function targetOrder(...levels: readonly ConfigLevel[]): readonly ConfigLevel[] {
  return CONFIG_PRECEDENCE.filter((level) => levels.includes(level));
}

/**
 * Every surface that combines more than one level, and how.
 *
 * Surfaces with a single level today — MCP servers (project rows), web access
 * and model defaults (host-level), authority / compaction / Code Mode policy
 * (one project override over built-in defaults) — have no precedence to
 * compute yet and join this table when their second level lands.
 */
const CONFIG_SURFACES = {
  /**
   * Skills: `<project>/.agents/skills` (repo) and `~/.agents/skills`
   * (personal), by slug. Today the repo's copy wins; under `cloud` the
   * personal one does (Q57).
   */
  skills: {
    merge: "union",
    local: ["repo", "personal"],
    cloud: targetOrder("personal", "repo"),
  },
  /** Prompt templates: `<project>/.volli/commands` (repo) and `<userData>/commands` (personal), by name. Same flip as skills. */
  promptTemplates: {
    merge: "union",
    local: ["repo", "personal"],
    cloud: targetOrder("personal", "repo"),
  },
  /** A skill's invocation mode: the project's rule, over the skill's own declaration (the caller's fallback). */
  skillMode: { merge: "override", order: ["project"] },
  /**
   * The decision model: a project's override over the app-wide setting. Kept
   * project-first under `cloud` too: the override is today the person's own
   * per-project choice, so its cloud level is decided with its Convex rows.
   */
  decisionModel: { merge: "override", order: ["project", "personal"] },
  /** Theme surfaces (canvas, appearance, terminal theme): a project's override over the global choice, per surface. */
  theme: { merge: "override", order: ["project", "personal"] },
} as const satisfies Record<
  string,
  | { merge: ConfigMerge; order: readonly ConfigLevel[] }
  | { merge: ConfigMerge; local: readonly ConfigLevel[]; cloud: readonly ConfigLevel[] }
>;

/** A surface declared in the table above. */
export type ConfigSurfaceId = keyof typeof CONFIG_SURFACES;

type SurfaceDeclaration<S extends ConfigSurfaceId> = (typeof CONFIG_SURFACES)[S];

/**
 * One surface's plan. A surface whose order moves under the `cloud` flag must
 * be told whether the flag is on — it is a required argument for exactly those
 * surfaces, so no caller can forget it; the rest take none.
 */
export function configPlan<S extends ConfigSurfaceId>(
  surface: S,
  ...flag: SurfaceDeclaration<S> extends { cloud: unknown } ? [cloud: boolean] : []
): ConfigPlan<SurfaceDeclaration<S>["merge"]> {
  const declared: SurfaceDeclaration<ConfigSurfaceId> = CONFIG_SURFACES[surface];
  const order =
    "order" in declared ? declared.order : flag[0] === true ? declared.cloud : declared.local;
  return { merge: declared.merge as SurfaceDeclaration<S>["merge"], order };
}

/** An `override` surface's answer: the value in force and the level that set it. */
export interface ResolvedConfigValue<V, L extends string = ConfigLevel> {
  readonly value: V;
  readonly level: L;
}

/**
 * Resolve an `override` surface: the value of the highest level in the plan's
 * order that sets one. `null` and `undefined` both mean "inherit", so a level
 * absent from `layers` and a level that stored `null` read the same. `null`
 * when no level sets it — the caller's built-in default applies.
 */
export function resolveConfigValue<V, L extends string = ConfigLevel>(
  plan: ConfigPlan<"override", L>,
  layers: Partial<Record<L, V | null | undefined>>,
): ResolvedConfigValue<V, L> | null {
  for (const level of plan.order) {
    const value = layers[level];
    if (value !== null && value !== undefined) return { value, level };
  }
  return null;
}

/** One entry of a resolved `union` surface, with the level it came from. */
export interface ResolvedConfigEntry<T, L extends string = ConfigLevel> {
  readonly key: string;
  readonly value: T;
  readonly level: L;
}

/**
 * Resolve a `union` surface: every level's entries, keyed by `keyOf`, where a
 * key several levels define resolves to the highest level's entry outright
 * (it replaces, never merges fields). Within one level a later entry replaces
 * an earlier one with the same key. A key a level denies is removed from that
 * level and every level below it; a higher level may still define it.
 *
 * Levels are walked lowest first, so the result is in first-seen order from
 * the bottom of the plan; callers that present a list sort it themselves.
 */
export function resolveConfigEntries<T, L extends string = ConfigLevel>(
  plan: ConfigPlan<"union", L>,
  layers: Partial<Record<L, readonly T[]>>,
  keyOf: (entry: T) => string,
  deny: Partial<Record<L, readonly string[]>> = {},
): readonly ResolvedConfigEntry<T, L>[] {
  const byKey = new Map<string, ResolvedConfigEntry<T, L>>();
  for (const level of plan.order.toReversed()) {
    for (const value of layers[level] ?? []) {
      const key = keyOf(value);
      byKey.set(key, { key, value, level });
    }
    for (const key of deny[level] ?? []) byKey.delete(key);
  }
  return [...byKey.values()];
}
