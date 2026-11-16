import * as React from "react";
import { ChevronDownIcon, CloseIcon, type IconComponent } from "./icon";
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
  /**
   * `pointer` says whether a pointer chose it; `trigger` is the tab's menu
   * button when the dropdown ran it (none from the right-click menu), for an
   * action that moves the tab and must place focus after it.
   */
  run(pointer?: boolean, trigger?: HTMLElement | null): void;
  destructive?: boolean;
}
export const TabActionsContext = React.createContext<readonly TabAction[]>([]);
/**
 * Whether closing this tab is destructive: the tab kind's own answer, set once
 * by the strip that knows the kind (VC-1229). The chevron dropdown and the
 * right-click menu both read it, so Close cannot be red in one and plain in
 * the other. Plain unless a kind says otherwise: destructive ink is the
 * exception (`docs/DESIGN.md`), earned by closing a tab that ends work.
 */
export const TabCloseDestructiveContext = React.createContext(false);
/** Rich member controls dismiss only after their own activation has run. */
export const TabDropdownDismissContext = React.createContext<() => void>(() => {});

/** The one Close row every tab menu draws: same label, glyph and ink everywhere. */
export function closeTabAction(run: (pointer?: boolean) => void, destructive: boolean): TabAction {
  return { label: "Close", icon: CloseIcon, run, destructive };
}

function TabContextActionItem({ action }: { action: TabAction }) {
  return (
    <ContextMenuItem
      icon={action.icon}
      variant={action.destructive ? "destructive" : "default"}
      onSelect={() => action.run()}
    >
      {action.label}
    </ContextMenuItem>
  );
}

/** Shared extra actions in the tab's existing context menu. */
export function TabContextActions() {
  return React.useContext(TabActionsContext).map((action) => (
    <TabContextActionItem key={action.label} action={action} />
  ));
}

/** The tab's Close in its context menu, with the ink its chevron dropdown uses. */
export function TabContextClose({ onClose }: { onClose(): void }) {
  const destructive = React.useContext(TabCloseDestructiveContext);
  return <TabContextActionItem action={closeTabAction(onClose, destructive)} />;
}

/** Pointer-down is claimed before a sortable tab can capture the gesture. */
export function TabActionDropdown({
  label,
  actions,
  children,
  onOpenChange,
}: {
  label: string;
  actions: readonly TabAction[];
  children?: React.ReactNode;
  onOpenChange?(open: boolean): void;
}) {
  const [open, setOpen] = React.useState(false);
  const pointer = React.useRef(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const changeOpen = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const dismiss = React.useCallback(() => changeOpen(false), [changeOpen]);
  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild>
        <button
          ref={trigger}
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
        onPointerDownCapture={() => {
          pointer.current = true;
        }}
        onKeyDownCapture={() => {
          pointer.current = false;
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <TabDropdownDismissContext.Provider value={dismiss}>
          {children}
        </TabDropdownDismissContext.Provider>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            variant={action.destructive ? "destructive" : "default"}
            onSelect={() => action.run(pointer.current, trigger.current)}
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
  closeDestructive = false,
  children,
}: {
  actions: readonly TabAction[];
  /** See {@link TabCloseDestructiveContext}. */
  closeDestructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TabActionsContext.Provider value={actions}>
      <TabCloseDestructiveContext.Provider value={closeDestructive}>
        {children}
      </TabCloseDestructiveContext.Provider>
    </TabActionsContext.Provider>
  );
}
