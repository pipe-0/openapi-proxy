import {
  DocumentTooComplexError,
  findExternalRefs,
  indexOperations,
  type OpenAPIDocument,
  parseSpec,
  SpecParseError,
  withBudget,
} from "@openapi-proxy/core";
import { GUARDS } from "../shared/plans";
import { MAX_PACKED_LENGTH, pack, sha256Hex } from "./codec";
import type { SourceRow } from "./db/schema";
import type { Env } from "./env";
import { HeaderSecretError, openHeaders } from "./secrets";

/**
 * Talking to a source: fetching its document, asking its version endpoint,
 * and the cheapest-first check of whether it has changed. What is done with
 * the answers (assembling a project's document, storing it) is in assemble.ts.
 */

/**
 * Largest source document accepted: as much as a whole project may hold.
 * Bounded by Worker memory and CPU, not by storage.
 */
export const MAX_SOURCE_BYTES = GUARDS.projectBytes;
/** A version endpoint is trusted for this long before the document itself is compared again. */
export const MAX_UNVERIFIED_MS = 24 * 60 * 60 * 1000;

/** For the small requests: version probes and redirects. */
const FETCH_TIMEOUT_MS = 10_000;
/**
 * For the document itself. Generous on purpose: frameworks build the document
 * on the first request after a deploy, and for a large API that alone can
 * take ten seconds or more. The moment right after a deploy is exactly when
 * a check matters.
 */
const DOCUMENT_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "openapi-proxy (+https://github.com/pipe-0/openapi-proxy)";

