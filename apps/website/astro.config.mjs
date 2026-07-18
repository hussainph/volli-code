import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  site: "https://volli-code.pages.dev",
  integrations: [react()],
});
