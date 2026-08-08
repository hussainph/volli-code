import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// The live smoke talks to a real provider through the developer's own Pi
// credentials, so it gets no offline setup file and no coverage gate.
export default defineConfig({
  test: {
    include: ["smoke/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
