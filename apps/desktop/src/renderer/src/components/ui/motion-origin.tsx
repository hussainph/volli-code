/** Activation-local motion provenance, carried through portals and closing Presence. */
import * as React from "react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";

type Origin = "keyboard" | "pointer";
type OpenProps = { open?: boolean; defaultOpen?: boolean; onOpenChange?(open: boolean): void };
type MotionState = { origin: Origin | "instant"; record(origin: Origin): void };
const UNKNOWN: MotionState = { origin: "keyboard", record: () => {} };
const MotionOrigin = React.createContext<Record<string, MotionState>>({});

/** Unknown/programmatic opens are instant; a fresh trigger gesture can opt into motion. */
export function MotionOriginRoot({
  scope,
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  children,
  hover = false,
}: OpenProps & {
  scope: string;
  hover?: boolean;
  children(props: Required<Pick<OpenProps, "open" | "onOpenChange">>): React.ReactNode;
}) {
  const parent = React.useContext(MotionOrigin);
  const reduced = useReducedMotion();
  const [internal, setInternal] = React.useState(defaultOpen);
  const open = controlled ?? internal;
  const [origin, setOrigin] = React.useState<Origin>("keyboard");
  const activation = React.useRef<Origin | null>(null);
  const expiry = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(expiry.current), []);
  const previousOpen = React.useRef(open);
  const requestedOpen = React.useRef<boolean | null>(null);
  const record = React.useCallback(
    (next: Origin) => {
      activation.current = next;
      // Keyboard cancels an entrance; a later pointer inside an already-open
      // surface must not replay it. Closing records its own activation below.
      if (!open || next === "keyboard") setOrigin(reduced ? "keyboard" : next);
      // Browsers can drain microtasks between capture and Radix's bubble listener.
      // Keep this activation through dispatch, not through the next timer task.
      clearTimeout(expiry.current);
      expiry.current = setTimeout(() => {
        activation.current = null;
      }, 0);
    },
    [open, reduced],
  );
  const externalChange = open !== previousOpen.current && requestedOpen.current !== open;
  const effectiveOrigin: MotionState["origin"] = reduced
    ? "instant"
    : externalChange
      ? "keyboard"
      : origin;
  React.useLayoutEffect(() => {
    if (externalChange || reduced) setOrigin("keyboard");
    previousOpen.current = open;
    requestedOpen.current = null;
  }, [open, externalChange, reduced]);
  const value = React.useMemo(
    () => ({ ...parent, [scope]: { origin: effectiveOrigin, record } }),
    [parent, scope, effectiveOrigin, record],
  );
  return (
    <MotionOrigin.Provider value={value}>
      {children({
        open,
        onOpenChange(next) {
          // Radix hover intent resolves after the triggering pointer event.
          requestedOpen.current = next;
          setOrigin(reduced ? "keyboard" : (activation.current ?? (hover ? origin : "keyboard")));
          if (controlled === undefined) setInternal(next);
          onOpenChange?.(next);
        },
      })}
    </MotionOrigin.Provider>
  );
}

/** Compose, never replace, caller handlers. Capture runs before Radix changes open state. */
export function useMotionOriginProps<T extends HTMLElement>(
  scope: string,
  props: React.DOMAttributes<T> & {
    onEscapeKeyDown?(event: KeyboardEvent): void;
    onPointerDownOutside?(event: CustomEvent<{ originalEvent: PointerEvent }>): void;
  },
  hover = false,
  surface = false,
) {
  const { origin, record } = React.useContext(MotionOrigin)[scope] ?? UNKNOWN;
  return {
    ...(surface
      ? {
          onEscapeKeyDown(event: KeyboardEvent) {
            record("keyboard");
            props.onEscapeKeyDown?.(event);
          },
          onPointerDownOutside(event: CustomEvent<{ originalEvent: PointerEvent }>) {
            record("pointer");
            props.onPointerDownOutside?.(event);
          },
        }
      : {}),
    "data-motion-origin": origin,
    onPointerDownCapture(event: React.PointerEvent<T>) {
      record("pointer");
      props.onPointerDownCapture?.(event);
    },
    onPointerMoveCapture(event: React.PointerEvent<T>) {
      if (hover) record("pointer");
      props.onPointerMoveCapture?.(event);
    },
    onKeyDownCapture(event: React.KeyboardEvent<T>) {
      record("keyboard");
      props.onKeyDownCapture?.(event);
    },
    onClickCapture(event: React.MouseEvent<T>) {
      record(event.detail === 0 ? "keyboard" : "pointer");
      props.onClickCapture?.(event);
    },
    onFocusCapture(event: React.FocusEvent<T>) {
      if (hover) record("keyboard");
      props.onFocusCapture?.(event);
    },
  };
}
