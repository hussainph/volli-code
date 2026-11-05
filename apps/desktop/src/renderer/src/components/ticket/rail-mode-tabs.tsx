/** Inspector placement around the locked, shared in-page view switcher. */
import { ViewSwitcher, type ViewSwitcherTab } from "@renderer/components/ui/view-switcher";
import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { cn } from "@renderer/lib/utils";
export { viewSwitcherMotion as railTabMotion } from "@renderer/components/ui/view-switcher";
export type { ViewSwitcherMotion as RailTabMotion } from "@renderer/components/ui/view-switcher";
export type RailModeTab<K extends string> = ViewSwitcherTab<K>;
export interface RailModeTabsProps<K extends string> {
  modes: readonly RailModeTab<K>[];
  active: K;
  label: string;
  idPrefix: string;
  onSelect(next: K): void;
}
export function RailModeTabs<K extends string>(props: RailModeTabsProps<K>) {
  return (
    <div className={cn("sticky top-0 z-20 shrink-0 pt-4 pb-4", RAIL_PANEL_INSET)}>
      <ViewSwitcher {...props} />
    </div>
  );
}
