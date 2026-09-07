/**
 * What this Session is governed by, as a chip in the composer footer.
 *
 * It sits with the model and the effort pills because it is the same KIND of
 * thing they are — a standing fact about the Session, read rather than pressed —
 * and unlike them it is not a control at all: authority is app-owned state that
 * the surface being governed cannot edit, which is `settings/configure/
 * authority-pane.tsx`'s whole non-negotiable. So this is a chip and never a
 * picker, and pressing it does nothing because there is nothing here to choose.
 *
 * IT READS THE ATTACHMENT, NEVER THE PROJECT (VC-285). The text comes from the
 * Snapshot saved against the live attachment, by way of `authorityChip` in
 * @volli/session-presentation. A Configure edit made while this Session runs
 * leaves this chip exactly where it is, which is the truth: policy is pinned
 * when an attachment opens and re-resolved at the next one.
 *
 * THE WHOLE SENTENCE IS VISIBLE, on purpose. The finding this ticket answers was
 * that the meaning of a posture lived in an information popover; a chip that
 * showed "Observe" and hid "policy record · pack dca89a93" behind a hover would
 * be the same failure in a smaller box. The visible sentence includes
 * “Authority” too; a shield alone is not a label.
 */
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import type { AuthorityChipView } from "@volli/session-presentation";

import { Badge } from "@renderer/components/ui/badge";

export function AuthorityChip({ chip }: { chip: AuthorityChipView | null }) {
  // Nothing attached is nothing to say. An empty chip would claim a Session was
  // running under something before it had started running at all.
  if (chip === null) return null;
  return (
    <Badge
      data-testid="session-authority-chip"
      data-authority={chip.state}
      // No fill: the footer's resting chrome is quiet, and a filled chip here
      // would out-shout the model pill beside it — this qualifies the Session,
      // it does not alarm about it.
      //
      // It may shrink, against the primitive's own `shrink-0`, but the sentence
      // wraps rather than truncates at the chat pane's narrow floor. Outcome and
      // pack version are both required visible facts, not tooltip detail.
      className="min-w-0 max-w-full shrink whitespace-normal border-transparent"
    >
      <ShieldCheckIcon aria-hidden className="size-3 shrink-0" weight="bold" />
      <span className="min-w-0">{chip.summary}</span>
    </Badge>
  );
}
