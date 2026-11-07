import * as React from "react";
import { cn } from "@renderer/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/** Identity help waits deliberately longer than ordinary action labels (400ms).
 * Each mark owns its delay: moving between marks never skips the dwell. */
const HELP_TAG_DELAY = 1500;
type HelpModality = "keyboard" | "pointer";
// Select content is portalled, and windowed command rows can all recycle in
// one commit. Keep local modality on the existing trigger/composite across
// that recycling; weak keys never retain an unmounted anchor.
const anchorModality = new WeakMap<Element, HelpModality>();
const focusRestoration = new WeakMap<Element, HelpModality>();
const COMPOSITE = '[data-slot="command"], [data-slot="select-content"], [role="menu"]';
type HelpRegistration = (active: boolean) => void;
type CompositeHelp = {
  keyboard(): boolean;
  register(host: HTMLElement, show: HelpRegistration): () => void;
};
const compositeHelp = new WeakMap<HTMLElement, CompositeHelp>();

/** One local modality/selection observer per composite, shared by its marks.
 * cmdk can have NO input; windowed comboboxes can recycle their active option.
 * Navigation also syncs when the active id does not change (singleton/endpoints).
 * No document-wide input-device heuristic or additional focus target is needed. */
function helpForComposite(scope: HTMLElement): CompositeHelp {
  const existing = compositeHelp.get(scope);
  if (existing) return existing;
  const command = scope.matches('[data-slot="command"]');
  const trigger = scope.id
    ? [...document.querySelectorAll<HTMLElement>('[role="combobox"][aria-controls]')].find(
        (candidate) => candidate.getAttribute("aria-controls") === scope.id,
      )
    : undefined;
  let modality = anchorModality.get(scope) ?? (trigger ? anchorModality.get(trigger) : undefined);
  let disposed = false;
  const registrations = new Map<HTMLElement, Set<HelpRegistration>>();
  const publish = (selected: Element | null) => {
    for (const [host, callbacks] of registrations)
      for (const show of callbacks) show(host === selected);
  };
  const sync = () => {
    if (disposed || modality !== "keyboard" || !scope.contains(document.activeElement)) return;
    const input = command ? scope.querySelector<HTMLInputElement>('[role="combobox"]') : null;
    const activeId = input?.getAttribute("aria-activedescendant");
    const selected = command
      ? activeId
        ? document.getElementById(activeId)
        : scope.querySelector('[role="option"][aria-selected="true"]')
      : (document.activeElement?.closest(
          '[role="option"], [role="menuitem"], [role="menuitemradio"]',
        ) ?? null);
    publish(selected);
  };
  const key = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    // Radix Select/menu typeahead also moves option focus. It is a keyboard
    // request even after pointer use; typing in a command input is not one.
    const typeahead =
      !command && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (
      typeahead ||
      ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)
    ) {
      modality = "keyboard";
      anchorModality.set(scope, modality);
      if (trigger) focusRestoration.set(trigger, modality);
      // After React/cmdk handles the same key, even if no DOM attribute changed.
      queueMicrotask(sync);
    } else if (event.key === "Escape" || event.key === "Enter") {
      if (trigger) focusRestoration.set(trigger, "keyboard");
      modality = undefined;
      anchorModality.delete(scope);
      publish(null);
    }
  };
  const pointer = () => {
    modality = "pointer";
    anchorModality.set(scope, modality);
    // An unset Select has no trigger mark yet. Carry this gesture across the
    // value's mount and Radix's close autofocus, not just across option recycling.
    if (trigger) focusRestoration.set(trigger, modality);
    publish(null);
  };
  const blur = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !scope.contains(event.relatedTarget))
      publish(null);
  };
  const observer = new MutationObserver(sync);
  observer.observe(scope, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-activedescendant", "aria-selected", "data-selected"],
  });
  scope.addEventListener("keydown", key, true);
  // Capture precedes Radix's pointermove -> item.focus(), including no press.
  scope.addEventListener("pointermove", pointer, true);
  scope.addEventListener("pointerdown", pointer, true);
  scope.addEventListener("focusin", sync);
  scope.addEventListener("focusout", blur);
  const controller: CompositeHelp = {
    keyboard: () => modality === "keyboard",
    register(host, show) {
      const callbacks = registrations.get(host) ?? new Set<HelpRegistration>();
      registrations.set(host, callbacks);
      callbacks.add(show);
      sync();
      return () => {
        callbacks.delete(show);
        if (callbacks.size === 0) registrations.delete(host);
        if (registrations.size !== 0) return;
        disposed = true;
        observer.disconnect();
        scope.removeEventListener("keydown", key, true);
        scope.removeEventListener("pointermove", pointer, true);
        scope.removeEventListener("pointerdown", pointer, true);
        scope.removeEventListener("focusin", sync);
        scope.removeEventListener("focusout", blur);
        compositeHelp.delete(scope);
      };
    },
  };
  compositeHelp.set(scope, controller);
  return controller;
}
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
    let keyboardShown = false;
    const scope = host.closest<HTMLElement>(COMPOSITE);
    const controller = scope ? helpForComposite(scope) : null;
    const close = () => setOpen(false);
    const unregister = controller?.register(host, (active) => {
      if (active) {
        keyboardShown = true;
        setOpen(true);
      } else if (keyboardShown) {
        keyboardShown = false;
        close();
      }
    });
    const focus = () => {
      const restoredModality = focusRestoration.get(host);
      // Spend the restoration hint once: the next deliberate keyboard focus
      // must still reveal help, even after the preceding pointer selection.
      focusRestoration.delete(host);
      if (pressing || restoredModality === "pointer" || (controller && !controller.keyboard()))
        return;
      anchorModality.set(host, "keyboard");
      keyboardShown = true;
      setOpen(true);
    };
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !host.contains(event.relatedTarget)) {
        keyboardShown = false;
        close();
      }
    };
    const up = () => {
      pressing = false;
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    const down = () => {
      pressing = true;
      anchorModality.set(host, "pointer");
      close();
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    const key = () => anchorModality.set(host, "keyboard");
    host.addEventListener("focusin", focus);
    host.addEventListener("focusout", blur);
    host.addEventListener("pointerdown", down);
    host.addEventListener("keydown", key, true);
    return () => {
      unregister?.();
      disabled.disconnect();
      host.removeEventListener("focusin", focus);
      host.removeEventListener("focusout", blur);
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
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
