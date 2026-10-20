#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, "../..");
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const declaredPackages = new Set(
  [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ].filter((name) => !name.startsWith("@volli/")),
);

function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const externalizeDeclaredPackages = {
  name: "externalize-agent-runtime-dependencies",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^.]/ }, (args) =>
      declaredPackages.has(packageOf(args.path)) ? { path: args.path, external: true } : null,
    );
  },
};

const temporaryDirectory = await mkdtemp(join(packageRoot, "node_modules", ".vc441-runner-"));
const bundlePath = join(temporaryDirectory, "runner.mjs");
try {
  await build({
    entryPoints: [join(scriptDirectory, "runner.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundlePath,
    plugins: [externalizeDeclaredPackages],
    logLevel: "silent",
  });
  await import(pathToFileURL(bundlePath).href);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
