import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { ColumnsIcon } from "@phosphor-icons/react/dist/csr/Columns";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
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
      <PrefRow label="Zoom" icon={MonitorIcon} description="Scale the app's text and controls.">
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
            <PlusIcon />
          </Button>
        </ButtonGroup>
      </PrefRow>
      <PrefRow
        label="Diff layout"
        icon={ColumnsIcon}
        description="Read changes inline or in two columns."
      >
        <ButtonGroup aria-label="Diff layout">
          {(
            [
              { key: "inline", label: "Inline", icon: CodeIcon },
              { key: "side-by-side", label: "Side by side", icon: ColumnsIcon },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant={diffPresentation === key ? "secondary" : "outline"}
                  aria-label={label}
                  aria-pressed={diffPresentation === key}
                  onClick={() => setDiffPresentation(key)}
                >
                  <Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </ButtonGroup>
      </PrefRow>
      <PrefRow
        label="Show cost and token usage"
        icon={CurrencyDollarIcon}
        htmlFor="cost-visible"
        description="Show usage in the rails; recording continues when hidden."
      >
        <Switch id="cost-visible" checked={costVisible} onCheckedChange={setCostVisible} />
      </PrefRow>
    </PrefSection>
  );
}
