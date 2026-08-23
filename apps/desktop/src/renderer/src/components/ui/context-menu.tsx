"use client";

/**
 * The context-menu primitives, and one policy that binds every item in them:
 * `icon` is REQUIRED — on {@link ContextMenuItem} and {@link ContextMenuSubTrigger}
 * alike — and is drawn at Phosphor's default outline weight. `iconWeight="fill"`
 * is the deliberate exception for a surface whose visual requirement names it;
 * a normal menu never gets fill as generic emphasis.
 *
 * Geometry comes from `menu-classes.ts` — this file states no menu size of its
 * own, so it cannot drift from the dropdown it is the right-click twin of.
 */
import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import type { Icon } from "@phosphor-icons/react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";
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
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

function ContextMenuPortal({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

/** Required `icon`, outline by default; `fill` is an explicit visual exception. */
function ContextMenuSubTrigger({
  className,
  icon: ItemIcon,
  iconWeight,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  icon: Icon;
  iconWeight?: "fill";
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_OPEN, className)}
      {...props}
    >
      <ItemIcon aria-hidden weight={iconWeight} />
      {children}
      <CaretRightIcon weight="bold" className="ml-auto" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      className={cn(
        MENU_SURFACE,
        MENU_SURFACE_PAD,
        MENU_SURFACE_MOTION,
        "max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          MENU_SURFACE,
          MENU_SURFACE_PAD,
          MENU_SURFACE_MOTION,
          "max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

/** Required `icon`, outline by default; `fill` is an explicit visual exception. */
function ContextMenuItem({
  className,
  variant = "default",
  icon: ItemIcon,
  iconWeight,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
  icon: Icon;
  iconWeight?: "fill";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(MENU_ROW, MENU_ROW_STATE, MENU_ROW_DESTRUCTIVE, className)}
      {...props}
    >
      <ItemIcon aria-hidden weight={iconWeight} />
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
          <CheckIcon weight="bold" className={MENU_INDICATOR_MARK} />
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
          <CheckIcon weight="bold" className={MENU_INDICATOR_MARK} />
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
