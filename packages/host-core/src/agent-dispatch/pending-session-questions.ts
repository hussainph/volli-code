import { readInteractionPrompts, redactPayloadSecrets } from "@volli/shared";
import type { SessionProjection } from "@volli/shared";

/**
 * Pending questions, independent of the transcript window. Normalize legacy
 * flat asks through the shared reader so every question on a card survives.
 * Only presentation fields cross the CLI door, never native correlation or
 * credential metadata. Scrub before rendering, without truncating or flattening
 * multiline prose; the CLI renderer owns its terminal-safe trust envelope.
 */
export function pendingSessionQuestions(projection: SessionProjection | undefined) {
  return (projection?.interactions.active ?? [])
    .filter((interaction) => interaction.kind === "question")
    .map((interaction) => ({
      id: redactPayloadSecrets(interaction.id),
      title: redactPayloadSecrets(interaction.title),
      detail: interaction.detail === null ? null : redactPayloadSecrets(interaction.detail),
      prompts: readInteractionPrompts(interaction).map((prompt) => ({
        id: redactPayloadSecrets(prompt.id),
        label: redactPayloadSecrets(prompt.label),
        detail: prompt.detail === null ? null : redactPayloadSecrets(prompt.detail),
        options: prompt.options.map((option) => ({
          id: redactPayloadSecrets(option.id),
          label: redactPayloadSecrets(option.label),
          description:
            option.description === null ? null : redactPayloadSecrets(option.description),
        })),
        multiple: prompt.multiple,
        custom: prompt.custom,
      })),
    }));
}
