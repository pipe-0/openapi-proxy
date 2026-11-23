import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/**
 * The package bundles other people's code, so it carries their license
 * notices: one file per bundle, written when it is built, from the modules
 * that actually went into it.
 */
interface Bundled {
  name: string;
  version: string;
  license: string;
  text: string | undefined;
}

/** The package a module belongs to: the nearest folder above it whose package.json names one. */
function packageOf(file: string): string | undefined {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, version } = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    if (typeof name === "string" && typeof version === "string") return dir;
  }
  return undefined;
}

function read(dir: string): Bundled {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license?: string;
  };
  const file = readdirSync(dir).find((name) => /^(licen[sc]e|copying|notice)(\.|-|$)/i.test(name));
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? "see the package",
    text: file ? readFileSync(join(dir, file), "utf8").trim() : undefined,
  };
}

/**
 * Write THIRD-PARTY-NOTICES.txt next to a bundle. `also` names packages that
 * are in it without being modules of their own: stylesheets and fonts that a
 * stylesheet brings in.
 */
export function notices(also: string[] = []): Plugin {
  return {
    name: "third-party-notices",
    generateBundle() {
      const dirs = new Set<string>();
      for (const id of this.getModuleIds()) {
        const file = id.split("?")[0] ?? "";
        if (!file.includes("/node_modules/") || !existsSync(file)) continue;
        const dir = packageOf(file);
        if (dir) dirs.add(realpathSync(dir));
      }
      for (const name of also) dirs.add(realpathSync(join(process.cwd(), "node_modules", name)));

      const bundled = new Map<string, Bundled>();
      for (const dir of dirs) {
        const entry = read(dir);
        bundled.set(`${entry.name}@${entry.version}`, entry);
      }
      const entries = [...bundled.values()].sort((a, b) => a.name.localeCompare(b.name));
      if (entries.length === 0) this.error("No bundled package was found to give notice of.");

      const rule = "-".repeat(72);
      this.emitFile({
        type: "asset",
        fileName: "THIRD-PARTY-NOTICES.txt",
        source: [
          "@pipe0/openapi-proxy includes the following packages. Each is used under its own license.",
          "",
          ...entries.map((entry) => `  ${entry.name} ${entry.version} (${entry.license})`),
          "",
          ...entries.flatMap((entry) => [
            rule,
            `${entry.name} ${entry.version}`,
            `License: ${entry.license}`,
            "",
            entry.text ?? "The package ships no license file. See its repository.",
            "",
          ]),
        ].join("\n"),
      });
    },
  };
}
