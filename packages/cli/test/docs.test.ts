import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFINITION_SHAPE, keysOf, readDefinition, VARIANT_ICONS, WAYS } from "@openapi-proxy/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { noConfig } from "../src/no-config.js";
import { captured, EXAMPLES } from "./helpers.js";

/**
 * The docs are written by hand. These hold them to what the code knows: a key
 * the validator accepts, a flag the tool takes and a page the app links to
 * cannot be added, renamed or removed without the docs following.
 */
const ROOT = join(EXAMPLES, "..");
const DOCS = join(ROOT, "src/web/content/docs");
const page = (slug: string) => readFileSync(join(DOCS, `${slug}.mdx`), "utf8");
const oneLine = (text: string) => text.replace(/\s+/g, " ");

/** The part of a page under one heading, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => line.replace(/^#+\s*/, "") === heading && /^#/.test(line),
  );
  expect(start, `a heading "${heading}"`).toBeGreaterThan(-1);
  const level = (/^#+/.exec(lines[start] ?? "")?.[0] ?? "").length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+\s/.test(line) && (/^#+/.exec(line)?.[0] ?? "").length <= level,
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** Every file under a folder, by path. */
function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.endsWith(".gen.ts")) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

/** A heading as the address of its place on the page. */
const anchorOf = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");

describe("the configuration reference", () => {
  const reference = page("configuration");
  // Where the reference describes the keys of each part of the file.
  const describedIn = (parent: string): string => {
    if (parent === "") return "The project";
    if (parent === "sources[]") return "sources";
    if (parent === "variants.<slug>") return "variants";
    if (/\.(include|exclude)$/.test(parent)) return "include and exclude";
    return "overrides";
  };

  it("names every key the validator knows, where that part of the file is described", () => {
    const keys = keysOf(DEFINITION_SHAPE);
    expect(keys.length).toBeGreaterThan(25);
    for (const key of keys) {
      const cut = key.lastIndexOf(".");
      const parent = cut === -1 ? "" : key.slice(0, cut);
      const name = key.slice(cut + 1);
      expect(section(reference, describedIn(parent)), key).toContain(`\`${name}\``);
    }
  });

  it("names every icon a variant can have", () => {
    for (const icon of VARIANT_ICONS)
      expect(section(reference, "variants")).toContain(`\`${icon}\``);
  });

  it("has an example that is valid and uses every key", () => {
    const block = /```yaml\n([\s\S]*?)```/.exec(section(reference, "An example with every key"));
    const data = parse(block?.[1] ?? "") as unknown;
    expect(readDefinition(data)).not.toHaveProperty("problems");

    // The keys the example has, as the paths the format gives its own.
    const used = new Set<string>();
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, `${path}[]`);
      } else if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          const here = path === "variants" ? "variants.<slug>" : path ? `${path}.${key}` : key;
          used.add(here);
          walk(inner, here);
        }
      }
    };
    walk(data, "");
    expect(keysOf(DEFINITION_SHAPE).filter((key) => !used.has(key))).toEqual([]);
  });
});

describe("the reference of the command line tool", () => {
  it("names every command and every option the tool takes", () => {
    const source = readFileSync(join(ROOT, "packages/cli/src/cli.ts"), "utf8");
    const reference = page("cli");
    const options = new Set(source.match(/--[a-z][a-z-]+/g));
    expect(options.size).toBeGreaterThan(8);
    for (const option of options) expect(reference, option).toContain(option);
    for (const command of ["init", "dev", "validate", "operations", "deploy"]) {
      expect(reference).toMatch(new RegExp(`^## ${command}$`, "m"));
    }
  });
});

describe("links into the docs", () => {
  const pages = readdirSync(DOCS)
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => name.replace(/\.mdx$/, ""));
  const anchors = new Map(
    pages.map((slug) => [
      slug,
      new Set([...page(slug).matchAll(/^#+\s+(.+)$/gm)].map((match) => anchorOf(match[1] ?? ""))),
    ]),
  );

  it("lead to a page that exists, and to a heading it has", () => {
    const files = [
      ...filesIn(join(ROOT, "src/web")),
      ...filesIn(join(ROOT, "packages/editor/src")),
      ...filesIn(join(ROOT, "packages/cli/src")),
      ...filesIn(join(ROOT, "packages/cli/page")),
      ...filesIn(EXAMPLES),
      join(ROOT, "README.md"),
      join(ROOT, "packages/cli/README.md"),
    ].filter((path) => existsSync(path) && /\.(tsx?|mdx?|ya?ml|html)$/.test(path));

    let found = 0;
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      const links = [
        // An address, in prose or in code: of this site, or of no site in particular.
        ...[
          ...text.matchAll(
            /(?<![\w/-])(https?:\/\/[a-z0-9.:-]+)?\/docs\/([a-z0-9-]+)(?:\.md)?(?:#([a-z0-9-]+))?/g,
          ),
        ]
          .filter(([, site]) => !site || /\/\/(openapi-proxy\.app|localhost)/.test(site))
          .map(([, , slug, anchor]) => [slug, anchor] as const),
        // The app's own link into the docs.
        ...[...text.matchAll(/<DocsLink slug="([a-z0-9-]+)(?:#([a-z0-9-]+))?"/g)].map(
          ([, slug, anchor]) => [slug, anchor] as const,
        ),
      ];
      for (const [slug = "", anchor] of links) {
        // The start page is /docs, and its Markdown is /docs/index.md.
        if (slug === "index") continue;
        found += 1;
        expect(pages, `${path} links to /docs/${slug}`).toContain(slug);
        if (anchor) {
          expect(
            [...(anchors.get(slug) ?? [])],
            `${path} links to /docs/${slug}#${anchor}`,
          ).toContain(anchor);
        }
      }
    }
    expect(found).toBeGreaterThan(40);
  });

  it("are listed in the order of the sidebar, every page once", () => {
    const meta = JSON.parse(readFileSync(join(DOCS, "meta.json"), "utf8")) as { pages: string[] };
    const listed = meta.pages.filter((entry) => !entry.startsWith("---"));
    expect([...listed].sort()).toEqual([...pages].sort());
  });
});

describe("the two ways to make a project", () => {
  const sentences = [WAYS.url.when, WAYS.repository.when];

  it("are described in the same words on the first page of the docs and in the README", () => {
    for (const path of [join(DOCS, "index.mdx"), join(ROOT, "README.md")]) {
      const text = readFileSync(path, "utf8");
      expect(text, path).toContain(`**${WAYS.url.title}.** ${WAYS.url.when}`);
      expect(text, path).toContain(`**${WAYS.repository.title}.** ${WAYS.repository.when}`);
    }
  });

  it("are taken from one place by the app and by the landing page", () => {
    for (const path of ["src/web/pages/connect.tsx", "src/web/site/landing.tsx"]) {
      const text = readFileSync(join(ROOT, path), "utf8");
      expect(text, path).toMatch(/WAYS(\.|\[)/);
      // And not written out a second time next to it.
      for (const sentence of sentences) expect(text, path).not.toContain(sentence);
    }
  });

  it("are what the tool says when it finds no definition file", async () => {
    const { err } = await captured(async () => noConfig("openapi-proxy.yaml"));
    expect(err).toContain("There is no openapi-proxy.yaml here.");
    for (const sentence of sentences) expect(oneLine(err)).toContain(sentence);
    expect(err).toContain("openapi-proxy init <url or file of your OpenAPI document>");
    // No line is wider than a terminal.
    for (const line of err.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });
});
