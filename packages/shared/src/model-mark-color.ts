/**
 * The tints the model marks are drawn in — one palette, in `@volli/shared`
 * where CLAUDE.md keeps TypeScript-consumable domain colors (the project-tile
 * and tag palettes are the precedent).
 *
 * They are here rather than composed from generated theme tokens because they
 * are the one thing a token cannot express: a vendor's identity. A mark tinted
 * with `--primary` would be Volli's colour on someone else's logo, and a mark
 * tinted with `--muted-foreground` would make a row of them one grey smear —
 * which is the reason the marks exist at all. Everything ELSE about a mark —
 * the fallback lettermark's fill and ink, its box, the row it sits in — is
 * generated tokens, and stays that way.
 *
 * The values are low-chroma and brand-adjacent rather than the vendors' own
 * saturated hex: they must sit legibly on an arbitrary canvas in both
 * appearances, and none of them may read as Volli's own ember accent. That is
 * the rule `harness-identity.tsx` follows for harness marks; this is the same
 * rule for model marks, promoted out of the renderer so the next palette is
 * added beside this one instead of inside a component.
 *
 * Keys are a model FAMILY (read off a model's id and label) or a provider id,
 * and the two spaces deliberately share one table: `anthropic` the account and
 * `claude` the family are the same colour, because a person scanning a column
 * is looking for one thing and should find it under either name.
 */
export const MODEL_MARK_TINTS = {
  /** Families. */
  claude: "#C08A62",
  openai: "#6E93A8",
  gemini: "#8B90C9",
  deepseek: "#7A9AB8",
  mistral: "#B89A6A",
  llama: "#7C93B8",
  qwen: "#B08A7A",
  /** Providers with a mark of their own. */
  google: "#8B90C9",
  huggingface: "#C0A860",
  cloudflare: "#C09060",
  xiaomi: "#C08A62",
  openrouter: "#8BA3B0",
  /**
   * The neutral, for marks every vendor renders monochrome (Copilot's goggles,
   * Vercel's triangle, Cursor's cube). A tint invented for them would be a
   * colour the vendor does not have.
   */
  monochrome: "#A8ADB6",
} as const;

export type ModelMarkTintKey = keyof typeof MODEL_MARK_TINTS;
