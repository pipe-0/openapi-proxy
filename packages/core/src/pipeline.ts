import {
  availableVersions,
  type ConversionLoss,
  convertDocument,
  type TargetVersion,
  versionFamily,
} from "./transforms/convert/index.js";
import { type MergeNote, type MergePart, mergeDocuments } from "./transforms/merge.js";
import { applyVariant } from "./transforms/select.js";
import type { FilterStats, OpenAPIDocument, Selection } from "./types.js";

/**
 * From source documents to the document a reader gets, in two stages. Both
 * are pure, and the Worker and the browser preview run exactly this code.
 *
 *   sources ──▶ assembleDocument ──▶ the project's document
 *                 convert (only if the sources' versions differ), then merge
 *
 *   the project's document ──▶ buildVariant ──▶ what one audience is served
 *                 select the variant's operations, then convert (only if asked)
 *
 * Nothing is converted that does not have to be: one source, served in its
 * own version, goes through unchanged.
 */

/** A source that was converted so that it could be merged with the others. */
export interface ConvertedSource {
  source: string;
  from: string;
  to: string;
}

export interface AssembledDocument {
  doc: OpenAPIDocument;
  /** For each operation, the name of the source it came from. */
  origins: Map<string, string>;
  notes: MergeNote[];
  converted: ConvertedSource[];
}

/**
 * One document out of a project's sources. Sources written for OpenAPI 3.0
 * are brought to 3.1 first when others are 3.1 or later, because the two
 * describe schemas in different dialects and cannot be mixed in one document.
 */
export function assembleDocument(sources: MergePart[]): AssembledDocument {
  const families = new Set(sources.map((source) => versionFamily(source.doc)));
  const converted: ConvertedSource[] = [];

  const parts =
    families.has("3.0") && families.size > 1
      ? sources.map((source) => {
          if (versionFamily(source.doc) !== "3.0") return source;
          converted.push({ source: source.name, from: "3.0", to: "3.1" });
          return { ...source, doc: convertDocument(source.doc, "3.1").doc };
        })
      : sources;

  return { ...mergeDocuments(parts), converted };
}

export interface VariantOptions {
  selection: Selection;
  /** The OpenAPI version to serve. Leave out to serve the document's own. */
  version?: TargetVersion | null | undefined;
}

export interface BuiltVariant {
  doc: OpenAPIDocument;
  stats: FilterStats;
  /** What converting to the requested version could not carry over. */
  losses: ConversionLoss[];
}

/** What one variant serves: its operations and what they need, in the version it asks for. */
export function buildVariant(doc: OpenAPIDocument, options: VariantOptions): BuiltVariant {
  const selected = applyVariant(doc, options.selection);
  if (!options.version) return { ...selected, losses: [] };
  // A document can move to a version there is no conversion from (a source
  // that starts emitting 3.2, say). The variant is then served as the
  // document is, and says so, rather than not at all.
  if (!availableVersions(selected.doc).includes(options.version)) {
    const family = versionFamily(selected.doc);
    return {
      ...selected,
      losses: [
        {
          what: `the conversion itself: an OpenAPI ${family} document cannot be converted to ${options.version} yet`,
          count: 1,
        },
      ],
    };
  }
  // Selecting first means only what is served gets converted, and only its losses reported.
  const { doc: converted, losses } = convertDocument(selected.doc, options.version);
  return { doc: converted, stats: selected.stats, losses };
}
