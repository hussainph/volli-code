import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      include: ["src/**"],
      exclude: ["src/index.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
  pack: {
    entry: { volli: "src/index.ts" },
    format: "cjs",
    outDir: "dist",
    outExtensions: () => ({ js: ".cjs" }),
    clean: true,
    deps: { alwaysBundle: (id: string) => id.startsWith("@volli/") },
  },
});
