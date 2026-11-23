import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { notices } from "./notices.ts";

/**
 * The page `openapi-proxy dev` serves at `/`: the variant editor over a
 * definition file. It is built once, into the package, as a document and the
 * few files it loads. Nothing is fetched from anywhere when it runs.
 */
export default defineConfig({
  root: "page",
  base: "./",
  // The stylesheet brings in Tailwind's base styles, the animations and the font.
  plugins: [
    tailwindcss(),
    react(),
    notices(["tailwindcss", "tw-animate-css", "@fontsource-variable/inter"]),
  ],
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: "../dist/editor",
    emptyOutDir: true,
    assetsDir: "assets",
    // One script and one stylesheet: the page is opened from localhost, where a request costs nothing.
    rolldownOptions: { output: { codeSplitting: false } },
    chunkSizeWarningLimit: 2000,
  },
});
