import * as React from "react";
import { GLASS_MOTION, springSamples } from "@renderer/lib/glass-motion";
import { paneResizeActive, usePaneResizeActive } from "@renderer/lib/pane-resize";
import { prefersReducedMotion, useReducedMotion } from "@renderer/hooks/use-reduced-motion";

interface TabMeta {
  id: string;
}
interface CascadeIntent {
  open(pointer: boolean): void;
  close(node: HTMLElement | null, pointer: boolean): void;
}
export const TabCascadeContext = React.createContext<CascadeIntent | null>(null);
interface Row {
  id: string;
  node: HTMLElement;
  slot: HTMLElement;
}
interface Opening {
  widths: Map<string, number>;
  velocities: Map<string, number>;
}
interface Retiring {
  id: string;
  clone: HTMLElement;
  following: string[];
  width: number;
}
interface WidthRun {
  animation: Animation;
  values: number[];
  started: number;
}
const OWNED = [
  "width",
  "flex",
  "min-width",
  "overflow",
  "margin-inline-end",
  "padding-left",
  "padding-right",
] as const;
const pinSamples = springSamples("pin");

/** A group, a wrapped file, and a bare tab all occupy ONE direct flex slot. */
function slotOf(node: HTMLElement): HTMLElement {
  let slot = node;
  while (slot.parentElement && slot.parentElement.getAttribute("role") !== "tablist")
    slot = slot.parentElement;
  return slot;
}
function retiringClone(slot: HTMLElement): HTMLElement {
  // Only the small tab drawing is copied, never a Session/editor subtree.
  const clone = slot.cloneNode(true) as HTMLElement;
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    for (const name of ["id", "role", "aria-controls", "data-pair-target-id", "data-testid"])
      element.removeAttribute(name);
    element.removeAttribute("tabindex");
  }
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  clone.style.pointerEvents = "none";
  clone.style.width = "100%";
  clone.style.minWidth = "0";
  clone.style.flex = "1 1 auto";
  const shell = document.createElement("div");
  shell.dataset.tabRetiring = "";
  shell.setAttribute("aria-hidden", "true");
  shell.inert = true;
  shell.style.cssText = "display:flex;pointer-events:none;overflow:hidden;min-width:0";
  shell.append(clone);
  return shell;
}
function velocityOf(run: WidthRun | undefined): number {
  if (!run) return 0;
  const elapsed =
    typeof run.animation.currentTime === "number"
      ? run.animation.currentTime
      : performance.now() - run.started;
  const index = Math.min(63, Math.max(0, Math.floor((elapsed / GLASS_MOTION.pin) * 64)));
  return ((run.values[index + 1] ?? 0) - (run.values[index] ?? 0)) / (GLASS_MOTION.pin / 64000);
}

/** Width, not scale: captions keep their type size. Only explicit pointer
 * commands cascade; keyboard/programmatic changes and live divider resizing
 * return to ordinary flex synchronously. Commands never await playback. */