export type UpstreamErrorCode =
  | "bad-url"
  | "unreachable"
  | "http-error"
  | "too-large"
  | "invalid-spec"
  | "external-refs"
  | "cannot-merge";

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  readonly detail?: string | undefined;

  constructor(code: UpstreamErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Cloudflare's own ceiling on what one invocation may do: requests out, and
 * queries to the database (50 of each on the free plan). Running into it says
 * nothing about a source, so it is never recorded as a source's failure.
 *
 * Only an error the runtime itself raised counts. An `UpstreamError` is ours,
 * and its text can come from the source (a parser quoting the document it
 * could not read), which must not be able to pass for the platform.
 */
export function isPlatformLimit(error: unknown): boolean {
  return (
    error instanceof Error &&
    !(error instanceof UpstreamError) &&
    /too many (subrequests|api requests)/i.test(`${error.message} ${error.cause ?? ""}`)
  );
}

export function validateSourceUrl(url: unknown): URL {
  if (typeof url !== "string" || url.trim() === "") {
    throw new UpstreamError("bad-url", "A URL is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new UpstreamError("bad-url", `"${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UpstreamError("bad-url", "Only http(s) URLs are supported.");
  }
  parsed.hash = "";
  return parsed;
}

/**
 * One outbound request. Redirects are followed by hand so that the project's
 * request headers (credentials) only ever go to the origin they were
 * configured for, never to wherever a redirect points. The time limit is for
 * the whole chain, not for each hop.
 */
async function send(
  url: string,
  method: "GET" | "HEAD",
  baseHeaders: Record<string, string>,
  credentials: Record<string, string>,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const trustedOrigin = new URL(url).origin;
  const signal = AbortSignal.timeout(timeoutMs);
  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = new Headers({ "user-agent": USER_AGENT, ...baseHeaders });
    if (new URL(target).origin === trustedOrigin) {
      for (const [name, value] of Object.entries(credentials)) headers.set(name, value);
    }

    let response: Response;
    try {
      response = await fetch(target, {
        method,
        headers,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (isPlatformLimit(error)) throw error;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new UpstreamError(
        "unreachable",
        timedOut
          ? `The source did not respond within ${timeoutMs / 1000} seconds.`
          : "Could not reach the source URL.",
        error instanceof Error ? error.message : String(error),
      );
    }

    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || response.status === 304 || !location) {
      return response;
    }
    await response.body?.cancel();
    const next = new URL(location, target);
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new UpstreamError("http-error", "The source redirects to an unsupported URL.");
    }
    target = next.href;
  }
  throw new UpstreamError("http-error", "The source redirects too many times.");
}

/** Read a response body, giving up (undefined) as soon as it exceeds `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface FetchedSpec {
  body: string;
  /** The body, parsed. */
  doc: OpenAPIDocument;
  bodyHash: string;
  bodyBytes: number;
  etag: string | null;
  lastModified: string | null;
  title: string | null;
  apiVersion: string | null;
  specVersion: string;
  /** How many operations it defines. */
  operations: number;
}

export const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export interface FetchOptions {
  /** Sent as conditional headers; a 304 then comes back as `"not-modified"`. */
  validators?: { etag: string | null; lastModified: string | null };
  /**
   * Hash of the copy already stored. A download with the same hash comes back
   * as `"identical"` without being parsed, which is most of the cost of a
   * check against a source that sends no validators.
   */
  knownHash?: string;
}

/** The source answered, and what it sent is byte for byte what is stored. */
export interface IdenticalSpec {
  identical: true;
  etag: string | null;
  lastModified: string | null;
}

/** Fetch and validate a source document. */
export async function fetchSpec(
  url: string,
  credentials: Record<string, string>,
  { validators, knownHash }: FetchOptions = {},
): Promise<FetchedSpec | IdenticalSpec | "not-modified"> {
  const headers: Record<string, string> = {
    accept: "application/json, application/yaml, application/x-yaml, text/yaml, text/plain, */*",
  };
  if (validators?.etag) headers["if-none-match"] = validators.etag;
  if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;

  const response = await send(url, "GET", headers, credentials, DOCUMENT_TIMEOUT_MS);

  if (response.status === 304) return "not-modified";
  if (!response.ok) {
    await response.body?.cancel();
    const needsAuth = response.status === 401 || response.status === 403;
    throw new UpstreamError(
      "http-error",
      `The source responded with HTTP ${response.status}.`,
      needsAuth ? "If it requires credentials, add them as a request header." : undefined,
    );
  }

  const bytes = await readCapped(response, MAX_SOURCE_BYTES);
  if (!bytes) {
    throw new UpstreamError(
      "too-large",
      `The source is larger than the ${megabytes(MAX_SOURCE_BYTES)} limit.`,
    );
  }
  const bodyHash = await sha256Hex(bytes);
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (knownHash !== undefined && bodyHash === knownHash) {
    return { identical: true, etag, lastModified };
  }
  const body = new TextDecoder().decode(bytes);

  // Reading the document and looking through it, under one budget of work.
  let parsed: ReturnType<typeof parseSpec>;
  let externalRefs: string[];
  let operations: number;
  try {
    ({ parsed, externalRefs, operations } = withBudget(() => {
      const parsed = parseSpec(body);
      return {
        parsed,
        externalRefs: findExternalRefs(parsed.doc),
        operations: indexOperations(parsed.doc).totalOperations,
      };
    }));
  } catch (error) {
    if (error instanceof SpecParseError || error instanceof DocumentTooComplexError) {
      throw new UpstreamError("invalid-spec", error.message);
    }
    throw error;
  }
  if (externalRefs.length > 0) {
    throw new UpstreamError(
      "external-refs",
      "The document references external files, which isn't supported. Bundle it into a single file first.",
      externalRefs.slice(0, 5).join(", "),
    );
  }

  const info = parsed.doc.info as { title?: unknown; version?: unknown } | undefined;
  return {
    body,
    doc: parsed.doc,
    bodyHash,
    bodyBytes: bytes.byteLength,
    etag,
    lastModified,
    title: typeof info?.title === "string" && info.title.trim() !== "" ? info.title.trim() : null,
    apiVersion: typeof info?.version === "string" ? info.version : null,
    specVersion: parsed.specVersion,
    operations,
  };
}

const VERSION_HEADERS = [
  "x-api-version",
  "api-version",
  "x-version",
  "x-revision",
  "etag",
  "last-modified",
];
const VERSION_BODY_KEYS = [
  "version",
  "apiVersion",
  "api_version",
  "revision",
  "sha",
  "commit",
  "build",
];

function versionFromHeaders(headers: Headers): string | undefined {
  for (const name of VERSION_HEADERS) {
    const value = headers.get(name);
    if (value) return `${name}: ${value}`;
  }
  return undefined;
}

function versionFromBody(body: string): string | undefined {
  const text = body.trim();
  if (text === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string" || typeof parsed === "number") return String(parsed);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    for (const key of VERSION_BODY_KEYS) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number") return `${key}: ${value}`;
    }
    const info = record.info;
    if (typeof info === "object" && info !== null) {
      const version = (info as Record<string, unknown>).version;
      if (typeof version === "string") return `info.version: ${version}`;
    }
    return undefined;
  } catch {
    // Plain text such as "1.4.2" or a git sha.
    return text.length <= 200 && !text.includes("\n") ? text : undefined;
  }
}

/**
 * Ask a lightweight endpoint which version of the API is live, without
 * downloading the document. A HEAD request is tried first, so the endpoint can
 * be the spec URL itself if it answers HEAD with a version header. Otherwise a
 * GET is made and its headers, then a small body, are inspected.
 *
 * Returns undefined when no version can be read, in which case the caller
 * compares the document itself.
 */
export async function probeVersion(
  versionUrl: string,
  credentials: Record<string, string>,
): Promise<string | undefined> {
  const accept = { accept: "application/json, text/plain, */*" };
  try {
    const head = await send(versionUrl, "HEAD", accept, credentials);
    if (head.ok) {
      const version = versionFromHeaders(head.headers);
      if (version) return version;
    }

    const response = await send(versionUrl, "GET", accept, credentials);
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const version = versionFromHeaders(response.headers);
    if (version) {
      await response.body?.cancel();
      return version;
    }
    const bytes = await readCapped(response, 16_384);
    return bytes ? versionFromBody(new TextDecoder().decode(bytes)) : undefined;
  } catch {
    return undefined;
  }
}

