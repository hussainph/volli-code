/** Effective values stay visible; reset is an explicit action in a small popover. */
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Button } from "@renderer/components/ui/button";

export function OverrideControl({
  label,
  inheritedValue,
  overridden,
  disabled = false,
  onRevert,
  children,
}: {
  label: string;
  inheritedValue: string;
  overridden: boolean;
  disabled?: boolean;
  onRevert(): void;
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      {overridden ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              aria-label={`Reset ${label} to the global value, ${inheritedValue}`}
            >
              <ArrowCounterClockwiseIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-2">
            <p className="px-2 py-2 text-ui text-muted-foreground">
              Global default: {inheritedValue}
            </p>
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onRevert}>
              <ArrowCounterClockwiseIcon />
              Revert to global default
            </Button>
          </PopoverContent>
        </Popover>
      ) : (
        <span aria-hidden className="size-5" />
      )}
    </>
  );
}
