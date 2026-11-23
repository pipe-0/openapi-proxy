import { normalizeSelection } from "../selection/edit.js";
import { isValidPathPrefix, normalizePathPrefix } from "../transforms/merge.js";
import { type DocumentOverrides, readOverrides } from "../transforms/override.js";
import { isJsonObject, type JsonObject, type Selection } from "../types.js";
import {
  DEFINITION_SHAPE,
  DEFINITION_VERSIONS,
  type ProjectDefinition,
  SELECTION_SHAPE,
  type SourceDefinition,
  type VariantDefinition,
  type Visibility,
} from "./format.js";
import type { VariantIconName } from "./icons.js";
import { check, type Problem } from "./shape.js";

export type ReadDefinition = { definition: ProjectDefinition } | { problems: Problem[] };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether an address is this machine's own. Plain HTTP is only ever accepted for these. */
export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname) || hostname.endsWith(".localhost");
}

function overridesAt(
  value: unknown,
  path: string,
  problems: Problem[],
): DocumentOverrides | undefined {
  if (value === undefined) return undefined;
  // What is wrong inside it has been said already, at the key it is at.
  if (problems.some((problem) => problem.path.startsWith(path))) return undefined;
  const read = readOverrides(value);
  if (read && "problem" in read) {
    problems.push({ path, message: read.problem });
    return undefined;
  }
  return read ?? undefined;
}

function sourceAt(
  raw: JsonObject,
  path: string,
  problems: Problem[],
): SourceDefinition | undefined {
  const source: SourceDefinition = {};
  if (typeof raw.name === "string") source.name = raw.name;

  const hasUrl = typeof raw.url === "string";
  const hasFile = typeof raw.file === "string";
  if (hasUrl && hasFile) {
    problems.push({ path, message: "has both url and file. A source is one or the other." });
    return undefined;
  }
  if (!hasUrl && !hasFile) {
    // A url or file that was there and did not fit has been reported already.
    if (!("url" in raw) && !("file" in raw)) {
      problems.push({ path, message: "needs a url or a file." });
    }
    return undefined;
  }
  if (hasUrl) {
    try {
      const url = new URL(raw.url as string);
      url.hash = "";
      source.url = url.href;
    } catch {
      problems.push({ path: `${path}.url`, message: "is not a valid address." });
      return undefined;
    }
  } else {
    source.file = raw.file as string;
  }

  if (raw.main === true) source.main = true;
  if (raw.follow === true) {
    if (hasFile) {
      problems.push({
        path: `${path}.follow`,
        message: "is only for a url: a file changes with a deploy and has nothing to follow.",
      });
    } else {
      source.follow = true;
    }
  }
  if (typeof raw.pathPrefix === "string") {
    const prefix = normalizePathPrefix(raw.pathPrefix);
    if (prefix !== undefined) {
      if (isValidPathPrefix(prefix)) source.pathPrefix = prefix;
      else {
        problems.push({
          path: `${path}.pathPrefix`,
          message:
            "must be path segments of letters, digits, dots, hyphens and underscores, such as /billing.",
        });
      }
    }
  }
  return source;
}

function sourcesAt(raw: unknown, problems: Problem[]): SourceDefinition[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) {
    problems.push({ path: "sources", message: "needs at least one source." });
    return [];
  }
  const sources: SourceDefinition[] = [];
  let sound = true;
  raw.forEach((item, index) => {
    const source = isJsonObject(item) ? sourceAt(item, `sources[${index}]`, problems) : undefined;
    if (source) sources.push(source);
    else sound = false;
  });
  // What holds between sources is only worth saying once each of them is sound.
  if (!sound) return sources;

  const urls = new Map<string, number>();
  sources.forEach((source, index) => {
    if (!source.url) return;
    const first = urls.get(source.url);
    if (first === undefined) urls.set(source.url, index);
    else {
      problems.push({
        path: `sources[${index}].url`,
        message: `is the same address as sources[${first}]. A document is in a project once.`,
      });
    }
  });

  if (sources.length === 1) {
    // The only source is the main one; saying so adds nothing.
    delete sources[0]?.main;
    return sources;
  }
  const names = new Map<string, number>();
  sources.forEach((source, index) => {
    if (!source.name) {
      problems.push({
        path: `sources[${index}].name`,
        message: "is required when a project has several sources.",
      });
      return;
    }
    const key = source.name.toLowerCase();
    const first = names.get(key);
    if (first === undefined) names.set(key, index);
    else {
      problems.push({
        path: `sources[${index}].name`,
        message: `is also the name of sources[${first}]. Each source needs a name of its own.`,
      });
    }
  });
  const mains = sources.filter((source) => source.main).length;
  if (mains !== 1) {
    problems.push({
      path: "sources",
      message: `exactly one source needs main: true (found ${mains}). It is the one whose title, description and servers describe the merged document.`,
    });
  }
  return sources;
}

