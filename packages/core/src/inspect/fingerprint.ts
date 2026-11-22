import { canonical, componentContent, digest, usedComponents } from "../document/content-hash.js";
import { forEachOperation } from "../document/path-items.js";
import type { OpenAPIDocument } from "../types.js";

/**
 * One fingerprint per operation, keyed like the operation index. Two
 * documents give an operation the same fingerprint exactly when a reader
 * would see the same thing for it: the operation itself, what its path item
 * adds (shared parameters, servers, summary), the document's default security
 * where the operation states none, and every component it references, however
 * indirectly.
 *
 * That last part is the point. An operation "changes" far more often through
 * a schema it uses than through its own lines, and comparing operation objects
 * would miss all of those.
 *
 * Key order is ignored, so a generator that emits the same document in a
 * different order changes nothing.
 */
export function fingerprintOperations(doc: OpenAPIDocument): Map<string, string> {
  const content = componentContent(doc);
  const fingerprints = new Map<string, string>();

  forEachOperation(doc, ({ key, operation, item }) => {
    const context = {
      operation,
      shared: {
        parameters: item.parameters,
        servers: item.servers,
        summary: item.summary,
        description: item.description,
      },
      // An operation without its own `security` is governed by the document's.
      security: operation.security === undefined ? doc.security : undefined,
    };
    const parts = [canonical(context), ...content.reach(usedComponents(context))];
    fingerprints.set(key, digest(parts.join("\n")));
  });

  return fingerprints;
}
