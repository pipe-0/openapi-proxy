import { effectiveVariant } from "@openapi-proxy/core";
import { bold, dim, note, plural, print, table } from "../output.js";
import { describe, loadProject, servedKeys } from "../project.js";

/**
 * List what the project's document holds: every operation with its tags, and
 * the tags with how many operations each has. This is what `include` and
 * `exclude` are written from.
 */
export async function operations(options: {
  config: string;
  sources: string[];
  tag: string | undefined;
  variant: string | undefined;
  json: boolean;
}): Promise<number> {
  const project = await loadProject(options.config, options.sources);
  const { definition } = project.config;
  const { index, entries } = describe(project);

  if (options.variant !== undefined && !Object.hasOwn(definition.variants, options.variant)) {
    const known = Object.keys(definition.variants);
    throw new Error(
      `There is no variant "${options.variant}" in ${options.config}. ${known.length > 0 ? `It has ${known.join(", ")}.` : "It has none yet."}`,
    );
  }
  const served =
    options.variant === undefined
      ? undefined
      : servedKeys(index, effectiveVariant(definition, options.variant).selection);
  const shown = entries.filter(
    (entry) => options.tag === undefined || entry.tags.includes(options.tag),
  );

  if (options.json) {
    print(
      JSON.stringify(
        {
          tags: index.tags.filter((tag) => tag.count > 0),
          operations: shown.map((entry) => ({
            operation: entry.key,
            tags: entry.tags,
            ...(entry.summary ? { summary: entry.summary } : {}),
            ...(entry.source ? { source: entry.source } : {}),
            ...(served ? { served: served.has(entry.key) } : {}),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const rows = shown.map((entry) => [
    ...(served ? [served.has(entry.key) ? "served" : dim("hidden")] : []),
    entry.key,
    entry.tags.join(", "),
    dim(entry.summary ?? ""),
  ]);
  for (const line of table(rows)) print(line);
  if (shown.length === 0)
    note(
      options.tag
        ? `No operation has the tag "${options.tag}".`
        : "The document has no operations.",
    );

  note("");
  note(
    `${bold(plural(shown.length, "operation"))}${options.tag ? ` tagged ${options.tag}` : ""}${served ? `, ${shown.filter((entry) => served.has(entry.key)).length} served by ${options.variant}` : ""}.`,
  );
  if (options.tag === undefined) {
    note(
      `Tags: ${index.tags
        .filter((tag) => tag.count > 0)
        .map((tag) => `${tag.name} (${tag.count})`)
        .join(", ")}`,
    );
  }
  return 0;
}
