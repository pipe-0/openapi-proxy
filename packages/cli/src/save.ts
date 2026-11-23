import type { ProjectDefinition } from "@openapi-proxy/core";
import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  type Node,
  parseDocument,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

type Path = Array<string | number>;
type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** How the file's author indents: by how many spaces, and whether list items sit under their key or to its right. */
function styleOf(text: string): { indent: number; indentSeq: boolean } {
  const lines = text.split("\n");
  // One step of indentation is the least any line is indented by. Comments
  // do not count, and neither does the inside of a list item: its second key
  // sits two columns right of its dash whatever the file's step is.
  const depths = lines.flatMap((line) => {
    const depth = /^( +)(- )?[^\s#-]/.exec(line)?.[1]?.length;
    return depth === undefined ? [] : [depth];
  });
  const indent = depths.length > 0 ? Math.min(...depths) : 2;
  // `key:` followed by `- item` at the same depth: items are not indented.
  const flush = lines.some((line, index) => {
    const key = /^( *)[^\s#-][^#]*:\s*(#.*)?$/.exec(line);
    const next = lines.slice(index + 1).find((later) => later.trim() !== "");
    return key !== null && (next?.startsWith(`${key[1]}- `) ?? false);
  });
  return { indent: Math.min(Math.max(indent, 2), 8), indentSeq: !flush };
}

/** A new value as a node, written the way a person would write it in this file. */
function nodeFor(doc: Document, value: unknown, key?: string | number): Node {
  const node = doc.createNode(value) as Node;
  const dress = (current: unknown, name?: string | number) => {
    if (isSeq(current)) {
      // A few tags read best on one line. Operations, which are long and can
      // hold braces, get a line each.
      const items = current.items;
      const short =
        name === "tags" &&
        items.every(isScalar) &&
        items.reduce((sum, item) => sum + String((item as Scalar).value).length + 2, 0) <= 60;
      current.flow = short;
      for (const item of items) dress(item);
    } else if (isMap(current)) {
      for (const pair of current.items) {
        dress(pair.value, isScalar(pair.key) ? String(pair.key.value) : undefined);
      }
    }
  };
  dress(node, key);
  return node;
}

/**
 * The order the keys of a definition are written in, by people and by `init`.
 * A key that is new to a map goes where it would be looked for, not at the end.
 */
const ORDER = [
  "version",
  "project",
  "name",
  "icon",
  "instance",
  "visibility",
  "url",
  "file",
  "main",
  "follow",
  "pathPrefix",
  "include",
  "exclude",
  "tags",
  "operations",
  "overrides",
  "title",
  "description",
  "servers",
  "sources",
  "variants",
];
const rankOf = (key: unknown): number => ORDER.indexOf(String(isScalar(key) ? key.value : key));

/** Put a new key into a map: before the first key that belongs after it, or at the end. */
function insert(doc: Document, map: YAMLMap, key: string, value: unknown): void {
  const pair = doc.createPair(key, nodeFor(doc, value, key));
  const mine = rankOf(key);
  const at = mine === -1 ? -1 : map.items.findIndex((item) => rankOf(item.key) > mine);
  if (at === -1) map.items.push(pair);
  else {
    if (at === 0) keepWithFirst(map, map.items[0]?.key);
    map.items.splice(at, 0, pair);
  }
}

/**
 * A comment above the first entry of a list or a map is kept by the library
 * as a comment of the whole. When something new is put in front of that
 * entry, the comment goes with the entry it was written above.
 */
function keepWithFirst(collection: YAMLMap | YAMLSeq, first: unknown): void {
  if (!collection.commentBefore || first === null || typeof first !== "object") return;
  const node = first as { commentBefore?: string | null };
  node.commentBefore = node.commentBefore
    ? `${collection.commentBefore}\n${node.commentBefore}`
    : collection.commentBefore;
  collection.commentBefore = null;
}

function patchTextList(doc: Document, path: Path, before: string[], after: string[]): void {
  const node = doc.getIn(path, true);
  if (!isSeq(node) || !node.items.every(isScalar)) {
    doc.setIn(path, nodeFor(doc, after, path.at(-1)));
    return;
  }
  const seq = node as YAMLSeq<Scalar>;
  const wanted = new Set(after);
  const had = new Set(before);
  // What is no longer wanted goes, item by item: the others keep their place and their comments.
  seq.items = seq.items.filter((item) => wanted.has(String(item.value).trim()));
  for (const value of after) {
    if (!had.has(value)) seq.add(doc.createNode(value) as Scalar);
  }
}

/** What tells one entry of a list from another: a server by its address, a source by its address or name. */
const entryId = (entry: unknown): string =>
  isPlain(entry) && typeof (entry.url ?? entry.name ?? entry.file) === "string"
    ? String(entry.url ?? entry.name ?? entry.file)
    : JSON.stringify(entry);

/**
 * Change a list of entries (sources, servers) entry by entry: one that is
 * still there stays the node it was, with the comments around it, and is
 * changed where it stands; one that is gone is taken out; a new one is put
 * where the list has it now. False if the list in the file is not what it
 * was read as, and has to be written whole.
 */
function patchEntries(doc: Document, path: Path, before: unknown[], after: unknown[]): boolean {
  const seq = doc.getIn(path, true);
  if (!isSeq(seq) || seq.items.length !== before.length) return false;
  const ids = before.map(entryId);
  if (new Set(ids).size !== ids.length) return false;

  const free = new Map(ids.map((id, index) => [id, index]));
  const matched = after.map((entry) => {
    const index = free.get(entryId(entry));
    if (index !== undefined) free.delete(entryId(entry));
    return index;
  });
  // An entry whose address changed is still the entry at its place, if the list is as long as it was.
  if (before.length === after.length) {
    matched.forEach((index, at) => {
      if (index === undefined && [...free.values()].includes(at)) {
        matched[at] = at;
        for (const [id, value] of free) if (value === at) free.delete(id);
      }
    });
  }
  const nodes = seq.items;
  if (matched[0] !== 0) keepWithFirst(seq, nodes[0]);
  seq.items = matched.map((index, at) =>
    index === undefined ? definitionNode(doc, after[at]) : (nodes[index] as never),
  );
  matched.forEach((index, at) => {
    if (index !== undefined) patch(doc, [...path, at], before[index], after[at]);
  });
  return true;
}

function patch(doc: Document, path: Path, before: unknown, after: unknown): void {
  if (same(before, after)) return;
  if (after === undefined) {
    doc.deleteIn(path);
    return;
  }
  if (isPlain(before) && isPlain(after) && isMap(doc.getIn(path, true))) {
    const map = doc.getIn(path, true) as YAMLMap;
    const removed = Object.keys(before).filter((key) => !Object.hasOwn(after, key));
    const added = Object.keys(after).filter((key) => !Object.hasOwn(before, key));
    for (const key of removed) {
      // The same thing under another name is a rename: it stays where it is, with what was written around it.
      const renamedTo = added.find((candidate) => same(before[key], after[candidate]));
      const pair = map.items.find((item) => isScalar(item.key) && item.key.value === key);
      if (renamedTo !== undefined && pair && isScalar(pair.key)) {
        pair.key.value = renamedTo;
        added.splice(added.indexOf(renamedTo), 1);
      } else {
        doc.deleteIn([...path, key]);
      }
    }
    for (const key of Object.keys(after)) {
      if (added.includes(key)) insert(doc, map, key, after[key]);
      else if (Object.hasOwn(before, key)) patch(doc, [...path, key], before[key], after[key]);
    }
    return;
  }
  if (isTextList(before) && isTextList(after)) {
    patchTextList(doc, path, before, after);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && patchEntries(doc, path, before, after)) {
    return;
  }
  const existing = doc.getIn(path, true);
  if (isScalar(existing) && (typeof after !== "object" || after === null)) {
    // The value changes; how it is quoted and what is written after it stay.
    existing.value = after;
    return;
  }
  doc.setIn(path, nodeFor(doc, after, path.at(-1)));
}

/**
 * A line without the spacing that the YAML library sets its own way: after a
 * key, before a comment, inside brackets, at the end.
 */
const loosely = (line: string): string =>
  line
    .replace(/:[ \t]+/g, ": ")
    .replace(/\s+#/g, " #")
    .replace(/([[{])\s+/g, "$1")
    .replace(/\s+([\]}])/g, "$1")
    .trimEnd();

/**
 * The library writes the whole document again, in its own spacing. Every
 * line that says what a line of the original said is put back the way its
 * author wrote it, so that a save shows up in a diff as what was changed.
 */
function inTheAuthorsHand(original: string, written: string): string {
  const lines = original.split("\n");
  const kept = new Map<string, string[]>();
  // A comment after a key that holds a block (`variants:  # by slug`) is
  // written by the library on a line of its own, under the key.
  const split = new Map<string, string[]>();
  for (const line of lines) {
    const key = loosely(line);
    const queue = kept.get(key);
    if (queue) queue.push(line);
    else kept.set(key, [line]);
    const block = /^(\s*[^\s#][^#]*:)\s+(#.*)$/.exec(line);
    if (block) {
      const pair = `${block[1]}\n${(block[2] as string).trimEnd()}`;
      split.set(pair, [...(split.get(pair) ?? []), line]);
    }
  }

  const out: string[] = [];
  const result = written.split("\n");
  for (let index = 0; index < result.length; index++) {
    const line = result[index] as string;
    const next = result[index + 1];
    const joined =
      next === undefined ? undefined : split.get(`${line.trimEnd()}\n${next.trim()}`)?.shift();
    if (joined !== undefined) {
      out.push(joined);
      kept.get(loosely(joined))?.shift();
      index++;
      continue;
    }
    out.push(kept.get(loosely(line))?.shift() ?? line);
  }
  return out.join("\n");
}

/** What a text holds, as plain data, or undefined if it cannot be read. */
function dataOf(text: string): unknown {
  const doc = parseDocument(text);
  return doc.errors.length > 0 ? undefined : doc.toJS();
}

/**
 * Write a changed definition into the text of a definition file. Only what
 * changed is touched: comments, the order of keys, and the way each list and
 * string is written stay as their author left them.
 *
 * `before` is the definition the text holds, as it was read from it; `after`
 * is what it should hold. Both are in the form `readDefinition` gives.
 */
export function patchDefinition(
  text: string,
  before: ProjectDefinition,
  after: ProjectDefinition,
): string {
  if (same(before, after)) return text;
  // Line ends are the author's too. Inside, it is all one kind.
  if (text.includes("\r\n")) {
    return patchDefinition(text.replaceAll("\r\n", "\n"), before, after).replaceAll("\n", "\r\n");
  }
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) {
    // Nothing a person wrote to keep: an empty file, or one that is not a map.
    doc.contents = doc.createNode(after) as never;
    return doc.toString({ lineWidth: 0 });
  }
  patch(doc, [], before, after);
  const written = doc.toString({
    lineWidth: 0,
    flowCollectionPadding: false,
    ...styleOf(text),
  });
  // Putting lines back is a matter of looks, and must never change what the
  // file says. If it would, the plain version is what is saved.
  const restored = inTheAuthorsHand(text, written);
  return same(dataOf(restored), dataOf(written)) ? restored : written;
}
