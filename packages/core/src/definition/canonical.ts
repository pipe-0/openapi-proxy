/**
 * A value as JSON with its keys in order, so that two values that say the
 * same thing give the same text, whatever order they were written in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value)) ?? "null";
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) out[key] = sorted(record[key]);
  }
  return out;
}
