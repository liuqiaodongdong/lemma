export {
  LemmaEditor,
  default,
  extractOutlineHeadings,
  type LemmaEditorHandle,
  type LemmaEditorProps,
  type SetExternalMarkdownOptions,
} from './LemmaEditor';
export {
  createLemmaExtensions,
  createLemmaSchema,
  type CreateLemmaExtensionsOptions,
} from './schemaExtensions';
export {
  normalizeAiMathDelimiters,
  normalizeDisplayDollarBlocks,
} from './codec/mathDelimiterNormalizer';
export {
  createParseContext,
  parseMarkdownChunkToBlocks,
  parseMarkdownToDocJson,
  parseMarkdownToPmNode,
  type ParseContext,
} from './codec/markdownParser';
export {
  splitMarkdownForProgressiveLoad,
  type ProgressiveMarkdownOptions,
  type ProgressiveMarkdownSplit,
} from './codec/markdownChunker';
export { serializeDocToMarkdown } from './codec/markdownSerializer';
export {
  escapeCommentAttr,
  unescapeCommentAttr,
} from './codec/commentAttrCodec';
export { sanitizeSvgCode } from './extensions/SvgBlock';
export {
  SYNC_MATH_BUDGET_PER_BURST,
  beginBulkMathMountWindow,
  endBulkMathMountWindow,
  setHydrationActive,
  isHydrationActive,
  scheduleOrMountMath,
  upgradeMathElementNow,
  unobserveMathElement,
} from './extensions/mathViewportScheduler';
export {
  HighlightMark,
  normalizeHighlightColor,
  getSelectionHighlightColor,
  hasAnyHighlightInSelection,
  hasAnyHighlightInDoc,
  applyHighlightColor,
  removeSelectionHighlight,
  clearAllHighlights,
} from './extensions/HighlightMark';
export {
  CommentMark,
  generateCommentId,
  formatCommentTimestamp,
  extractSelectionQuote,
  extractDocumentComments,
  findCommentIdAtPos,
  addCommentAtRange,
  updateCommentTextById,
  removeCommentById,
  clearAllComments,
  activeCommentPluginKey,
  createActiveCommentPlugin,
  setActiveCommentDecoration,
} from './extensions/CommentMark';
