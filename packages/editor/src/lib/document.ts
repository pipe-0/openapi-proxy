import {
  type OpenAPIDocument,
  parseSpec,
  type SpecFormat,
  type TargetVersion,
} from "@openapi-proxy/core";
import { byteLength } from "./utils";

/** A project's assembled document, parsed where the editor runs. */
export interface ProjectDoc {
  doc: OpenAPIDocument;
  /** Whether the source is JSON on one line, so previews are sized exactly like what is served. */
  minified: boolean;
  bytes: number;
}

/**
 * Read the text of a project's document. The picker and the live preview run
 * the same filter code on it that serving runs, so what the preview shows is
 * what will be served.
 */
export function readProjectDoc(text: string): ProjectDoc {
  const parsed = parseSpec(text);
  return { doc: parsed.doc, minified: parsed.minified, bytes: byteLength(text) };
}

/**
 * What follows a variant's URL for one representation of it: `.json` for the
 * version its document has, `/3.0.json` for one it is converted to.
 */
export function representation(version: TargetVersion | null, format: SpecFormat): string {
  return `${version === null ? "" : `/${version}`}.${format}`;
}
