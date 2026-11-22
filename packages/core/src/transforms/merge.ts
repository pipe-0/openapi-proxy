import { componentContent, sameValue } from "../document/content-hash.js";
import {
  isMethodField,
  operationKey,
  resolvePathItem,
  webhookKey,
} from "../document/path-items.js";
import { escapePointerSegment, unescapePointerSegment } from "../document/pointer.js";
import { implicitSubtypes, parseComponentRef } from "../document/refs.js";
import { isJsonObject, type JsonObject, type OpenAPIDocument } from "../types.js";
import { hasLooseRefs, inlineRemovedRefs } from "./inline-refs.js";

/** One of the documents being merged. */
export interface MergePart {
  /** The document. It is never changed. */
  doc: OpenAPIDocument;
  /**
   * What people call it ("Billing"). It says where an operation came from,
   * and it names components that had to be renamed.
   */
  name: string;
  /** Put in front of every path of this document, e.g. `/billing`. */
  pathPrefix?: string | undefined;
}

/** Something a merge did that the owner of the documents should know about. */
export type MergeNote =
  /**
   * An operation is not served, because an earlier document already has its
   * place. Usually that document defines the same operation. With
   * `pathDiffers`, it describes the same path in another way (another
   * spelling of a parameter, other path-level parameters, a `$ref`), so the
   * two documents cannot share that path.
   */
  | {
      kind: "operation-left-out";
      source: string;
      operation: string;
      keptFrom: string;
      pathDiffers?: true;
    }
  /** Two documents use one name for different things. The later one's got a new name. */
  | { kind: "component-renamed"; source: string; group: string; from: string; to: string }
  /** Two operations had the same `operationId`, which has to be unique. */
  | { kind: "operation-id-renamed"; source: string; from: string; to: string }
  /** The document lists servers of its own. The merged one uses the first document's. */
  | { kind: "servers-differ"; source: string };

export interface MergeResult {
  doc: OpenAPIDocument;
  /** For each operation key of the merged document, the name of the part it came from. */
  origins: Map<string, string>;
  notes: MergeNote[];
}

export class MergeError extends Error {
  readonly code: "nothing-to-merge" | "version-mismatch";

  constructor(code: MergeError["code"], message: string) {
    super(message);
    this.name = "MergeError";
    this.code = code;
  }
}

