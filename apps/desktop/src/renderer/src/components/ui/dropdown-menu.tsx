import { useOverlayLayer } from "./overlay-layer";
import { GlassSurface } from "./surface";

import * as React from "react";
import { ChevronRightIcon, CheckIcon } from "@renderer/components/ui/icon";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";
import { MotionOriginRoot, useMotionOriginProps } from "./motion-origin";
import {
  MENU_INDICATOR,
  MENU_INDICATOR_MARK,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_DESTRUCTIVE,
  MENU_ROW_INDICATED,
  MENU_ROW_OPEN,
  MENU_ROW_STATE,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  MENU_SURFACE,
  MENU_SURFACE_MOTION,
  MENU_SURFACE_PAD,
} from "@renderer/components/ui/menu-classes";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return (
    <MotionOriginRoot scope="dropdown-menu" {...props}>
      {(motion) => <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} {...motion} />}
    </MotionOriginRoot>
  );
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal
      data-slot="dropdown-menu-portal"
      {...props}
      container={useOverlayLayer()}
    />
  );
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const motion = useMotionOriginProps("dropdown-menu", props);
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} {...motion} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const motion = useMotionOriginProps("dropdown-menu", props, false, true);
  return (
    <DropdownMenuPrimitive.Portal container={useOverlayLayer()}>
      <GlassSurface asChild tier="full">
        <DropdownMenuPrimitive.Content
          data-slot="dropdown-menu-content"
          sideOffset={sideOffset}
          className={cn(
            MENU_SURFACE,
            "material-floating",
            MENU_SURFACE_PAD,
            MENU_SURFACE_MOTION,
            "max-h-[min(var(--radix-dropdown-menu-content-available-height),20rem)] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain",
            className,
          )}
          {...props}
          {...motion}
        />
      </GlassSurface>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_DESTRUCTIVE, "plain-menu-row", className)}
      {...props}
    />
  );
}

// Checkbox/radio items share the native leading checked-state gutter.
function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_INDICATED, "plain-menu-row", className)}
      checked={checked}
      {...props}
    >
      {children}
      <span className={MENU_INDICATOR}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon strokeWidth={2.25} className={MENU_INDICATOR_MARK} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

// Same leading indicator as the checkbox item — a check, not a radio dot,
// so single-select (ordering, dialog pickers) and multi-select (facet chips)
// menus read as one visual language.
function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_INDICATED, "plain-menu-row", className)}
      {...props}
    >
      {children}
      <span className={MENU_INDICATOR}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon strokeWidth={2.25} className={MENU_INDICATOR_MARK} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn(MENU_LABEL, className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(MENU_SEPARATOR, className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="dropdown-menu-shortcut" className={cn(MENU_SHORTCUT, className)} {...props} />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return (
    <MotionOriginRoot scope="dropdown-menu" {...props} hover>
      {(motion) => (
        <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} {...motion} />
      )}
    </MotionOriginRoot>
  );
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  const motion = useMotionOriginProps("dropdown-menu", props, true);
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_OPEN, "plain-menu-row", className)}
      {...props}
      {...motion}
    >
      {children}
      <ChevronRightIcon data-slot="menu-submenu-caret" strokeWidth={2.25} className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

/** Portaled for the reason `ContextMenuSubContent` is: a parent float clips it. */
function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const motion = useMotionOriginProps("dropdown-menu", props, false, true);
  return (
    <DropdownMenuPrimitive.Portal container={useOverlayLayer()}>
      <GlassSurface asChild tier="full">
        <DropdownMenuPrimitive.SubContent
          data-slot="dropdown-menu-sub-content"
          className={cn(
            MENU_SURFACE,
            "material-floating",
            MENU_SURFACE_PAD,
            MENU_SURFACE_MOTION,
            "max-h-[min(var(--radix-dropdown-menu-content-available-height),20rem)] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain",
            className,
          )}
          {...props}
          {...motion}
        />
      </GlassSurface>
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
