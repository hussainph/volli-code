/** What `WorldShader` asks of a shader engine, whichever one paints. */
export interface EngineOptions {
  /** 1 is the tuned calm pace; 0 paints one still frame and never ticks. */
  speed: number;
  /** Where in time to start, in ms — carries a world's motion across remounts. */
  frame: number;
  /** The device-pixel-ratio ceiling for the backing canvas. */
  maxDpr: number;
  /** The first frame is on screen: safe to fade in over the static paint. */
  onReady(): void;
  /** The GPU took the context back: fall back to the static paint. */
  onLost(): void;
}

export interface WorldEngine {
  setPlaying(on: boolean): void;
  /** Current time in ms, to resume from after a remount. */
  frame(): number;
  dispose(): void;
}

/** Paper Shaders' MeshGradient: the one living light the site uses. */
export type WorldShaderVariant = "mesh";