/** Credentials for the version endpoint: the source's own, when it lives on the same origin. */
function versionCredentials(
  source: Pick<SourceRow, "url" | "versionUrl">,
  credentials: Record<string, string>,
): Record<string, string> {
  if (!source.versionUrl) return {};
  return new URL(source.versionUrl).origin === new URL(source.url).origin ? credentials : {};
}

/** A source as a check needs it: everything but the stored document. */
export type SourceMeta = Omit<SourceRow, "body">;

/** What one look at a source found, and what to record about it. */
export type SourceCheck =
  /** Nothing new. */
  | { outcome: "same"; fields: Partial<SourceRow> }
  /** A different document. `fields` describes it; the caller stores it. */
  | { outcome: "new"; fields: Partial<SourceRow>; fetched: FetchedSpec }
  | { outcome: "failed"; error: string };

/**
 * Find out whether a source has changed, cheapest check first:
 *
 * 1. Version endpoint, if configured. Same version as last time means nothing
 *    is downloaded. Not trusted forever: the document is compared at least
 *    once per MAX_UNVERIFIED_MS, because many APIs change without bumping a
 *    version. If that comparison finds a new document behind an old version,
 *    the endpoint has proven that it cannot be relied on and is ignored from
 *    then on.
 * 2. Conditional GET with the stored validators. A 304 transfers no body.
 * 3. Download. The same bytes as the stored copy end here, unparsed.
 *
 * `force` ("Check now") skips step 1. Nothing is written here.
 */
export async function checkSource(
  env: Env,
  source: SourceMeta,
  now: number,
  options: { force?: boolean } = {},
): Promise<SourceCheck> {
  try {
    const credentials = await openHeaders(env.AUTH_SECRET, source.headers);

    let observedVersion: string | undefined;
    const askVersion = () =>
      source.versionUrl
        ? probeVersion(source.versionUrl, versionCredentials(source, credentials))
        : Promise.resolve(undefined);
    if (source.versionUrl && source.versionMismatchAt === null) {
      observedVersion = await askVersion();
      if (
        !options.force &&
        observedVersion !== undefined &&
        observedVersion === source.lastKnownVersion &&
        now - source.verifiedAt < MAX_UNVERIFIED_MS
      ) {
        return { outcome: "same", fields: { lastStatus: "ok", lastError: null } };
      }
    }

    const fetched = await fetchSpec(source.url, credentials, {
      validators: { etag: source.upstreamEtag, lastModified: source.upstreamLastModified },
      knownHash: source.bodyHash,
    });

    const checked = {
      verifiedAt: now,
      lastStatus: "ok" as const,
      lastError: null,
      // The version we saw just before this fetch describes at least this document.
      lastKnownVersion: observedVersion ?? null,
    };
    if (fetched === "not-modified") return { outcome: "same", fields: checked };
    if ("identical" in fetched) {
      // Same bytes; the validators may still be new (a source that started sending an ETag).
      return {
        outcome: "same",
        fields: {
          ...checked,
          upstreamEtag: fetched.etag,
          upstreamLastModified: fetched.lastModified,
        },
      };
    }

    // The same version as last time, and a different document. Either a deploy
    // landed between the two requests (then the version has moved by now), or
    // the endpoint does not change when the document does.
    let versionMismatchAt = source.versionMismatchAt;
    if (
      observedVersion !== undefined &&
      observedVersion === source.lastKnownVersion &&
      (await askVersion()) === observedVersion
    ) {
      versionMismatchAt = now;
    }

    return {
      outcome: "new",
      fetched,
      fields: {
        ...checked,
        versionMismatchAt,
        apiVersion: fetched.apiVersion,
        specVersion: fetched.specVersion,
        upstreamEtag: fetched.etag,
        upstreamLastModified: fetched.lastModified,
        bodyHash: fetched.bodyHash,
        bodyBytes: fetched.bodyBytes,
        operations: fetched.operations,
      },
    };
  } catch (error) {
    if (isPlatformLimit(error)) throw error;
    return { outcome: "failed", error: describeFailure(error) };
  }
}

/** A failure in words for the person who owns the source. */
export function describeFailure(error: unknown): string {
  if (error instanceof UpstreamError)
    return [error.message, error.detail].filter(Boolean).join(" ");
  if (error instanceof HeaderSecretError) return error.message;
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

export async function packSpec(body: string): Promise<string> {
  const packed = await pack(body);
  if (packed.length > MAX_PACKED_LENGTH) {
    throw new UpstreamError("too-large", "The source is too large to store, even compressed.");
  }
  return packed;
}
