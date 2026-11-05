"use client";

/**
 * The context-menu primitives, and one policy that binds every item in them:
 * `icon` is REQUIRED — on {@link ContextMenuItem} and {@link ContextMenuSubTrigger}
 * alike — and is drawn with the shared set's outline stroke. Selected and
 * destructive rows communicate their exception through ink or background,
 * never through a second, filled icon family.
 *
 * Geometry comes from `menu-classes.ts` — this file states no menu size of its
 * own, so it cannot drift from the dropdown it is the right-click twin of.
 */
import * as React from "react";
import {
  ChevronRightIcon,
  CheckIcon,
  type IconComponent as Icon,
} from "@renderer/components/ui/icon";

import { ContextMenu as ContextMenuPrimitive } from "radix-ui";

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

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return (
    <MotionOriginRoot scope="context-menu" {...props}>
      {(motion) => <ContextMenuPrimitive.Root data-slot="context-menu" {...props} {...motion} />}
    </MotionOriginRoot>
  );
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  const motion = useMotionOriginProps("context-menu", props);
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} {...motion} />;
}

function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

function ContextMenuPortal({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return (
    <MotionOriginRoot scope="context-menu" {...props} hover>
      {(motion) => <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} {...motion} />}
    </MotionOriginRoot>
  );
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

/** Every action has a neighbouring shared symbol. */
function ContextMenuSubTrigger({
  className,
  icon: ItemIcon,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  icon: Icon;
}) {
  const motion = useMotionOriginProps("context-menu", props, true);
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_OPEN, className)}
      {...props}
      {...motion}
    >
      <ItemIcon aria-hidden />
      {children}
      <ChevronRightIcon strokeWidth={2.25} className="ml-auto" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

/**
 * Portaled, never drawn inside its parent: `material-floating` contains paint
 * (and its blur is a containing block), so a submenu left in the parent's DOM
 * is clipped to the parent's box — open, focusable and invisible.
 */
function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  const motion = useMotionOriginProps("context-menu", props, false, true);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        data-slot="context-menu-sub-content"
        className={cn(
          MENU_SURFACE,
          "material-floating",
          MENU_SURFACE_PAD,
          MENU_SURFACE_MOTION,
          "max-h-[min(var(--radix-context-menu-content-available-height),20rem)] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain",
          className,
        )}
        {...props}
        {...motion}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  const motion = useMotionOriginProps("context-menu", props, false, true);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          MENU_SURFACE,
          "material-floating",
          MENU_SURFACE_PAD,
          MENU_SURFACE_MOTION,
          "max-h-[min(var(--radix-context-menu-content-available-height),20rem)] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain",
          className,
        )}
        {...props}
        {...motion}
      />
    </ContextMenuPrimitive.Portal>
  );
}

/** Every action has a neighbouring shared symbol. */
function ContextMenuItem({
  className,
  variant = "default",
  icon: ItemIcon,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
  icon: Icon;
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_DESTRUCTIVE, className)}
      {...props}
    >
      <ItemIcon aria-hidden />
      {children}
    </ContextMenuPrimitive.Item>
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_INDICATED, className)}
      checked={checked}
      {...props}
    >
      {children}
      <span className={MENU_INDICATOR}>
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon strokeWidth={2.25} className={MENU_INDICATOR_MARK} />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
    </ContextMenuPrimitive.CheckboxItem>
  );
}

// A check, not a radio dot, and trailing rather than leading — the same mark in
// the same column as the checkbox item above and as the dropdown's pair, so
// single-select and multi-select menus read as one language.
function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_INDICATED, className)}
      {...props}
    >
      {children}
      <span className={MENU_INDICATOR}>
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon strokeWidth={2.25} className={MENU_INDICATOR_MARK} />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
    </ContextMenuPrimitive.RadioItem>
  );
}

function ContextMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      className={cn(MENU_LABEL, className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn(MENU_SEPARATOR, className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="context-menu-shortcut" className={cn(MENU_SHORTCUT, className)} {...props} />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
};
