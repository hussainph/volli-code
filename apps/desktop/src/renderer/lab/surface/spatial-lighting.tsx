import * as React from "react";
import { clamp, lightResponse, type Body, type Point } from "./spatial";

const SOURCES = ["key", "return"] as const;
const EDGES = ["top", "right", "bottom", "left"] as const;

/** Static raster recipes. During placement changes only the leaf transforms/opacity change. */
export function SpatialLayers({ materialFace = false }: { materialFace?: boolean }) {
  return (
    <span className="surface-spatial-layers" aria-hidden>
      {materialFace ? <span className="surface-material-face" /> : null}
      {SOURCES.map((source) => (
        <React.Fragment key={source}>
          <span className="surface-spatial-shadow" data-light={source} data-part="shadow" />
          <span className="surface-spatial-face">
            <span
              className={`surface-spatial-glow surface-light-${source}`}
              data-light={source}
              data-part="glow"
            />
          </span>
          {EDGES.map((edge) => (
            <span
              key={edge}
              className={`surface-spatial-edge surface-light-${source} surface-edge-${edge}`}
              data-light={source}
              data-part={edge}
            />
          ))}
        </React.Fragment>
      ))}
    </span>
  );
}

export function LightHandles() {
  return (
    <div className="surface-light-handles" data-surface-controls>
      {SOURCES.map((source) => (
        <button
          key={source}
          type="button"
          className={`surface-light-handle surface-light-${source}`}
          data-spatial-source={source}
          aria-label={`Move ${source} light`}
          aria-describedby="surface-light-help"
        >
          {source === "key" ? "K" : "R"}
        </button>
      ))}
    </div>
  );
}

export interface LightPlacement {
  keyX: number;
  keyY: number;
  returnX: number;
  returnY: number;
}
interface Settings {
  angle: number;
  elevation: number;
  crown: number;
  rim: number;
  shadow: number;
  tint: number;
  workElevation: number;
  workRim: number;
  workShadow: number;
  workTint: number;
}
interface Target {
  node: HTMLElement;
  body: Body;
  leaves: HTMLElement[];
}
const NO_EXTRA_SURFACES: readonly HTMLElement[] = [];
const isLensSurface = (node: HTMLElement) => node.classList.contains("surface-lens");

/** Event-driven, not an idle animation loop. Bounds are cached until layout changes.
 * Read all rects before writing; light dragging does not rerender React, change CSS
 * gradients/box-shadows/filters, or read rects on each pointer event. Leaf-only
 * transform/opacity writes permit compositor reuse of the prepainted textures.
 */
