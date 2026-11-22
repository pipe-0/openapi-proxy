import {
  buildVariant,
  type Selection,
  type SpecFormat,
  serialize,
  type TargetVersion,
  TRANSFORM_VERSION,
} from "@openapi-proxy/core";
import { and, eq } from "drizzle-orm";
import { loadDocument } from "./assemble";
import { MAX_PACKED_LENGTH, pack, sha256Hex, unpack } from "./codec";
import type { Db } from "./db/client";
import { projects, sources, variantOutputs } from "./db/schema";

export interface RenderTarget {
  projectId: string;
  bodyHash: string;
  variantId: string;
  selection: Selection;
  /** The OpenAPI version to serve; null serves the project's own. */
  outputVersion: TargetVersion | null;
  selectionVersion: number;
}

/**
 * Strong validator for one representation of a variant. It changes when, and
 * only when, the bytes can: a new document, a change to what the variant
 * serves (its selection or its version), the other format, or an upgrade of
 * the engine.
 */
export async function variantEtag(target: RenderTarget, format: SpecFormat): Promise<string> {
  const identity = [
    TRANSFORM_VERSION,
    target.bodyHash,
    target.variantId,
    target.selectionVersion,
    format,
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

/**
 * The document a variant serves, in one format. Looks for stored output
 * first; a miss means a source or the variant changed since it was last
 * rendered, so the pipeline runs once (assemble the sources, select, convert)
 * and the caller stores the result.
 */
export async function renderVariant(
  db: Db,
  target: RenderTarget,
  format: SpecFormat,
  etag: string,
  now: number,
): Promise<Rendered | undefined> {
  const stored = await db
    .select({ etag: variantOutputs.etag, body: variantOutputs.body })
    .from(variantOutputs)
    .where(and(eq(variantOutputs.variantId, target.variantId), eq(variantOutputs.format, format)))
    .get();
  if (stored?.etag === etag) return { body: await unpack(stored.body), etag };

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

  const { doc, indent } = await loadDocument(rows);
  const built = buildVariant(doc, { selection: target.selection, version: target.outputVersion });
  const body = serialize(built.doc, format, { indent });

  return {
    body,
    etag,
    store: async () => {
      const packed = await pack(body);
      if (packed.length > MAX_PACKED_LENGTH) return; // rendered on demand instead
      const row = { variantId: target.variantId, format, etag, body: packed, createdAt: now };
      await db
        .insert(variantOutputs)
        .values(row)
        .onConflictDoUpdate({
          target: [variantOutputs.variantId, variantOutputs.format],
          set: { etag, body: packed, createdAt: now },
        });
    },
  };
}
