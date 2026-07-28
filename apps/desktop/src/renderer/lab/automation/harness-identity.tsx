/**
 * A harness as a thing you recognise rather than a word you read.
 *
 * The problem this solves: in a product whose whole claim is BYO-harness,
 * *which agent will run* is a category distinction — but across the automations
 * surfaces it was rendering as grey body text in five different places, at the
 * same weight as a column name. Mid-drag, with a palette open and a card under
 * your hand, "Claude Code" and "Codex" are two grey words you have to actually
 * read; a mark you can catch in peripheral vision is worth more than the label.
 *
 * Two deliberate choices:
 *
 * 1. **A glyph carries the identity, colour only reinforces it.** The marks are
 *    legible with colour removed, which matters because these appear on a
 *    dragged card, in a menu, and inside a mono chip — three places where a
 *    colour-only signal would be the whole signal.
 *
 * 2. **The tints are NOT `PROJECT_COLORS`.** Reusing that palette was the first
 *    instinct and it is a semantic collision: a swatch in this app already means
 *    "which project", and a rail tile sitting next to a harness dot in the same
 *    ochre would be asserting a relationship that does not exist. These are a
 *    separate, deliberately lower-chroma band — present enough to group by,
 *    quiet enough never to compete with the ember accent, which stays the app's
 *    own colour and belongs to no harness.
 *
 * Lab-only for now. If this survives the design review it belongs in
 * `@volli/shared` next to `harnessLabel`, so every surface agrees.
 */
import { AsteriskIcon } from "@phosphor-icons/react/dist/csr/Asterisk";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import type { Icon } from "@phosphor-icons/react/dist/lib/types";
import { harnessLabel, type HarnessId } from "@volli/shared";

import { cn } from "@renderer/lib/utils";

export interface HarnessIdentity {
  label: string;
  Mark: Icon;
  /** Low-chroma tint, distinct from PROJECT_COLORS. See the module doc. */
  tint: string;
}

export const HARNESS_IDENTITY: Record<HarnessId, HarnessIdentity> = {
  // The asterisk is Claude's own mark; borrowing it means the default harness
  // is the one nobody has to learn.
  "claude-code": { label: harnessLabel("claude-code"), Mark: AsteriskIcon, tint: "#C08A62" },
  codex: { label: harnessLabel("codex"), Mark: CubeIcon, tint: "#6E93A8" },
  opencode: { label: harnessLabel("opencode"), Mark: StackIcon, tint: "#8B7BA8" },
};

/**
 * The mark alone. `aria-hidden` by default because it is nearly always adjacent
 * to the label it stands for — two accessible names for one fact is noise in a
 * screen reader, and the label is the better of the two.
 */
export function HarnessMark({
  harnessId,
  className,
  labelled = false,
}: {
  harnessId: HarnessId;
  className?: string;
  labelled?: boolean;
}) {
  const { Mark, tint, label } = HARNESS_IDENTITY[harnessId];
  return (
    <Mark
      weight="bold"
      aria-hidden={!labelled}
      aria-label={labelled ? label : undefined}
      style={{ color: tint }}
      className={cn("size-3 shrink-0", className)}
    />
  );
}

/**
 * Mark + name, the standard pairing. `muted` is for the many places this sits
 * as secondary metadata beside something more important — the mark keeps its
 * tint there, because the tint is the part that survives not being read.
 */
export function HarnessTag({
  harnessId,
  muted = true,
  className,
}: {
  harnessId: HarnessId;
  muted?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
        muted ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      <HarnessMark harnessId={harnessId} />
      {HARNESS_IDENTITY[harnessId].label}
    </span>
  );
}
