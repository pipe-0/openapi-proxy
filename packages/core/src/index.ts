// Reading and writing documents

// A project as a definition
export type {
  EffectiveVisibility,
  Problem,
  ProjectDefinition,
  ReadDefinition,
  ReadSelection,
  Shape,
  SourceDefinition,
  VariantDefinition,
  VariantIconName,
  Visibility,
} from "./definition/index.js";
export {
  canonicalJson,
  DEFINITION_LIMITS,
  DEFINITION_SHAPE,
  DEFINITION_VERSIONS,
  definitionSchema,
  describeProblem,
  effectiveOverrides,
  effectiveVariant,
  effectiveVisibility,
  isLoopback,
  isVariantIcon,
  isVisibility,
  keysOf,
  mergeOrder,
  readDefinition,
  readSelection,
  SELECTION_SHAPE,
  sourceLabel,
  UNNAMED_SOURCE,
  VARIANT_ICONS,
  VISIBILITIES,
  warningsOf,
} from "./definition/index.js";
export { WORK_BUDGET, withBudget } from "./document/budget.js";
export {
  DOCUMENT_LIMITS,
  type DocumentLimits,
  DocumentTooComplexError,
  measure,
  OUTPUT_LIMITS,
} from "./document/limits.js";
export type { SpecParseErrorCode } from "./document/parse.js";
export { parseSpec, SpecParseError } from "./document/parse.js";
export { operationKey, WEBHOOK_PREFIX, webhookKey } from "./document/path-items.js";
export type { ComponentRef, RefScanResult } from "./document/refs.js";
export {
  componentClosure,
  findExternalRefs,
  implicitSubtypes,
  scanRefs,
} from "./document/refs.js";
export type { SchemaVisitor } from "./document/schemas.js";
export { mapSchema, mapSchemas } from "./document/schemas.js";
export type { SerializeOptions } from "./document/serialize.js";
export { serialize } from "./document/serialize.js";
// Looking at a document
export { fingerprintOperations, sameScheme } from "./inspect/fingerprint.js";
export { indexOperations } from "./inspect/operations.js";
export { unmatchedCount, unmatchedNames } from "./inspect/unmatched.js";
// From sources to what is served
export type {
  AssembledDocument,
  BuiltVariant,
  ConvertedSource,
  VariantOptions,
} from "./pipeline.js";
export { assembleDocument, buildVariant } from "./pipeline.js";
// Selections
export type { LaterAdditions } from "./selection/edit.js";
export {
  followTag,
  laterAdditions,
  normalizeSelection,
  pinTag,
  setOperationsServed,
  setTagServed,
  tagRule,
  withLaterAdditions,
} from "./selection/edit.js";
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
export type { DocumentOverrides, ServerOverride } from "./transforms/override.js";
export { applyOverrides, OVERRIDE_LIMITS, readOverrides } from "./transforms/override.js";
export { applyVariant } from "./transforms/select.js";
export type {
  ComponentGroup,
  FilterResult,
  FilterStats,
  HttpMethod,
  JsonObject,
  OpenAPIDocument,
  OperationEntry,
  OperationIndex,
  ParsedSpec,
  Selection,
  SelectionRules,
  SpecFormat,
  TagEntry,
  UnmatchedNames,
} from "./types.js";
export { COMPONENT_GROUPS, HTTP_METHODS, isJsonObject, TRANSFORM_VERSION } from "./types.js";
