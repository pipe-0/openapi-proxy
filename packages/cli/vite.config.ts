import { copyFileSync } from "node:fs";
import { defineConfig } from "vite";

/**
 * The command line tool as one file with nothing to install beside it: the
 * engine, the YAML library and the local server are all bundled in. Whoever
 * runs `npx @pipe0/openapi-proxy` downloads this package and nothing else.
 */
export default defineConfig({
  build: {
    ssr: "src/cli.ts",
    target: "node20",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { entryFileNames: "cli.js", banner: "#!/usr/bin/env node" },
    },
  },
  ssr: { noExternal: true },
  plugins: [
    {
      name: "definition-schema",
      // The schema of the installed version, for editors and agents that are offline.
      closeBundle() {
        copyFileSync("../../public/schema/definition.v1.json", "schema.json");
      },
    },
  ],
});