/** `billing/` and `/billing` both mean `/billing`; nothing means no prefix. */
export function normalizePathPrefix(input: string | null | undefined): string | undefined {
  const text = (input ?? "").trim();
  // Trailing slashes go. (A loop, not `/\/+$/`: that pattern takes quadratic
  // time on a long run of slashes that does not reach the end.)
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end -= 1;
  const trimmed = text.slice(0, end);
  if (trimmed === "") return undefined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** A normalized prefix made of ordinary path segments. */
export function isValidPathPrefix(prefix: string): boolean {
  return /^(\/[A-Za-z0-9._~-]+)+$/.test(prefix) && prefix.length <= 200;
}

/**
 * Merge several OpenAPI documents into one. This is for independent APIs that
 * should be described as a single API (a main service and the ones behind
 * it), not for one API split across files with `$ref`.
 *
 * The rules, chosen so that a merge can run unattended every time a source
 * changes and never has to stop and ask:
 *
 * - **The first document is the main one.** `info`, `servers` and everything
 *   else at the top level come from it.
 * - **Paths, webhooks, components and tags are combined.**
 * - **The same operation twice: the earlier document wins.** The other is
 *   left out, and a note says so.
 * - **The same component name twice:** if both mean the same thing, they
 *   become one. If not, the later document's is renamed after that document
 *   (`Error` becomes `BillingError`) and every reference to it follows.
 * - **An `operationId` used twice** is renamed the same way, since a document
 *   may use each only once.
 *
 * What holds throughout: an operation means in the merged document what it
 * meant in its own. It keeps the schemas it had, under whatever name, and the
 * security its document gave it, written onto the operation where that was a
 * document-wide default the main document does not share.
 *
 * A single part without a prefix comes back as it is.
 */
export function mergeDocuments(parts: MergePart[]): MergeResult {
  const [main] = parts;
  if (!main) throw new MergeError("nothing-to-merge", "There is nothing to merge.");
  assertSameFamily(parts);

  const origins = new Map<string, string>();
  const notes: MergeNote[] = [];

  // One document, as it is: nothing to combine, nothing to compare.
  if (parts.length === 1 && !normalizePathPrefix(main.pathPrefix)) {
    for (const [path, item] of Object.entries(asObject(main.doc.paths))) {
      for (const [, method] of operationsAt(main.doc, item)) {
        origins.set(operationKey(method, path), main.name);
      }
    }
    for (const [name, item] of Object.entries(asObject(main.doc.webhooks))) {
      for (const [, method] of operationsAt(main.doc, item)) {
        origins.set(webhookKey(method, name), main.name);
      }
    }
    return { doc: main.doc, origins, notes };
  }

  // What the documents bring is collected in Maps, not objects: the keys are
  // theirs, and a Map has no keys with a meaning of its own (`__proto__`).
  const paths = new Map<string, unknown>();
  /** Path with its parameter names removed → the path as first written. */
  const templates = new Map<string, string>();
  /** Path → the document that brought it. */
  const pathOwners = new Map<string, string>();
  const webhooks = new Map<string, unknown>();
  /** Group → its components by name. A group that is not a map of components is kept as it is. */
  const components = new Map<string, unknown>();
  /**
   * `<group>/<name>` in the merged document → what it means: a digest of the
   * component and everything it references. Worked out only when a later
   * document uses the same name.
   */
  const meaning = new Map<string, () => string>();
  const tags: unknown[] = [];
  const tagNames = new Set<string>();
  /** `x-tagGroups` (Redoc, Scalar) by name: groups with the same name become one. */
  const tagGroups = new Map<unknown, unknown>();
  const operationIds = new Set<string>();

  for (const part of parts) {
    const source = part.name;
    const prefix = normalizePathPrefix(part.pathPrefix);
    const content = componentContent(part.doc);
    const partComponents = isJsonObject(part.doc.components) ? part.doc.components : {};

    // ---- Which of this part's components need a new name ----
    const renames = new Map<string, string>();
    /** `<group>/<new name>` of every rename so far, so that two do not land on one name. */
    const renamedTo = new Set<string>();
    for (const [group, members] of Object.entries(partComponents)) {
      if (!isJsonObject(members)) continue;
      for (const name of Object.keys(members)) {
        const key = `${group}/${name}`;
        const existing = meaning.get(key);
        if (existing === undefined || existing() === content.deepDigest(key)) continue;

        const merged = components.get(group);
        const taken = (candidate: string) =>
          (merged instanceof Map && merged.has(candidate)) ||
          Object.hasOwn(members, candidate) ||
          renamedTo.has(`${group}/${candidate}`);
        // `Error` becomes `BillingError`, and `bearerAuth` becomes `BillingBearerAuth`.
        const base = `${componentPrefix(source)}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
        let renamed = base;
        for (let n = 2; taken(renamed); n++) renamed = `${base}${n}`;
        renames.set(key, renamed);
        renamedTo.add(`${group}/${renamed}`);
        notes.push({ kind: "component-renamed", source, group, from: name, to: renamed });
      }
    }

    const idRenames = new Map<string, string>();
    const rewrites: Rewrites = {
      components: renames,
      operationIds: idRenames,
      prefix,
      families: familiesOf(partComponents),
    };
    const rewritten = <T>(node: T): T =>
      renames.size === 0 && idRenames.size === 0 && !prefix ? node : (rewrite(node, rewrites) as T);

    // ---- Which of its operations are kept, and which ids collide ----
    /** What this part adds under one of its paths: the whole item, or operations for an item that exists. */
    interface Addition {
      /** The path as this document writes it, and as the merged one will. */
      raw: string;
      path: string;
      /** Set when the operations join a path item an earlier document brought. */
      joins?: Array<[field: string, method: string]>;
    }
    const additions: Addition[] = [];
    /** A path item behind a `$ref` can be reached from two paths. Its ids are claimed once. */
    const claimed = new Set<JsonObject>();
    const claimId = (operation: JsonObject) => {
      const id = operation.operationId;
      if (typeof id !== "string" || claimed.has(operation)) return;
      claimed.add(operation);
      if (!operationIds.has(id)) {
        operationIds.add(id);
        return;
      }
      let renamed = idRenames.get(id);
      if (!renamed) {
        const base = `${componentPrefix(source)}_${id}`;
        renamed = base;
        for (let n = 2; operationIds.has(renamed); n++) renamed = `${base}${n}`;
        idRenames.set(id, renamed);
        operationIds.add(renamed);
        notes.push({ kind: "operation-id-renamed", source, from: id, to: renamed });
      }
    };
    const leaveOut = (operation: string, keptFrom: string, pathDiffers = false) =>
      notes.push({
        kind: "operation-left-out",
        source,
        operation,
        keptFrom,
        ...(pathDiffers ? { pathDiffers: true as const } : {}),
      });

    for (const [rawPath, item] of Object.entries(asObject(part.doc.paths))) {
      if (!isJsonObject(item)) continue;
      const path = `${prefix ?? ""}${rawPath}`;
      const template = path.replace(/\{[^}]*\}/g, "{}");
      const existingPath = templates.get(template);
      const operations = operationsAt(part.doc, item);

      if (existingPath === undefined) {
        templates.set(template, path);
        pathOwners.set(path, source);
        for (const [, method, operation] of operations) {
          origins.set(operationKey(method, path), source);
          claimId(operation);
        }
        additions.push({ raw: rawPath, path });
        continue;
      }

      // Undefined when the other spelling of this path is in this same document.
      const existing = paths.get(existingPath);
      const owner = (method?: string) =>
        (method && origins.get(operationKey(method, existingPath))) ||
        pathOwners.get(existingPath) ||
        source;
      // Operations can join an existing path only if nothing about the path
      // itself would change for either side: the same spelling, and the same
      // shared fields once this document's references have their final names.
      const joinable =
        existingPath === path &&
        isJsonObject(existing) &&
        existing.$ref === undefined &&
        item.$ref === undefined &&
        sameValue(sharedFields(existing), rewrite(sharedFields(item), rewrites));

      const joins: Array<[string, string]> = [];
      for (const [field, method, operation] of operations) {
        const key = operationKey(method, path);
        if (origins.has(operationKey(method, existingPath))) {
          leaveOut(key, owner(method));
        } else if (!joinable) {
          leaveOut(key, owner(), true);
        } else {
          origins.set(key, source);
          claimId(operation);
          joins.push([field, method]);
        }
      }
      if (joins.length > 0) additions.push({ raw: rawPath, path, joins });
    }

    const newWebhooks: string[] = [];
    for (const [name, item] of Object.entries(asObject(part.doc.webhooks))) {
      if (!isJsonObject(item)) continue;
      const operations = operationsAt(part.doc, item);
      if (webhooks.has(name)) {
        for (const [, method] of operations) {
          leaveOut(webhookKey(method, name), origins.get(webhookKey(method, name)) ?? source);
        }
        continue;
      }
      for (const [, method, operation] of operations) {
        origins.set(webhookKey(method, name), source);
        claimId(operation);
      }
      newWebhooks.push(name);
    }

    // ---- What this part contributes, as a document of its own ----
    const rawPaths = asObject(part.doc.paths);
    const rawWebhooks = asObject(part.doc.webhooks);
    const kept: OpenAPIDocument = {
      ...part.doc,
      paths: Object.fromEntries(
        additions.map(({ raw, joins }) => [
          raw,
          joins ? onlyOperations(asObject(rawPaths[raw]), joins) : rawPaths[raw],
        ]),
      ),
      webhooks: Object.fromEntries(newWebhooks.map((name) => [name, rawWebhooks[name]])),
    };
    // A reference into an operation that was left out (bundlers write such
    // refs: `#/paths/~1users/get/...`) would now find another document's
    // operation there, or nothing. It is replaced by a copy of what it meant.
    const own = hasLooseRefs(part.doc) ? inlineRemovedRefs(kept, part.doc).doc : kept;

    // A default that the main document does not share is written onto the
    // operations it applied to, so each keeps the security it had.
    const ownSecurity = part.doc.security ?? [];
    const explicit = part !== main && !sameValue(ownSecurity, main.doc.security ?? []);
    const secured = (item: unknown) => (explicit ? withSecurity(item, ownSecurity) : item);

    // ---- Rewrite what is kept, and add it ----
    const ownPaths = asObject(own.paths);
    for (const { raw, path, joins } of additions) {
      const item = asObject(secured(ownPaths[raw]));
      if (!joins) {
        paths.set(path, rewritten(item));
        continue;
      }
      const target = { ...asObject(paths.get(path)) };
      for (const [field, method] of joins) {
        if (isMethodField(field)) {
          target[field] = rewritten(item[field]);
        } else {
          target.additionalOperations = {
            ...asObject(target.additionalOperations),
            [method]: rewritten(additionalOperation(item, method)),
          };
        }
      }
      paths.set(path, target);
    }

    const ownWebhooks = asObject(own.webhooks);
    for (const name of newWebhooks) webhooks.set(name, rewritten(secured(ownWebhooks[name])));

    for (const [group, members] of Object.entries(asObject(own.components))) {
      if (!isJsonObject(members)) {
        // Not a map of components (an extension value, say): the first one stands.
        if (!components.has(group)) components.set(group, members);
        continue;
      }
      if (!components.has(group)) components.set(group, new Map<string, unknown>());
      const target = components.get(group);
      if (!(target instanceof Map)) continue;
      for (const [name, body] of Object.entries(members)) {
        const key = `${group}/${name}`;
        const finalName = renames.get(key) ?? name;
        const finalKey = `${group}/${finalName}`;
        if (meaning.has(finalKey)) continue; // the same thing, already there
        target.set(finalName, rewritten(group === "pathItems" ? secured(body) : body));
        meaning.set(finalKey, () => content.deepDigest(key));
      }
    }

    for (const tag of Array.isArray(part.doc.tags) ? part.doc.tags : []) {
      const name = isJsonObject(tag) && typeof tag.name === "string" ? tag.name : undefined;
      if (name !== undefined && tagNames.has(name)) continue;
      if (name !== undefined) tagNames.add(name);
      tags.push(tag);
    }
    for (const group of Array.isArray(part.doc["x-tagGroups"]) ? part.doc["x-tagGroups"] : []) {
      const name = isJsonObject(group) ? group.name : group;
      const existing = tagGroups.get(name);
      if (!isJsonObject(existing) || !isJsonObject(group)) {
        if (!tagGroups.has(name)) tagGroups.set(name, group);
        continue;
      }
      const listed = [existing.tags, group.tags].flatMap((list) =>
        Array.isArray(list) ? list : [],
      );
      tagGroups.set(name, { ...existing, tags: [...new Set(listed)] });
    }

    if (
      part !== main &&
      part.doc.servers !== undefined &&
      !sameValue(part.doc.servers, main.doc.servers)
    ) {
      notes.push({ kind: "servers-differ", source });
    }
  }

  // The main document, with the combined parts in place of its own. Keys keep
  // their position; a section the main document lacked goes to the end.
  const doc: OpenAPIDocument = { ...main.doc, openapi: highestVersion(parts) };
  const place = (key: string, value: unknown, present: boolean) => {
    if (present) doc[key] = value;
    else delete doc[key];
  };
  place("paths", Object.fromEntries(paths), paths.size > 0 || main.doc.paths !== undefined);
  place("webhooks", Object.fromEntries(webhooks), webhooks.size > 0);
  place(
    "components",
    Object.fromEntries(
      [...components].map(([group, members]) => [
        group,
        members instanceof Map ? Object.fromEntries(members) : members,
      ]),
    ),
    components.size > 0,
  );
  place("tags", tags, tags.length > 0);
  place("x-tagGroups", [...tagGroups.values()], tagGroups.size > 0);

  return { doc, origins, notes };
}

// ---- Rules of combination ----

const versionOf = (doc: OpenAPIDocument) => (typeof doc.openapi === "string" ? doc.openapi : "");
/** 3.0 on one side, 3.1 and later on the other: their schema rules are different languages. */
const familyOf = (version: string) => (version.startsWith("3.0") ? "3.0" : "3.1 or later");

function assertSameFamily(parts: MergePart[]): void {
  const [main, ...others] = parts;
  if (!main) return;
  const family = familyOf(versionOf(main.doc));
  const odd = others.find((part) => familyOf(versionOf(part.doc)) !== family);
  if (!odd) return;
  throw new MergeError(
    "version-mismatch",
    `${main.name} is OpenAPI ${versionOf(main.doc)} and ${odd.name} is ${versionOf(odd.doc)}. A 3.0 document cannot be merged with one that is 3.1 or later, because their schemas follow different rules.`,
  );
}

function highestVersion(parts: MergePart[]): string {
  const rank = (version: string) =>
    version.split(".").reduce((sum, part) => sum * 1000 + (Number.parseInt(part, 10) || 0), 0);
  return parts.map((part) => versionOf(part.doc)).sort((a, b) => rank(b) - rank(a))[0] ?? "";
}

/** "Billing API" names things "Billing": words run together, without a trailing "API". */
function componentPrefix(name: string): string {
  const words = name.replace(/\bapi\b/gi, " ").match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return joined || "Other";
}

const asObject = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

/** A path item's operations as `[field or method name, METHOD, operation]`. */
function operationFields(item: JsonObject): Array<[string, string, JsonObject]> {
  const found: Array<[string, string, JsonObject]> = [];
  for (const [key, value] of Object.entries(item)) {
    if (isMethodField(key) && isJsonObject(value)) {
      found.push([key, key.toUpperCase(), value]);
    } else if (key === "additionalOperations" && isJsonObject(value)) {
      for (const [method, operation] of Object.entries(value)) {
        if (isJsonObject(operation))
          found.push(["additionalOperations", method.toUpperCase(), operation]);
      }
    }
  }
  return found;
}

/** The operations a path item defines, following a `$ref` to where they are written. */
const operationsAt = (doc: OpenAPIDocument, item: unknown) =>
  isJsonObject(item) ? operationFields(resolvePathItem(doc, item) ?? item) : [];

/** One of a path item's 3.2 `additionalOperations`, whatever case its method is written in. */
function additionalOperation(item: JsonObject, method: string): unknown {
  const found = Object.entries(asObject(item.additionalOperations)).find(
    ([name]) => name.toUpperCase() === method,
  );
  return found?.[1];
}

/** A path item reduced to some of its operations. What it says about all of them stays. */
function onlyOperations(item: JsonObject, operations: Array<[field: string, method: string]>) {
  const reduced = sharedFields(item);
  for (const [field, method] of operations) {
    if (isMethodField(field)) {
      reduced[field] = item[field];
    } else {
      reduced.additionalOperations = {
        ...asObject(reduced.additionalOperations),
        [method]: additionalOperation(item, method),
      };
    }
  }
  return reduced;
}

/**
 * A path item whose operations state the security they would otherwise take
 * from their document's default. An operation that states its own is left as
 * it is, and so is an item that is only a `$ref`.
 */
function withSecurity(item: unknown, security: unknown): unknown {
  if (!isJsonObject(item) || item.$ref !== undefined) return item;
  const stated = (operation: unknown) =>
    isJsonObject(operation) && operation.security === undefined
      ? { ...operation, security }
      : operation;
  const each = (operations: JsonObject) =>
    Object.fromEntries(Object.entries(operations).map(([name, value]) => [name, stated(value)]));
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => {
      if (isMethodField(key)) return [key, stated(value)];
      if (key === "additionalOperations" && isJsonObject(value)) return [key, each(value)];
      return [key, value];
    }),
  );
}

/**
 * The schemas of a document that have a discriminator and are extended by
 * others through `allOf`, each with the names of those others.
 */
function familiesOf(components: JsonObject): Map<unknown, string[]> {
  const schemas = asObject(components.schemas);
  const families = new Map<unknown, string[]>();
  for (const [name, subtypes] of implicitSubtypes(components)) {
    families.set(schemas[name], subtypes);
  }
  return families;
}

/** What a path item says about all of its operations: parameters, servers, summary. */
function sharedFields(item: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => !isMethodField(key) && key !== "additionalOperations"),
  );
}

