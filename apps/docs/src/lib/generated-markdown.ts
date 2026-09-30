import {
  AGENT_CAPABILITY_BASELINE,
  AGENT_CAPABILITY_CHANGES,
  AGENT_ERROR_CODES,
  ERROR_RECOVERY,
  VERB_REGISTRY,
  type VerbEffects,
  type VerbEntry,
} from "@volli/shared";

type EffectVerb = VerbEntry & { effects: VerbEffects };
const effectVerbs = (VERB_REGISTRY as readonly VerbEntry[]).filter(
  (verb): verb is EffectVerb => verb.listed && verb.effects !== undefined,
);

const bullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");

/** Expand data-backed components so copied pages contain the same facts as HTML. */
export function expandGeneratedMarkdown(body: string): string {
  return body
    .replace(/<AgentVerbEffects\s*\/>/g, () =>
      effectVerbs
        .map((verb) => {
          const effects = verb.effects;
          return [
            `### \`${verb.key}\``,
            ...(effects.when ? [`Applies when \`${effects.when}\` is supplied.`] : []),
            ...(verb.options.some((option) => option.name === "--dry-run")
              ? ["**Preview:** supports `--dry-run`."]
              : []),
            "**Durable writes**",
            effects.durableWrites.length > 0
              ? bullets(effects.durableWrites.map((write) => write.summary))
              : "None.",
            "**What a person sees**",
            bullets(effects.humanVisible),
            "**Does not do**",
            bullets(effects.nonEffects),
          ].join("\n\n");
        })
        .join("\n\n"),
    )
    .replace(/<AgentErrorRecovery\s*\/>/g, () =>
      AGENT_ERROR_CODES.map((code) => {
        const guidance = ERROR_RECOVERY[code];
        return [
          `### \`${code}\``,
          guidance.why,
          `**Safe next action:** ${guidance.next ?? "Unknown. Inspect current durable state before deciding whether a retry is safe."}`,
        ].join("\n\n");
      }).join("\n\n"),
    )
    .replace(/<AgentCapabilityChanges\s*\/>/g, () => {
      const categories = ["added", "changed", "fixed", "removed"] as const;
      return [
        `The record starts at source revision \`${AGENT_CAPABILITY_BASELINE}\`. It does not backfill canaries or v0.1.0.`,
        ...AGENT_CAPABILITY_CHANGES.map((change) =>
          [
            `## ${change.build} (after ${change.baseline})`,
            ...categories.flatMap((category) => [
              `### ${category[0]!.toUpperCase()}${category.slice(1)}`,
              change[category].length > 0 ? bullets(change[category]) : "None in this record.",
            ]),
          ].join("\n\n"),
        ),
      ].join("\n\n");
    });
}
