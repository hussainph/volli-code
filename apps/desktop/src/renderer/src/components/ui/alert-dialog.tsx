"use client";

import * as React from "react";
import { ControlShapeProvider } from "./control-shape";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";
import { MotionOriginRoot, useMotionOriginProps } from "./motion-origin";
import { Button } from "@renderer/components/ui/button";

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return (
    <MotionOriginRoot scope="alert-dialog" {...props}>
      {(motion) => <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} {...motion} />}
    </MotionOriginRoot>
  );
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  const motion = useMotionOriginProps("alert-dialog", props);
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} {...motion} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  const motion = useMotionOriginProps("alert-dialog", props);
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        // Confirmations share the sheet's scrim, timing and reduced-motion gate.
        "fixed inset-0 z-50 bg-scrim duration-(--duration-sheet) ease-(--ease-out) data-[state=closed]:duration-(--duration-menu-out) motion-reduce:animate-none! data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
      {...motion}
    />
  );
}

function AlertDialogContent({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: "default" | "sm";
}) {
  const motion = useMotionOriginProps("alert-dialog", props, false, true);
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          "material-floating group/alert-dialog-content fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100svh-2rem)] w-full overflow-y-auto overscroll-contain max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-container border bg-background p-4 text-ui shadow-overlay duration-(--duration-sheet) ease-(--ease-out) data-[state=closed]:duration-(--duration-menu-out) motion-reduce:animate-none! data-[size=sm]:max-w-[min(20rem,calc(100vw-2rem))] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[size=default]:sm:max-w-lg",
          className,
        )}
        {...props}
        {...motion}
      >
        <ControlShapeProvider context="sheet">{children}</ControlShapeProvider>
      </AlertDialogPrimitive.Content>
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid min-w-0 grid-cols-1 gap-2 text-left has-data-[slot=alert-dialog-media]:grid-cols-[auto_minmax(0,1fr)] has-data-[slot=alert-dialog-media]:[&>[data-slot=alert-dialog-description]]:col-span-full",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("flex flex-wrap justify-end gap-2", className)}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-heading font-semibold break-words", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function AlertDialogMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        // An action glyph beside the title, not a decorative icon tile.
        "flex h-6 items-center text-muted-foreground *:[svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={cn(className)}
        {...props}
      />
    </Button>
  );
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={cn(className)}
        {...props}
      />
    </Button>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
