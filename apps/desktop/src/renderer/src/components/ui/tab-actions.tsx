import * as React from "react";
import { ChevronDownIcon, type IconComponent } from "./icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";
import { ContextMenuItem } from "./context-menu";

export interface TabAction {
  label: string;
  icon: IconComponent;
  run(pointer?: boolean): void;
  destructive?: boolean;
}
export const TabActionsContext = React.createContext<readonly TabAction[]>([]);

/** Shared extra actions in the tab's existing context menu. */
export function TabContextActions() {
  return React.useContext(TabActionsContext).map((action) => (
    <ContextMenuItem
      key={action.label}
      icon={action.icon}
      variant={action.destructive ? "destructive" : "default"}
      onSelect={() => action.run()}
    >
      {action.label}
    </ContextMenuItem>
  ));
}

/** Pointer-down is claimed before a sortable tab can capture the gesture. */
export function TabActionDropdown({
  label,
  actions,
  children,
}: {
  label: string;
  actions: readonly TabAction[];
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const pointer = React.useRef(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="tab-menu"
          aria-label={`Actions for ${label}`}
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 hover:bg-border hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) event.stopPropagation();
          }}
        >
          <ChevronDownIcon className="size-3" strokeWidth={2.25} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onClickCapture={() => setOpen(false)}
        onPointerDownCapture={() => {
          pointer.current = true;
        }}
        onKeyDownCapture={() => {
          pointer.current = false;
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            variant={action.destructive ? "destructive" : "default"}
            onSelect={() => action.run(pointer.current)}
          >
            <action.icon className="size-4" />
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TabActionScope({
  actions,
  children,
}: {
  actions: readonly TabAction[];
  children: React.ReactNode;
}) {
  return <TabActionsContext.Provider value={actions}>{children}</TabActionsContext.Provider>;
}