export function useSpatialLighting(
  stage: React.RefObject<HTMLDivElement | null>,
  lens: HTMLDivElement | null,
  settings: Settings,
  layout: boolean | string,
  placement: LightPlacement,
  onPlacement?: (value: LightPlacement) => void,
  extraSurfaces: readonly HTMLElement[] = NO_EXTRA_SURFACES,
) {
  const {
    angle,
    elevation: inputElevation,
    crown: inputCrown,
    rim: inputRim,
    shadow: inputShadow,
    tint: inputTint,
    workElevation,
    workRim,
    workShadow,
    workTint,
  } = settings;
  const { keyX, keyY, returnX, returnY } = placement;
  const positions = React.useRef<Point[]>([
    { x: keyX, y: keyY },
    { x: returnX, y: returnY },
  ]);
  const previousInput = React.useRef<(LightPlacement & { angle: number }) | null>(null);
  const liveSettings = React.useRef(settings);
  const requestPaint = React.useRef<(() => void) | null>(null);
  const commit = React.useRef(onPlacement);
  React.useEffect(() => {
    commit.current = onPlacement;
  }, [onPlacement]);
  React.useEffect(() => {
    liveSettings.current = {
      angle,
      elevation: inputElevation,
      crown: inputCrown,
      rim: inputRim,
      shadow: inputShadow,
      tint: inputTint,
      workElevation,
      workRim,
      workShadow,
      workTint,
    };
    requestPaint.current?.();
  }, [
    angle,
    inputElevation,
    inputCrown,
    inputRim,
    inputShadow,
    inputTint,
    workElevation,
    workRim,
    workShadow,
    workTint,
  ]);
  React.useEffect(() => {
    const previous = previousInput.current;
    positions.current = [
      { x: keyX, y: keyY },
      { x: returnX, y: returnY },
    ];
    // A bundle restore/reset wins over Angle. Only an angle-only edit re-orbits.
    if (
      previous &&
      previous.angle !== angle &&
      previous.keyX === keyX &&
      previous.keyY === keyY &&
      previous.returnX === returnX &&
      previous.returnY === returnY
    ) {
      const radians = ((angle + 90) * Math.PI) / 180;
      positions.current = [
        { x: 0.5 + Math.cos(radians) * 0.4, y: 0.5 + Math.sin(radians) * 0.4 },
        { x: 0.5 - Math.cos(radians) * 0.4, y: 0.5 - Math.sin(radians) * 0.4 },
      ];
      commit.current?.({
        keyX: positions.current[0].x,
        keyY: positions.current[0].y,
        returnX: positions.current[1].x,
        returnY: positions.current[1].y,
      });
    }
    previousInput.current = { angle, keyX, keyY, returnX, returnY };
    requestPaint.current?.();
  }, [angle, keyX, keyY, returnX, returnY]);
  React.useEffect(() => {
    const root = stage.current;
    if (!root) return;
    function commitPlacement() {
      commit.current?.({
        keyX: positions.current[0].x,
        keyY: positions.current[0].y,
        returnX: positions.current[1].x,
        returnY: positions.current[1].y,
      });
    }
    const handles = [...root.querySelectorAll<HTMLButtonElement>("[data-spatial-source]")];
    const nodes = [
      ...new Set([
        ...root.querySelectorAll<HTMLElement>("[data-spatial-body]"),
        ...(lens ? [lens] : []),
        ...extraSurfaces,
      ]),
    ];
    let targets: Target[] = [];
    let bounds = root.getBoundingClientRect();
    let dirty = true;
    let frame = 0;
    let activePointer: number | null = null;

    function paint() {
      frame = 0;
      const { elevation, crown, rim, shadow, tint } = liveSettings.current;
      if (dirty) {
        bounds = root!.getBoundingClientRect();
        targets = nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            node,
            body: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              elevation: 0,
            },
            leaves: [...node.querySelectorAll<HTMLElement>("[data-light][data-part]")].filter(
              (leaf) => leaf.closest("[data-spatial-body], .surface-lens") === node,
            ),
          };
        });
        dirty = false;
      }
      for (const target of targets)
        target.body.elevation = isLensSurface(target.node)
          ? elevation
          : target.node.dataset.spatialMaterial === "work"
            ? liveSettings.current.workElevation
            : crown === 0
              ? 0
              : Number(target.node.dataset.spatialBody);
      const lights = positions.current.map((point, index) => ({
        x: bounds.x + point.x * bounds.width,
        y: bounds.y + point.y * bounds.height,
        elevation: 100,
        power: index === 0 ? 1 : 0.65,
      }));
      // All measurements above; only compositor-property writes below.
      handles.forEach((handle, index) => {
        handle.style.transform = `translate3d(${positions.current[index].x * bounds.width}px, ${positions.current[index].y * bounds.height}px, 0)`;
      });
      const bodies = targets.map((target) => target.body);
      for (const target of targets) {
        const isWork = target.node.dataset.spatialMaterial === "work";
        const responseRim = isWork ? liveSettings.current.workRim : rim;
        const responseTint = isWork
          ? liveSettings.current.workTint
          : isLensSurface(target.node)
            ? tint
            : crown;
        const responseShadow = isWork ? liveSettings.current.workShadow : shadow;
        const enabled = isLensSurface(target.node) || isWork || crown > 0;
        const responses = lights.map((light) => lightResponse(target.body, light, bodies));
        for (const leaf of target.leaves) {
          const index = leaf.dataset.light === "key" ? 0 : 1;
          const response = responses[index];
          const part = leaf.dataset.part;
          let opacity = 0;
          if (enabled && part === "shadow") {
            leaf.style.transform = `translate3d(${response.shadow.x}px, ${response.shadow.y}px, 0)`;
            opacity = target.body.elevation > 0 ? response.strength * responseShadow : 0;
          } else if (enabled && part === "glow") {
            leaf.style.transform = `translate3d(${response.glow.x}px, ${response.glow.y}px, 0)`;
            opacity = response.strength * responseTint;
          } else if (enabled) {
            opacity =
              response.strength *
              response.edges[EDGES.indexOf(part as (typeof EDGES)[number])] *
              responseRim;
          }
          leaf.style.opacity = String(opacity);
        }
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(paint);
    }
    function invalidate() {
      dirty = true;
      schedule();
    }
    function promote(active: boolean) {
      for (const target of targets)
        for (const leaf of target.leaves) {
          if (active)
            leaf.style.willChange =
              leaf.dataset.part === "shadow" || leaf.dataset.part === "glow"
                ? "transform, opacity"
                : "opacity";
          else leaf.style.removeProperty("will-change");
        }
    }
    const resize = new ResizeObserver(invalidate);
    resize.observe(root);
    nodes.forEach((node) => resize.observe(node));
    // Radix can reposition its portal without resizing it (collision/flip).
    const portalPlacement = new MutationObserver(invalidate);
    for (const node of nodes)
      if (isLensSurface(node) && node.parentElement)
        portalPlacement.observe(node.parentElement, {
          attributes: true,
          attributeFilter: ["style"],
        });
    window.addEventListener("resize", invalidate);
    window.addEventListener("scroll", invalidate, true);
    const cleanups = handles.map((handle, index) => {
      function move(event: PointerEvent) {
        if (event.pointerId !== activePointer) return;
        positions.current[index] = {
          x: clamp((event.clientX - bounds.x) / Math.max(1, bounds.width), 0.02, 0.98),
          y: clamp((event.clientY - bounds.y) / Math.max(1, bounds.height), 0.02, 0.98),
        };
        schedule();
      }
      function down(event: PointerEvent) {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.focus();
        activePointer = event.pointerId;
        promote(true);
        handle.setPointerCapture(event.pointerId);
        move(event);
      }
      function up() {
        if (activePointer === null) return;
        activePointer = null;
        promote(false);
        commitPlacement();
      }
      function key(event: KeyboardEvent) {
        const directions: Record<string, Point> = {
          ArrowLeft: { x: -1, y: 0 },
          ArrowRight: { x: 1, y: 0 },
          ArrowUp: { x: 0, y: -1 },
          ArrowDown: { x: 0, y: 1 },
        };
        const direction = directions[event.key];
        if (!direction) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.01 : 0.04;
        const current = positions.current[index];
        positions.current[index] = {
          x: clamp(current.x + direction.x * step, 0.02, 0.98),
          y: clamp(current.y + direction.y * step, 0.02, 0.98),
        };
        schedule();
        commitPlacement();
      }
      handle.addEventListener("pointerdown", down);
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
      handle.addEventListener("lostpointercapture", up);
      handle.addEventListener("keydown", key);
      return () => {
        handle.removeEventListener("pointerdown", down);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        handle.removeEventListener("lostpointercapture", up);
        handle.removeEventListener("keydown", key);
      };
    });
    requestPaint.current = schedule;
    schedule();
    return () => {
      requestPaint.current = null;
      cancelAnimationFrame(frame);
      promote(false);
      resize.disconnect();
      portalPlacement.disconnect();
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("scroll", invalidate, true);
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [stage, lens, layout, extraSurfaces]);
}
