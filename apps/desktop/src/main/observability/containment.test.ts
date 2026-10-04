/**
 * The property the whole export slice exists to keep: telemetry stays in main.
 *
 * Every other suite here checks a module. This one checks the seams between
 * them, in the same spirit as `../web/secrecy.test.ts` — because the failure
 * worth catching is not in the exporter that knows it is exporting, it is in
 * some future import two layers away that pulls the SDK into a process that
 * should never hold one.
 *
 * Two rules, both structural, both read off the actual source tree rather than
 * asserted about a mock:
 *
 * 1. **OpenTelemetry stays in host-core's observability directory.** The exporter
 *    moved to `@volli/host-core` (VC-622), so no desktop source —
 *    renderer, preload or main — has a reason to name an OpenTelemetry package
 *    any more. The renderer renders untrusted model output and the preload is
 *    the sandboxed bridge; a tracer in either is an exporter behind a hostile
 *    surface.
 *
 * 2. **Nothing reads or writes `OTEL_*` through `process.env`.** Volli
 *    configures both signal exporters from a Settings row. Writing the same configuration into the
 *    process environment would put it one `inheritEnv` away from every tool a
 *    model can run — and `piExecutionEnv`'s allowlist is a second line, not a
 *    licence to leak into the first.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** `apps/desktop/src`, from this file rather than from a working directory. */
const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** The move must keep both static guards on the exporter and its new neighbours. */
const HOST_SRC = join(SRC, "../../../packages/host-core/src");
const HOST_EXPORTER_DIR = join(HOST_SRC, "observability");

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "dist-electron") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(?:ts|tsx|mts|cts)$/.test(entry)) found.push(path);
    }
  };
  walk(root);
  return found;
}

/**
 * This file, excluded from its own scans.
 *
 * It states the two rules, so it necessarily contains the shapes it forbids —
 * in a regex and in the prose explaining one. It is the specification, not a
 * subject of it.
 */
const SELF = fileURLToPath(import.meta.url);

const ALL_SOURCES = sourceFiles(SRC).filter((path) => path !== SELF);
const HOST_SOURCES = sourceFiles(HOST_SRC);

describe("OpenTelemetry stays in Electron main", () => {
  it("finds the desktop sources it is meant to be checking", () => {
    // A guard on the guard: a walk that silently found nothing would pass every
    // assertion below while proving nothing at all.
    expect(ALL_SOURCES.length).toBeGreaterThan(100);
    expect(ALL_SOURCES.some((path) => path.startsWith(join(SRC, "renderer")))).toBe(true);
    expect(ALL_SOURCES.some((path) => path.startsWith(join(SRC, "preload")))).toBe(true);
  });

  it("is named only by host-core's observability modules (VC-622)", () => {
    const offenders = [...ALL_SOURCES, ...HOST_SOURCES].filter(
      (path) =>
        !path.startsWith(HOST_EXPORTER_DIR) &&
        readFileSync(path, "utf8").includes("@opentelemetry/"),
    );
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
  });

  it("is reachable from the exporter's own modules in @volli/host-core, so the rule above has teeth", () => {
    const naming = sourceFiles(HOST_EXPORTER_DIR).filter((path) =>
      readFileSync(path, "utf8").includes("@opentelemetry/"),
    );
    expect(naming.length).toBeGreaterThan(0);
  });

  it("is not reached indirectly, because nothing outside main imports the exporter", () => {
    const outsideMain = ALL_SOURCES.filter((path) => !path.startsWith(join(SRC, "main")));
    const offenders = outsideMain.filter((path) =>
      /from\s+["'][^"']*observability\/(?:otlp|settings|sink|genai)["']/.test(
        readFileSync(path, "utf8"),
      ),
    );
    expect(offenders.map((path) => path.slice(SRC.length))).toEqual([]);
  });
});

describe("OTEL_* never enters the process environment", () => {
  it("is read or written by no desktop or host-core source", () => {
    // Matches `process.env.OTEL_…` and `process.env["OTEL_…"]` in either
    // direction. The Settings owner passes an explicit address to both OTLP
    // signal exporters, so no source has a reason to inspect an ambient value.
    const accesses = /process\.env(?:\.OTEL_|\[\s*["'`]OTEL_)/;
    const offenders = [...ALL_SOURCES, ...HOST_SOURCES].filter((path) =>
      accesses.test(readFileSync(path, "utf8")),
    );
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
  });

  it("is not set on this process by the exporter modules themselves", async () => {
    const before = Object.keys(process.env).filter((name) => name.startsWith("OTEL_"));
    // Importing every exporter module — from @volli/host-core, where they
    // moved (VC-622) — is the strongest available check that module-load side
    // effects do not configure OpenTelemetry through the environment — which is
    // how most OTel setups are wired, and is exactly what Volli must not do.
    await import("@volli/host-core/observability/otlp");
    await import("@volli/host-core/observability/settings");
    await import("@volli/host-core/observability/sink");
    await import("@volli/host-core/observability/genai");
    expect(Object.keys(process.env).filter((name) => name.startsWith("OTEL_"))).toEqual(before);
  });
});
