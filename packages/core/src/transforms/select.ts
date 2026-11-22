import {
  isMethodField,
  operationKey,
  operationsOf,
  resolvePathItem,
  webhookKey,
} from "../document/path-items.js";
import { componentClosure } from "../document/refs.js";
import { indexOperations } from "../inspect/operations.js";
import { resolveSelection } from "../selection/resolve.js";
import {
  COMPONENT_GROUPS,
  type FilterResult,
  isJsonObject,
  type JsonObject,
  type OpenAPIDocument,
  type Selection,
} from "../types.js";
import { hasLooseRefs, inlineRemovedRefs } from "./inline-refs.js";

const PRUNED_GROUPS = new Set<string>(COMPONENT_GROUPS);

/**
 * Produce a filtered copy of an OpenAPI document containing only the operations
 * (paths and webhooks) matched by the selection, with `components` pruned to
 * the transitive `$ref`-reachable closure of what remains.
 *
 * Guarantees:
 * - the input document is never mutated;
 * - key order from the source is preserved everywhere;
 * - every `$ref` in the output resolves within the output (self-contained),
 *   provided the source itself had no dangling or external refs;
 * - applying the same selection to the output again is a no-op (idempotent).
 */
export function applyVariant(doc: OpenAPIDocument, selection: Selection): FilterResult {
  const index = indexOperations(doc);
  const keptKeys = resolveSelection(index, selection);

  // 1. Drop unselected operations from `paths` and `webhooks`.
  let draft: OpenAPIDocument = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "paths" || key === "webhooks") {
      draft[key] = filterPathItems(doc, value, keptKeys, key === "webhooks");
    } else {
      draft[key] = value;
    }
  }

  // 2. Refs that pointed into a dropped operation get a copy of their target.
  let inlinedRefs = 0;
  if (hasLooseRefs(doc)) {
    const result = inlineRemovedRefs(draft, doc);
    draft = result.doc;
    inlinedRefs = result.inlined;
  }

  // 3. Everything that is served verbatim can hold refs and security
  //    requirements, so all of it roots the component closure: the document
  //    minus `components`, plus component groups we do not prune.
  const components = isJsonObject(draft.components) ? draft.components : undefined;
  const roots: unknown[] = [];
  for (const [key, value] of Object.entries(draft)) {
    if (key !== "components") roots.push({ [key]: value });
  }
  for (const [group, members] of Object.entries(components ?? {})) {
    if (!PRUNED_GROUPS.has(group)) roots.push(members);
  }
  const needed = componentClosure(roots, components);

  // 4. Assemble the output in source key order.
  const keptTagNames = keptTags(doc, index.entries, keptKeys);
  const keptComponents: Record<string, number> = {};
  const totalComponents: Record<string, number> = {};
  const out: OpenAPIDocument = {};

  for (const [key, value] of Object.entries(draft)) {
    if (key === "components") {
      const pruned = pruneComponents(value, needed, keptComponents, totalComponents);
      if (pruned !== undefined) out.components = pruned;
    } else if (key === "tags" && Array.isArray(value)) {
      const tags = value.filter(
        (tag) => isJsonObject(tag) && typeof tag.name === "string" && keptTagNames.has(tag.name),
      );
      if (tags.length > 0) out.tags = tags;
    } else if (key === "x-tagGroups" && Array.isArray(value)) {
      const groups = filterTagGroups(value, keptTagNames);
      if (groups.length > 0) out[key] = groups;
    } else {
      out[key] = value;
    }
  }

  const sourceKeys = new Set(index.entries.map((entry) => entry.key));
  const missingSelectedOperations =
    selection.mode === "include" ? selection.operations.filter((key) => !sourceKeys.has(key)) : [];

  return {
    doc: out,
    stats: {
      keptOperations: keptKeys.size,
      totalOperations: index.totalOperations,
      keptComponents,
      totalComponents,
      missingSelectedOperations,
      inlinedRefs,
    },
  };
}

