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
