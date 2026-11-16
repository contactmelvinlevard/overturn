import { defineConfig } from "tsup";
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["iife"],
  globalName: "OverturnFront",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  clean: true,
  minify: true,
  noExternal: ["@overturn-ai/shared", "@frontapp/plugin-sdk"],
  outDir: "dist",
});