// ---- Following a rename through a document ----

interface Rewrites {
  /** `<group>/<name>` → the component's new name. */
  components: Map<string, string>;
  operationIds: Map<string, string>;
  prefix: string | undefined;
  /** See `familiesOf`. */
  families: Map<unknown, string[]>;
}

/**
 * Keys under which a document holds its author's own data: examples and
 * default values. Whatever is in there is not a reference, even if it has a
 * key called `$ref` or `operationId`. (An API that returns OpenAPI documents
 * or JSON Schemas shows exactly that in its examples.)
 */
const LITERAL = new Set([
  "example",
  "default",
  "const",
  "enum",
  // In an Example Object.
  "value",
  "dataValue",
  "serializedValue",
  "externalValue",
]);

/**
 * Keys whose value maps names to things. The names are the author's, and can
 * be any word at all, including the ones this file gives a meaning to: a
 * response called `default`, a property called `security`. So the keys inside
 * these are never read as keywords; only what they name is looked into.
 */
const NAMED = new Set([
  // In a schema.
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
  // In the rest of a document.
  "paths",
  "webhooks",
  "x-webhooks",
  "callbacks",
  "responses",
  "headers",
  "content",
  "encoding",
  "examples",
  "links",
  "variables",
  // The groups of `components` that are not already listed.
  "schemas",
  "parameters",
  "requestBodies",
  "securitySchemes",
  "pathItems",
  "mediaTypes",
]);

