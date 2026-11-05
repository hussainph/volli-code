import {
  MonitorIcon,
  MinusIcon,
  AddIcon,
  CodeIcon,
  ColumnsIcon,
  CostIcon,
} from "@renderer/components/ui/icon";

import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import { Segmented } from "@renderer/components/ui/segmented";
import { Switch } from "@renderer/components/ui/switch";
import { UI_SCALE_STEPS, useUiStore } from "@renderer/stores/ui";

export function DisplaySection() {
  const uiScale = useUiStore((s) => s.uiScale),
    setUiScale = useUiStore((s) => s.setUiScale);
  const diffPresentation = useUiStore((s) => s.diffPresentation),
    setDiffPresentation = useUiStore((s) => s.setDiffPresentation);
  const costVisible = useUiStore((s) => s.costVisible),
    setCostVisible = useUiStore((s) => s.setCostVisible);
  const index = UI_SCALE_STEPS.findIndex((step) => step === uiScale);
  return (
    <PrefSection title="Display" icon={MonitorIcon}>
      <PrefRow label="Zoom" icon={MonitorIcon}>
        <ButtonGroup aria-label="Zoom">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Decrease zoom"
            disabled={index <= 0}
            onClick={() => setUiScale(UI_SCALE_STEPS[index - 1])}
          >
            <MinusIcon />
          </Button>
          <output className="grid min-w-16 place-items-center px-2 font-mono text-ui tabular-nums">
            {Math.round(uiScale * 100)}%
          </output>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Increase zoom"
            disabled={index >= UI_SCALE_STEPS.length - 1}
            onClick={() => setUiScale(UI_SCALE_STEPS[index + 1])}
          >
            <AddIcon />
          </Button>
        </ButtonGroup>
      </PrefRow>
      <PrefRow label="Diff layout" icon={ColumnsIcon}>
        <Segmented
          ariaLabel="Diff layout"
          iconOnly
          value={diffPresentation}
          onChange={setDiffPresentation}
          options={[
            { key: "inline", label: "Inline", icon: CodeIcon },
            { key: "side-by-side", label: "Side by side", icon: ColumnsIcon },
          ]}
        />
      </PrefRow>
      <PrefRow label="Show cost and token usage" icon={CostIcon} htmlFor="cost-visible">
        <Switch id="cost-visible" checked={costVisible} onCheckedChange={setCostVisible} />
      </PrefRow>
    </PrefSection>
  );
}
