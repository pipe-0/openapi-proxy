import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Problem, type ProjectDefinition, readDefinition } from "@openapi-proxy/core";
import { type Document, isMap, isScalar, LineCounter, type Node, parseDocument } from "yaml";

/** The file every command reads unless it is told another. */
export const DEFAULT_CONFIG = "openapi-proxy.yaml";

/** A problem in a definition file, with the line it is on where that is known. */
export interface FileProblem extends Problem {
  line?: number;
}

/** A definition file that could be read. */
export interface Config {
  /** Absolute path of the file. */
  path: string;
  /** Its folder: what `file:` sources are relative to. */
  dir: string;
  text: string;
  definition: ProjectDefinition;
}

/** There is no definition file where one was looked for. */
export class NoConfigError extends Error {
  constructor(readonly path: string) {
    super(`There is no ${path}.`);
    this.name = "NoConfigError";
  }
}

/** The file is there and does not hold a definition. */
export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly problems: FileProblem[],
  ) {
    super(`${path} is not a valid definition.`);
    this.name = "ConfigError";
  }
}

/** The steps of a path such as `sources[1].url` or `variants.public.icon`. */
function steps(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const part of path.split(".")) {
    const match = /^(.*?)((?:\[\d+\])*)$/.exec(part);
    if (!match) continue;
    if (match[1] !== "") out.push(match[1] as string);
    for (const index of (match[2] as string).matchAll(/\[(\d+)\]/g)) out.push(Number(index[1]));
  }
  return out;
}

/**
 * The line a path of the definition is written on, counted from 1. For a key
 * of a map that is the line of the key itself, so that a key which should not
 * be there, or one whose value starts on the next line, is pointed at where
 * it is written. A path that leads nowhere points at the nearest thing that
 * is there.
 */
export function lineOf(doc: Document, counter: LineCounter, path: string): number | undefined {
  const way = steps(path);
  const offsetOf = (node: unknown) => (node as Node | null | undefined)?.range?.[0];

  let offset: number | undefined = way.length === 0 ? 0 : undefined;
  for (let length = way.length; offset === undefined && length > 0; length--) {
    const parent = length === 1 ? doc.contents : doc.getIn(way.slice(0, length - 1), true);
    const last = way[length - 1];
    if (isMap(parent)) {
      const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === last);
      offset = offsetOf(pair?.key);
    } else {
      offset = offsetOf(doc.getIn(way.slice(0, length), true));
    }
  }
  return offset === undefined ? undefined : counter.linePos(offset).line;
}

export type ParsedConfig =
  | { definition: ProjectDefinition; doc: Document; counter: LineCounter }
  | { problems: FileProblem[] };

/** Read a definition from the text of a file. */
export function parseConfig(text: string): ParsedConfig {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: false });
  if (doc.errors.length > 0) {
    const lines = text.split("\n");
    // One problem per line: a single slip usually makes the parser complain twice.
    const seen = new Set<number>();
    return {
      problems: doc.errors.flatMap((error) => {
        const { line } = counter.linePos(error.pos[0]);
        if (seen.has(line)) return [];
        seen.add(line);
        // The slip that is easy to make here: a path with {braces} inside [a, b].
        const braces = /\[[^\]]*\{/.test(lines[line - 1] ?? "")
          ? " In a list written as [a, b], an operation with {braces} in its path needs quotes. Or write the list with one entry per line, each after a hyphen."
          : "";
        return [{ path: "", message: `is not valid YAML: ${error.message}.${braces}`, line }];
      }),
    };
  }
  const read = readDefinition(doc.toJS());
  if ("definition" in read) return { definition: read.definition, doc, counter };
  return {
    problems: read.problems.map((problem) => {
      const line = lineOf(doc, counter, problem.path);
      return line === undefined ? problem : { ...problem, line };
    }),
  };
}

/** Read the definition file at a path. Throws `NoConfigError` or `ConfigError`. */
export function loadConfig(file: string): Config {
  const path = resolve(file);
  if (!existsSync(path)) throw new NoConfigError(file);
  const text = readFileSync(path, "utf8");
  const parsed = parseConfig(text);
  if ("problems" in parsed) throw new ConfigError(file, parsed.problems);
  return { path, dir: dirname(path), text, definition: parsed.definition };
}
