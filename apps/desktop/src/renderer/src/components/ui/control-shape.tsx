/** Native border shape is contextual, not one radius for the whole app. */
import { createContext, useContext, type ReactNode } from "react";

export type ControlShape = "auto" | "capsule" | "rounded" | "circle";
export type ControlContext = "toolbar" | "content" | "sheet" | "popover" | "sidebar";
export type ControlShapeSize =
  | "mini"
  | "xs"
  | "sm"
  | "default"
  | "lg"
  | "icon"
  | "icon-xs"
  | "icon-sm"
  | "icon-lg"
  | null;
const ShapeContext = createContext<ControlContext>("content");

export function ControlShapeProvider({
  context,
  children,
}: {
  context: ControlContext;
  children: ReactNode;
}) {
  return <ShapeContext.Provider value={context}>{children}</ShapeContext.Provider>;
}

/** App rungs xs/sm/default/lg are 20/24/28/36px; 28+ is the large native tier. */
export function resolveControlShape(
  shape: ControlShape,
  size: ControlShapeSize,
  context: ControlContext,
  kind: "button" | "segmented" | "popup" | "search" | "field" = "button",
): Exclude<ControlShape, "auto"> {
  if (shape !== "auto") return shape;
  if (kind === "search") return "capsule";
  const icon = size?.startsWith("icon") === true;
  // Native toolbar material normalizes every item to a 28pt capsule; only
  // square image-only items are circles. A text field elsewhere stays rounded.
  if (context === "toolbar") return icon && kind === "button" ? "circle" : "capsule";
  if (kind === "field") return "rounded";
  // Natural alert presentation normalizes buttons, not every sheet control.
  if (context === "sheet" && kind === "button") return "capsule";
  const large = size === "default" || size === "lg" || size === "icon" || size === "icon-lg";
  return large ? "capsule" : "rounded";
}

export function useControlShape(
  shape: ControlShape,
  size: ControlShapeSize,
  kind?: Parameters<typeof resolveControlShape>[3],
) {
  const context = useContext(ShapeContext);
  return {
    "data-shape": resolveControlShape(shape, size, context, kind),
    "data-control-context": context,
  };
}
