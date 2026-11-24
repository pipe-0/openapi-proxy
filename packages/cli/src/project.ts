import {
  assembleTexts,
  ConvertError,
  DocumentTooComplexError,
  effectiveVariant,
  indexOperations,
  MergeError,
  type OperationEntry,
  type OperationIndex,
  ORIGINAL_VARIANT,
  type ProjectNote,
  renderOriginalText,
  renderVariantText,
  resolveSelection,
  type Selection,
  type SpecFormat,
  SpecParseError,
  servedSlugs,
  type TargetVersion,
  type UnmatchedNames,
  unmatchedNames,
  versionFamily,
  withBudget,
} from "@openapi-proxy/core";
import { type Config, loadConfig } from "./config.js";
import { type ReadSource, readSourceFlags, readSources, SourceError } from "./sources.js";

/** A project as it is right now: its definition file and its documents, both just read. */
export interface Project {
  config: Config;
  sources: ReadSource[];
}

/** Read the definition file and every source it names. */
export async function loadProject(
  configPath: string,
  sourceFlags: string[] = [],
): Promise<Project> {
  const config = loadConfig(configPath);
  const overrides = readSourceFlags(sourceFlags, config.definition);
  return { config, sources: await readSources(config, overrides) };
}

/** What the engine says about a document when it turns it down, as a source's problem. */
function refusal(project: Project, error: unknown): never {
  if (
    error instanceof MergeError ||
    error instanceof ConvertError ||
    error instanceof DocumentTooComplexError ||
    error instanceof SpecParseError
  ) {
    const [first] = project.sources;
    throw new SourceError(first?.name ?? "", first?.from ?? "", error.message);
  }
  throw error;
}

/** What the project's document holds: its operations, each with the source it came from. */
export function describe(project: Project): {
  index: OperationIndex;
  entries: OperationEntry[];
  specVersion: string;
  /** What putting several documents together did. */
  notes: ProjectNote[];
} {
  try {
    return withBudget(() => {
      const { doc, origins, notes, converted } = assembleTexts(project.sources);
      const index = indexOperations(doc);
      const several = project.sources.length > 1;
      const entries = index.entries.map((entry) =>
        several ? { ...entry, source: origins.get(entry.key) } : entry,
      );
      return {
        index: { ...index, entries },
        entries,
        specVersion: versionFamily(doc),
        notes: [
          ...converted.map((each) => ({ kind: "source-converted" as const, ...each })),
          ...notes,
        ],
      };
    });
  } catch (error) {
    return refusal(project, error);
  }
}

/** One variant's document, exactly as the service would serve it. */
export function render(
  project: Project,
  slug: string,
  format: SpecFormat,
  version: TargetVersion | null,
): string {
  const { selection, overrides } = effectiveVariant(project.config.definition, slug);
  try {
    return slug === ORIGINAL_VARIANT
      ? renderOriginalText(project.sources, { version, format })
      : renderVariantText(project.sources, { selection, overrides, version, format });
  } catch (error) {
    return refusal(project, error);
  }
}

/** The operations a selection serves. */
export function servedKeys(index: OperationIndex, selection: Selection): Set<string> {
  return withBudget(() => resolveSelection(index, selection));
}

/** Per variant: how much of the document it serves, and the names it has that the document does not. */
export function summarize(
  project: Project,
  index: OperationIndex,
): Array<{ slug: string; served: number; total: number; unmatched: UnmatchedNames }> {
  return servedSlugs(project.config.definition).map((slug) => {
    const { selection } = effectiveVariant(project.config.definition, slug);
    return {
      slug,
      served: servedKeys(index, selection).size,
      total: index.totalOperations,
      unmatched: unmatchedNames(index, selection),
    };
  });
}
