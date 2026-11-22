import { spend, spendText, withBudget } from "../document/budget.js";
import { documentContent, sameValue } from "../document/content-hash.js";
import {
  operationKey,
  operationsOf,
  resolvePathItem,
  webhookKey,
  withOperations,
} from "../document/path-items.js";
import { pointerSegments, pointerTo } from "../document/pointer.js";
import { componentPlace, implicitSubtypes, parseComponentRef } from "../document/refs.js";
import { mapStructure } from "../document/schemas.js";
import { walk } from "../document/walk.js";
import { isJsonObject, type JsonObject, type OpenAPIDocument } from "../types.js";
import { inlineRemovedRefs } from "./inline-refs.js";

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
 * document-wide default the main document does not share. Of a later document
 * only its paths, webhooks, components and tags are taken; whatever in them
 * referred to the rest of it (`#/x-shared/...`) gets a copy of what it meant.
 *
 * A single part without a prefix comes back as it is.
 */
export function mergeDocuments(parts: MergePart[]): MergeResult {
  return withBudget(() => merge(parts));
}

function merge(parts: MergePart[]): MergeResult {
  const [main] = parts;
  if (!main) throw new MergeError("nothing-to-merge", "There is nothing to merge.");
  assertSameFamily(parts);
  // One document, as it is: nothing to combine, nothing to compare.
  if (parts.length === 1 && !normalizePathPrefix(main.pathPrefix)) return asItIs(main);

  const merged: Merged = {
    origins: new Map(),
    notes: [],
    paths: new Map(),
    templates: new Map(),
    pathOwners: new Map(),
    webhooks: new Map(),
    components: new Map(),
    meaning: new Map(),
    tags: [],
    tagNames: new Set(),
    tagGroups: new Map(),
    operationIds: new Set(),
  };

  /** What a document's default security amounts to: the requirements, and what the schemes they name are. */
  const defaultSecurity = (doc: OpenAPIDocument, content: ReturnType<typeof documentContent>) =>
    content.of({ security: doc.security ?? [] });
  let mainSecurity = "";
  /** The main document's top level, apart from the sections that are combined. */
  let top: JsonObject = {};

  for (const part of parts) {
    const content = documentContent(part.doc);
    if (part === main) {
      mainSecurity = defaultSecurity(part.doc, content);
      top = addPart(merged, part, part.doc, content, true);
      continue;
    }
    // A default that the main document does not share is written onto the
    // operations it applied to, before anything else: a path item that two
    // documents have in common is then no longer the same thing in both.
    const differs = defaultSecurity(part.doc, content) !== mainSecurity;
    const doc = differs ? withStatedSecurity(part.doc) : part.doc;
    addPart(merged, part, doc, differs ? documentContent(doc) : content, false);

    if (part.doc.servers !== undefined && !sameValue(part.doc.servers, main.doc.servers)) {
      merged.notes.push({ kind: "servers-differ", source: part.name });
    }
  }

  // The main document, with the combined sections in place of its own. Keys
  // keep their position; a section the main document lacked goes to the end.
  const { paths, webhooks, components, tags, tagGroups } = merged;
  const doc: OpenAPIDocument = { ...top, openapi: highestVersion(parts) };
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
  place(
    "x-tagGroups",
    [...tagGroups.values()].map(({ group, tags: joined }) =>
      joined && isJsonObject(group) ? { ...group, tags: [...joined] } : group,
    ),
    tagGroups.size > 0,
  );

  return { doc, origins: merged.origins, notes: merged.notes };
}

/** A single document, served as it is: only where its operations come from is worked out. */
function asItIs(main: MergePart): MergeResult {
  const origins = new Map<string, string>();
  for (const webhook of [false, true]) {
    const container = asObject(webhook ? main.doc.webhooks : main.doc.paths);
    for (const name of Object.keys(container)) {
      spend();
      for (const { method } of operationsAt(main.doc, container[name])) {
        origins.set(webhook ? webhookKey(method, name) : operationKey(method, name), main.name);
      }
    }
  }
  return { doc: main.doc, origins, notes: [] };
}

/**
 * What has been combined so far. In Maps, not objects: the keys are the
 * documents', and a Map has no keys with a meaning of its own (`__proto__`).
 */
