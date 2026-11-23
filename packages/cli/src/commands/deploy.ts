import { gzipSync } from "node:zlib";
import {
  type ApplyResult,
  DEPLOY_KEY_VARIABLE,
  HOSTED_URL,
  type Problem,
  type SourceDefinition,
  sourceLabel,
  unmatchedCount,
} from "@openapi-proxy/core";
import { type Config, lineOf, loadConfig, parseConfig } from "../config.js";
import { bold, dim, fail, green, note, plural, print, RUN, table, warn } from "../output.js";
import { type ReadSource, readSource, SourceError, tooLarge } from "../sources.js";
import { problemLine } from "./validate.js";

/** Where a file is deployed to unless it names an instance of its own. */
export const HOSTED = HOSTED_URL;
/** The environment variable a deploy reads its key from. */
export const KEY_VARIABLE = DEPLOY_KEY_VARIABLE;
const TIMEOUT_MS = 120_000;

interface Refusal {
  code?: string;
  error?: string;
  detail?: string;
  source?: string;
  problems?: Problem[];
}

/**
 * Where a deploy ran, from what the CI system says about itself. Shown in the
 * app next to the project, so that a deployed project says which commit it is.
 */
export function originOf(env: NodeJS.ProcessEnv): Record<string, string> {
  const origin: Record<string, string | undefined> = env.GITHUB_ACTIONS
    ? {
        commit: env.GITHUB_SHA,
        ref: env.GITHUB_REF,
        repository: env.GITHUB_REPOSITORY,
        runUrl:
          env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
            ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
            : undefined,
      }
    : env.GITLAB_CI
      ? {
          commit: env.CI_COMMIT_SHA,
          ref: env.CI_COMMIT_REF_NAME,
          repository: env.CI_PROJECT_PATH,
          runUrl: env.CI_PIPELINE_URL,
        }
      : {};
  return Object.fromEntries(
    Object.entries(origin).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

/**
 * The instance a definition is deployed to. Reading the file has already
 * held it to https, or to this machine: a deploy sends a key.
 */
export const instanceOf = (config: Config): string => config.definition.instance ?? HOSTED;

const megabytes = (bytes: number) =>
  bytes < 100_000
    ? `${Math.max(1, Math.round(bytes / 1000))} kB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
const time = (at: number) => new Date(at).toTimeString().slice(0, 8);
const LAYER = {
  variant: "set on the variant",
  project: "from the project",
  workspace: "from the workspace",
};

/**
 * Deploy a definition file: read its sources here, and send them with the
 * definition to the service, which makes the project what the file says.
 * With `dryRun` the service works everything out and changes nothing.
 */
export async function deploy(options: {
  config: string;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const env = options.env ?? process.env;
  const config = loadConfig(options.config);
  const { definition } = config;
  const instance = instanceOf(config);

  const key = env[KEY_VARIABLE]?.trim();
  if (!key) {
    fail(`${KEY_VARIABLE} is not set.`);
    note("");
    note("A deploy needs a deploy API key. The owner of the workspace creates one at");
    note(`${instance}/workspace and stores it as a secret of the pipeline:`);
    note("");
    note(`  ${KEY_VARIABLE}=oap_... ${RUN} deploy`);
    return 1;
  }

  // Every source that can be read here is sent along, followed ones too, so
  // that the project has its documents the moment the deploy is done.
  const read = new Map<SourceDefinition, ReadSource>();
  const left: Array<{ source: SourceDefinition; why: string }> = [];
  await Promise.all(
    definition.sources.map(async (source) => {
      try {
        read.set(source, await readSource(config, source));
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        left.push({ source, why: error.message });
      }
    }),
  );
  for (const { source, why } of left) {
    if (source.follow) {
      // The service reads it itself, perhaps with credentials that only it has.
      warn(`${why} It is followed, so the service reads it itself.`);
    } else {
      fail(why);
    }
  }
  if (left.some(({ source }) => !source.follow)) return 1;
  const large = tooLarge([...read.values()]);
  if (large) {
    fail(large);
    return 1;
  }

  const documents = Object.fromEntries(
    [...read].map(([source, document]) => [
      sourceLabel(source),
      // The bytes as they were read, so that the service sees the document its source serves.
      { gzip: gzipSync(document.raw).toString("base64") },
    ]),
  );
  const origin = originOf(env);
  let response: Response;
  try {
    response = await fetch(
      `${instance}/api/projects/${definition.project}${options.dryRun ? "?dryRun=true" : ""}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "user-agent": "openapi-proxy-cli",
        },
        body: JSON.stringify({
          definition,
          documents,
          ...(Object.keys(origin).length > 0 ? { origin } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    fail(
      timedOut
        ? `${instance} did not answer within ${TIMEOUT_MS / 1000} seconds.`
        : `${instance} could not be reached.`,
    );
    return 1;
  }

  if (!response.ok) {
    const refusal = (await response.json().catch(() => ({}))) as Refusal;
    refused(options.config, config, instance, response.status, refusal);
    return 1;
  }
  report(options.config, config, instance, (await response.json()) as ApplyResult, read);
  return 0;
}

/** Say why the service did not take a deploy, and what to do about it. */
function refused(
  file: string,
  config: Config,
  instance: string,
  status: number,
  refusal: Refusal,
): void {
  if (refusal.problems && refusal.problems.length > 0) {
    const parsed = parseConfig(config.text);
    for (const problem of refusal.problems) {
      const line =
        "problems" in parsed ? undefined : lineOf(parsed.doc, parsed.counter, problem.path);
      fail(problemLine(file, line === undefined ? problem : { ...problem, line }));
    }
    return;
  }
  const said = [refusal.error, refusal.detail].filter(Boolean).join(" ");
  if (status === 401) {
    fail(`${instance} did not accept the key in ${KEY_VARIABLE}.`);
    note(
      "It may have been revoked, or belong to another instance. A deploy needs a deploy API key.",
    );
    return;
  }
  if (refusal.code === "slug-taken") {
    fail(
      `The project slug "${config.definition.project}" belongs to another workspace on ${instance}. Choose another: it is the "project" key of ${file}.`,
    );
    return;
  }
  fail(said || `${instance} answered with HTTP ${status}.`);
}

/** Print what a deploy did, or would do. */
function report(
  file: string,
  config: Config,
  instance: string,
  result: ApplyResult,
  read: Map<SourceDefinition, ReadSource>,
): void {
  const { definition } = config;
  const slug = definition.project;
  const done = result.dryRun
    ? `Dry run: ${instance} would ${result.created ? "create" : "update"} ${bold(slug)}. Nothing was changed.`
    : `${green(result.created ? "Created" : "Deployed")} ${bold(slug)} on ${instance}`;
  print(done);
  if (result.tookOver) {
    note(
      result.dryRun
        ? "This project is edited in the app today. A deploy makes this file what defines it."
        : "This project was edited in the app. It is now defined by this file.",
    );
  }

  print();
  print("Sources");
  const readOf = new Map([...read].map(([source, document]) => [sourceLabel(source), document]));
  const followed = new Map(
    definition.sources.map((source) => [sourceLabel(source), source.follow]),
  );
  for (const line of table(
    result.sources.map((source) => {
      if (source.action === "removed") return [`  ${source.name}`, "removed", "", "", ""];
      const document = readOf.get(source.name);
      const from = document
        ? document.remote
          ? `read from ${document.from} at ${time(document.readAt)}`
          : `read from ${document.from}`
        : "read by the service";
      const again = followed.get(source.name)
        ? "the service keeps reading it"
        : document?.remote
          ? "not read again until the next deploy"
          : "";
      return [
        `  ${source.name}`,
        source.document === "kept" ? "unchanged" : source.document,
        megabytes(source.bytes),
        plural(source.operations, "operation"),
        dim([from, again].filter(Boolean).join("; ")),
      ];
    }),
  )) {
    print(line);
  }

  print();
  print("Variants");
  if (result.variants.length === 0) print(dim("  The file has no variants yet."));
  for (const line of table(
    result.variants.map((variant) => {
      if (variant.action === "deleted") {
        const keys = variant.keysRemoved
          ? `${plural(variant.keysRemoved, "user API key")} for it removed`
          : "";
        return [`  ${variant.slug}`, "deleted", "", keys, ""];
      }
      return [
        `  ${variant.slug}`,
        variant.action,
        `${variant.servedOperations} of ${plural(variant.totalOperations, "operation")}`,
        `${variant.visibility.value} (${LAYER[variant.visibility.from]})`,
        variant.url,
      ];
    }),
  )) {
    print(line);
  }

  const { added, removed, changed } = result.operations;
  if (!result.created && added.length + removed.length + changed.length > 0) {
    print();
    print(
      `Operations: ${[
        added.length > 0 ? `${added.length} added` : "",
        removed.length > 0 ? `${removed.length} removed` : "",
        changed.length > 0 ? `${changed.length} changed` : "",
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
    const shown = [
      ...added.map((key) => `  + ${key}`),
      ...removed.map((key) => `  - ${key}`),
      ...changed.map((key) => `  ~ ${key}`),
    ];
    for (const line of shown.slice(0, 40)) print(line);
    if (shown.length > 40) print(dim(`  and ${shown.length - 40} more`));
  }

  const parsed = parseConfig(config.text);
  const located = (problem: Problem) => {
    const line =
      "problems" in parsed ? undefined : lineOf(parsed.doc, parsed.counter, problem.path);
    return problemLine(file, line === undefined ? problem : { ...problem, line });
  };
  for (const warning of result.warnings) warn(located(warning));
  for (const variant of result.variants) {
    if (variant.action === "deleted" || unmatchedCount(variant.notFound) === 0) continue;
    const sides = [
      ["include.operations", variant.notFound.include.operations],
      ["include.tags", variant.notFound.include.tags],
      ["exclude.operations", variant.notFound.exclude.operations],
      ["exclude.tags", variant.notFound.exclude.tags],
    ] as const;
    for (const [side, names] of sides) {
      if (names.length === 0) continue;
      warn(
        located({
          path: `variants.${variant.slug}.${side}`,
          message: `names ${names.map((name) => JSON.stringify(name)).join(", ")}, which ${names.length === 1 ? "is" : "are"} not in the ${result.sources.length === 1 ? "document" : "documents"}. That is fine if the API does not have ${names.length === 1 ? "it" : "them"} yet.`,
        }),
      );
    }
  }
}
