import { copyFileSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { notices } from "./notices.ts";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

/**
 * The command line tool as one file with nothing to install beside it: the
 * engine, the YAML library and the local server are all bundled in. Whoever
 * runs `npx @pipe0/openapi-proxy` downloads this package and nothing else.
 */
export default defineConfig({
  // What `--version` prints is what package.json says, read when the tool is built.
  define: { __VERSION__: JSON.stringify(version) },
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
    notices(),
    {
      name: "definition-schema",
      // The schema of the installed version, for editors and agents that are offline.
      closeBundle() {
        copyFileSync("../../public/schema/definition.v1.json", "schema.json");
      },
    },
  ],
});
