export {
  computeDocDiff,
  computeInlineDiffForNodes,
  applyAcceptHunkToBaseline,
  buildRevertTransaction,
  extractBlockPreviewText,
  extractLatexAttr,
  extractSvgAttr,
  extractTablePreviewText,
  type PositionedInlineInsert,
  type PositionedInlineDelete,
  type RichDiffHunk,
} from './diffEngine';

export {
  diffPluginKey,
  createDiffReviewPlugin,
  setDiffPluginData,
  createSanitizedSvgContainer,
  type DiffPluginHandlers,
  type DiffPluginData,
  type DiffPluginState,
} from './diffPlugin';

export {
  useDiffReview,
  type UseDiffReviewParams,
  type UseDiffReviewResult,
} from './useDiffReview';
