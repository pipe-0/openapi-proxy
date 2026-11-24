import { createHash } from "node:crypto";
import {
  type ApplyResult,
  effectiveVariant,
  effectiveVisibility,
  indexOperations,
  ORIGINAL_VARIANT,
  type ProjectDefinition,
  type ProjectView,
  parseSpec,
  servedSlugs,
  sourceLabel,
  unmatchedNames,
  versionFamily,
  withBudget,
} from "@openapi-proxy/core";
import { describe, type Project, servedKeys } from "./project.js";

/**
 * A number that changes when the file's text does. The editor sends it back
 * with a save, which is refused if the file was changed in the meantime.
 */
export function revisionOf(text: string): number {
  return Number.parseInt(createHash("sha256").update(text).digest("hex").slice(0, 12), 16);
}

/**
 * A definition file and its documents, as the editor reads a project: the
 * same shape the service gives for a project of its own. What only a service
 * has is said not to be there (`can`), and the editor leaves it out.
 */
export function viewOf(project: Project, origin: string): ProjectView {
  const { definition, text } = project.config;
  const { index, entries, specVersion, notes } = describe(project);
  const read = new Map(project.sources.map((source) => [source.name, source]));

  return {
    definition,
    state: {
      revision: revisionOf(text),
      managedBy: "file",
      applied: null,
      urlPrefix: `${origin}/v/`,
      specVersion,
      documentHash: createHash("sha256")
        .update(project.sources.map((source) => source.hash).join("\n"))
        .digest("hex"),
      bodyBytes: project.sources.reduce((sum, source) => sum + source.bytes, 0),
      operations: entries,
      notes,
      check: null,
      sources: definition.sources.map((source) => {
        const name = sourceLabel(source);
        const document = read.get(name);
        const doc = withBudget(() => parseSpec(document?.text ?? "").doc);
        const info = (doc.info ?? {}) as { title?: unknown; version?: unknown };
        return {
          name,
          title: typeof info.title === "string" ? info.title : null,
          headerNames: [],
          validator: null,
          apiVersion: typeof info.version === "string" ? info.version : null,
          specVersion: versionFamily(doc),
          bodyBytes: document?.bytes ?? 0,
          operations: indexOperations(doc).totalOperations,
          readAt: document?.readAt ?? 0,
          lastStatus: "ok",
          lastError: null,
        };
      }),
      variants: Object.fromEntries(
        servedSlugs(definition).map((slug) => {
          const { selection } = effectiveVariant(definition, slug);
          return [
            slug,
            {
              id: slug,
              url: `${origin}/v/${definition.project}/${slug}`,
              // Without a workspace to ask, "public" stands in where nothing is
              // said. `defaultVisibility: null` tells the editor not to claim it.
              visibility: effectiveVisibility(definition, slug, "public"),
              servedOperations: servedKeys(index, selection).size,
              totalOperations: index.totalOperations,
              notFound: unmatchedNames(index, selection),
              createdAt: 0,
              updatedAt: 0,
            },
          ];
        }),
      ),
      defaultVisibility: null,
      createdAt: 0,
      can: { edit: true, credentials: false, keys: false, check: false },
    },
  };
}

/** What a save did, in the words the service uses for an apply. */
export function resultOf(
  before: ProjectDefinition,
  view: ProjectView,
  dryRun: boolean,
): ApplyResult {
  const { definition, state } = view;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const gone = {
    include: { operations: [], tags: [] },
    exclude: { operations: [], tags: [] },
  };
  return {
    dryRun,
    created: false,
    tookOver: false,
    project: { slug: definition.project, revision: state.revision, managedBy: "file" },
    sources: definition.sources.map((source, position) => ({
      name: sourceLabel(source),
      action: same(source, before.sources[position]) ? "unchanged" : "updated",
      document: "kept",
      follow: source.follow === true,
      bytes: state.sources[position]?.bodyBytes ?? 0,
      operations: state.sources[position]?.operations ?? 0,
    })),
    variants: [
      ...Object.entries(state.variants).map(([slug, variant]) => ({
        slug,
        // The original is always there, named in the file or not.
        action: !(Object.hasOwn(before.variants, slug) || slug === ORIGINAL_VARIANT)
          ? ("created" as const)
          : same(before.variants[slug], definition.variants[slug])
            ? ("unchanged" as const)
            : ("changed" as const),
        url: variant.url,
        visibility: variant.visibility,
        servedOperations: variant.servedOperations,
        totalOperations: variant.totalOperations,
        notFound: variant.notFound,
      })),
      ...Object.keys(before.variants)
        .filter((slug) => slug !== ORIGINAL_VARIANT && !Object.hasOwn(definition.variants, slug))
        .map((slug) => ({
          slug,
          action: "deleted" as const,
          url: `${state.urlPrefix}${definition.project}/${slug}`,
          visibility: effectiveVisibility(before, slug, "public"),
          servedOperations: 0,
          totalOperations: state.operations.length,
          notFound: gone,
        })),
    ],
    operations: { total: state.operations.length, added: [], removed: [], changed: [] },
    warnings: [],
    definition,
  };
}
