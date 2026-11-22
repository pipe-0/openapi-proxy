import { isJsonObject, type OpenAPIDocument } from "../types.js";
import { implicitSubtypes, scanRefs } from "./refs.js";

/** JSON with object keys in sorted order: equal values give equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isJsonObject(value)) {
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) fields.push(`${JSON.stringify(key)}:${canonical(value[key])}`);
    }
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether two JSON values are the same, whatever order their keys are in. */
export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || canonical(a) === canonical(b);
}

/**
 * A 53-bit string hash (cyrb53), in base 36. Fast, synchronous, and plenty for
 * telling two texts apart. For comparison only; it is not a security hash.
 */
export function digest(text: string): string {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  return (4294967296 * (2097151 & low) + (high >>> 0)).toString(36);
}

/** The components a node refers to directly, as `<group>/<name>` keys. */
export function usedComponents(node: unknown): string[] {
  const scan = scanRefs(node);
  return [
    ...scan.refs.map((ref) => `${ref.group}/${ref.name}`),
    ...scan.securitySchemes.map((name) => `securitySchemes/${name}`),
  ];
}

/**
 * What the components of one document amount to, each serialized and scanned
 * once however often it is asked about. `reach` follows references to the end;
 * `deepDigest` hashes a component together with everything it reaches, so two
 * components have the same deep digest exactly when they mean the same thing.
 */
export function componentContent(doc: OpenAPIDocument) {
  const components = isJsonObject(doc.components) ? doc.components : {};
  const subtypes = implicitSubtypes(components);
  const described = new Map<string, { digest: string; uses: string[] } | null>();
  const deep = new Map<string, string>();

  const describe = (key: string) => {
    const known = described.get(key);
    if (known !== undefined) return known;

    const slash = key.indexOf("/");
    const groupName = key.slice(0, slash);
    const name = key.slice(slash + 1);
    const group = components[groupName];
    const body = isJsonObject(group) ? group[name] : undefined;
    const entry =
      body === undefined
        ? null
        : {
            digest: digest(canonical(body)),
            uses: [
              ...usedComponents(body),
              // The members of a polymorphic family count as part of it.
              ...(groupName === "schemas" ? (subtypes.get(name) ?? []) : []).map(
                (subtype) => `schemas/${subtype}`,
              ),
            ],
          };
    described.set(key, entry);
    return entry;
  };

  /** Every component reachable from these, as sorted `key=digest` lines. */
  const reach = (from: string[]): string[] => {
    const reached = new Set<string>();
    const queue = [...from];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (reached.has(next)) continue;
      reached.add(next);
      for (const further of describe(next)?.uses ?? []) queue.push(further);
    }
    return [...reached].sort().map((key) => `${key}=${describe(key)?.digest ?? "missing"}`);
  };

  const deepDigest = (key: string): string => {
    const known = deep.get(key);
    if (known !== undefined) return known;
    const value = digest(reach([key]).join("\n"));
    deep.set(key, value);
    return value;
  };

  return { reach, deepDigest };
}
