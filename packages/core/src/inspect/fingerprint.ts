import { withBudget } from "../document/budget.js";
import { digestOf, documentContent } from "../document/content-hash.js";
import { forEachOperation } from "../document/path-items.js";
import { type JsonObject, type OpenAPIDocument, TRANSFORM_VERSION } from "../types.js";

/**
 * How fingerprints are computed, as a prefix on each. Two fingerprints say
 * something about each other only if they were computed the same way, which
 * any change to the engine may alter, so whoever compares them has to
 * compare this first (see `sameScheme`).
 */
const FINGERPRINT_SCHEME = `${TRANSFORM_VERSION}:`;

/** Whether two fingerprints were computed the same way, and so can be compared. */
export function sameScheme(a: string, b: string): boolean {
  const scheme = (fingerprint: string) => fingerprint.slice(0, fingerprint.indexOf(":") + 1);
  return scheme(a) === scheme(b);
}

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
 *
 * What operations have in common (a path item's parameters, the document's
 * security, a path item that many paths point at) is looked at once, not once
 * for each of them.
 */
export function fingerprintOperations(doc: OpenAPIDocument): Map<string, string> {
  return withBudget(() => {
    const content = documentContent(doc);
    const fingerprints = new Map<string, string>();

    /** What a path item says about all of its operations, as one value per item. */
    const shared = new Map<JsonObject, JsonObject>();
    const sharedBy = (item: JsonObject) => {
      let fields = shared.get(item);
      if (!fields) {
        fields = {
          parameters: item.parameters,
          servers: item.servers,
          summary: item.summary,
          description: item.description,
        };
        shared.set(item, fields);
      }
      return fields;
    };
    // An operation without its own `security` is governed by the document's.
    const inherited = { security: doc.security };

    forEachOperation(doc, ({ key, operation, item }) => {
      const parts = [
        content.of(operation),
        content.of(sharedBy(item)),
        operation.security === undefined ? content.of(inherited) : null,
      ];
      fingerprints.set(key, `${FINGERPRINT_SCHEME}${digestOf(parts)}`);
    });

    return fingerprints;
  });
}
