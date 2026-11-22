// Reading and writing documents
export type { SpecParseErrorCode } from "./document/parse.js";
export { DOCUMENT_LIMITS, findExternalRefs, parseSpec, SpecParseError } from "./document/parse.js";
export { operationKey, WEBHOOK_PREFIX, webhookKey } from "./document/path-items.js";
export type { ComponentRef, RefScanResult } from "./document/refs.js";
export { componentClosure, implicitSubtypes, scanRefs } from "./document/refs.js";
export type { SchemaVisitor } from "./document/schemas.js";
export { mapSchema, mapSchemas } from "./document/schemas.js";
export type { SerializeOptions } from "./document/serialize.js";
export { serialize } from "./document/serialize.js";
// Looking at a document
export { computeDrift } from "./inspect/drift.js";
export { fingerprintOperations } from "./inspect/fingerprint.js";
export { indexOperations } from "./inspect/operations.js";
// From sources to what is served
export type {
  AssembledDocument,
  BuiltVariant,
  ConvertedSource,
  VariantOptions,
} from "./pipeline.js";
export { assembleDocument, buildVariant } from "./pipeline.js";
// Selections
export { pinTag, setOperationsServed, setTagServed, withMode } from "./selection/edit.js";
export { isValidSlug, resolveSelection, SLUG_PATTERN, slugify } from "./selection/resolve.js";
// The transforms the pipeline is made of
export type { ConversionLoss, ConvertResult, TargetVersion } from "./transforms/convert/index.js";
export {
  availableVersions,
  ConvertError,
  convertDocument,
  TARGET_VERSIONS,
  versionFamily,
} from "./transforms/convert/index.js";
export type { MergeNote, MergePart, MergeResult } from "./transforms/merge.js";
export {
  isValidPathPrefix,
  MergeError,
  mergeDocuments,
  normalizePathPrefix,
} from "./transforms/merge.js";
export { applyVariant } from "./transforms/select.js";
export type {
  ComponentGroup,
  Drift,
  FilterResult,
  FilterStats,
  HttpMethod,
  JsonIndent,
  JsonObject,
  OpenAPIDocument,
  OperationEntry,
  OperationIndex,
  ParsedSpec,
  Selection,
  SelectionMode,
  SpecFormat,
  TagEntry,
} from "./types.js";
export { COMPONENT_GROUPS, HTTP_METHODS, isJsonObject, TRANSFORM_VERSION } from "./types.js";
