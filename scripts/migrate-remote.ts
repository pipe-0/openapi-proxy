/**
 * Apply D1 migrations to the remote database of the build that was just made.
 *
 * `vite build` writes the Worker's effective Wrangler configuration (with the
 * real database id, wherever that came from) next to the bundle and leaves a
 * pointer to it. `wrangler deploy` follows that pointer by itself; the D1
 * commands do not, so this hands them the same file.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pointer = resolve(".wrangler/deploy/config.json");
let configPath: string;
try {
  configPath = (JSON.parse(readFileSync(pointer, "utf8")) as { configPath: string }).configPath;
} catch {
  console.error("No build found. Run `vite build` first (or use `pnpm run deploy`).");
  process.exit(1);
}

const result = spawnSync(
  "wrangler",
  [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--remote",
    "--config",
    resolve(dirname(pointer), configPath),
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
