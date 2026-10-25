/**
 * Config resolution: the one precedence rule every configuration surface reads.
 *
 * Configuration comes in levels. Volli Cloud's target order is
 * **personal > project > workspace**, admin **policy** over all of them, and
 * **repo** files — `AGENTS.md`, `.agents/*`, `.mcp.json`, read from the
 * Working copy and never stored — always apply: a configured level may add
 * entries beside a repo's, but it can neither switch a repo entry off (only a
 * surface's declared deny levels, i.e. policy, can) nor replace one by defining
 * the same name — the repo's entry keeps that name. So repo sits directly
 * under policy, above every configured level.
 *
 * Each configuration surface declares, in the table below:
 *
 *  - its **merge**: `override` (one value; the highest level that sets it
 *    wins, `null`/`undefined` meaning "inherit") or `union` (a keyed
 *    collection; every level contributes, and for a key several levels define
 *    the highest wins outright).
 *  - its **deny levels** (unions only): the levels whose deny lists remove a
 *    key from themselves and every level below them — how admin policy
 *    overrides all. A deny level must be in the order (policy first, so it
 *    is present before its rows exist); a deny list from any other level is
 *    ignored.
 *  - its **order**: the levels it reads, highest first. A surface that still
 *    resolves in its pre-cloud order declares that order literally and says
 *    why; a surface that moves to the target order under the `cloud` flag
 *    declares both (`flagOff` and `cloud`), so flag-off behaviour stays
 *    byte-identical.
 *
 * Today only local levels exist: `personal` (this person's machine-wide
 * settings, `~/.agents/skills`, `<userData>/commands`), `project` (the
 * project row and the self-gitignored `.volli/commands/`), and `repo`.
 * `workspace` and `policy` are absent until their Convex rows land; they plug
 * into the same declarations.
 *
 * Pure: no Node/DOM imports.
 */

/** Every configuration level, in Volli Cloud's target precedence, highest first. */
const CONFIG_PRECEDENCE = ["policy", "repo", "personal", "project", "workspace"] as const;

/** One configuration level. */
export type ConfigLevel = (typeof CONFIG_PRECEDENCE)[number];

/** How a surface combines its levels; see the module comment. */
export type ConfigMerge = "override" | "union";

/**
 * A resolved precedence: what to merge, the levels to read (highest first),
 * and — for a union — the levels whose deny lists count. Generic over the
 * level vocabulary so a store with its own local scopes (the secret store's
 * `session > project > always`, declared beside it) resolves through the same
 * code.
 */
export interface ConfigPlan<M extends ConfigMerge, L extends string = ConfigLevel> {
  readonly merge: M;
  readonly order: readonly L[];
  readonly deny?: readonly L[];
}

/** The given levels in target order — a declaration that cannot drift from it. */
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
   * (personal), by slug. The repo's copy wins a slug both define, with the
   * `cloud` flag on or off: the target order already puts repo first.
   */
  skills: {
    merge: "union",
    deny: ["policy"],
    order: targetOrder("policy", "repo", "personal"),
  },
  /**
   * Prompt templates: `<project>/.volli/commands` (project — `.volli` is
   * self-gitignored, so these are the project's local assets, not repo files)
   * and `<userData>/commands` (personal), by name. Today the project's copy
   * wins; under `cloud` the personal one does (the target order).
   */
  promptTemplates: {
    merge: "union",
    deny: ["policy"],
    flagOff: ["policy", "project", "personal"],
    cloud: targetOrder("policy", "personal", "project"),
  },
  /**
   * A skill's invocation mode: the project's rule, over the declaration in
   * the skill's own file — which is the definition itself rather than a
   * configured level, so it is the caller's fallback, not a level here.
   */
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
  { merge: ConfigMerge; deny?: readonly ConfigLevel[] } & (
    | { order: readonly ConfigLevel[] }
    | { flagOff: readonly ConfigLevel[]; cloud: readonly ConfigLevel[] }
  )
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
    "order" in declared ? declared.order : flag[0] === true ? declared.cloud : declared.flagOff;
  return {
    merge: declared.merge as SurfaceDeclaration<S>["merge"],
    order,
    ...("deny" in declared ? { deny: declared.deny } : {}),
  };
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
 * an earlier one with the same key. A key one of the plan's deny levels denies
 * is removed from that level and every level below it (a higher level may
 * still define it); deny lists from levels the plan does not name are ignored.
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
    if (plan.deny?.includes(level) !== true) continue;
    for (const key of deny[level] ?? []) byKey.delete(key);
  }
  return [...byKey.values()];
}
