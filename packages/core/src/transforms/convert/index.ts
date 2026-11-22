import { mapSchemas } from "../../document/schemas.js";
import type { OpenAPIDocument } from "../../types.js";
import { booleanSchemaIn30, downgrade31to30 } from "./downgrade-3.1-to-3.0.js";
import type { Conversion } from "./step.js";
import { upgrade30to31 } from "./upgrade-3.0-to-3.1.js";

/** The versions a document can be converted to. */
export type TargetVersion = "3.0" | "3.1";

export const TARGET_VERSIONS: readonly TargetVersion[] = ["3.0", "3.1"];

/** Something a conversion could not carry over, and how many times it came up. */
export interface ConversionLoss {
  what: string;
  count: number;
}

export interface ConvertResult {
  doc: OpenAPIDocument;
  /** Empty when nothing was lost, which includes "nothing had to be converted". */
  losses: ConversionLoss[];
}

export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvertError";
  }
}

/** `3.0`, `3.1`, `3.2`: the part of a document's version that decides its rules. */
export function versionFamily(doc: OpenAPIDocument): string {
  const version = typeof doc.openapi === "string" ? doc.openapi : "";
  return version.split(".").slice(0, 2).join(".");
}

const CONVERSIONS: Conversion[] = [upgrade30to31, downgrade31to30];

/** The versions this document can be served as, its own included. */
export function availableVersions(doc: OpenAPIDocument): TargetVersion[] {
  const family = versionFamily(doc);
  return TARGET_VERSIONS.filter(
    (target) => target === family || CONVERSIONS.some((c) => c.from === family && c.to === target),
  );
}

/**
 * The document in another version of OpenAPI. A document already in that
 * version comes back as it is. The input is never changed.
 */
export function convertDocument(doc: OpenAPIDocument, target: TargetVersion): ConvertResult {
  const family = versionFamily(doc);
  if (family === target) return { doc, losses: [] };

  const conversion = CONVERSIONS.find((c) => c.from === family && c.to === target);
  if (!conversion) {
    throw new ConvertError(`An OpenAPI ${family} document cannot be converted to ${target} yet.`);
  }

  const counts = new Map<string, number>();
  const report = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);

  let next = mapSchemas(doc, {
    schema: (schema) =>
      conversion.schemas.reduce((current, step) => step.apply(current, report), schema),
    ...(target === "3.0" ? { boolean: booleanSchemaIn30 } : {}),
  });
  for (const step of conversion.document) next = step.apply(next, report);

  return { doc: next, losses: [...counts].map(([what, count]) => ({ what, count })) };
}