export function useTabCascade(
  area: React.RefObject<HTMLDivElement | null>,
  scroller: React.RefObject<HTMLDivElement | null>,
  inventory: Map<HTMLElement, TabMeta>,
) {
  const runs = React.useRef(new Map<HTMLElement, WidthRun>());
  const styles = React.useRef(new Map<HTMLElement, Map<string, string>>());
  const ghosts = React.useRef(new Set<HTMLElement>());
  const pending = React.useRef(new Map<string, Retiring>());
  const previous = React.useRef(new Set<string>());
  const opening = React.useRef<Opening | null>(null);
  const held = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownWidth = React.useRef<number | null>(null);
  const listMinimum = React.useRef<{ list: HTMLElement; value: string } | null>(null);
  const resizing = usePaneResizeActive();
  const reduced = useReducedMotion();
  const live = React.useCallback(
    (): Row[] =>
      Array.from(scroller.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).flatMap(
        (node) => {
          const meta = inventory.get(node);
          return meta ? [{ id: meta.id, node, slot: slotOf(node) }] : [];
        },
      ),
    [scroller, inventory],
  );
  const remember = React.useCallback((slot: HTMLElement) => {
    if (!styles.current.has(slot))
      styles.current.set(
        slot,
        new Map(OWNED.map((name) => [name, slot.style.getPropertyValue(name)])),
      );
  }, []);
  const restore = React.useCallback((slot: HTMLElement) => {
    const saved = styles.current.get(slot);
    if (!saved) return;
    for (const [name, value] of saved) {
      if (value) slot.style.setProperty(name, value);
      else slot.style.removeProperty(name);
    }
    styles.current.delete(slot);
  }, []);
  const cancel = React.useCallback((slot: HTMLElement) => {
    const run = runs.current.get(slot);
    runs.current.delete(slot);
    run?.animation.cancel();
  }, []);
  const unlockList = React.useCallback(() => {
    const saved = listMinimum.current;
    if (saved) {
      if (saved.value) saved.list.style.minWidth = saved.value;
      else saved.list.style.removeProperty("min-width");
      listMinimum.current = null;
    }
  }, []);
  const clear = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    timer.current = openTimer.current = null;
    held.current = false;
    opening.current = null;
    pending.current.clear();
    for (const slot of runs.current.keys()) cancel(slot);
    for (const slot of styles.current.keys()) restore(slot);
    for (const ghost of ghosts.current) ghost.remove();
    ghosts.current.clear();
    unlockList();
  }, [cancel, restore, unlockList]);
  const animateWidth = React.useCallback(
    (
      slot: HTMLElement,
      from: number,
      to: number,
      velocity = 0,
      gapFrom = 0,
      gapTo = 0,
      done?: () => void,
    ) => {
      cancel(slot);
      remember(slot);
      const padding = slot.getAttribute("role") === "tab" ? getComputedStyle(slot) : null;
      const left = padding ? Number.parseFloat(padding.paddingLeft) || 0 : 0;
      const right = padding ? Number.parseFloat(padding.paddingRight) || 0 : 0;
      slot.style.flex = "0 0 auto";
      slot.style.minWidth = "0px";
      slot.style.overflow = "hidden";
      slot.style.width = `${to}px`;
      slot.style.marginInlineEnd = `${gapTo}px`;
      const omega = (2 * Math.PI) / 0.2;
      const values = pinSamples.map((progress, index) => {
        const time = ((index / 64) * 8.5) / omega;
        return index === 64
          ? to
          : Math.max(0, from + (to - from) * progress + velocity * time * Math.exp(-omega * time));
      });
      const finish = () => {
        if (!held.current) restore(slot);
        done?.();
      };
      if (typeof slot.animate !== "function" || (Math.abs(from - to) < 0.5 && gapFrom === gapTo)) {
        finish();
        return;
      }
      const frames = values.map((width, index) => ({
        width: `${width}px`,
        offset: index / 64,
        marginInlineEnd: `${gapFrom + (gapTo - gapFrom) * (pinSamples[index] ?? 1)}px`,
        // A bare tab's padding must not impose a nonzero minimum at its birth.
        ...(padding
          ? {
              paddingLeft: `${Math.min(1, width / Math.max(1, left + right)) * left}px`,
              paddingRight: `${Math.min(1, width / Math.max(1, left + right)) * right}px`,
            }
          : {}),
      }));
      const animation = slot.animate(frames, {
        duration: GLASS_MOTION.pin,
        easing: GLASS_MOTION.linear,
        fill: "both",
      });
      runs.current.set(slot, { animation, values, started: performance.now() });
      animation.onfinish = () => {
        if (runs.current.get(slot)?.animation !== animation) return;
        runs.current.delete(slot);
        animation.cancel();
        finish();
      };
    },
    [cancel, remember, restore],
  );
  const release = React.useCallback(() => {
    if (!held.current) return;
    held.current = false;
    pending.current.clear();
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const rows = live();
    const starts = new Map(rows.map(({ slot }) => [slot, slot.getBoundingClientRect().width]));
    const velocities = new Map(rows.map(({ slot }) => [slot, velocityOf(runs.current.get(slot))]));
    for (const { slot } of rows) {
      cancel(slot);
      restore(slot);
    }
    unlockList();
    // Measure final flex without charging a retiring capsule's temporary slot.
    for (const ghost of ghosts.current) ghost.style.display = "none";
    const targets = new Map(rows.map(({ slot }) => [slot, slot.getBoundingClientRect().width]));
    for (const ghost of ghosts.current) ghost.style.display = "flex";
    for (const { slot } of rows)
      animateWidth(slot, starts.get(slot) ?? 0, targets.get(slot) ?? 0, velocities.get(slot) ?? 0);
  }, [live, cancel, restore, unlockList, animateWidth]);
  const activity = React.useCallback(() => {
    if (!held.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(release, GLASS_MOTION.tabCloseHold);
  }, [release]);
  const api = React.useMemo<CascadeIntent>(
    () => ({
      open(pointer) {
        if (!pointer || prefersReducedMotion() || paneResizeActive()) {
          clear();
          return;
        }
        const rows = live();
        opening.current = {
          widths: new Map(rows.map(({ id, slot }) => [id, slot.getBoundingClientRect().width])),
          velocities: new Map(rows.map(({ id, slot }) => [id, velocityOf(runs.current.get(slot))])),
        };
        if (openTimer.current) clearTimeout(openTimer.current);
        // A failed/abandoned async create must not animate an unrelated later tab.
        openTimer.current = setTimeout(() => {
          opening.current = null;
        }, 10000);
      },
      close(node, pointer) {
        if (!node || !pointer || prefersReducedMotion() || paneResizeActive()) {
          clear();
          return;
        }
        const rows = live();
        const index = rows.findIndex((row) => row.node === node);
        const row = rows[index];
        if (!row) return;
        const widths = new Map(rows.map(({ slot }) => [slot, slot.getBoundingClientRect().width]));
        pending.current.set(row.id, {
          id: row.id,
          clone: retiringClone(row.slot),
          width: widths.get(row.slot) ?? 0,
          following: rows.slice(index + 1).map((next) => next.id),
        });
        for (const { slot } of rows) {
          cancel(slot);
          remember(slot);
          slot.style.flex = "0 0 auto";
          slot.style.width = `${widths.get(slot) ?? 0}px`;
        }
        const list = row.slot.parentElement;
        if (list && !listMinimum.current) {
          listMinimum.current = { list, value: list.style.minWidth };
          // Preserve the scroll extent too: closing near the end must not clamp
          // scrollLeft and slide the next × away from a stationary pointer.
          list.style.minWidth = `${Math.max(list.getBoundingClientRect().width, scroller.current?.clientWidth ?? 0)}px`;
        }
        opening.current = null;
        held.current = true;
        activity();
      },
    }),
    [clear, live, remember, cancel, scroller, activity],
  );
  React.useLayoutEffect(() => {
    const rows = live();
    const ids = new Set(rows.map((row) => row.id));
    const removed = [...previous.current].filter((id) => !ids.has(id));
    const added = rows.some((row) => !previous.current.has(row.id));
    if (removed.some((id) => !pending.current.has(id)) || (added && !opening.current)) clear();
    const list =
      rows[0]?.slot.parentElement ??
      scroller.current?.querySelector<HTMLElement>('[role="tablist"]');
    const gap = list ? Number.parseFloat(getComputedStyle(list).columnGap) || 0 : 0;
    for (const id of removed) {
      const exit = pending.current.get(id);
      pending.current.delete(id);
      if (!exit || !list) continue;
      const next = exit.following.flatMap((following) =>
        rows.filter((row) => row.id === following),
      )[0];
      list.insertBefore(exit.clone, next?.slot ?? null);
      ghosts.current.add(exit.clone);
      animateWidth(exit.clone, exit.width, 0, 0, 0, -gap, () => {
        exit.clone.remove();
        ghosts.current.delete(exit.clone);
      });
    }
    const intent = opening.current;
    if (intent && rows.some((row) => !intent.widths.has(row.id)) && !resizing && !reduced) {
      opening.current = null;
      held.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (openTimer.current) clearTimeout(openTimer.current);
      timer.current = openTimer.current = null;
      const starts = new Map(
        rows.map(({ id, slot }) => [
          id,
          runs.current.has(slot)
            ? slot.getBoundingClientRect().width
            : (intent.widths.get(id) ?? 0),
        ]),
      );
      const velocities = new Map(
        rows.map(({ id, slot }) => [
          id,
          runs.current.has(slot)
            ? velocityOf(runs.current.get(slot))
            : (intent.velocities.get(id) ?? 0),
        ]),
      );
      for (const { slot } of rows) {
        cancel(slot);
        restore(slot);
      }
      unlockList();
      for (const ghost of ghosts.current) ghost.style.display = "none";
      const targets = new Map(rows.map(({ id, slot }) => [id, slot.getBoundingClientRect().width]));
      for (const ghost of ghosts.current) ghost.style.display = "flex";
      for (const { id, slot } of rows)
        animateWidth(
          slot,
          starts.get(id) ?? 0,
          targets.get(id) ?? 0,
          velocities.get(id) ?? 0,
          intent.widths.has(id) ? 0 : -gap,
        );
    }
    previous.current = ids;
  });
  React.useLayoutEffect(() => {
    if (resizing || reduced) clear();
  }, [resizing, reduced, clear]);
  React.useEffect(() => {
    const element = area.current;
    if (!element) return;
    knownWidth.current = element.clientWidth;
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            const width = element.clientWidth;
            if (width !== knownWidth.current) clear();
            knownWidth.current = width;
          })
        : null;
    observer?.observe(element);
    const keyboard = () => clear();
    window.addEventListener("keydown", keyboard, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("keydown", keyboard, true);
      clear();
    };
  }, [area, clear]);
  return { api, release, activity };
}
