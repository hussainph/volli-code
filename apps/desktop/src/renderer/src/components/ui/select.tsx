"use client";

import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { Select as SelectPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";
import { FIELD_INVALID } from "@renderer/components/ui/field-classes";
import {
  MENU_INDICATOR,
  MENU_INDICATOR_MARK,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_INDICATED,
  MENU_ROW_STATE,
  MENU_SEPARATOR,
  MENU_SURFACE,
  MENU_SURFACE_ANCHORED,
  MENU_SURFACE_FADE,
  MENU_SURFACE_PAD,
} from "@renderer/components/ui/menu-classes";

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-2 rounded-control border border-border bg-transparent px-4 text-ui whitespace-nowrap shadow-raised transition-[color,border-color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground data-[size=default]:h-7 data-[size=sm]:h-6 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 dark:bg-border/30 dark:hover:bg-border/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground",
        // No caret speaks for a closed trigger, so unlike the text fields it
        // keeps the keyboard ring — button.tsx's quiet recipe, not a field one.
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/45",
        FIELD_INVALID,
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <CaretDownIcon className="size-3.5 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          MENU_SURFACE,
          MENU_SURFACE_FADE,
          "relative overflow-x-hidden overflow-y-auto",
          // Everything below the fade is popper-only, and not as a style
          // choice: `SelectItemAlignedPosition` publishes NONE of it. It sets
          // no `data-side`, and both `--radix-select-content-transform-origin`
          // and `--radix-select-content-available-height` are written by
          // `SelectPopperPosition` alone. Applied unconditionally, the origin
          // resolves to an undefined var, is invalid at computed-value time,
          // and silently falls back to `50% 50%` — an item-aligned select that
          // zooms out of its own middle while sitting on the trigger. The
          // height clamp fails the same way (item-aligned carries an inline
          // `maxHeight` instead). Item-aligned therefore fades and does not
          // zoom: the honest motion for a surface with no published anchor.
          position === "popper" &&
            "max-h-(--radix-select-content-available-height) origin-(--radix-select-content-transform-origin) data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          position === "popper" && MENU_SURFACE_ANCHORED,
          className,
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            MENU_SURFACE_PAD,
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(MENU_LABEL, className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        MENU_ROW,
        MENU_ROW_STATE,
        MENU_ROW_INDICATED,
        "w-full *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      {/* Before the text, not after it: the `*:[span]:last:` rule above dresses
          the ItemText's span, which only stays last while the indicator leads. */}
      <span data-slot="select-item-indicator" className={MENU_INDICATOR}>
        <SelectPrimitive.ItemIndicator>
          <CheckIcon weight="bold" className={MENU_INDICATOR_MARK} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn(MENU_SEPARATOR, "pointer-events-none", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <CaretUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <CaretDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