function variantAt(raw: JsonObject, path: string, problems: Problem[]): VariantDefinition {
  const variant: VariantDefinition = {};
  if (typeof raw.name === "string") variant.name = raw.name;
  if (typeof raw.icon === "string") variant.icon = raw.icon as VariantIconName;
  if (typeof raw.visibility === "string") variant.visibility = raw.visibility as Visibility;
  const selection = normalizeSelection({
    ...(isJsonObject(raw.include) ? { include: raw.include } : {}),
    ...(isJsonObject(raw.exclude) ? { exclude: raw.exclude } : {}),
  } as Selection);
  if (selection.include) variant.include = selection.include;
  if (selection.exclude) variant.exclude = selection.exclude;
  const overrides = overridesAt(raw.overrides, `${path}.overrides`, problems);
  if (overrides) variant.overrides = overrides;
  return variant;
}

/**
 * Read a definition from plain data, as parsed from YAML or JSON. Gives the
 * definition in its one stored form (text trimmed, lists sorted and without
 * duplicates, what says nothing left out), or every problem found, each with
 * the place it is at.
 */
export function readDefinition(input: unknown): ReadDefinition {
  const problems: Problem[] = [];
  if (isJsonObject(input) && "version" in input && input.version !== 1) {
    // Another version may have other keys, so nothing else is said about it.
    return {
      problems: [
        {
          path: "version",
          message: `${JSON.stringify(input.version)} is not a version of the format this reads.`,
          allowed: DEFINITION_VERSIONS.map(String),
        },
      ],
    };
  }

  const raw = check(DEFINITION_SHAPE, input, "", problems);
  if (!isJsonObject(raw)) return { problems };

  const definition: ProjectDefinition = {
    version: 1,
    project: typeof raw.project === "string" ? raw.project : "",
    sources: [],
    variants: {},
  };
  const ordered: Partial<ProjectDefinition> = {};
  if (typeof raw.name === "string") ordered.name = raw.name;
  if (typeof raw.instance === "string") {
    try {
      const url = new URL(raw.instance);
      if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
        problems.push({
          path: "instance",
          message:
            "must start with https://. Plain http:// is only for an instance on this machine.",
        });
      } else {
        ordered.instance = url.origin;
      }
    } catch {
      problems.push({ path: "instance", message: "is not a valid address." });
    }
  }
  if (typeof raw.visibility === "string") ordered.visibility = raw.visibility as Visibility;
  const overrides = overridesAt(raw.overrides, "overrides", problems);
  if (overrides) ordered.overrides = overrides;

  definition.sources = sourcesAt(raw.sources, problems);
  if (isJsonObject(raw.variants)) {
    for (const [slug, variant] of Object.entries(raw.variants)) {
      if (isJsonObject(variant)) {
        definition.variants[slug] = variantAt(variant, `variants.${slug}`, problems);
      }
    }
  }

  if (problems.length > 0) return { problems };
  const { version, project, sources, variants } = definition;
  return { definition: { version, project, ...ordered, sources, variants } };
}

export type ReadSelection = { selection: Selection } | { problems: Problem[] };

/** Read a selection by itself, into its stored form. */
export function readSelection(input: unknown): ReadSelection {
  const problems: Problem[] = [];
  const raw = check(SELECTION_SHAPE, input, "", problems);
  if (problems.length > 0 || !isJsonObject(raw)) return { problems };
  return { selection: normalizeSelection(raw as Selection) };
}

/** A problem as one line, for a person or a log. */
export function describeProblem(problem: Problem): string {
  const allowed = problem.allowed ? ` Allowed: ${problem.allowed.join(", ")}.` : "";
  return `${problem.path === "" ? "The definition" : problem.path} ${problem.message}${allowed}`;
}

/**
 * Things in a sound definition that are probably not what was meant. They
 * stop nothing.
 */
export function warningsOf(definition: ProjectDefinition): Problem[] {
  const warnings: Problem[] = [];
  for (const [slug, variant] of Object.entries(definition.variants)) {
    const { include } = variant;
    if (include && !include.tags?.length && !include.operations?.length) {
      warnings.push({
        path: `variants.${slug}.include`,
        message:
          "names nothing, so this variant serves nothing. Leave include out to serve everything.",
      });
    }
  }
  return warnings;
}