/** Filter a `paths` or `webhooks` map. Items left without operations are dropped. */
function filterPathItems(
  doc: OpenAPIDocument,
  container: unknown,
  keptKeys: Set<string>,
  webhook: boolean,
): JsonObject {
  const out: JsonObject = {};
  if (!isJsonObject(container)) return out;

  for (const [name, rawItem] of Object.entries(container)) {
    if (!isJsonObject(rawItem)) continue;
    const item = resolvePathItem(doc, rawItem);
    if (!item) continue;

    const keyFor = (method: string) =>
      webhook ? webhookKey(method, name) : operationKey(method, name);

    const operations = operationsOf(item);
    const kept = operations.filter(({ method }) => keptKeys.has(keyFor(method))).length;
    if (kept === 0) continue;

    // Fully kept items pass through as-is, which also preserves a path-level `$ref`.
    out[name] =
      kept === operations.length ? rawItem : withoutDroppedOperations(item, keyFor, keptKeys);
  }

  return out;
}

function withoutDroppedOperations(
  item: JsonObject,
  keyFor: (method: string) => string,
  keptKeys: Set<string>,
): JsonObject {
  const rebuilt: JsonObject = {};
  for (const [key, value] of Object.entries(item)) {
    if (isMethodField(key)) {
      if (keptKeys.has(keyFor(key))) rebuilt[key] = value;
    } else if (key === "additionalOperations" && isJsonObject(value)) {
      const additional = Object.fromEntries(
        Object.entries(value).filter(([method]) => keptKeys.has(keyFor(method))),
      );
      if (Object.keys(additional).length > 0) rebuilt[key] = additional;
    } else {
      // Path-item-shared keys: parameters, servers, summary, description, x-*.
      rebuilt[key] = value;
    }
  }
  return rebuilt;
}

/**
 * Tags to keep in the top-level `tags` array: those on a kept operation, plus
 * their ancestors (OpenAPI 3.2 lets a tag name a `parent`).
 */
function keptTags(
  doc: OpenAPIDocument,
  entries: Array<{ key: string; tags: string[] }>,
  keptKeys: Set<string>,
): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    if (!keptKeys.has(entry.key)) continue;
    for (const tag of entry.tags) names.add(tag);
  }

  if (Array.isArray(doc.tags)) {
    const parents = new Map<string, string>();
    for (const tag of doc.tags) {
      if (isJsonObject(tag) && typeof tag.name === "string" && typeof tag.parent === "string") {
        parents.set(tag.name, tag.parent);
      }
    }
    for (const name of [...names]) {
      let parent = parents.get(name);
      while (parent !== undefined && !names.has(parent)) {
        names.add(parent);
        parent = parents.get(parent);
      }
    }
  }
  return names;
}

/** `x-tagGroups` (Redoc, Scalar) lists tag names; drop the ones that are gone. */
function filterTagGroups(groups: unknown[], keptTagNames: Set<string>): unknown[] {
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isJsonObject(group) || !Array.isArray(group.tags)) {
      out.push(group);
      continue;
    }
    const tags = group.tags.filter((tag) => typeof tag === "string" && keptTagNames.has(tag));
    if (tags.length === 0) continue;
    out.push(tags.length === group.tags.length ? group : { ...group, tags });
  }
  return out;
}

function pruneComponents(
  components: unknown,
  needed: Set<string>,
  keptCounts: Record<string, number>,
  totalCounts: Record<string, number>,
): JsonObject | undefined {
  if (!isJsonObject(components)) return undefined;

  const out: JsonObject = {};
  for (const [group, members] of Object.entries(components)) {
    if (!PRUNED_GROUPS.has(group) || !isJsonObject(members)) {
      // Vendor extensions and groups we do not know stay exactly as they are.
      out[group] = members;
      continue;
    }

    totalCounts[group] = Object.keys(members).length;
    const keptGroup: JsonObject = {};
    for (const [name, body] of Object.entries(members)) {
      if (needed.has(`${group}/${name}`)) keptGroup[name] = body;
    }

    const keptCount = Object.keys(keptGroup).length;
    keptCounts[group] = keptCount;
    if (keptCount > 0) out[group] = keptGroup;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