/**
 * A copy of `node` in which every mention of a renamed thing uses its new
 * name: `$ref`s, discriminators (which can name a schema without a `$ref`,
 * or without naming it at all), security requirements (whose keys name
 * security schemes) and `operationId`s, in operations and in the links that
 * point at them. A path prefix is applied to references into `paths`.
 *
 * It walks everything, so a place the specification adds tomorrow is covered,
 * and it knows the two kinds of places where a key is not a keyword: maps of
 * names, and literal data. Parts that mention nothing renamed are shared with
 * the original, not copied.
 */
function rewrite(node: unknown, rewrites: Rewrites, named = false): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const rewritten = rewrite(item, rewrites);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : node;
  }
  if (!isJsonObject(node)) return node;

  let out: JsonObject | undefined;
  for (const [key, value] of Object.entries(node)) {
    const next = named ? rewrite(value, rewrites) : rewriteField(node, key, value, rewrites);
    if (next !== value) {
      out ??= { ...node };
      out[key] = next;
    }
  }
  return out ?? node;
}

/** One keyword of an object and its value. */
function rewriteField(parent: JsonObject, key: string, value: unknown, rewrites: Rewrites) {
  // Schema `examples` is a list of literal values; elsewhere it maps names to Example Objects.
  if (LITERAL.has(key) || (key === "examples" && Array.isArray(value))) return value;
  if (typeof value === "string") {
    // A link points at an operation by `operationRef` (a reference) or `operationId`.
    if (key === "$ref" || key === "operationRef") return rewriteRef(value, rewrites);
    if (key === "operationId") return rewrites.operationIds.get(value) ?? value;
    return value;
  }
  if (key === "security" && Array.isArray(value)) return rewriteSecurity(value, rewrites);
  if (key === "discriminator" && isJsonObject(value)) {
    return rewriteDiscriminator(value, parent, rewrites);
  }
  return rewrite(value, rewrites, NAMED.has(key) && isJsonObject(value));
}

