import { TARGET_VERSIONS, type TargetVersion } from "./transforms/convert/index.js";
import type { SpecFormat } from "./types.js";

/**
 * What a URL of a variant asks for. A variant has one selection and several
 * representations, and the URL says which: the format by its extension (or
 * the Accept header), the OpenAPI version by a path segment.
 *
 *   /v/<project>/<variant>[.json|.yaml]             in the version its document has
 *   /v/<project>/<variant>/<version>[.json|.yaml]   in 3.0 or 3.1, converted
 *
 * The service and the local server read URLs with this, so the same path
 * means the same thing on both.
 */
export interface Representation {
  /** The variant's slug. */
  slug: string;
  format: SpecFormat;
  /** Whether the format came from the Accept header and not from the URL. */
  negotiated: boolean;
  /** The version segment as written, if the URL has one. */
  askedVersion: string | undefined;
}

export const CONTENT_TYPES: Record<SpecFormat, string> = {
  json: "application/json; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
};

function formatOf(
  raw: string,
  accept: string,
): { name: string; format: SpecFormat; negotiated: boolean } {
  if (raw.endsWith(".json")) return { name: raw.slice(0, -5), format: "json", negotiated: false };
  if (raw.endsWith(".yaml")) return { name: raw.slice(0, -5), format: "yaml", negotiated: false };
  if (raw.endsWith(".yml")) return { name: raw.slice(0, -4), format: "yaml", negotiated: false };
  const wantsYaml = /application\/(x-)?yaml|text\/(x-)?yaml/i.test(accept);
  return { name: raw, format: wantsYaml ? "yaml" : "json", negotiated: true };
}

/** Read the last one or two path segments of a variant's URL. */
export function readRepresentation(
  variantSegment: string,
  versionSegment: string | undefined,
  accept: string,
): Representation {
  // The extension is on the last segment, whichever that is.
  const last = formatOf(versionSegment ?? variantSegment, accept);
  return {
    slug: versionSegment === undefined ? last.name : variantSegment,
    format: last.format,
    negotiated: last.negotiated,
    askedVersion: versionSegment === undefined ? undefined : last.name,
  };
}

/**
 * The OpenAPI version a request gets, or undefined when the URL names one
 * there is none of. Null is the document's own, unconverted, which is what a
 * URL without a version in it serves. Conversion exists between 3.0 and 3.1.
 */
export function versionFor(
  asked: string | undefined,
  specVersion: string,
): TargetVersion | null | undefined {
  if (asked === undefined || asked === specVersion) return null;
  const version = TARGET_VERSIONS.find((candidate) => candidate === asked);
  return version && TARGET_VERSIONS.some((candidate) => candidate === specVersion)
    ? version
    : undefined;
}

/** What to tell a reader who asked for a version there is none of. */
export function noSuchVersion(path: string, asked: string, specVersion: string): string {
  return `${path} is not served as "${asked}". Its document is OpenAPI ${specVersion}; a 3.0 or 3.1 document is also served as the other, at /3.0 and /3.1.`;
}

/** If-None-Match uses weak comparison: `W/"x"` and `"x"` match. CDNs weaken ETags when they compress. */
export function etagMatches(header: string | undefined | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}
