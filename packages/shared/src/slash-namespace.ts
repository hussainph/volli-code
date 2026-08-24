/**
 * One discoverable `/` namespace: every open source contributes candidates,
 * and one resolver gives each candidate a unique, spellable invocation name.
 *
 * Verbs reserve their names first. The source registry then runs in declaration
 * order, currently commands before skills, preserving the historical
 * template-over-skill precedence without filtering either loser from the
 * surface. A collision renames the later candidate by source; an unspellable
 * on-disk basename is normalized under the same qualifier rather than offered
 * as a row that submit can never resolve.
 *
 * The source registry is the extension seam for future prompt-template, MCP and
 * plugin supplies. The resolver and its consumers iterate one entry list; a new
 * source does not add another namespace array, ranking pass or picker concat.
 */
import { COMPOSER_VERBS } from "./composer-verb";
import type { PromptTemplate } from "./prompt-template";
import { isSlashInvocationName } from "./slash-name";
import type { SkillReference } from "./skill";

/** The qualifier a template wears when it cannot keep its bare name. */
export const COMMAND_QUALIFIER = "command";

/** The qualifier a skill wears when it cannot keep its bare name. */
export const SKILL_QUALIFIER = "skill";

/** What a resolved invocation delivers at submit. */
export type SlashTarget =
  | { readonly kind: "command"; readonly template: PromptTemplate }
  | { readonly kind: "skill"; readonly skill: SkillReference };

/** Every source currently contributing rows to the slash surface. */
export type SlashSourceKind = SlashTarget["kind"];

/** What already owned a name when a later entry had to move. */
export type SlashOwner = "verb" | SlashSourceKind;

/** Raw supplies; their tier merges happen before this renderer-facing seam. */
export interface SlashNamespaceInput {
  readonly templates: readonly PromptTemplate[];
  readonly skills: readonly SkillReference[];
}

type SlashCandidate =
  | {
      readonly kind: "command";
      readonly bareName: string;
      readonly description: string;
      readonly target: Extract<SlashTarget, { kind: "command" }>;
    }
  | {
      readonly kind: "skill";
      readonly bareName: string;
      readonly description: string;
      readonly target: Extract<SlashTarget, { kind: "skill" }>;
    };

interface SlashSourceAdapter {
  readonly qualifier: string;
  /** UI group copy travels with the source rather than living in a parallel switch. */
  readonly heading: string;
  candidates(input: SlashNamespaceInput): readonly SlashCandidate[];
}

type SlashSourceSpec<Kind extends SlashSourceKind> = Omit<SlashSourceAdapter, "candidates"> & {
  candidates(input: SlashNamespaceInput): readonly Extract<SlashCandidate, { kind: Kind }>[];
};

function slashSource<const Kind extends SlashSourceKind>(
  kind: Kind,
  spec: SlashSourceSpec<Kind>,
): readonly [Kind, SlashSourceAdapter] {
  return [kind, spec];
}

/**
 * One ordered registry of open slash sources.
 *
 * A future source declares its qualifier, heading and candidate adapter here.
 * Consumers iterate the resulting namespace entries and do not maintain a
 * matching list of source arrays.
 */
const SLASH_SOURCE_ENTRIES = [
  slashSource("command", {
    qualifier: COMMAND_QUALIFIER,
    heading: "Commands",
    candidates: ({ templates }) =>
      templates.map((template) => ({
        kind: "command",
        bareName: template.name,
        description: template.description,
        target: { kind: "command", template },
      })),
  }),
  slashSource("skill", {
    qualifier: SKILL_QUALIFIER,
    heading: "Skills",
    candidates: ({ skills }) =>
      skills
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((skill) => ({
          kind: "skill",
          bareName: skill.name,
          description: skill.description,
          target: { kind: "skill", skill },
        })),
  }),
] as const;

/** The source adapters as the repo's standard immutable keyed registry shape. */
export const SLASH_SOURCE_REGISTRY: ReadonlyMap<SlashSourceKind, SlashSourceAdapter> = new Map<
  SlashSourceKind,
  SlashSourceAdapter
>(SLASH_SOURCE_ENTRIES);

/** One resolved row in the flat namespace. */
export interface SlashName {
  readonly kind: SlashSourceKind;
  /** What is typed after `/`; always spellable and unique in this namespace. */
  readonly name: string;
  /** The original file or directory name. */
  readonly bareName: string;
  readonly description: string;
  readonly target: SlashTarget;
  /** Registry order, so ranking can keep keyboard order aligned with UI groups. */
  readonly sourceOrder: number;
  readonly heading: string;
  /** The owner that took this row's preferred name, if any. */
  readonly shadowedBy: SlashOwner | null;
  /** True when the original name itself could not round-trip through the grammar. */
  readonly syntaxQualified: boolean;
}

/** Every non-verb slash row, in source precedence order. */
export interface SlashNamespace {
  readonly entries: readonly SlashName[];
}

/** A safe, legible stem for an on-disk name the slash grammar cannot spell. */
function safeStem(value: string): string {
  const stem = value.replace(/[^A-Za-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
  return stem === "" ? "item" : stem;
}

/** Reserve `base`, then `base1`, `base2`, … until one is free. */
function reserve(owners: Map<string, SlashOwner>, base: string, owner: SlashOwner): string {
  let candidate = base;
  let suffix = 1;
  while (owners.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  owners.set(candidate, owner);
  return candidate;
}

/**
 * Resolve every source through one owner map.
 *
 * The map stores WHO claimed each resolved name, not merely whether it is
 * taken. That keeps `shadowedBy` truthful for duplicate/unmerged input and for
 * generated aliases that collide with a later item of the same source.
 */
export function resolveSlashNamespace(input: SlashNamespaceInput): SlashNamespace {
  const owners = new Map<string, SlashOwner>(
    COMPOSER_VERBS.map((verb) => [verb.name, "verb" as const]),
  );
  const entries: SlashName[] = [];

  for (const [sourceOrder, [kind, source]] of SLASH_SOURCE_ENTRIES.entries()) {
    for (const candidate of source.candidates(input)) {
      const syntaxQualified = !isSlashInvocationName(candidate.bareName);
      if (syntaxQualified) {
        const base = `${source.qualifier}:${safeStem(candidate.bareName)}`;
        const shadowedBy = owners.get(base) ?? null;
        entries.push({
          ...candidate,
          name: reserve(owners, base, kind),
          sourceOrder,
          heading: source.heading,
          shadowedBy,
          syntaxQualified: true,
        });
        continue;
      }

      const shadowedBy = owners.get(candidate.bareName) ?? null;
      entries.push({
        ...candidate,
        name:
          shadowedBy === null
            ? reserve(owners, candidate.bareName, kind)
            : reserve(owners, `${source.qualifier}:${candidate.bareName}`, kind),
        sourceOrder,
        heading: source.heading,
        shadowedBy,
        syntaxQualified: false,
      });
    }
  }

  return { entries };
}

/** The namespace as submit's resolved-name lookup. */
export function slashTargets(namespace: SlashNamespace): ReadonlyMap<string, SlashTarget> {
  return new Map(namespace.entries.map((entry) => [entry.name, entry.target]));
}
