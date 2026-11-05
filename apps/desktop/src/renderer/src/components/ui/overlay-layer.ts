/** All floating UI escapes the app's glass/containment tree. The layer is a
 * direct child of body, never a containing block of its own. */
export function overlayLayer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  let layer = document.getElementById("volli-overlays");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "volli-overlays";
    layer.dataset.overlayLayer = "";
    document.body.append(layer);
  }
  return layer;
}
