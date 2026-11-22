import { isJsonObject, type OpenAPIDocument } from "../types.js";
import { spend, spendText } from "./budget.js";
import { resolvePointer } from "./pointer.js";
import { componentPlace, implicitSubtypes, scanRefs } from "./refs.js";

/**
 * A 53-bit hash (cyrb53) that text is fed to piece by piece. Fast,
 * synchronous, and plenty for telling two values apart. For comparison only;
 * it is not a security hash, and nothing relies on it against someone who
 * writes both values.
 */
class Hash {
  private high = 0xdeadbeef;
  private low = 0x41c6ce57;

  feed(text: string): this {
    spendText(text.length);
    let { high, low } = this;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      high = Math.imul(high ^ code, 2654435761);
      low = Math.imul(low ^ code, 1597334677);
    }
    this.high = high;
    this.low = low;
    return this;
  }

  /** In base 36. */
  result(): string {
    let { high, low } = this;
    high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
    low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
    return (4294967296 * (2097151 & low) + (high >>> 0)).toString(36);
  }
}

/** The hash of a text. */
export function digest(text: string): string {
  return new Hash().feed(text).result();
}

/**
 * The hash of a JSON value, whatever order its keys are in: equal values give
 * equal digests. Nothing is written out to get it; the value is fed to the
 * hash as it is walked, every part with its kind and its length in front, so
 * that no two values read the same.
 */
export function digestOf(value: unknown): string {
  const hash = new Hash();
  const feed = (node: unknown): void => {
    spend();
    if (typeof node === "string") {
      hash.feed(`s${node.length}:`).feed(node);
    } else if (Array.isArray(node)) {
      hash.feed(`[${node.length}:`);
      for (const item of node) feed(item);
    } else if (isJsonObject(node)) {
      const keys = Object.keys(node)
        .filter((key) => node[key] !== undefined)
        .sort();
      spend(keys.length);
      hash.feed(`{${keys.length}:`);
      for (const key of keys) {
        hash.feed(`${key.length}:`).feed(key);
        feed(node[key]);
      }
    } else {
      hash.feed(`v${String(node)};`);
    }
  };
  feed(value);
  return hash.result();
}

/** Whether two JSON values are the same, whatever order their keys are in. */
export function sameValue(a: unknown, b: unknown): boolean {
  spend();
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (!isJsonObject(a) || !isJsonObject(b)) return false;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  const others = Object.keys(b).filter((key) => b[key] !== undefined);
  spend(keys.length + others.length);
  return (
    keys.length === others.length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
  );
}

/**
 * The places a part of a document mentions, each in its one spelling: the
 * components it references, the security schemes it names, and anywhere else
 * a reference of its points (`#/paths/...`).
 */
export function mentions(node: unknown): string[] {
  const scan = scanRefs(node);
  return [
    ...scan.refs.map((ref) => componentPlace(ref.group, ref.name)),
    ...scan.securitySchemes.map((name) => componentPlace("securitySchemes", name)),
    ...scan.pointers,
  ];
}

/**
 * What the parts of one document amount to. Two parts mean the same thing
 * exactly when their digests here are equal: they say the same, and
 * everything they mention, however indirectly, says the same.
 *
 * What a part mentions is not only components. A bundler writes references
 * to wherever a schema first appeared (`#/paths/~1users/get/...`); such a
 * place is followed like a component, so a change there is a change to
 * everything that borrows it.
 *
 * Everything is looked at once: each place is hashed and scanned once, and
 * so is each value `of` is asked about, however many others share it.
 * Following every reference to the end separately for each place would take
 * the square of that for a long chain of schemas. Instead the places are
 * taken in groups that reach each other (one schema that refers to itself,
 * or a ring of them, is one group), from the far end of the references
 * backwards: a group's digest is made from its own members and the digests
 * of the groups it points at, which are known by then.
 */
export function documentContent(doc: OpenAPIDocument) {
  /** For the head and the members of a polymorphic family: where its extenders are. */
  const subtypes = new Map<string, string[]>();
  for (const [name, extenders] of implicitSubtypes(
    isJsonObject(doc.components) ? doc.components : undefined,
  )) {
    subtypes.set(
      componentPlace("schemas", name),
      extenders.map((extender) => componentPlace("schemas", extender)),
    );
  }

  const described = new Map<string, { digest: string; uses: string[] }>();
  const deep = new Map<string, string>();

  const describe = (place: string) => {
    const known = described.get(place);
    if (known !== undefined) return known;
    const body = resolvePointer(doc, place);
    const entry =
      body === undefined
        ? // A reference to something the document does not define.
          { digest: "missing", uses: [] }
        : // The members of a polymorphic family count as part of it.
          { digest: digestOf(body), uses: [...mentions(body), ...(subtypes.get(place) ?? [])] };
    described.set(place, entry);
    return entry;
  };

  /**
   * Tarjan's algorithm for strongly connected components, with a stack of
   * its own instead of recursion: a chain of ten thousand schemas is ten
   * thousand calls deep otherwise.
   */
  const resolve = (start: string): void => {
    const order = new Map<string, number>();
    const lowest = new Map<string, number>();
    const open: string[] = [];
    const isOpen = new Set<string>();
    const frames: Array<{ place: string; next: number }> = [];
    const enter = (place: string) => {
      order.set(place, order.size);
      lowest.set(place, order.size - 1);
      open.push(place);
      isOpen.add(place);
      frames.push({ place, next: 0 });
    };
    const low = (place: string) => lowest.get(place) as number;

    enter(start);
    for (let frame = frames.at(-1); frame; frame = frames.at(-1)) {
      spend();
      const { place } = frame;
      const { uses } = describe(place);
      const used = uses[frame.next];
      if (used !== undefined) {
        frame.next += 1;
        if (deep.has(used)) continue; // finished earlier: its digest is known
        if (!order.has(used)) enter(used);
        else if (isOpen.has(used))
          lowest.set(place, Math.min(low(place), order.get(used) as number));
        continue;
      }

      // Everything `place` uses has been looked at.
      frames.pop();
      const parent = frames.at(-1);
      if (parent) lowest.set(parent.place, Math.min(low(parent.place), low(place)));
      if (low(place) !== order.get(place)) continue;

      // `place` is where its group was entered: everything above it on `open` belongs to it.
      const members = open.splice(open.lastIndexOf(place));
      for (const member of members) isOpen.delete(member);
      const inside = new Set(members);
      const beyond = new Set<string>();
      for (const member of members) {
        for (const reached of describe(member).uses) {
          if (!inside.has(reached)) beyond.add(deep.get(reached) as string);
        }
      }
      const own = members.map((member) => [member, describe(member).digest]).sort();
      const value = digestOf([own, [...beyond].sort()]);
      for (const member of members) deep.set(member, value);
    }
  };

  /** What the place a reference names amounts to, with everything it reaches. */
  const at = (place: string): string => {
    if (!deep.has(place)) resolve(place);
    return deep.get(place) as string;
  };

  const values = new Map<object, string>();
  /** What a value amounts to, with everything it mentions. Worked out once for each object. */
  const of = (value: unknown): string => {
    if (typeof value !== "object" || value === null) return digestOf(value);
    let known = values.get(value);
    if (known === undefined) {
      known = digestOf([digestOf(value), [...new Set(mentions(value).map(at))].sort()]);
      values.set(value, known);
    }
    return known;
  };

  return { at, of };
}
