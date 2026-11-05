/** Inspector pages share the native segmented control; only its thumb moves. */
import { type IconComponent } from "@renderer/components/ui/icon";

import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { Segmented } from "@renderer/components/ui/segmented";
import { cn } from "@renderer/lib/utils";

export interface RailModeTab<K extends string> {
  key: K;
  label: string;
  icon: IconComponent;
}

export interface RailModeTabsProps<K extends string> {
  modes: readonly RailModeTab<K>[];
  active: K;
  label: string;
  idPrefix: string;
  onSelect(next: K): void;
}

export function RailModeTabs<K extends string>({
  modes,
  active,
  label,
  idPrefix,
  onSelect,
}: RailModeTabsProps<K>) {
  return (
    <div className={cn("sticky top-0 z-20 flex shrink-0 justify-center py-3", RAIL_PANEL_INSET)}>
      <Segmented
        ariaLabel={label}
        tabIdPrefix={idPrefix}
        value={active}
        options={modes}
        iconOnly
        onChange={onSelect}
      />
    </div>
  );
}
