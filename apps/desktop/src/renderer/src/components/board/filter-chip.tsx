import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

interface FilterChipOption {
  value: string;
  label: string;
}

interface FilterChipProps {
  label: string;
  options: readonly FilterChipOption[];
  selected: readonly string[];
  onToggle(value: string): void;
}

/** Generic multi-select facet chip: a dropdown of checkbox options that stays open per-toggle. */
export function FilterChip({ label, options, selected, onToggle }: FilterChipProps) {
  const active = selected.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "h-7 rounded-full border border-border px-2.5 text-xs text-muted-foreground",
            active && "border-[#3a3a3a] text-foreground",
          )}
        >
          {active ? `${label} · ${selected.length}` : label}
          <CaretDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.includes(option.value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggle(option.value)}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
