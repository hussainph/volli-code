import * as React from "react";
import { SidebarIcon } from "@renderer/components/ui/icon";

import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Separator } from "@renderer/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_ICON = "3rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

/** Input modality is carried to the shell; keyboard toggles never animate. */
type SidebarToggleOptions = { instant?: boolean };
type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: (options?: SidebarToggleOptions) => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean, options?: SidebarToggleOptions) => void;
}) {
  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean), options?: SidebarToggleOptions) => {
      const openState = typeof value === "function" ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState, options);
      } else {
        _setOpen(openState);
      }

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open],
  );

  const toggleSidebar = React.useCallback(
    (options?: SidebarToggleOptions) => {
      setOpen((previous) => !previous, options);
    },
    [setOpen],
  );

  // Adds a keyboard shortcut to toggle the sidebar. `event.repeat` is still
  // excluded: a held ⌘B should toggle once, not strobe the shell. ⌘ only, like
  // every other app chord: ⌃B is macOS's "back one character" in text fields,
  // and ⌥⌘B belongs to the right rail.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        if (!event.repeat) toggleSidebar({ instant: true });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed";

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      toggleSidebar,
    }),
    [state, open, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      {/* No delayDuration override: this provider wraps the whole app, so it
          inherits the primitive's HIG defaults (500ms initial, instant while
          moving between adjacent tooltips via skipDelayDuration). */}
      <TooltipProvider>
        <div
          data-slot="sidebar-wrapper"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
}) {
  const { state } = useSidebar();

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          // No fill of its own (#74): the sidebar column floats on the canvas
          // layer now, and each embedded pane names what it wears — the project
          // rail nothing, the primary sidebar `bg-sidebar-veil` (app-shell.tsx).
          "flex h-full w-(--sidebar-width) flex-col text-sidebar-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    // Stock shadcn gates the desktop sidebar behind md: breakpoints (hidden
    // md:block / md:flex) and swaps in a Sheet below that. Removed here: a
    // docked DevTools panel can push the viewport under 768px, and a desktop
    // app must never hide its sidebar or swap it for a mobile drawer.
    <div
      className="group peer block text-sidebar-foreground"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-(--duration-menu-in) ease-swift",
          // Instant tracking while the resize grip is dragged (AppShell sets
          // data-resizing on the provider) — a timed transition would rubber-band.
          "group-data-[resizing]/sidebar-wrapper:transition-none",
          "group-data-[motion=instant]/sidebar-wrapper:transition-none",
          "group-data-[collapsible=offcanvas]:w-0",
          "group-data-[side=right]:rotate-180",
          variant === "floating" || variant === "inset"
            ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          "fixed inset-y-0 z-10 flex h-svh w-(--sidebar-width) transition-[left,right,width] duration-(--duration-menu-in) ease-swift",
          "group-data-[resizing]/sidebar-wrapper:transition-none",
          "group-data-[motion=instant]/sidebar-wrapper:transition-none",
          side === "left"
            ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
            : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
          // Adjust the padding for floating and inset variants.
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          // Transparent for the same reason as the pane above: an opaque fill
          // here would cover the canvas under the whole two-tier column.
          className="flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-card"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      data-sidebar="trigger"
      data-sidebar-trigger=""
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={className}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar({ instant: event.detail === 0 });
      }}
      {...props}
    >
      {/* A shared outline symbol; the trigger is not a state badge. */}
      <SidebarIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        // min-w-0: a flex-1 row child defaults to min-width:auto, so wide
        // content (e.g. the board canvas) would stretch the window instead
        // of engaging its own overflow-x scroller.
        "relative flex w-full min-w-0 flex-1 flex-col bg-background",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-card md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      // A VEILED hairline, not an opaque `--sidebar-border` (#74): a 1px opaque
      // stroke over a lightness ramp is the most visible instance of the
      // fixed-tint problem — a bright line at the dark end, invisible at the
      // light one. Solved rather than flat white, so it still composites to
      // exactly `--sidebar-border` while `canvas: solid`.
      className={cn("mx-2 w-auto bg-sidebar-border-veil", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-ui font-medium text-sidebar-foreground/70 ring-ring outline-hidden transition-[margin,opacity] duration-(--duration-sheet) ease-swift focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

/*
 * `width,height,padding` are gone from the transition list, and they were not
 * merely idle. Stock shadcn names them because the icon-collapse changes all
 * three; this app has no icon presentation left, so nothing ever animates them
 * on purpose — but a transition does not care why a property changed. Dragging
 * the resize grip changes the pane's width, which changes every row's width, and
 * every row in the sidebar then ran its own 100ms width animation for each frame
 * of the drag. That is a layout animation per row per sample, on the one
 * interaction that already had a main thread to spare.
 *
 * What is left is what actually changes: the fill and ink on hover/active, and
 * the `active:scale-[0.97]` press — which needs `scale` named in the list, not
 * `transform`, and cancels under reduced motion with `scale-100!`. See the
 * press note in `ui/button.tsx` for why those are two different properties.
 */
const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-ring outline-hidden transition-[transform,scale,background-color,color] duration-(--duration-menu-out) ease-out group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent-veil hover:text-foreground focus-visible:ring-2 active:scale-[0.97] active:bg-sidebar-accent-veil active:text-foreground motion-reduce:scale-100! disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent-veil data-[active=true]:font-medium data-[active=true]:text-foreground data-[state=open]:hover:bg-sidebar-accent-veil data-[state=open]:hover:text-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent-veil hover:text-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent-veil hover:text-foreground hover:shadow-[0_0_0_1px_var(--accent)]",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-ui",
        lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : "button";
  const { state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== "collapsed"} {...tooltip} />
    </Tooltip>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        // The nesting rule is a hairline over the canvas too — same veil, same
        // reason as SidebarSeparator's.
        "mx-4 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border-veil px-2 py-1",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
