/** Lab-only 2.5D light transport: measured screen-space rectangles + explicit heights.
 * Not ray tracing: one centre ray / neighbour, inverse-square falloff, soft blocking.
 * No DOM, pixel reads or per-frame rasterization. Bounded by the tiny fixture count.
 */
export interface Point {
  x: number;
  y: number;
}
export interface Body {
  x: number;
  y: number;
  width: number;
  height: number;
  elevation: number;
}
export interface Light extends Point {
  elevation: number;
  power: number;
}
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/** First crossing of a segment with a rectangle; null when it misses. */
export function crossing(from: Point, to: Point, rect: Body): number | null {
  let enter = 0;
  let exit = 1;
  for (const [start, delta, low, high] of [
    [from.x, to.x - from.x, rect.x, rect.x + rect.width],
    [from.y, to.y - from.y, rect.y, rect.y + rect.height],
  ]) {
    if (Math.abs(delta) < 0.001) {
      if (start < low || start > high) return null;
    } else {
      const a = (low - start) / delta;
      const b = (high - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return null;
    }
  }
  return enter < 1 && exit > 0 ? enter : null;
}

export function lightResponse(target: Body, light: Light, neighbours: readonly Body[]) {
  const centre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const dx = light.x - centre.x;
  const dy = light.y - centre.y;
  const distance = Math.hypot(dx, dy);
  const nx = dx / Math.max(1, distance);
  const ny = dy / Math.max(1, distance);
  let transmission = 1;
  for (const neighbour of neighbours) {
    if (neighbour === target || neighbour.elevation <= target.elevation) continue;
    const t = crossing(centre, light, neighbour);
    if (t === null) continue;
    const rayHeight = target.elevation + t * (light.elevation - target.elevation);
    // Soft centre-ray approximation: no hard on/off flicker at a grazing height.
    transmission *= 1 - 0.85 * clamp((neighbour.elevation - rayHeight) / 8);
  }
  const strength = clamp(light.power / (1 + (distance / 480) ** 2)) * transmission;
  const projection = target.elevation / Math.max(24, light.elevation - target.elevation);
  return {
    strength,
    edges: [Math.max(0, -ny), Math.max(0, nx), Math.max(0, ny), Math.max(0, -nx)],
    shadow: { x: clamp(-dx * projection, -96, 96), y: clamp(-dy * projection, -96, 96) },
    glow: {
      x: clamp(dx, -target.width / 2, target.width / 2),
      y: clamp(dy, -target.height / 2, target.height / 2),
    },
  };
}
