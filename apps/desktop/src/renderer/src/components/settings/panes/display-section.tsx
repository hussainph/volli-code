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
 *
 * Cost visibility joins them because it is the same KIND of preference: what
 * this window puts on screen, app-wide, with no bearing on what the app does.
 * It is deliberately NOT in Settings → Telemetry, which configures the
 * developer OTLP export — a reader who went there to stop a dollar figure
 * appearing during a screen-share would be turning off an unrelated subsystem
 * and would still see the figure.
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
import { Switch } from "@renderer/components/ui/switch";
import { UI_SCALE_STEPS, useUiStore, type DiffPresentation } from "@renderer/stores/ui";

export function DisplaySection() {
  const uiScale = useUiStore((store) => store.uiScale);
  const setUiScale = useUiStore((store) => store.setUiScale);
  const diffPresentation = useUiStore((store) => store.diffPresentation);
  const setDiffPresentation = useUiStore((store) => store.setDiffPresentation);
  const costVisible = useUiStore((store) => store.costVisible);
  const setCostVisible = useUiStore((store) => store.setCostVisible);

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
      {/*
       * Stated as the POSITIVE, like General's project-switcher row: the flag
       * is what it says, and a switch reading "Hide cost" that is ON when the
       * number is absent is a double negative every reader has to unpick.
       *
       * The hint carries the one thing a reader could otherwise get wrong.
       * Someone turning this off is hiding a number from a shared screen, and
       * they must not walk away believing they also stopped Volli measuring —
       * the ledger keeps recording either way, which is what makes turning it
       * back on show a complete history rather than a gap.
       */}
      <PrefRow
        label="Show cost and token usage"
        htmlFor="cost-visible"
        hint={
          <>
            Shows what Sessions, Tickets and projects have cost, in the rails. Turning this off
            hides those readouts only — usage is still recorded, so switching it back on shows the
            full history.
          </>
        }
      >
        <Switch id="cost-visible" checked={costVisible} onCheckedChange={setCostVisible} />
      </PrefRow>
    </PrefSection>
  );
}
