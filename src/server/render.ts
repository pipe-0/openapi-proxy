import {
  buildVariant,
  ConvertError,
  type DocumentOverrides,
  DocumentTooComplexError,
  MergeError,
  type Selection,
  type SpecFormat,
  SpecParseError,
  serialize,
  type TargetVersion,
  TRANSFORM_VERSION,
  withBudget,
} from "@openapi-proxy/core";
import { and, eq } from "drizzle-orm";
import { documentFrom } from "./assemble";
import { MAX_PACKED_LENGTH, pack, sha256Hex, unpack } from "./codec";
import type { Db } from "./db/client";
import { projects, sources, variantOutputs } from "./db/schema";

export interface RenderTarget {
  projectId: string;
  bodyHash: string;
  variantId: string;
  selection: Selection;
  /** The OpenAPI version to serve; null serves the document's own. */
  version: TargetVersion | null;
  /** Title, description and servers the variant states itself; null for none. */
  overrides: DocumentOverrides | null;
  revision: number;
}

/**
 * Strong validator for one representation of a variant. It changes when, and
 * only when, the bytes can: a new document, a change to what the variant
 * serves (its selection, what it states at the top), another format or
 * OpenAPI version, or an upgrade of the engine.
 */
export async function variantEtag(target: RenderTarget, format: SpecFormat): Promise<string> {
  const identity = [
    TRANSFORM_VERSION,
    target.bodyHash,
    target.variantId,
    target.revision,
    format,
    target.version ?? "own",
  ].join(":");
  return `"${(await sha256Hex(identity)).slice(0, 32)}"`;
}

export interface Rendered {
  body: string;
  /** The validator of `body`. Differs from the one asked for if a source changed in between. */
  etag: string;
  /** Persist the freshly rendered output. Absent when it came from storage. */
  store?: () => Promise<void>;
}

/** A variant that cannot be served as it is, and why. */
export interface RenderFailure {
  failure: string;
  /** Remember the failure, so the next request does not repeat the work. */
  store?: () => Promise<void>;
}

/**
 * The document a variant serves, in one format and version. Looks for stored output
 * first; a miss means a source or the variant changed since it was last
 * rendered, so the pipeline runs once (assemble the sources, select, convert)
 * and the caller stores the result.
 *
 * It runs once whether it succeeds or not. A document can be valid and still
 * not be servable: too large or too deep once it is written out, more work
 * than a job is allowed, too large to store. That is found out here, under
 * one budget of work for the whole render, and the answer is stored like a
 * rendered document would be, whatever it is: everything a render does
 * follows from what the ETag stands for, so the same attempt would end the
 * same way. Anyone can request a public URL as often as they like; what that
 * costs is one attempt per change, not one per request.
 */
export async function renderVariant(
  db: Db,
  target: RenderTarget,
  format: SpecFormat,
  etag: string,
  now: number,
): Promise<Rendered | RenderFailure | undefined> {
  const version: TargetVersion | "own" = target.version ?? "own";
  const stored = await db
    .select({
      etag: variantOutputs.etag,
      body: variantOutputs.body,
      error: variantOutputs.error,
    })
    .from(variantOutputs)
    .where(
      and(
        eq(variantOutputs.variantId, target.variantId),
        eq(variantOutputs.format, format),
        eq(variantOutputs.version, version),
      ),
    )
    .get();
  if (stored?.etag === etag) {
    if (stored.error !== null) return { failure: stored.error };
    return { body: await unpack(stored.body), etag };
  }

  // The sources together with the hash that describes them, in one read. A
  // check can replace both between the caller's query and this one; the ETag
  // is derived from the hash that belongs to the documents rendered here.
  const rows = await db
    .select({
      name: sources.name,
      pathPrefix: sources.pathPrefix,
      body: sources.body,
      bodyHash: projects.bodyHash,
    })
    .from(sources)
    .innerJoin(projects, eq(projects.id, sources.projectId))
    .where(eq(sources.projectId, target.projectId))
    .orderBy(sources.position);
  const [first] = rows;
  if (!first) return undefined;
  if (first.bodyHash !== target.bodyHash) {
    etag = await variantEtag({ ...target, bodyHash: first.bodyHash }, format);
  }

  const finalEtag = etag;
  const remember = (outcome: { body: string; error: string | null }) => async () => {
    const row = { variantId: target.variantId, format, version, etag: finalEtag, createdAt: now };
    await db
      .insert(variantOutputs)
      .values({ ...row, ...outcome })
      .onConflictDoUpdate({
        target: [variantOutputs.variantId, variantOutputs.format, variantOutputs.version],
        set: { etag: finalEtag, createdAt: now, ...outcome },
      });
  };

  try {
    const texts = await Promise.all(rows.map((row) => unpack(row.body)));
    const body = withBudget(() => {
      const { doc, minified } = documentFrom(rows, texts);
      const built = buildVariant(doc, {
        selection: target.selection,
        version: target.version,
        overrides: target.overrides,
      });
      return serialize(built.doc, format, { minified });
    });
    // Compressed before it is answered with, not after: a document that does
    // not fit in a row could never be stored, and would be rendered again for
    // every request.
    const packed = await pack(body);
    if (packed.length > MAX_PACKED_LENGTH) {
      throw new DocumentTooComplexError("too-large", "The document is too large to be served.");
    }
    return { body, etag, store: remember({ body: packed, error: null }) };
  } catch (error) {
    // What the engine says about a document is for its owner to read. Anything
    // else is a fault here: it is logged, and the reader is told only that.
    const failure = isRefusal(error)
      ? error.message
      : "The document could not be put together. The operator has been told.";
    if (!isRefusal(error)) console.error("render failed", target.variantId, format, error);
    return { failure, store: remember({ body: "", error: failure }) };
  }
}

/** An error by which the engine turns a document down, with a reason meant to be read. */
function isRefusal(error: unknown): error is Error {
  return (
    error instanceof DocumentTooComplexError ||
    error instanceof SpecParseError ||
    error instanceof MergeError ||
    error instanceof ConvertError
  );
}
