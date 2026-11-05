"use client";
import { GlassSurface } from "./surface";

import * as React from "react";
import { useControlShape, type ControlShape } from "./control-shape";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CheckIcon,
  UnfoldIcon,
} from "@renderer/components/ui/icon";

import { Select as SelectPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";
import { MotionOriginRoot, useMotionOriginProps } from "./motion-origin";
import { FIELD_INVALID } from "@renderer/components/ui/field-classes";
import {
  MENU_INDICATOR,
  MENU_INDICATOR_MARK,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_STATE,
  MENU_SEPARATOR,
  MENU_SURFACE,
  MENU_SURFACE_ANCHORED,
  MENU_SURFACE_FADE,
  MENU_SURFACE_PAD,
} from "@renderer/components/ui/menu-classes";

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return (
    <MotionOriginRoot scope="select" {...props}>
      {(motion) => <SelectPrimitive.Root data-slot="select" {...props} {...motion} />}
    </MotionOriginRoot>
  );
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
  variant = "regular",
  shape = "auto",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
  variant?: "regular" | "inspector";
  shape?: ControlShape;
}) {
  const motion = useMotionOriginProps("select", props);
  const shapeProps = useControlShape(shape, size, "popup");
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      {...shapeProps}
      className={cn(
        "flex w-fit items-center justify-between gap-1 rounded-native-control border border-border-strong control-material bg-card px-control-pad-default pr-2 text-ui whitespace-nowrap shadow-control hover:shadow-control-hover active:shadow-control-pressed transition-[color,border-color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground data-[size=default]:h-control-default data-[size=sm]:h-control-sm data-[size=sm]:px-1 data-[size=sm]:leading-4 [[data-slot=button-group][data-orientation=horizontal]_&]:h-auto [[data-slot=button-group][data-orientation=horizontal]_&]:self-stretch *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 hover:bg-accent hover:[--control-fill:var(--accent)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground",
        // No caret speaks for a closed trigger, so unlike the text fields it
        // keeps the keyboard ring — button.tsx's quiet recipe, not a field one.
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
        FIELD_INVALID,
        variant === "inspector" &&
          "inspector-popup justify-start border-0 bg-transparent px-0 shadow-none hover:shadow-none active:shadow-none",
        className,
      )}
      {...props}
      {...motion}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <UnfoldIcon className="size-3.5 text-muted-foreground" />
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
  const motion = useMotionOriginProps("select", props, false, true);
  return (
    <SelectPrimitive.Portal>
      <GlassSurface asChild tier="full">
        <SelectPrimitive.Content
          data-slot="select-content"
          className={cn(
            MENU_SURFACE,
            "material-floating",
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
          {...motion}
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
      </GlassSurface>
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
        "w-full gap-1 [&>[data-slot=select-item-indicator]]:order-last [&>[data-slot=select-item-indicator]]:ml-auto [&>[data-slot=select-item-indicator]]:shrink-0 [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2",
        className,
      )}
      {...props}
    >
      {/* The mark occupies only its own width plus the tight row gap. */}
      <span data-slot="select-item-indicator" className={cn(MENU_INDICATOR, "static")}>
        <SelectPrimitive.ItemIndicator>
          <CheckIcon strokeWidth={2.25} className={MENU_INDICATOR_MARK} />
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
      <ChevronUpIcon className="size-4" />
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
      <ChevronDownIcon className="size-4" />
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