function rewriteRef(ref: string, { components, prefix }: Rewrites): string {
  const component = /^#\/components\/([^/]+)\/([^/]+)(.*)$/.exec(ref);
  if (component) {
    const [, group = "", name = "", rest = ""] = component;
    const renamed = components.get(
      `${unescapePointerSegment(group)}/${unescapePointerSegment(name)}`,
    );
    return renamed ? `#/components/${group}/${escapePointerSegment(renamed)}${rest}` : ref;
  }
  const path = /^#\/paths\/([^/]+)(.*)$/.exec(ref);
  if (path && prefix) {
    const [, segment = "", rest = ""] = path;
    return `#/paths/${escapePointerSegment(`${prefix}${unescapePointerSegment(segment)}`)}${rest}`;
  }
  return ref;
}

/**
 * A discriminator finds the schema for a value in its `mapping` or, failing
 * that, by name: the value "Cat" means the schema called `Cat`. A schema that
 * is found by name and gets a new one has to keep answering to the old, or
 * the same payload would now mean another document's `Cat`. So the name it
 * had is written into the mapping.
 */
function rewriteDiscriminator(
  discriminator: JsonObject,
  schema: JsonObject,
  rewrites: Rewrites,
): JsonObject {
  const renamed = (name: string) => rewrites.components.get(`schemas/${name}`);
  /** A target is a `$ref`-style string, or just the name of a schema. */
  const target = (to: unknown) =>
    typeof to !== "string"
      ? to
      : to.startsWith("#")
        ? rewriteRef(to, rewrites)
        : (renamed(to) ?? to);

  const mapping = new Map<string, unknown>();
  /** Schemas the mapping lists already. Their author chose the values they answer to. */
  const listed = new Set<string>();
  for (const [value, to] of Object.entries(asObject(discriminator.mapping))) {
    mapping.set(value, target(to));
    if (typeof to === "string") listed.add(parseComponentRef(to)?.name ?? to);
  }
  for (const name of foundByName(schema, rewrites)) {
    const now = renamed(name);
    if (now !== undefined && !listed.has(name) && !mapping.has(name)) {
      mapping.set(name, `#/components/schemas/${escapePointerSegment(now)}`);
    }
  }

  const out: JsonObject = { ...discriminator };
  if (mapping.size > 0) out.mapping = Object.fromEntries(mapping);
  // OpenAPI 3.2: the schema for values the mapping does not list.
  if (out.defaultMapping !== undefined) out.defaultMapping = target(out.defaultMapping);
  return sameValue(out, discriminator) ? discriminator : out;
}

/** The schemas a discriminator can find by name: those its schema lists, and those that extend it. */
function foundByName(schema: JsonObject, { families }: Rewrites): string[] {
  const listed = [schema.oneOf, schema.anyOf]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .flatMap((member) => {
      const ref =
        isJsonObject(member) && typeof member.$ref === "string"
          ? parseComponentRef(member.$ref)
          : undefined;
      return ref?.group === "schemas" ? [ref.name] : [];
    });
  return [...listed, ...(families.get(schema) ?? [])];
}

/** `security: [{ bearerAuth: [] }]`: the keys are names of security schemes. */
function rewriteSecurity(requirements: unknown[], { components }: Rewrites): unknown[] {
  let changed = false;
  const next = requirements.map((requirement) => {
    if (!isJsonObject(requirement)) return requirement;
    if (!Object.keys(requirement).some((name) => components.has(`securitySchemes/${name}`))) {
      return requirement;
    }
    changed = true;
    return Object.fromEntries(
      Object.entries(requirement).map(([name, scopes]) => [
        components.get(`securitySchemes/${name}`) ?? name,
        scopes,
      ]),
    );
  });
  return changed ? next : requirements;
}
