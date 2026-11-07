import * as React from "react";
import { cn } from "@renderer/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/** Identity help waits deliberately longer than ordinary action labels (400ms).
 * Each mark owns its delay: moving between marks never skips the dwell. */
const HELP_TAG_DELAY = 1500;
// Survives windowed option recycling, without retaining unmounted command roots.
const keyboardCommands = new WeakMap<Element, boolean>();
const FOCUS_HOST =
  'button, a[href], [role="option"], [role="menuitem"], [role="radio"], [role="tab"], [role="combobox"]';

/** Supplemental identity inside an existing anchor's tooltip. Ordinary title
 * help keeps its own timing; only this detail waits for a mark hover. Focus
 * reuses the anchor, and neither markup nor global tooltip events are added. */
export function useHelpTagDetail(
  ref: React.RefObject<HTMLElement | null>,
  pointerTarget: string,
  enabled: boolean,
) {
  const [visible, setVisible] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismiss = React.useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setVisible(false);
  }, []);
  React.useEffect(() => {
    const anchor = ref.current;
    if (!anchor || !enabled) {
      dismiss();
      return;
    }
    const mark = anchor.querySelector<HTMLElement>(pointerTarget);
    let pressing = false;
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setVisible(true), HELP_TAG_DELAY);
    };
    const focus = (event: FocusEvent) => {
      if (event.target === anchor && !pressing) setVisible(true);
    };
    const up = () => {
      pressing = false;
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    const down = () => {
      pressing = true;
      dismiss();
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    mark?.addEventListener("pointerenter", enter);
    mark?.addEventListener("pointerleave", dismiss);
    anchor.addEventListener("focusin", focus);
    anchor.addEventListener("focusout", dismiss);
    anchor.addEventListener("pointerdown", down);
    return () => {
      clearTimeout(timer.current);
      up();
      mark?.removeEventListener("pointerenter", enter);
      mark?.removeEventListener("pointerleave", dismiss);
      anchor.removeEventListener("focusin", focus);
      anchor.removeEventListener("focusout", dismiss);
      anchor.removeEventListener("pointerdown", down);
    };
  }, [ref, pointerTarget, enabled, dismiss]);
  return { visible: enabled && visible, dismiss };
}

/** A named mark, not another button inside the control it identifies. Borrow
 * the host's focus, including a combobox's active descendant; inert captions
 * get their own stop. The tag uses the existing label material and portal. */
export function HelpTag({
  label,
  detail,
  children,
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"span">, "children"> & {
  label: string;
  detail?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [open, setOpen] = React.useState(false);
  const [ownStop, setOwnStop] = React.useState(false);
  React.useEffect(() => {
    const mark = ref.current;
    if (!mark) return;
    const host = mark.parentElement?.closest<HTMLElement>(FOCUS_HOST);
    if (!host) {
      setOwnStop(true);
      return;
    }
    const syncStop = () => {
      const frozen = host.hasAttribute("disabled");
      setOwnStop(frozen);
      if (!frozen && mark === document.activeElement) host.focus();
    };
    syncStop();
    const disabled = new MutationObserver(syncStop);
    disabled.observe(host, { attributes: true, attributeFilter: ["disabled"] });
    let pressing = false;
    const focus = () => {
      if (!pressing) setOpen(true);
    };
    const close = () => setOpen(false);
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !host.contains(event.relatedTarget)) close();
    };
    const up = () => {
      pressing = false;
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    const down = () => {
      pressing = true;
      close();
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    host.addEventListener("focusin", focus);
    host.addEventListener("focusout", blur);
    host.addEventListener("pointerdown", down);

    // cmdk and the windowed command list keep DOM focus on their input.
    const command = host.closest('[data-slot="command"]');
    const input = command?.querySelector<HTMLInputElement>('[role="combobox"]');
    let keyboardShown = false;
    const syncActive = () => {
      if (command && keyboardCommands.get(command) && input && input === document.activeElement) {
        keyboardShown = input.getAttribute("aria-activedescendant") === host.id;
        setOpen(keyboardShown);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (!command) return;
      if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key))
        keyboardCommands.set(command, true);
      else if (event.key === "Escape" || event.key === "Enter") {
        keyboardCommands.set(command, false);
        close();
      }
    };
    const pointer = () => {
      if (keyboardShown) close();
      keyboardShown = false;
      if (command) keyboardCommands.set(command, false);
    };
    const active = new MutationObserver(syncActive);
    if (input) {
      syncActive();
      active.observe(input, { attributes: true, attributeFilter: ["aria-activedescendant"] });
      input.addEventListener("keydown", key);
      input.addEventListener("blur", close);
      command?.addEventListener("pointermove", pointer);
      command?.addEventListener("pointerdown", pointer);
    }
    return () => {
      disabled.disconnect();
      active.disconnect();
      host.removeEventListener("focusin", focus);
      host.removeEventListener("focusout", blur);
      host.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      input?.removeEventListener("keydown", key);
      input?.removeEventListener("blur", close);
      command?.removeEventListener("pointermove", pointer);
      command?.removeEventListener("pointerdown", pointer);
    };
  }, []);
  return (
    <TooltipProvider delayDuration={HELP_TAG_DELAY} skipDelayDuration={0}>
      <Tooltip open={open} onOpenChange={setOpen} delayDuration={HELP_TAG_DELAY}>
        <TooltipTrigger asChild>
          <span
            {...props}
            ref={ref}
            role="img"
            aria-label={label}
            tabIndex={ownStop ? 0 : undefined}
            data-slot="help-tag"
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring in-data-[slot=select-trigger]:pointer-events-auto",
              className,
            )}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72 text-wrap data-[state=closed]:animate-none">
          <bdi>{detail ? `${detail} · ${label}` : label}</bdi>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
