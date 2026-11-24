import { withBudget } from "./document/budget.js";
import { measure, OUTPUT_LIMITS } from "./document/limits.js";
import { parseSpec } from "./document/parse.js";
import { serialize } from "./document/serialize.js";
import {
  availableVersions,
  type ConversionLoss,
  convertDocument,
  type TargetVersion,
  versionFamily,
} from "./transforms/convert/index.js";
import { type MergeNote, type MergePart, mergeDocuments } from "./transforms/merge.js";
import { applyOverrides, type DocumentOverrides } from "./transforms/override.js";
import { applyVariant } from "./transforms/select.js";
import type { FilterStats, OpenAPIDocument, Selection, SpecFormat } from "./types.js";

/**
 * From source documents to the document a reader gets, in two stages. Both
 * are pure, and the Worker and the browser preview run exactly this code.
 *
 *   sources ──▶ assembleDocument ──▶ the project's document
 *                 convert (only if the sources' versions differ), then merge
 *
 *   the project's document ──▶ buildVariant ──▶ what one audience is served
 *                 select the variant's operations, convert (only if asked),
 *                 then say at the top what the variant says differently
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
  return withBudget(() => assemble(sources));
}

function assemble(sources: MergePart[]): AssembledDocument {
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

  const merged = mergeDocuments(parts);
  // One source as it is was measured when it was parsed. Anything else is new.
  if (merged.doc !== sources[0]?.doc) measure(merged.doc, OUTPUT_LIMITS);
  return { ...merged, converted };
}

export interface VariantOptions {
  selection: Selection;
  /** The OpenAPI version to serve. Leave out to serve the document's own. */
  version?: TargetVersion | null | undefined;
  /** Title, description and servers, where the variant states its own. */
  overrides?: DocumentOverrides | null | undefined;
}

export interface BuiltVariant {
  doc: OpenAPIDocument;
  stats: FilterStats;
  /** What converting to the requested version could not carry over. */
  losses: ConversionLoss[];
}

/**
 * What one variant serves: its operations and what they need, in the version
 * it asks for.
 *
 * Both functions here throw a `DocumentTooComplexError` if what they made is
 * past `OUTPUT_LIMITS`, or if making it takes more work than a call is
 * allowed (document/budget.ts). A document can be small and still become
 * enormous, or cost the square of its size, when it is put together or cut
 * down; whoever calls these can rely on what they cost and on the size of
 * what comes back.
 */
export function buildVariant(doc: OpenAPIDocument, options: VariantOptions): BuiltVariant {
  return withBudget(() => {
    const built = build(doc, options);
    const out = { ...built, doc: applyOverrides(built.doc, options.overrides) };
    measure(out.doc, OUTPUT_LIMITS);
    return out;
  });
}

function build(doc: OpenAPIDocument, options: VariantOptions): BuiltVariant {
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

/** One source as text, with what decides how it is merged in. */
export interface SourceText {
  name: string;
  pathPrefix?: string | null | undefined;
  text: string;
}

/**
 * The project's document from the text of each source, in merge order. Not
 * under a budget of its own on purpose: whoever calls it can put it, and
 * whatever is done with the document after it, under one (`withBudget`).
 */
export function assembleTexts(parts: SourceText[]): {
  doc: OpenAPIDocument;
  /** Whether the main source is JSON on one line, for output that is too. */
  minified: boolean;
  /** With one source served as it is: its own text, which is the document. */
  single: string | undefined;
  /** What the main source is written in. */
  format: SpecFormat;
  /** For each operation, the name of the source it came from. */
  origins: Map<string, string>;
  /** What merging did. */
  notes: MergeNote[];
  converted: ConvertedSource[];
} {
  const parsed = parts.map((part) => ({ part, spec: parseSpec(part.text) }));
  const [first] = parsed;
  if (!first) throw new Error("A project without sources.");
  const { doc, origins, notes, converted } = assembleDocument(
    parsed.map(({ part, spec }) => ({
      name: part.name,
      doc: spec.doc,
      pathPrefix: part.pathPrefix ?? undefined,
    })),
  );
  return {
    doc,
    minified: first.spec.minified,
    single: parsed.length === 1 && !first.part.pathPrefix ? first.part.text : undefined,
    format: first.spec.format,
    origins,
    notes,
    converted,
  };
}

/** The project's whole document as text: the one source as it is, or the merge as JSON. */
export function documentText(parts: SourceText[]): string {
  return withBudget(() => {
    const { doc, minified, single } = assembleTexts(parts);
    return single ?? serialize(doc, "json", { minified });
  });
}

/**
 * What a reader of a variant is sent, from the text of the sources: assemble,
 * select, convert if asked, write out. One budget of work for all of it. The
 * service and the local server both serve exactly this.
 */
export function renderVariantText(
  parts: SourceText[],
  options: VariantOptions & { format: SpecFormat },
): string {
  return withBudget(() => {
    const { doc, minified } = assembleTexts(parts);
    const built = buildVariant(doc, options);
    return serialize(built.doc, options.format, { minified });
  });
}

/**
 * What a reader of a project's original is sent: its documents as they are,
 * nothing selected away and nothing said differently at the top. One source
 * asked for in its own version and format is its own text, byte for byte.
 * Otherwise the assembled document is converted if asked, then written out.
 */
export function renderOriginalText(
  parts: SourceText[],
  options: { version?: TargetVersion | null | undefined; format: SpecFormat },
): string {
  return withBudget(() => {
    const { doc, minified, single, format } = assembleTexts(parts);
    if (!options.version && single !== undefined && format === options.format) return single;
    // A version there is no conversion to is served as the document is, as a variant is.
    const out =
      options.version && availableVersions(doc).includes(options.version)
        ? convertDocument(doc, options.version).doc
        : doc;
    if (out !== doc) measure(out, OUTPUT_LIMITS);
    return serialize(out, options.format, { minified });
  });
}