interface Merged {
  /** Operation key → the name of the part it came from. */
  origins: Map<string, string>;
  notes: MergeNote[];
  paths: Map<string, unknown>;
  /** Path with its parameter names removed → the path as first written. */
  templates: Map<string, string>;
  /** Path → the document that brought it. */
  pathOwners: Map<string, string>;
  webhooks: Map<string, unknown>;
  /** Group → its components by name. A group that is not a map of components is kept as it is. */
  components: Map<string, unknown>;
  /**
   * `<group>/<name>` in the merged document → what it means: a digest of the
   * component and everything it references. Worked out only when a later
   * document uses the same name.
   */
  meaning: Map<string, () => string>;
  tags: unknown[];
  tagNames: Set<string>;
  /**
   * `x-tagGroups` (Redoc, Scalar) by name: groups with the same name become
   * one. `tags` is set once a second group of that name has added to the first.
   */
  tagGroups: Map<unknown, { group: unknown; tags?: Set<unknown> }>;
  operationIds: Set<string>;
}

/** What a part adds under one of its paths: the whole item, or operations for an item that exists. */
interface Addition {
  /** The path as this document writes it, and as the merged one will. */
  raw: string;
  path: string;
  /** Set when operations join a path item an earlier document brought: their methods. */
  joined?: Set<string>;
}

/**
 * Add one document to what has been combined. `doc` is the part's document,
 * relying on no default for security that the main document does not have.
 * Returns what is left of its top level, with its references following the
 * renames; only the main document's is used.
 */
function addPart(
  merged: Merged,
  part: MergePart,
  doc: OpenAPIDocument,
  content: ReturnType<typeof documentContent>,
  isMain: boolean,
): JsonObject {
  const source = part.name;
  const prefix = normalizePathPrefix(part.pathPrefix);
  const naming = componentPrefix(source);

  const renames = renamedComponents(merged, doc, content, source, naming);
  const operationIds = new Map<string, string>();
  const rewritesFor = (components: unknown): Rewrites => ({
    components: renames,
    operationIds,
    prefix,
    membersOf: familyMembers(asObject(components)),
  });
  const { additions, newWebhooks } = claimOperations(
    merged,
    doc,
    source,
    naming,
    prefix,
    rewritesFor(doc.components),
  );

  // ---- What this part contributes, as a document of its own ----
  const rawPaths = asObject(doc.paths);
  const rawWebhooks = asObject(doc.webhooks);
  const kept: OpenAPIDocument = {
    // Of a later document, only these sections end up in the merged one.
    ...(isMain ? doc : doc.components === undefined ? {} : { components: doc.components }),
    paths: Object.fromEntries(
      additions.map(({ raw, joined }) => {
        const item = asObject(rawPaths[raw]);
        return [
          raw,
          joined
            ? withOperations(
                item,
                operationsOf(item).filter(({ method }) => joined.has(method)),
              )
            : rawPaths[raw],
        ];
      }),
    ),
    webhooks: Object.fromEntries(newWebhooks.map((name) => [name, rawWebhooks[name]])),
  };
  // A reference to something that is not carried over (an operation that was
  // left out, a section of its own that the merged document does not have)
  // would find another document's content there, or nothing. It is replaced
  // by a copy of what it meant.
  const own = inlineRemovedRefs(kept, doc).doc;

  // ---- Rewrite what is kept, and add it ----
  const rewrites = rewritesFor(own.components);
  const rewritten = <T>(node: T): T =>
    renames.size === 0 && operationIds.size === 0 && !prefix ? node : rewrite(node, rewrites);

  const ownPaths = asObject(own.paths);
  for (const { raw, path, joined } of additions) {
    const item = asObject(ownPaths[raw]);
    if (!joined) {
      merged.paths.set(path, rewritten(item));
      continue;
    }
    const target = asObject(merged.paths.get(path));
    merged.paths.set(
      path,
      withOperations(target, [
        ...operationsOf(target),
        ...operationsOf(item).map((joining) => ({
          ...joining,
          operation: rewritten(joining.operation),
        })),
      ]),
    );
  }

  const ownWebhooks = asObject(own.webhooks);
  for (const name of newWebhooks) merged.webhooks.set(name, rewritten(ownWebhooks[name]));

  const ownComponents = asObject(own.components);
  for (const group of Object.keys(ownComponents)) {
    const members = ownComponents[group];
    if (!isJsonObject(members)) {
      // Not a map of components (an extension value, say): the first one stands.
      if (!merged.components.has(group)) merged.components.set(group, members);
      continue;
    }
    if (!merged.components.has(group)) merged.components.set(group, new Map<string, unknown>());
    const target = merged.components.get(group);
    if (!(target instanceof Map)) continue;
    for (const name of Object.keys(members)) {
      spend();
      const key = `${group}/${name}`;
      const finalName = renames.get(key) ?? name;
      const finalKey = `${group}/${finalName}`;
      if (merged.meaning.has(finalKey)) continue; // the same thing, already there
      target.set(finalName, rewritten(members[name]));
      merged.meaning.set(finalKey, () => content.at(componentPlace(group, name)));
    }
  }

  for (const tag of asList(doc.tags)) {
    spend();
    const name = isJsonObject(tag) && typeof tag.name === "string" ? tag.name : undefined;
    if (name !== undefined && merged.tagNames.has(name)) continue;
    if (name !== undefined) merged.tagNames.add(name);
    merged.tags.push(tag);
  }
  for (const group of asList(doc["x-tagGroups"])) {
    spend();
    const name = isJsonObject(group) ? group.name : group;
    const known = merged.tagGroups.get(name);
    if (!known) {
      merged.tagGroups.set(name, { group });
    } else if (isJsonObject(known.group) && isJsonObject(group)) {
      // The same name again: what it lists joins what the first one lists.
      known.tags ??= new Set(asList(known.group.tags));
      const listed = asList(group.tags);
      spend(listed.length);
      for (const tag of listed) known.tags.add(tag);
    }
  }

  // The rest of its top level, with the keys of the combined sections left
  // where they are: whoever puts the combined sections in keeps their places.
  const rest = rewritten(
    Object.fromEntries(Object.entries(own).filter(([key]) => !COMBINED.has(key))),
  );
  return Object.fromEntries(
    Object.keys(own).map((key) => [key, COMBINED.has(key) ? undefined : rest[key]]),
  );
}

