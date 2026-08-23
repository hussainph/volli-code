/**
 * The Display block on Settings → Appearance: zoom and diff layout.
 *
 * Both already existed and both already persisted app-wide — zoom was reachable
 * only through ⌘+/⌘−/⌘0 and the View menu, and the diff layout only from a
 * control on the diff surface itself. Neither had a settings home, so neither
 * was discoverable and neither was checkable.
 *
 * Zoom is a `Select` over `UI_SCALE_STEPS` rather than a slider, because the
 * ladder is exactly why the steps exist: every rung is a layout-tested value,
 * and a continuous control would let someone land between two of them.
 *
 * Diff layout was a `Segmented` in the prototype and is a `Select` here. Two
 * options that are not a mode and carry no icons do not earn two pills — see
 * the pill budget in `kit/index.ts`.
 */
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";

import { CONTROL_W, PrefRow, PrefSection } from "@renderer/components/settings/kit";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { UI_SCALE_STEPS, useUiStore, type DiffPresentation } from "@renderer/stores/ui";

export function DisplaySection() {
  const uiScale = useUiStore((store) => store.uiScale);
  const setUiScale = useUiStore((store) => store.setUiScale);
  const diffPresentation = useUiStore((store) => store.diffPresentation);
  const setDiffPresentation = useUiStore((store) => store.setDiffPresentation);

  return (
    <PrefSection title="Display" icon={MonitorIcon}>
      <PrefRow label="Zoom" htmlFor="ui-zoom">
        <Select value={String(uiScale)} onValueChange={(next) => setUiScale(Number(next))}>
          <SelectTrigger id="ui-zoom" className={CONTROL_W.sm}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UI_SCALE_STEPS.map((step) => (
              <SelectItem key={step} value={String(step)}>
                {Math.round(step * 100)}%
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PrefRow>
      <PrefRow label="Diff layout" htmlFor="diff-layout">
        <Select
          value={diffPresentation}
          onValueChange={(next) => setDiffPresentation(next as DiffPresentation)}
        >
          <SelectTrigger id="diff-layout" className={CONTROL_W.md}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inline">Inline</SelectItem>
            <SelectItem value="side-by-side">Side by side</SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>
    </PrefSection>
  );
}
