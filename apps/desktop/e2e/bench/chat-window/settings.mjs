/** The same normalized recipe is sent to each fresh guarded instance. */
const defaults = {
  sessions: 10,
  turns: 2000,
  arm: "transcript",
  label: "run",
  streamSamples: 8,
  streamSteps: 120,
  streamTokenRate: 30,
  streamContent: "code",
  diagramSampleMs: null,
  draftPlanes: 2,
  draftBallast: 8000,
  draftKeys: 150,
  draftKeyInterval: 60,
  draftCpuThrottle: 1,
  revealPlanes: 2,
  revealSwitches: 30,
  revealInterval: 400,
  revealBallast: 0,
  revealCpuThrottle: 1,
  phases: false,
  draftTrace: null,
  revealTrace: null,
  streamTrace: null,
};
export function benchSettings(input = {}) {
  for (const key of Object.keys(input)) {
    if (!(key in defaults)) throw new Error(`unknown bench setting: ${key}`);
  }
  const result = { ...defaults, ...input };
  if (!["transcript", "draft", "reveal", "stream"].includes(result.arm))
    throw new Error("--arm is transcript, draft, reveal or stream");
  if (!["code", "diagram"].includes(result.streamContent))
    throw new Error("--stream-content is code or diagram");
  if (result.streamContent === "diagram" && !["stream", "transcript"].includes(result.arm))
    throw new Error("diagram content requires --arm stream or transcript");
  if (result.diagramSampleMs !== null) {
    if (
      result.streamContent !== "diagram" ||
      ![0, 100, "0", "100"].includes(result.diagramSampleMs)
    )
      throw new Error("--diagram-sample-ms requires diagram content and 0 or 100");
    result.diagramSampleMs = Number(result.diagramSampleMs);
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value !== "number") continue;
    const number = Number(result[key]);
    if (
      !Number.isFinite(number) ||
      number < (key.endsWith("Ballast") ? 0 : 1) ||
      number > 1_000_000
    )
      throw new Error(`invalid ${key}`);
    if (!key.endsWith("Throttle") && !Number.isInteger(number)) throw new Error(`invalid ${key}`);
    result[key] = number;
  }
  if (typeof result.label !== "string" || typeof result.phases !== "boolean")
    throw new Error("invalid label/phases");
  for (const arm of ["draft", "reveal", "stream"]) {
    const key = `${arm}Trace`;
    if (result[key] !== null && typeof result[key] !== "string") throw new Error(`invalid ${key}`);
    if (
      result[key] !== null &&
      result.arm !== arm &&
      !(arm === "stream" && result.arm === "transcript")
    )
      throw new Error(`${key} does not match --arm ${result.arm}`);
  }
  return result;
}

export function parseBenchArgs(args) {
  const options = {
    settings: {},
    skipBuild: false,
    prepareOnly: false,
    compare: null,
    output: null,
  };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["skipBuild", "prepareOnly"].includes(key)) {
      options[key] = true;
      continue;
    }
    if (key === "phases") {
      options.settings.phases = true;
      continue;
    }
    if (key === "compare") {
      options.compare = [args[++index], args[++index]];
      if (options.compare.some((ref) => !ref || ref.startsWith("--")))
        throw new Error("--compare needs two source revisions");
      continue;
    }
    const value = args[++index];
    if (!name.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new Error(`missing value for ${name}`);
    if (key === "output") options.output = value;
    else options.settings[key] = value;
  }
  options.settings = benchSettings(options.settings);
  if (options.prepareOnly && !options.compare) throw new Error("--prepare-only requires --compare");
  return options;
}
