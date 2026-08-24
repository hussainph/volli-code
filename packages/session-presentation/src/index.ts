/**
 * The Session Presentation Contract — the portable consumer boundary that
 * projects Session Semantic Facts into the Session Surface Model a Volli
 * client renders (CONTEXT.md defines both terms).
 *
 * Everything exported here is framework-neutral by construction, not by
 * discipline: this package's tsconfig strips the DOM lib and its manifest
 * declares neither React nor Electron, so a `window` reference or a JSX
 * import fails typecheck/install instead of review. Each Volli client — the
 * desktop renderer today, a second client tomorrow — maps this surface model
 * to its own components without reinterpreting runtime-native data
 * (docs/BOUNDARIES.md: clients talk to hosts; shared vocabulary, not
 * transport).
 */
export * from "./activity";
export * from "./compaction-boundary";
export * from "./composer-effort";
export * from "./composer-stack";
export * from "./context-usage";
export * from "./interaction";
export * from "./markdown-source";
export * from "./message-projection";
export * from "./session-model";
export * from "./transcript";
export * from "./wire";