/** The sections of a document that a merge combines. The rest is the main document's. */
const COMBINED = new Set(["paths", "webhooks", "components", "tags", "x-tagGroups"]);

/**
 * Which of a part's components need a new name: those whose name is taken by
 * something that means something else. `Error` becomes `BillingError`, and
 * `bearerAuth` becomes `BillingBearerAuth`.
 */
function renamedComponents(
  merged: Merged,
  doc: OpenAPIDocument,
  content: ReturnType<typeof documentContent>,
  source: string,
  naming: string,
): Map<string, string> {
  const renames = new Map<string, string>();
  /** `<group>/<new name>` of every rename so far, so that two do not land on one name. */
  const renamedTo = new Set<string>();
  const components = asObject(doc.components);

  for (const group of Object.keys(components)) {
    const members = components[group];
    if (!isJsonObject(members)) continue;
    const combined = merged.components.get(group);
    for (const name of Object.keys(members)) {
      spend();
      const key = `${group}/${name}`;
      const existing = merged.meaning.get(key);
      if (existing === undefined || existing() === content.at(componentPlace(group, name))) {
        continue;
      }

      const taken = (candidate: string) =>
        (combined instanceof Map && combined.has(candidate)) ||
        Object.hasOwn(members, candidate) ||
        renamedTo.has(`${group}/${candidate}`);
      const base = `${naming}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      let renamed = base;
      for (let n = 2; taken(renamed); n++) {
        spend();
        renamed = `${base}${n}`;
      }
      renames.set(key, renamed);
      renamedTo.add(`${group}/${renamed}`);
      merged.notes.push({ kind: "component-renamed", source, group, from: name, to: renamed });
    }
  }
  return renames;
}

/**
 * Decide which of a part's operations are kept, note the ones that are not,
 * and give a new id to every operation whose `operationId` is taken
 * (`operationIds` is filled with those).
 */
function claimOperations(
  merged: Merged,
  doc: OpenAPIDocument,
  source: string,
  naming: string,
  prefix: string | undefined,
  rewrites: Rewrites,
): { additions: Addition[]; newWebhooks: string[] } {
  const additions: Addition[] = [];
  /** A path item behind a `$ref` can be reached from two paths. Its ids are claimed once. */
  const claimed = new Set<JsonObject>();
  const claimId = (operation: JsonObject) => {
    const id = operation.operationId;
    if (typeof id !== "string" || claimed.has(operation)) return;
    claimed.add(operation);
    if (!merged.operationIds.has(id)) {
      merged.operationIds.add(id);
      return;
    }
    if (rewrites.operationIds.has(id)) return;
    const base = `${naming}_${id}`;
    let renamed = base;
    for (let n = 2; merged.operationIds.has(renamed); n++) {
      spend();
      renamed = `${base}${n}`;
    }
    rewrites.operationIds.set(id, renamed);
    merged.operationIds.add(renamed);
    merged.notes.push({ kind: "operation-id-renamed", source, from: id, to: renamed });
  };
  const leaveOut = (operation: string, keptFrom: string, pathDiffers = false) =>
    merged.notes.push({
      kind: "operation-left-out",
      source,
      operation,
      keptFrom,
      ...(pathDiffers ? { pathDiffers: true as const } : {}),
    });

  const rawPaths = asObject(doc.paths);
  for (const rawPath of Object.keys(rawPaths)) {
    spend();
    const item = rawPaths[rawPath];
    if (!isJsonObject(item)) continue;
    const path = `${prefix ?? ""}${rawPath}`;
    const template = templateOf(path);
    const existingPath = merged.templates.get(template);
    const operations = operationsAt(doc, item);

    if (existingPath === undefined) {
      merged.templates.set(template, path);
      merged.pathOwners.set(path, source);
      for (const { method, operation } of operations) {
        merged.origins.set(operationKey(method, path), source);
        claimId(operation);
      }
      additions.push({ raw: rawPath, path });
      continue;
    }

    // Undefined when the other spelling of this path is in this same document.
    const existing = merged.paths.get(existingPath);
    const owner = (method?: string) =>
      (method && merged.origins.get(operationKey(method, existingPath))) ||
      merged.pathOwners.get(existingPath) ||
      source;
    // Operations can join an existing path only if nothing about the path
    // itself would change for either side: the same spelling, and the same
    // shared fields once this document's references have their final names.
    const joinable =
      existingPath === path &&
      isJsonObject(existing) &&
      existing.$ref === undefined &&
      item.$ref === undefined &&
      sameValue(withOperations(existing, []), rewrite(withOperations(item, []), rewrites));

    const joined = new Set<string>();
    for (const { method, operation } of operations) {
      const key = operationKey(method, path);
      if (merged.origins.has(operationKey(method, existingPath))) {
        leaveOut(key, owner(method));
      } else if (!joinable) {
        leaveOut(key, owner(), true);
      } else {
        merged.origins.set(key, source);
        claimId(operation);
        joined.add(method);
      }
    }
    if (joined.size > 0) additions.push({ raw: rawPath, path, joined });
  }

  const newWebhooks: string[] = [];
  const rawWebhooks = asObject(doc.webhooks);
  for (const name of Object.keys(rawWebhooks)) {
    spend();
    const item = rawWebhooks[name];
    if (!isJsonObject(item)) continue;
    const operations = operationsAt(doc, item);
    if (merged.webhooks.has(name)) {
      for (const { method } of operations) {
        const key = webhookKey(method, name);
        leaveOut(key, merged.origins.get(key) ?? source);
      }
      continue;
    }
    for (const { method, operation } of operations) {
      merged.origins.set(webhookKey(method, name), source);
      claimId(operation);
    }
    newWebhooks.push(name);
  }
  return { additions, newWebhooks };
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
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The operations a path item defines, following a `$ref` to where they are written. */
const operationsAt = (doc: OpenAPIDocument, item: unknown) =>
  isJsonObject(item) ? operationsOf(resolvePathItem(doc, item) ?? item) : [];

/**
 * A path with the names of its parameters taken out: `/pets/{id}` and
 * `/pets/{petId}` are one path. (Read from left to right, once. A pattern
 * that looks for the closing brace again from every opening one takes the
 * square of a path that is all opening braces.)
 */
function templateOf(path: string): string {
  spendText(path.length);
  let template = "";
  for (let at = 0; ; ) {
    const open = path.indexOf("{", at);
    const close = open === -1 ? -1 : path.indexOf("}", open);
    if (close === -1) return template + path.slice(at);
    template += `${path.slice(at, open)}{}`;
    at = close + 1;
  }
}

/**
 * The document with every operation saying which security it has, instead of
 * leaving that to the document's default: in its paths and webhooks, in the
 * path items among its components, and in callbacks.
 */
function withStatedSecurity(doc: OpenAPIDocument): OpenAPIDocument {
  const security = doc.security ?? [];
  return mapStructure(doc, {
    operation: (operation) =>
      operation.security === undefined ? { ...operation, security } : operation,
  });
}

/**
 * For a schema with a discriminator: the names of the schemas that extend
 * it, directly or through one another (see `implicitSubtypes`).
 */
function familyMembers(components: JsonObject): (schema: JsonObject) => string[] {
  const subtypes = implicitSubtypes(components);
  const schemas = asObject(components.schemas);
  const names = new Map<unknown, string>();
  for (const name of subtypes.keys()) names.set(schemas[name], name);

  return (schema) => {
    const head = names.get(schema);
    if (head === undefined) return [];
    const members = new Set<string>();
    const queue = [head];
    for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
      for (const extender of subtypes.get(name) ?? []) {
        spend();
        if (members.has(extender)) continue;
        members.add(extender);
        queue.push(extender);
      }
    }
    return [...members];
  };
}

// ---- Following a rename through a document ----

interface Rewrites {
  /** `<group>/<name>` → the component's new name. */
  components: Map<string, string>;
  operationIds: Map<string, string>;
  prefix: string | undefined;
  /** See `familyMembers`. */
  membersOf: (schema: JsonObject) => string[];
}

/**
 * A copy of `node` in which every mention of a renamed thing uses its new
 * name: `$ref`s, discriminators (which can name a schema without a `$ref`,
 * or without naming it at all), security requirements (whose keys name
 * security schemes) and `operationId`s, in operations and in the links that
 * point at them. A path prefix is applied to references into `paths`.
 *
 * Parts that mention nothing renamed are shared with the original, not
 * copied. What counts as a mention is decided in document/walk.ts.
 */
function rewrite<T>(node: T, rewrites: Rewrites): T {
  return walk(node, {
    keyword(key, value, parent) {
      if (typeof value === "string") {
        // A link points at an operation by `operationRef` (a reference) or `operationId`.
        if (key === "$ref" || key === "operationRef") return rewriteRef(value, rewrites);
        if (key === "operationId") return rewrites.operationIds.get(value) ?? value;
        return undefined;
      }
      if (key === "security" && Array.isArray(value)) return rewriteSecurity(value, rewrites);
      if (key === "discriminator" && isJsonObject(value)) {
        return rewriteDiscriminator(value, parent, rewrites);
      }
      return undefined;
    },
  });
}

function rewriteRef(ref: string, { components, prefix }: Rewrites): string {
  if (!ref.startsWith("#/")) return ref;
  // Read the way a reference is resolved (escapes and all), and written back
  // in one spelling only if something about it changes.
  const segments = pointerSegments(ref);
  if (!segments) return ref;
  const [first, second, third] = segments;
  if (first === "components" && second !== undefined && third !== undefined) {
    const renamed = components.get(`${second}/${third}`);
    return renamed ? pointerTo(["components", second, renamed, ...segments.slice(3)]) : ref;
  }
  if (first === "paths" && second !== undefined && prefix) {
    return pointerTo(["paths", `${prefix}${second}`, ...segments.slice(2)]);
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
      mapping.set(name, componentPlace("schemas", now));
    }
  }

  const out: JsonObject = { ...discriminator };
  if (mapping.size > 0) out.mapping = Object.fromEntries(mapping);
  // OpenAPI 3.2: the schema for values the mapping does not list.
  if (out.defaultMapping !== undefined) out.defaultMapping = target(out.defaultMapping);
  return sameValue(out, discriminator) ? discriminator : out;
}

/** The schemas a discriminator can find by name: those its schema lists, and those that extend it. */
function foundByName(schema: JsonObject, { membersOf }: Rewrites): string[] {
  const listed = [schema.oneOf, schema.anyOf]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .flatMap((member) => {
      const ref =
        isJsonObject(member) && typeof member.$ref === "string"
          ? parseComponentRef(member.$ref)
          : undefined;
      return ref?.group === "schemas" ? [ref.name] : [];
    });
  return [...listed, ...membersOf(schema)];
}

/** `security: [{ bearerAuth: [] }]`: the keys are names of security schemes. */
function rewriteSecurity(requirements: unknown[], { components }: Rewrites): unknown[] {
  let changed = false;
  const next = requirements.map((requirement) => {
    if (!isJsonObject(requirement)) return requirement;
    const names = Object.keys(requirement);
    spend(names.length + 1);
    if (!names.some((name) => components.has(`securitySchemes/${name}`))) return requirement;
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
