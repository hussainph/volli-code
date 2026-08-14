import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";

import { cn } from "@renderer/lib/utils";
import {
  MENU_EMPTY,
  MENU_LABEL_CMDK,
  MENU_ROW,
  MENU_ROW_STATE_CMDK,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  MENU_SURFACE_PAD,
} from "@renderer/components/ui/menu-classes";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-container bg-popover text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    // One height for the row and the field inside it. Stock shipped a 40px
    // input inside a 36px wrapper — the field was taller than the box clipping
    // it, so its own padding decided where the text sat.
    <div data-slot="command-input-wrapper" className="flex h-8 items-center gap-2 border-b px-4">
      <MagnifyingGlassIcon className="size-3.5 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-8 w-full bg-transparent text-ui outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto", className)}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn(MENU_EMPTY, className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        MENU_SURFACE_PAD,
        MENU_LABEL_CMDK,
        "overflow-hidden text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn(MENU_SEPARATOR, className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(MENU_ROW, MENU_ROW_STATE_CMDK, className)}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="command-shortcut" className={cn(MENU_SHORTCUT, className)} {...props} />;
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
