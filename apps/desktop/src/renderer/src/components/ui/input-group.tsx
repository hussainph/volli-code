"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import {
  CONTROL_SIZE,
  FIELD_SURFACE,
  type ControlSize,
} from "@renderer/components/ui/field-classes";

import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";

function InputGroup({
  className,
  controlSize = "default",
  ...props
}: React.ComponentProps<"div"> & { controlSize?: ControlSize }) {
  return (
    <div
      data-slot="input-group"
      data-size={controlSize}
      role="group"
      className={cn(
        "group/input-group relative flex w-full items-center rounded-control transition-[color,border-color,box-shadow] outline-none",
        CONTROL_SIZE[controlSize],
        "[--control-inset:var(--spacing-control-pad-default)] data-[size=xs]:[--control-inset:var(--spacing-control-pad-xs)] data-[size=sm]:[--control-inset:var(--spacing-control-pad-sm)] data-[size=lg]:[--control-inset:var(--spacing-control-pad-lg)] [&>input]:px-(--control-inset)",
        FIELD_SURFACE,
        "min-w-0 px-0 has-[>textarea]:h-auto [&>input]:h-full data-[disabled=true]:opacity-50 has-[>input:disabled]:opacity-50 has-[>textarea:disabled]:opacity-50 [&>input:disabled]:opacity-100 [&>textarea:disabled]:opacity-100",

        // Variants based on alignment.
        "has-[>[data-align=inline-start]]:[&>input]:pl-2",
        "has-[>[data-align=inline-end]]:[&>input]:pr-2",
        "has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col ",
        "has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col ",

        // Error state.
        "has-[[data-slot][aria-invalid=true]]:border-destructive",

        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1 text-ui font-medium text-muted-foreground select-none [&>kbd]:rounded-sm [&>svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      align: {
        "inline-start": "order-first pl-(--control-inset)",
        "inline-end": "order-last pr-(--control-inset)",
        "block-start":
          "order-first w-full justify-start px-(--control-inset) pt-2 pb-1 text-foreground [&_[data-slot=input-group-text]]:text-foreground",
        "block-end": "order-last w-full justify-start px-(--control-inset) pt-1 pb-2 font-normal",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return;
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

/**
 * A `Button`, sized by `Button`'s own ladder.
 *
 * It used to carry a second ladder that reused the first one's names and
 * disagreed with it — `icon-sm` was 32px here and 24px there, which is why the
 * composer shipped a 24px Stop beside a 32px Submit in the same row. Forwarding
 * `size` straight through is what makes that unrepeatable: there is one set of
 * numbers, and this component no longer holds an opinion about them. All it
 * contributes is the group's ghost default.
 */
function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "sm",
  ...props
}: React.ComponentProps<typeof Button>) {
  return <Button type={type} size={size} variant={variant} className={className} {...props} />;
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="input-group-text"
      className={cn(
        "flex items-center gap-2 text-ui text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "flex-1 rounded-none border-0 control-flat bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "flex-1 resize-none rounded-none border-0 control-flat bg-transparent py-2 shadow-none focus-visible:ring-0 dark:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
};
