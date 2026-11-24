import {
  ORIGINAL_VARIANT,
  type ProjectDefinition,
  type Selection,
  type SourceDefinition,
  type VariantDefinition,
} from "@openapi-proxy/core";
import type { ProjectRow, SourceRow, VariantRow } from "./db/schema";

/**
 * A project's definition, and the rows it is stored in. The two say the same
 * thing: `definitionFromRows` reads a definition back exactly as `apply`
 * stored it, which a test holds it to.
 */

type SourceColumns = Pick<SourceRow, "name" | "url" | "file" | "follow" | "main" | "pathPrefix">;
type VariantColumns = Pick<
  VariantRow,
  "slug" | "name" | "icon" | "visibility" | "selection" | "overrides"
>;

/** The columns of a source that come from its entry in the definition. */
export function sourceColumns(source: SourceDefinition, several: boolean): SourceColumns {
  return {
    name: source.name ?? null,
    url: source.url ?? null,
    file: source.file ?? null,
    follow: source.follow === true,
    // A project's only source is its main one, whether it says so or not.
    main: several ? source.main === true : true,
    pathPrefix: source.pathPrefix ?? null,
  };
}

/** The columns of a variant that come from its entry in the definition. */
export function variantColumns(slug: string, variant: VariantDefinition): VariantColumns {
  const selection: Selection = {};
  if (variant.include) selection.include = variant.include;
  if (variant.exclude) selection.exclude = variant.exclude;
  return {
    slug,
    name: variant.name ?? null,
    icon: variant.icon ?? null,
    visibility: variant.visibility ?? null,
    selection,
    overrides: variant.overrides ?? null,
  };
}

/**
 * The definition a project's rows hold. `sources` and `variants` are taken in
 * the order of their `position`, which is the order the definition lists them in.
 */
export function definitionFromRows(
  project: Pick<ProjectRow, "slug" | "name" | "visibility" | "overrides">,
  sources: Array<SourceColumns & { position: number }>,
  variants: Array<VariantColumns & { position: number }>,
): ProjectDefinition {
  const several = sources.length > 1;
  const byPosition = <T extends { position: number }>(list: T[]) =>
    [...list].sort((a, b) => a.position - b.position);

  return {
    version: 1,
    project: project.slug,
    ...(project.name !== null ? { name: project.name } : {}),
    ...(project.visibility !== null ? { visibility: project.visibility } : {}),
    ...(project.overrides !== null ? { overrides: project.overrides } : {}),
    sources: byPosition(sources).map((source) => ({
      ...(source.name !== null ? { name: source.name } : {}),
      ...(source.url !== null ? { url: source.url } : { file: source.file ?? "" }),
      ...(several && source.main ? { main: true } : {}),
      ...(source.follow ? { follow: true } : {}),
      ...(source.pathPrefix !== null ? { pathPrefix: source.pathPrefix } : {}),
    })),
    variants: Object.fromEntries(
      byPosition(variants)
        // Every project has the original. The definition names it only to say who may read it.
        .filter((variant) => variant.slug !== ORIGINAL_VARIANT || variant.visibility !== null)
        .map((variant): [string, VariantDefinition] => [
          variant.slug,
          {
            ...(variant.name !== null ? { name: variant.name } : {}),
            ...(variant.icon !== null ? { icon: variant.icon } : {}),
            ...(variant.visibility !== null ? { visibility: variant.visibility } : {}),
            ...(variant.selection.include ? { include: variant.selection.include } : {}),
            ...(variant.selection.exclude ? { exclude: variant.selection.exclude } : {}),
            ...(variant.overrides !== null ? { overrides: variant.overrides } : {}),
          },
        ]),
    ),
  };
}
