import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  DEFINITION_LIMITS,
  DocumentTooComplexError,
  findExternalRefs,
  mergeOrder,
  type ProjectDefinition,
  parseSpec,
  type SourceText,
  SpecParseError,
  sourceLabel,
  withBudget,
} from "@openapi-proxy/core";
import type { Config } from "./config.js";

const FETCH_TIMEOUT_MS = 25_000;
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** One source's document, as it was read just now. */
export interface ReadSource extends SourceText {
  /** Where it was read from: an address or an absolute path. */
  from: string;
  /** Whether that is an address, not a file. */
  remote: boolean;
  bytes: number;
  /** SHA-256 of the bytes, in hex. */
  hash: string;
  /** When it was read. */
  readAt: number;
}

/** A source could not be read, or what it holds is not a document this can work with. */
export class SourceError extends Error {
  constructor(
    readonly source: string,
    readonly from: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

const isAddress = (location: string) => /^https?:\/\//i.test(location);

/**
 * What `--source` says, by the source it is for. `--source <location>` is for
 * a project's only source; with several, each is `--source <name>=<location>`.
 */
export function readSourceFlags(
  flags: string[],
  definition: ProjectDefinition,
): Map<string, string> {
  const labels = definition.sources.map(sourceLabel);
  const overrides = new Map<string, string>();
  for (const flag of flags) {
    const equals = flag.indexOf("=");
    const named = equals > 0 && labels.includes(flag.slice(0, equals));
    if (named) {
      overrides.set(flag.slice(0, equals), flag.slice(equals + 1));
    } else if (labels.length === 1) {
      overrides.set(labels[0] as string, flag);
    } else {
      throw new Error(
        `--source ${flag}: this project has several sources, so say which one: --source <name>=<location>. Their names are ${labels.join(", ")}.`,
      );
    }
  }
  return overrides;
}

async function fetchText(label: string, url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept:
          "application/json, application/yaml, application/x-yaml, text/yaml, text/plain, */*",
        "user-agent": "openapi-proxy-cli",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new SourceError(
      label,
      url,
      timedOut
        ? `${url} did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds.`
        : `${url} could not be reached. Is it running?`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError(label, url, `${url} answered with HTTP ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fileBytes(label: string, path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    throw new SourceError(label, path, `${path} could not be read. Does the file exist?`);
  }
}

/**
 * Read every source of a project, in the order they are merged, from where
 * the definition says or from where `--source` says instead. Each document is
 * held to what the service holds it to, so that what works here deploys.
 */
export async function readSources(
  config: Config,
  overrides: Map<string, string> = new Map(),
): Promise<ReadSource[]> {
  const sources = await Promise.all(
    mergeOrder(config.definition).map(async (source): Promise<ReadSource> => {
      const label = sourceLabel(source);
      const override = overrides.get(label);
      // What the file names is relative to the file; what a flag names, to where the command runs.
      const location = override ?? source.url ?? (source.file as string);
      const remote = isAddress(location);
      const from = remote
        ? location
        : isAbsolute(location)
          ? location
          : resolve(override === undefined ? config.dir : process.cwd(), location);
      const bytes = remote ? await fetchText(label, from) : await fileBytes(label, from);
      const text = new TextDecoder().decode(bytes);

      try {
        const external = withBudget(() => findExternalRefs(parseSpec(text).doc));
        if (external.length > 0) {
          throw new SourceError(
            label,
            from,
            `${from} references other files (${external.slice(0, 3).join(", ")}), which is not supported. Bundle it into one file first.`,
          );
        }
      } catch (error) {
        if (error instanceof SpecParseError || error instanceof DocumentTooComplexError) {
          throw new SourceError(
            label,
            from,
            `${from} is not an OpenAPI document: ${error.message}`,
          );
        }
        throw error;
      }
      return {
        name: label,
        pathPrefix: source.pathPrefix,
        text,
        from,
        remote,
        bytes: bytes.byteLength,
        hash: createHash("sha256").update(bytes).digest("hex"),
        readAt: Date.now(),
      };
    }),
  );

  const total = sources.reduce((sum, source) => sum + source.bytes, 0);
  if (total > DEFINITION_LIMITS.documentBytes) {
    const [first] = sources;
    throw new SourceError(
      first?.name ?? "",
      first?.from ?? "",
      sources.length === 1
        ? `The document is ${megabytes(total)}. The limit is ${megabytes(DEFINITION_LIMITS.documentBytes)}.`
        : `The documents are ${megabytes(total)} together. The limit for one project is ${megabytes(DEFINITION_LIMITS.documentBytes)}.`,
    );
  }
  return sources;
}
