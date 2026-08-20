import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The API contract, resolved to source.
      //
      // The published subpath points at `dist/`, which would make the dev
      // server depend on the contracts package having been built first. The
      // test runner already aliases these to source for the same reason; the
      // bundler should not disagree with it about what a module is.
      "@acalys/contracts/api/v1": path.resolve(
        __dirname,
        "../../packages/contracts/src/api/v1/index.ts",
      ),
    },
  },
  server: { port: 5173, host: true },
});
