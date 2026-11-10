import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function assertProductionReact(distDir) {
  const assets = join(distDir, "assets");
  const entries = await readdir(assets).catch(() => []);
  const bundles = entries.filter((name) => name.startsWith("index-") && name.endsWith(".js"));
  if (bundles.length === 0) throw new Error(`no bench bundle found in ${assets}`);
  // String literals survive minification; identifiers do not. The first two
  // exist only in react-dom's development build; `jsxDEV)(` is the minified
  // shape of a development JSX call, which carries per-element source metadata
  // and, against production React, does not even run.
  const developmentOnly = [
    "Consider memoization",
    "Each child in a list should have a unique",
    "jsxDEV)(",
  ];
  for (const bundle of bundles) {
    const source = await readFile(join(assets, bundle), "utf8");
    const found = developmentOnly.filter((marker) => source.includes(marker));
    if (found.length > 0) {
      throw new Error(
        `${bundle} was built for development (${found.join(", ")}); the bench must measure the build the app ships`,
      );
    }
  }
}

/** Read-only, bench-build-only instrumentation; product sources stay untouched.
 * Receiving production wiring: pele-diagram.tsx must keep its local
 * `const SAMPLE_MS = 100;` and be reached by ChatPlane. An absent or changed
 * seam fails the build; never add a product runtime cadence setting for this.
 */
export function diagramCadencePlugin(diagramSampleMs) {
  if (![null, 0, 100].includes(diagramSampleMs)) throw new Error("invalid diagram cadence");
  let transformed = false;
  return {
    name: "bench-only-diagram-cadence",
    enforce: "pre",
    buildStart() {
      transformed = false;
    },
    transform(source, id) {
      if (diagramSampleMs === null || !id.endsWith("/components/ui/ai-elements/pele-diagram.tsx"))
        return;
      const constant = "const SAMPLE_MS = 100;";
      if (source.split(constant).length !== 2)
        throw new Error("diagram sampling constant changed; update the benchmark probe");
      transformed = true;
      return source.replace(constant, `const SAMPLE_MS = ${diagramSampleMs};`);
    },
    generateBundle() {
      if (diagramSampleMs !== null && !transformed)
        throw new Error("diagram cadence transform did not run; refusing a vacuous comparison");
      this.emitFile({
        type: "asset",
        fileName: ".chat-window-cadence.json",
        source: JSON.stringify({ version: 1, diagramSampleMs }) + "\n",
      });
    },
  };
}

/** The driver must not measure a differently instrumented/stale bundle. */
export async function readBenchCadence(distDir, diagramSampleMs) {
  const artifact = JSON.parse(await readFile(join(distDir, ".chat-window-cadence.json"), "utf8"));
  if (
    artifact.version !== 1 ||
    ![null, 0, 100].includes(artifact.diagramSampleMs) ||
    artifact.diagramSampleMs !== diagramSampleMs
  )
    throw new Error(
      "bench cadence artifact does not match settings; rebuild through the guarded entry",
    );
  return artifact;
}
