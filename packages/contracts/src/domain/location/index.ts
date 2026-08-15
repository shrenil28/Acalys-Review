export {
  type LineRange,
  containsLine,
  lineCount,
  lineRangeSchema,
  rangesOverlap,
} from "./line-range.js";
export {
  SYMBOL_KINDS,
  type SymbolKind,
  type SymbolReference,
  symbolIdentity,
  symbolKindSchema,
  symbolReferenceSchema,
  symbolsEqual,
} from "./symbol-reference.js";
export {
  DIFF_SIDES,
  type DiffSide,
  type SourceLocation,
  diffSideSchema,
  formatLocation,
  locationsEqual,
  sourceLocationSchema,
} from "./source-location.js";
