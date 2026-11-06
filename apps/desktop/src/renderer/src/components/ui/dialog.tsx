import { useOverlayLayer } from "./overlay-layer";

import * as React from "react";
import { ControlShapeProvider } from "./control-shape";
import { CloseIcon } from "@renderer/components/ui/icon";

import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";
import { MotionOriginRoot, useMotionOriginProps } from "./motion-origin";
import { Button } from "@renderer/components/ui/button";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <MotionOriginRoot scope="dialog" {...props}>
      {(motion) => <DialogPrimitive.Root data-slot="dialog" {...props} {...motion} />}
    </MotionOriginRoot>
  );
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  const motion = useMotionOriginProps("dialog", props);
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} {...motion} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal" {...props} container={useOverlayLayer()} />
  );
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  const motion = useMotionOriginProps("dialog", props);
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-scrim duration-(--duration-sheet) ease-(--ease-out) motion-reduce:animate-none! data-[state=closed]:duration-(--duration-menu-out) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
      {...motion}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  material = "floating",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  material?: "floating" | "none";
}) {
  const motion = useMotionOriginProps("dialog", props, false, true);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-close-button={showCloseButton}
        className={cn(
          // A modal is not anchored to a trigger, so it keeps the centered
          // origin and only the duration/curve are shared with the scrim.
          material === "floating" && "material-floating",
          "fixed top-1/2 left-1/2 z-50 flex max-h-[min(80svh,40rem)] w-full flex-col overflow-y-auto overscroll-contain max-w-[calc(100%-2rem)] -translate-1/2 gap-4 rounded-container border border-border bg-background p-4 text-ui [&_label]:font-medium [&_div:has(>[data-slot=input])>span]:font-medium shadow-overlay duration-(--duration-sheet) ease-(--ease-out) data-[state=closed]:duration-(--duration-menu-out) motion-reduce:animate-none! data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className,
        )}
        {...props}
        {...motion}
      >
        <ControlShapeProvider context="sheet">
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-3 right-3 text-muted-foreground"
                aria-label="Close"
              >
                <CloseIcon className="size-3.5" />
              </Button>
            </DialogPrimitive.Close>
          )}
        </ControlShapeProvider>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 flex-col gap-2 text-left", className)}
      {...props}
    />
  );
}

/** Keeps the header and actions visible while long content scrolls internally. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-heading font-semibold break-words text-foreground [[data-close-button=true]_&]:pr-6",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogBody,
  DialogTitle,
  DialogDescription,
};
