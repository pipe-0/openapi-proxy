import { type Problem, unmatchedCount, warningsOf } from "@openapi-proxy/core";
import {
  type Config,
  ConfigError,
  type FileProblem,
  lineOf,
  loadConfig,
  parseConfig,
} from "../config.js";
import { fail, green, note, plural, print, warn } from "../output.js";
import { describe, type Project, summarize } from "../project.js";
import { readSourceFlags, readSources, SourceError } from "../sources.js";

/** A problem as a line that an editor can jump to: `file:line  path message`. */
export function problemLine(file: string, problem: FileProblem): string {
  const where = problem.line === undefined ? file : `${file}:${problem.line}`;
  const allowed = problem.allowed ? ` Allowed: ${problem.allowed.join(", ")}.` : "";
  const subject = problem.path === "" ? "The file" : problem.path;
  return `${where}  ${subject} ${problem.message}${allowed}`;
}

/** Finds the line of a path in a file that is known to be sound, for warnings. */
function lineFinder(config: Config): (path: string) => number | undefined {
  const parsed = parseConfig(config.text);
  return (path) => ("problems" in parsed ? undefined : lineOf(parsed.doc, parsed.counter, path));
}

/**
 * Check a definition file: its shape against the format, and its names
 * against the documents it points at. What is wrong with the file is an
 * error. A name the documents do not have is only said, because a file is
 * often written before the API it describes is live.
 */
export async function validate(options: { config: string; sources: string[] }): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(options.config);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    for (const problem of error.problems) fail(problemLine(error.path, problem));
    note(`\n${plural(error.problems.length, "problem")} in ${error.path}.`);
    return 1;
  }

  const lineIn = lineFinder(config);
  const located = (problem: Problem) => {
    const line = lineIn(problem.path);
    return problemLine(options.config, line === undefined ? problem : { ...problem, line });
  };
  for (const warning of warningsOf(config.definition)) warn(located(warning));

  let project: Project;
  try {
    const overrides = readSourceFlags(options.sources, config.definition);
    project = { config, sources: await readSources(config, overrides) };
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    print(`${green("ok")} ${options.config} is a valid definition.`);
    warn(`${error.message} The names in the file were not checked against it.`);
    return 0;
  }

  const { index } = describe(project);
  const variants = summarize(project, index);
  for (const variant of variants) {
    const sides = [
      ["include.operations", variant.unmatched.include.operations],
      ["include.tags", variant.unmatched.include.tags],
      ["exclude.operations", variant.unmatched.exclude.operations],
      ["exclude.tags", variant.unmatched.exclude.tags],
    ] as const;
    for (const [side, names] of sides) {
      if (names.length === 0) continue;
      warn(
        located({
          path: `variants.${variant.slug}.${side}`,
          message: `names ${names.map((name) => JSON.stringify(name)).join(", ")}, which ${names.length === 1 ? "is" : "are"} not in the ${project.sources.length === 1 ? "document" : "documents"}. That is fine if the API does not have ${names.length === 1 ? "it" : "them"} yet.`,
        }),
      );
    }
  }

  print(`${green("ok")} ${options.config} is a valid definition.`);
  for (const variant of variants) {
    const missing = unmatchedCount(variant.unmatched);
    print(
      `  ${variant.slug}: serves ${variant.served} of ${plural(variant.total, "operation")}${missing > 0 ? `, ${plural(missing, "name")} not found` : ""}`,
    );
  }
  // The original is always there; the variants are the ones the file makes from it.
  if (variants.length === 1) print("  It has no variants of its own yet.");
  return 0;
}
