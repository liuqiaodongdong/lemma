import { diffArrays } from 'diff';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type {
  DiffHunk,
  DiffHunkKind,
  InlineDiffSegment,
} from '../types/contract';

export interface PositionedInlineInsert {
  from: number;
  to: number;
  text: string;
  isInlineMath?: boolean;
  isBlockAtom?: boolean;
}

export interface PositionedInlineDelete {
  pos: number;
  text: string;
  isInlineMath?: boolean;
  order: number;
}

export interface RichDiffHunk extends DiffHunk {
  /** Start offset in baselineDoc for exact single-hunk acceptance */
  oldFrom: number;
  /** End offset in baselineDoc for exact single-hunk acceptance */
  oldTo: number;
  /** Exact ProseMirror ranges in currentDoc for inserted inline content */
  inlineInserts?: PositionedInlineInsert[];
  /** Exact ProseMirror anchor positions in currentDoc for deleted inline content */
  inlineDeletes?: PositionedInlineDelete[];
}

interface OldBlockEntry {
  node: PMNode;
  index: number;
  from: number;
  endPos: number;
  fingerprint: string;
}

interface NewBlockEntry {
  node: PMNode;
  index: number;
  pos: number;
  endPos: number;
  fingerprint: string;
}

interface AtomicInlineToken {
  kind: 'text' | 'math' | 'boundary';
  key: string;
  text: string;
  latex?: string;
  isInlineMath?: boolean;
  isBlockAtom?: boolean;
  from: number;
  to: number;
  blockId: number;
}

const TEXT_BEARING_BLOCKS = new Set<string>([
  'paragraph',
  'heading',
  'callout',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
]);

const PAIRABLE_BLOCK_TYPES = new Set<string>([
  'paragraph',
  'heading',
  'mathBlock',
  'svgBlock',
  'table',
  'callout',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'image',
]);

/**
 * Matches atomic inline tokens in academic Chinese/English prose:
 * 1. Individual BMP CJK ideographs, kana, hangul
 * 2. Individual astral CJK extension ideographs
 * 3. Contiguous ASCII whitespace runs
 * 4. Contiguous ASCII word / number runs
 * 5. Any remaining single Unicode character (punctuation, symbols, Greek letters, etc.)
 */
const INLINE_TEXT_TOKEN_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[\u{20000}-\u{2FA1F}]|[ \t\r\n]+|[A-Za-z0-9_]+|[^\s]/gu;

function computeBlockFingerprint(node: PMNode): string {
  return `${node.type.name}:${JSON.stringify(node.toJSON())}`;
}

export function extractLatexAttr(node: PMNode): string {
  const raw = node.attrs?.latex ?? node.attrs?.tex ?? node.textContent ?? '';
  return String(raw);
}

export function extractSvgAttr(node: PMNode): string {
  const raw = node.attrs?.code ?? node.attrs?.svg ?? node.textContent ?? '';
  return String(raw);
}

function extractInlineSummaryText(node: PMNode): string {
  const parts: string[] = [];
  node.forEach((child) => {
    if (child.isText && child.text) {
      parts.push(child.text);
    } else if (child.type.name === 'mathInline') {
      parts.push(`$${extractLatexAttr(child)}$`);
    } else if (child.type.name === 'hardBreak') {
      parts.push('\n');
    } else if (child.type.name === 'image') {
      const alt = String(child.attrs?.alt ?? '').trim();
      parts.push(alt ? `[图片: ${alt}]` : '[图片]');
    } else if (child.content.size > 0) {
      parts.push(extractBlockPreviewText(child));
    }
  });
  return parts.join('');
}

export function extractTablePreviewText(tableNode: PMNode): string {
  const rows: string[] = [];
  tableNode.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      const cellLines: string[] = [];
      cell.forEach((block) => {
        const txt = extractBlockPreviewText(block).trim();
        if (txt) cellLines.push(txt);
      });
      cells.push(cellLines.join(' '));
    });
    rows.push(`| ${cells.join(' | ')} |`);
  });
  return rows.join('\n');
}

export function extractBlockPreviewText(node: PMNode): string {
  const typeName = node.type.name;
  if (typeName === 'mathBlock') {
    return extractLatexAttr(node);
  }
  if (typeName === 'svgBlock') {
    return '[SVG 矢量图表]';
  }
  if (typeName === 'table') {
    return extractTablePreviewText(node);
  }
  if (typeName === 'image') {
    const alt = String(node.attrs?.alt ?? '').trim();
    const src = String(node.attrs?.src ?? '').trim();
    return alt ? `[图片: ${alt}]` : src ? `[图片: ${src}]` : '[图片]';
  }
  if (node.isTextblock) {
    return extractInlineSummaryText(node);
  }

  const lines: string[] = [];
  node.forEach((child) => {
    const childText = extractBlockPreviewText(child);
    if (childText) {
      lines.push(childText);
    }
  });
  return lines.join('\n');
}

function tokenizeBlockInlineContent(
  blockNode: PMNode,
  blockStartPos: number
): {
  tokens: AtomicInlineToken[];
  defaultAnchorPos: number;
} {
  const tokens: AtomicInlineToken[] = [];
  let nextBlockId = 0;
  let firstEditablePos: number | null = null;

  const walk = (node: PMNode, nodePos: number): void => {
    if (node.isTextblock) {
      const blockId = nextBlockId++;
      const contentStart = nodePos + 1;
      if (firstEditablePos === null) {
        firstEditablePos = contentStart;
      }

      node.forEach((child, childOffset) => {
        const childPos = contentStart + childOffset;
        if (child.isText && child.text) {
          const text = child.text;
          INLINE_TEXT_TOKEN_RE.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = INLINE_TEXT_TOKEN_RE.exec(text)) !== null) {
            const val = match[0];
            const from = childPos + match.index;
            const to = from + val.length;
            tokens.push({
              kind: 'text',
              key: `T:${val}`,
              text: val,
              from,
              to,
              blockId,
            });
          }
        } else if (child.type.name === 'mathInline') {
          const latex = extractLatexAttr(child);
          tokens.push({
            kind: 'math',
            key: `\u0000MATH:${latex}`,
            text: latex,
            latex,
            isInlineMath: true,
            from: childPos,
            to: childPos + child.nodeSize,
            blockId,
          });
        } else if (child.type.name === 'hardBreak') {
          tokens.push({
            kind: 'text',
            key: '\u0000BR:\n',
            text: '\n',
            from: childPos,
            to: childPos + child.nodeSize,
            blockId,
          });
        } else if (child.isInline) {
          const label =
            child.type.name === 'image'
              ? String(child.attrs?.alt || '[图片]')
              : child.textContent || `[${child.type.name}]`;
          tokens.push({
            kind: 'text',
            key: `\u0000INLINE:${child.type.name}:${JSON.stringify(child.attrs)}`,
            text: label,
            from: childPos,
            to: childPos + child.nodeSize,
            blockId,
          });
        }
      });

      const contentEnd = nodePos + node.nodeSize - 1;
      tokens.push({
        kind: 'boundary',
        key: `\u0000END:${node.type.name}`,
        text: '',
        from: contentEnd,
        to: contentEnd,
        blockId,
      });
      return;
    }

    if (node.type.name === 'mathBlock') {
      const blockId = nextBlockId++;
      if (firstEditablePos === null) {
        firstEditablePos = nodePos;
      }
      const latex = extractLatexAttr(node);
      tokens.push({
        kind: 'math',
        key: `\u0000MATH_BLOCK:${latex}`,
        text: latex,
        latex,
        isInlineMath: true,
        isBlockAtom: true,
        from: nodePos,
        to: nodePos + node.nodeSize,
        blockId,
      });
      return;
    }

    if (node.type.name === 'svgBlock') {
      const blockId = nextBlockId++;
      if (firstEditablePos === null) {
        firstEditablePos = nodePos;
      }
      const svg = extractSvgAttr(node);
      tokens.push({
        kind: 'text',
        key: `\u0000SVG_BLOCK:${svg}`,
        text: '[SVG 矢量图表]',
        isBlockAtom: true,
        from: nodePos,
        to: nodePos + node.nodeSize,
        blockId,
      });
      return;
    }

    if (node.isLeaf) {
      return;
    }

    const contentStart = nodePos + 1;
    node.forEach((child, childOffset) => {
      walk(child, contentStart + childOffset);
    });
  };

  walk(blockNode, blockStartPos);

  const fallbackPos = blockNode.isLeaf
    ? blockStartPos
    : Math.min(blockStartPos + 1, blockStartPos + blockNode.nodeSize - 1);

  return {
    tokens,
    defaultAnchorPos: firstEditablePos ?? fallbackPos,
  };
}

function pushInlineDiffSegment(
  segments: InlineDiffSegment[],
  type: 'equal' | 'insert' | 'delete',
  text: string,
  isInlineMath?: boolean
): void {
  if (!text && !isInlineMath) return;
  if (isInlineMath) {
    segments.push({ type, text, isInlineMath: true });
    return;
  }
  const prev = segments[segments.length - 1];
  if (prev && prev.type === type && !prev.isInlineMath) {
    prev.text += text;
  } else {
    segments.push({ type, text });
  }
}

export function computeInlineDiffForNodes(
  oldNode: PMNode,
  newNode: PMNode,
  newBlockStartPos: number
): {
  segments: InlineDiffSegment[];
  inlineInserts: PositionedInlineInsert[];
  inlineDeletes: PositionedInlineDelete[];
  hasInlineChanges: boolean;
} {
  const oldTokenized = tokenizeBlockInlineContent(oldNode, 0);
  const newTokenized = tokenizeBlockInlineContent(newNode, newBlockStartPos);

  const changes = diffArrays(oldTokenized.tokens, newTokenized.tokens, {
    comparator: (left, right) => left.key === right.key,
  });

  const segments: InlineDiffSegment[] = [];
  const inlineInserts: PositionedInlineInsert[] = [];
  const inlineDeletes: PositionedInlineDelete[] = [];

  // Determine initial inline anchor inside the first editable textblock of newNode
  const firstRealNewToken = newTokenized.tokens.find(
    (t) => t.kind !== 'boundary'
  );
  let cursorPos = firstRealNewToken
    ? firstRealNewToken.from
    : newTokenized.defaultAnchorPos;

  let deleteOrder = 0;
  let idx = 0;

  while (idx < changes.length) {
    const change = changes[idx];

    if (!change.added && !change.removed) {
      // Equal run (values come from newTokenized.tokens in jsdiff, or identical keys)
      for (const tok of change.value) {
        if (tok.kind !== 'boundary') {
          pushInlineDiffSegment(
            segments,
            'equal',
            tok.text,
            tok.isInlineMath
          );
        }
        cursorPos = tok.to;
      }
      idx++;
      continue;
    }

    // Coalesce contiguous removed/added runs so deletions always anchor cleanly before insertions
    const removedTokens: AtomicInlineToken[] = [];
    const addedTokens: AtomicInlineToken[] = [];

    while (
      idx < changes.length &&
      (changes[idx].added || changes[idx].removed)
    ) {
      const part = changes[idx];
      if (part.removed) {
        removedTokens.push(...part.value);
      } else if (part.added) {
        addedTokens.push(...part.value);
      }
      idx++;
    }

    const firstAddedReal = addedTokens.find((t) => t.kind !== 'boundary');
    const deleteAnchorPos = firstAddedReal ? firstAddedReal.from : cursorPos;

    // Emit removed tokens
    for (let r = 0; r < removedTokens.length; r++) {
      const tok = removedTokens[r];
      if (tok.kind === 'boundary') {
        // Only insert separator if there are subsequent non-boundary deleted tokens in this same run
        const hasMoreReal = removedTokens
          .slice(r + 1)
          .some((later) => later.kind !== 'boundary');
        if (hasMoreReal) {
          pushInlineDiffSegment(segments, 'delete', ' ');
          const prevDel = inlineDeletes[inlineDeletes.length - 1];
          if (
            prevDel &&
            prevDel.pos === deleteAnchorPos &&
            !prevDel.isInlineMath
          ) {
            prevDel.text += ' ';
          }
        }
        continue;
      }

      pushInlineDiffSegment(segments, 'delete', tok.text, tok.isInlineMath);

      if (tok.isInlineMath) {
        inlineDeletes.push({
          pos: deleteAnchorPos,
          text: tok.text,
          isInlineMath: true,
          order: deleteOrder++,
        });
      } else {
        const prevDel = inlineDeletes[inlineDeletes.length - 1];
        if (
          prevDel &&
          prevDel.pos === deleteAnchorPos &&
          !prevDel.isInlineMath
        ) {
          prevDel.text += tok.text;
        } else {
          inlineDeletes.push({
            pos: deleteAnchorPos,
            text: tok.text,
            order: deleteOrder++,
          });
        }
      }
    }

    // Emit added tokens and merge contiguous inline decoration ranges per textblock
    let activeInsertRange: {
      from: number;
      to: number;
      text: string;
      blockId: number;
      isBlockAtom?: boolean;
    } | null = null;

    const flushActiveInsert = () => {
      if (activeInsertRange && activeInsertRange.to > activeInsertRange.from) {
        inlineInserts.push({
          from: activeInsertRange.from,
          to: activeInsertRange.to,
          text: activeInsertRange.text,
          isBlockAtom: activeInsertRange.isBlockAtom,
        });
      }
      activeInsertRange = null;
    };

    for (const tok of addedTokens) {
      if (tok.kind === 'boundary') {
        flushActiveInsert();
        cursorPos = tok.to;
        continue;
      }

      pushInlineDiffSegment(segments, 'insert', tok.text, tok.isInlineMath);

      if (tok.isBlockAtom) {
        flushActiveInsert();
        inlineInserts.push({
          from: tok.from,
          to: tok.to,
          text: tok.text,
          isInlineMath: tok.isInlineMath,
          isBlockAtom: true,
        });
      } else if (
        activeInsertRange &&
        activeInsertRange.blockId === tok.blockId &&
        activeInsertRange.to === tok.from &&
        !activeInsertRange.isBlockAtom
      ) {
        activeInsertRange.to = tok.to;
        activeInsertRange.text += tok.text;
      } else {
        flushActiveInsert();
        activeInsertRange = {
          from: tok.from,
          to: tok.to,
          text: tok.text,
          blockId: tok.blockId,
        };
      }

      cursorPos = tok.to;
    }

    flushActiveInsert();
  }

  const hasInlineChanges =
    inlineInserts.length > 0 || inlineDeletes.length > 0;

  return {
    segments,
    inlineInserts,
    inlineDeletes,
    hasInlineChanges,
  };
}

const PUNCTUATION_ONLY_RE = /^[\p{P}\p{S}\s]+$/u;

function computeTokenSimilarity(oldNode: PMNode, newNode: PMNode): number {
  const oldToks = tokenizeBlockInlineContent(oldNode, 0).tokens.filter(
    (t) =>
      t.kind !== 'boundary' &&
      (t.isInlineMath || !PUNCTUATION_ONLY_RE.test(t.text))
  );
  const newToks = tokenizeBlockInlineContent(newNode, 0).tokens.filter(
    (t) =>
      t.kind !== 'boundary' &&
      (t.isInlineMath || !PUNCTUATION_ONLY_RE.test(t.text))
  );

  if (oldToks.length === 0 && newToks.length === 0) {
    return 1;
  }
  if (oldToks.length === 0 || newToks.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const t of oldToks) {
    counts.set(t.key, (counts.get(t.key) ?? 0) + 1);
  }
  let common = 0;
  for (const t of newToks) {
    const c = counts.get(t.key) ?? 0;
    if (c > 0) {
      common++;
      counts.set(t.key, c - 1);
    }
  }
  return (2 * common) / (oldToks.length + newToks.length);
}

function computeStringDiceSimilarity(a: string, b: string): number {
  const s1 = a.trim();
  const s2 = b.trim();
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      intersection++;
      bigrams.set(bg, count - 1);
    }
  }
  const denom = Math.max(1, s1.length - 1 + (s2.length - 1));
  return (2 * intersection) / denom;
}

function areBlocksCompatible(oldNode: PMNode, newNode: PMNode): boolean {
  const oldType = oldNode.type.name;
  const newType = newNode.type.name;
  if (oldType !== newType) return false;
  return PAIRABLE_BLOCK_TYPES.has(oldType) || oldNode.isTextblock;
}

function scoreBlockPair(
  oldNode: PMNode,
  newNode: PMNode,
  isOneToOne: boolean
): number {
  if (!areBlocksCompatible(oldNode, newNode)) {
    return -1;
  }

  const typeName = oldNode.type.name;

  if (typeName === 'mathBlock') {
    const sim = computeStringDiceSimilarity(
      extractLatexAttr(oldNode),
      extractLatexAttr(newNode)
    );
    return 0.5 + 0.5 * sim;
  }

  if (typeName === 'svgBlock') {
    const sim = computeStringDiceSimilarity(
      extractSvgAttr(oldNode),
      extractSvgAttr(newNode)
    );
    return 0.5 + 0.5 * sim;
  }

  if (typeName === 'table' || typeName === 'codeBlock' || typeName === 'image') {
    const sim = computeStringDiceSimilarity(
      extractBlockPreviewText(oldNode),
      extractBlockPreviewText(newNode)
    );
    return 0.5 + 0.5 * sim;
  }

  // Text-bearing blocks (paragraph, heading, callout, blockquote, bulletList, orderedList, taskList)
  const sim = computeTokenSimilarity(oldNode, newNode);
  if (sim >= 0.2) {
    return sim;
  }
  if (isOneToOne) {
    const oldLen = tokenizeBlockInlineContent(oldNode, 0).tokens.filter(
      (t) => t.kind !== 'boundary'
    ).length;
    const newLen = tokenizeBlockInlineContent(newNode, 0).tokens.filter(
      (t) => t.kind !== 'boundary'
    ).length;
    if (Math.min(oldLen, newLen) <= 4) {
      return 0.21;
    }
  }
  return -1;
}

/**
 * Finds an order-preserving pairing between removedOldBlocks and addedNewBlocks
 * maximizing similarity score while respecting type compatibility and the >= 0.2 threshold.
 */
function alignModifiedBlockRun(
  removedOld: OldBlockEntry[],
  addedNew: NewBlockEntry[]
): Array<[number, number]> {
  const m = removedOld.length;
  const n = addedNew.length;
  if (m === 0 || n === 0) return [];

  const isOneToOne = m === 1 && n === 1;
  if (isOneToOne) {
    const score = scoreBlockPair(removedOld[0].node, addedNew[0].node, true);
    return score >= 0 ? [[0, 0]] : [];
  }

  // Fallback linear greedy alignment for extraordinarily huge wholesale replacements
  if (m * n > 40_000) {
    const pairs: Array<[number, number]> = [];
    let jCursor = 0;
    for (let i = 0; i < m && jCursor < n; i++) {
      const s = scoreBlockPair(
        removedOld[i].node,
        addedNew[jCursor].node,
        false
      );
      if (s >= 0) {
        pairs.push([i, jCursor]);
        jCursor++;
      }
    }
    return pairs;
  }

  // Weighted monotonic DP (Needleman-Wunsch without gap penalty)
  const cols = n + 1;
  const dp = new Float64Array((m + 1) * cols);
  const choice = new Uint8Array((m + 1) * cols); // 1: diag pair, 2: skip old, 3: skip new

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cell = i * cols + j;
      const skipOld = dp[(i - 1) * cols + j];
      const skipNew = dp[i * cols + (j - 1)];

      let best = skipOld;
      let dir = 2;
      if (skipNew > best) {
        best = skipNew;
        dir = 3;
      }

      const pairScore = scoreBlockPair(
        removedOld[i - 1].node,
        addedNew[j - 1].node,
        false
      );
      if (pairScore >= 0) {
        // Slight tie-breaker favoring earlier in-order matches
        const candidate =
          dp[(i - 1) * cols + (j - 1)] + pairScore + 1e-6 * (m - i + (n - j));
        if (candidate >= best) {
          best = candidate;
          dir = 1;
        }
      }

      dp[cell] = best;
      choice[cell] = dir;
    }
  }

  const reversedPairs: Array<[number, number]> = [];
  let ci = m;
  let cj = n;
  while (ci > 0 && cj > 0) {
    const dir = choice[ci * cols + cj];
    if (dir === 1) {
      reversedPairs.push([ci - 1, cj - 1]);
      ci--;
      cj--;
    } else if (dir === 2) {
      ci--;
    } else {
      cj--;
    }
  }

  reversedPairs.reverse();
  return reversedPairs;
}

function getAddedSummary(node: PMNode): string {
  switch (node.type.name) {
    case 'mathBlock':
      return '新增了数学公式';
    case 'svgBlock':
    case 'image':
      return '新增了图表';
    case 'table':
      return '新增了三线表格';
    case 'heading':
      return '新增了章节标题';
    case 'callout':
      return '新增了提示框';
    case 'codeBlock':
      return '新增了代码块';
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return '新增了列表';
    default:
      return '新增了段落';
  }
}

function getDeletedSummary(node: PMNode): string {
  switch (node.type.name) {
    case 'mathBlock':
      return '删除了数学公式';
    case 'svgBlock':
      return '删除了 SVG 矢量图表';
    case 'image':
      return '删除了图表';
    case 'table':
      return '删除了三线表格';
    case 'heading':
      return '删除了章节标题';
    case 'callout':
      return '删除了提示框';
    case 'codeBlock':
      return '删除了代码块';
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return '删除了列表';
    default:
      return '删除了段落';
  }
}

function getTextModifiedSummary(node: PMNode, hasInlineChanges: boolean): string {
  if (!hasInlineChanges) {
    if (node.type.name === 'heading') return '修改了标题层级';
    return '修改了段落格式';
  }
  switch (node.type.name) {
    case 'heading':
      return '修改了章节标题';
    case 'callout':
      return '修改了提示框内容';
    case 'blockquote':
      return '修改了引用段落';
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return '修改了列表内容';
    default:
      return '修改了正文段落';
  }
}

function createPairedModifiedHunk(
  hunkIndex: number,
  oldEntry: OldBlockEntry,
  newEntry: NewBlockEntry
): RichDiffHunk {
  const oldNode = oldEntry.node;
  const newNode = newEntry.node;
  const typeName = newNode.type.name;
  const oldNodesJson = [oldNode.toJSON() as Record<string, unknown>];
  const baseId = `hunk-${oldEntry.from}-${oldEntry.endPos}-${typeName}`;

  if (typeName === 'mathBlock') {
    const oldLatex = extractLatexAttr(oldNode);
    const newLatex = extractLatexAttr(newNode);
    return {
      id: baseId,
      index: hunkIndex,
      kind: 'math-modified',
      summary: '修改了数学公式',
      oldFrom: oldEntry.from,
      oldTo: oldEntry.endPos,
      newFrom: newEntry.pos,
      newTo: newEntry.endPos,
      oldNodesJson,
      oldLatex,
      newLatex,
      oldPreviewText: oldLatex,
      newPreviewText: newLatex,
    };
  }

  if (typeName === 'svgBlock') {
    const oldSvg = extractSvgAttr(oldNode);
    const newSvg = extractSvgAttr(newNode);
    return {
      id: baseId,
      index: hunkIndex,
      kind: 'svg-modified',
      summary: '修改了 SVG 矢量图表',
      oldFrom: oldEntry.from,
      oldTo: oldEntry.endPos,
      newFrom: newEntry.pos,
      newTo: newEntry.endPos,
      oldNodesJson,
      oldSvg,
      newSvg,
    };
  }

  if (typeName === 'table') {
    const oldPreviewText = extractTablePreviewText(oldNode);
    const newPreviewText = extractTablePreviewText(newNode);
    const inlineInserts: PositionedInlineInsert[] = [];
    const inlineDeletes: PositionedInlineDelete[] = [];

    let sameShape = oldNode.childCount === newNode.childCount;
    if (sameShape) {
      for (let r = 0; r < oldNode.childCount; r++) {
        if (oldNode.child(r).childCount !== newNode.child(r).childCount) {
          sameShape = false;
          break;
        }
      }
    }

    if (sameShape) {
      let rowOffset = 0;
      let deleteOrderOffset = 0;
      for (let r = 0; r < newNode.childCount; r++) {
        const oldRow = oldNode.child(r);
        const newRow = newNode.child(r);
        const newRowPos = newEntry.pos + 1 + rowOffset;
        let cellOffset = 0;
        for (let c = 0; c < newRow.childCount; c++) {
          const oldCell = oldRow.child(c);
          const newCell = newRow.child(c);
          const newCellPos = newRowPos + 1 + cellOffset;
          if (!oldCell.eq(newCell)) {
            const cellDiff = computeInlineDiffForNodes(
              oldCell,
              newCell,
              newCellPos
            );
            inlineInserts.push(...cellDiff.inlineInserts);
            for (const del of cellDiff.inlineDeletes) {
              inlineDeletes.push({
                ...del,
                order: deleteOrderOffset++,
              });
            }
          }
          cellOffset += newCell.nodeSize;
        }
        rowOffset += newRow.nodeSize;
      }
    }

    return {
      id: baseId,
      index: hunkIndex,
      kind: 'table-modified',
      summary: '修改了三线表格',
      oldFrom: oldEntry.from,
      oldTo: oldEntry.endPos,
      newFrom: newEntry.pos,
      newTo: newEntry.endPos,
      oldNodesJson,
      oldPreviewText,
      newPreviewText,
      inlineInserts,
      inlineDeletes,
    };
  }

  if (TEXT_BEARING_BLOCKS.has(typeName) || newNode.isTextblock) {
    const inlineDiff = computeInlineDiffForNodes(
      oldNode,
      newNode,
      newEntry.pos
    );
    const kind: DiffHunkKind = inlineDiff.hasInlineChanges
      ? 'text-modified'
      : 'block-modified';

    return {
      id: baseId,
      index: hunkIndex,
      kind,
      summary: getTextModifiedSummary(newNode, inlineDiff.hasInlineChanges),
      oldFrom: oldEntry.from,
      oldTo: oldEntry.endPos,
      newFrom: newEntry.pos,
      newTo: newEntry.endPos,
      oldNodesJson,
      oldPreviewText: extractBlockPreviewText(oldNode),
      newPreviewText: extractBlockPreviewText(newNode),
      segments: inlineDiff.segments,
      inlineInserts: inlineDiff.inlineInserts,
      inlineDeletes: inlineDiff.inlineDeletes,
    };
  }

  return {
    id: baseId,
    index: hunkIndex,
    kind: 'block-modified',
    summary: typeName === 'codeBlock' ? '修改了代码块' : '修改了内容块',
    oldFrom: oldEntry.from,
    oldTo: oldEntry.endPos,
    newFrom: newEntry.pos,
    newTo: newEntry.endPos,
    oldNodesJson,
    oldPreviewText: extractBlockPreviewText(oldNode),
    newPreviewText: extractBlockPreviewText(newNode),
  };
}

function createDeletedBlockHunk(
  hunkIndex: number,
  oldEntry: OldBlockEntry,
  anchorPos: number
): RichDiffHunk {
  const oldNode = oldEntry.node;
  const typeName = oldNode.type.name;
  const hunk: RichDiffHunk = {
    id: `hunk-del-${oldEntry.from}-${oldEntry.endPos}`,
    index: hunkIndex,
    kind: 'block-deleted',
    summary: getDeletedSummary(oldNode),
    oldFrom: oldEntry.from,
    oldTo: oldEntry.endPos,
    newFrom: anchorPos,
    newTo: anchorPos,
    oldNodesJson: [oldNode.toJSON() as Record<string, unknown>],
    oldPreviewText: extractBlockPreviewText(oldNode),
  };

  if (typeName === 'mathBlock') {
    hunk.oldLatex = extractLatexAttr(oldNode);
  } else if (typeName === 'svgBlock') {
    hunk.oldSvg = extractSvgAttr(oldNode);
  }

  return hunk;
}

function createAddedBlockHunk(
  hunkIndex: number,
  newEntry: NewBlockEntry,
  oldAnchorPos: number,
  subIndex: number
): RichDiffHunk {
  const newNode = newEntry.node;
  const typeName = newNode.type.name;
  const hunk: RichDiffHunk = {
    id: `hunk-add-${oldAnchorPos}-${subIndex}-${newEntry.pos}`,
    index: hunkIndex,
    kind: 'block-added',
    summary: getAddedSummary(newNode),
    oldFrom: oldAnchorPos,
    oldTo: oldAnchorPos,
    newFrom: newEntry.pos,
    newTo: newEntry.endPos,
    oldNodesJson: [],
    newPreviewText: extractBlockPreviewText(newNode),
  };

  if (typeName === 'mathBlock') {
    hunk.newLatex = extractLatexAttr(newNode);
  } else if (typeName === 'svgBlock') {
    hunk.newSvg = extractSvgAttr(newNode);
  }

  return hunk;
}

/**
 * Computes block-aligned + CJK/math inline AST diff between baselineDoc and currentDoc.
 */
export function computeDocDiff(
  baselineDoc: PMNode,
  currentDoc: PMNode
): RichDiffHunk[] {
  if (baselineDoc.eq(currentDoc)) {
    return [];
  }

  const oldBlocks: OldBlockEntry[] = [];
  baselineDoc.forEach((node, offset, index) => {
    oldBlocks.push({
      node,
      index,
      from: offset,
      endPos: offset + node.nodeSize,
      fingerprint: computeBlockFingerprint(node),
    });
  });

  const newBlocks: NewBlockEntry[] = [];
  currentDoc.forEach((node, offset, index) => {
    newBlocks.push({
      node,
      index,
      pos: offset,
      endPos: offset + node.nodeSize,
      fingerprint: computeBlockFingerprint(node),
    });
  });

  const topChanges = diffArrays(oldBlocks, newBlocks, {
    comparator: (left, right) => left.fingerprint === right.fingerprint,
  });

  const hunks: RichDiffHunk[] = [];
  let oldCursorIdx = 0;
  let newCursorIdx = 0;
  let anchorOldPos = 0;
  let anchorNewPos = 0;

  let cIdx = 0;
  while (cIdx < topChanges.length) {
    const part = topChanges[cIdx];

    if (!part.added && !part.removed) {
      const count = part.count ?? part.value.length;
      oldCursorIdx += count;
      newCursorIdx += count;
      if (count > 0) {
        anchorOldPos = oldBlocks[oldCursorIdx - 1].endPos;
        anchorNewPos = newBlocks[newCursorIdx - 1].endPos;
      }
      cIdx++;
      continue;
    }

    // Coalesce contiguous removed & added top-level block runs between exact anchors
    let removedCount = 0;
    let addedCount = 0;
    while (
      cIdx < topChanges.length &&
      (topChanges[cIdx].added || topChanges[cIdx].removed)
    ) {
      const step = topChanges[cIdx];
      const stepLen = step.count ?? step.value.length;
      if (step.removed) {
        removedCount += stepLen;
      } else if (step.added) {
        addedCount += stepLen;
      }
      cIdx++;
    }

    const removedOldBlocks = oldBlocks.slice(
      oldCursorIdx,
      oldCursorIdx + removedCount
    );
    const addedNewBlocks = newBlocks.slice(
      newCursorIdx,
      newCursorIdx + addedCount
    );

    oldCursorIdx += removedCount;
    newCursorIdx += addedCount;

    const pairs = alignModifiedBlockRun(removedOldBlocks, addedNewBlocks);

    // Emit unpaired gaps and paired modified blocks strictly in document order
    let prevOldRel = 0;
    let prevNewRel = 0;
    let gapOldAnchor = anchorOldPos;
    let gapNewAnchor = anchorNewPos;

    const emitUnpairedGap = (oldEndRel: number, newEndRel: number) => {
      const unpairedOld = removedOldBlocks.slice(prevOldRel, oldEndRel);
      const unpairedNew = addedNewBlocks.slice(prevNewRel, newEndRel);

      const delNewAnchor =
        unpairedNew.length > 0 ? unpairedNew[0].pos : gapNewAnchor;

      for (const oldEntry of unpairedOld) {
        hunks.push(createDeletedBlockHunk(hunks.length, oldEntry, delNewAnchor));
        gapOldAnchor = oldEntry.endPos;
      }

      for (let a = 0; a < unpairedNew.length; a++) {
        const newEntry = unpairedNew[a];
        hunks.push(
          createAddedBlockHunk(hunks.length, newEntry, gapOldAnchor, a)
        );
        gapNewAnchor = newEntry.endPos;
      }
    };

    for (const [oldRel, newRel] of pairs) {
      emitUnpairedGap(oldRel, newRel);

      const oldEntry = removedOldBlocks[oldRel];
      const newEntry = addedNewBlocks[newRel];
      hunks.push(createPairedModifiedHunk(hunks.length, oldEntry, newEntry));

      gapOldAnchor = oldEntry.endPos;
      gapNewAnchor = newEntry.endPos;
      prevOldRel = oldRel + 1;
      prevNewRel = newRel + 1;
    }

    emitUnpairedGap(removedOldBlocks.length, addedNewBlocks.length);

    if (removedOldBlocks.length > 0) {
      anchorOldPos = removedOldBlocks[removedOldBlocks.length - 1].endPos;
    }
    if (addedNewBlocks.length > 0) {
      anchorNewPos = addedNewBlocks[addedNewBlocks.length - 1].endPos;
    }
  }

  return hunks;
}

/**
 * Applies ONLY a single hunk's current state onto baselineDoc, leaving all other
 * unaccepted hunks untouched so subsequent computeDocDiff calls yield exact positions.
 */
export function applyAcceptHunkToBaseline(
  baselineDoc: PMNode,
  currentDoc: PMNode,
  hunk: DiffHunk
): PMNode {
  const rich = hunk as Partial<RichDiffHunk>;
  let oldFrom = rich.oldFrom;
  let oldTo = rich.oldTo;

  if (typeof oldFrom !== 'number' || typeof oldTo !== 'number') {
    const freshHunks = computeDocDiff(baselineDoc, currentDoc);
    const matched =
      freshHunks.find((h) => h.id === hunk.id) ??
      freshHunks.find(
        (h) =>
          h.newFrom === hunk.newFrom &&
          h.newTo === hunk.newTo &&
          h.kind === hunk.kind
      );
    if (!matched) {
      return baselineDoc;
    }
    oldFrom = matched.oldFrom;
    oldTo = matched.oldTo;
  }

  const safeOldFrom = Math.max(0, Math.min(oldFrom, baselineDoc.content.size));
  const safeOldTo = Math.max(
    safeOldFrom,
    Math.min(oldTo, baselineDoc.content.size)
  );
  const safeNewFrom = Math.max(
    0,
    Math.min(hunk.newFrom, currentDoc.content.size)
  );
  const safeNewTo = Math.max(
    safeNewFrom,
    Math.min(hunk.newTo, currentDoc.content.size)
  );

  const prefix = baselineDoc.content.cut(0, safeOldFrom);
  const acceptedMid = currentDoc.content.cut(safeNewFrom, safeNewTo);
  const suffix = baselineDoc.content.cut(safeOldTo, baselineDoc.content.size);
  const nextFragment = prefix.append(acceptedMid).append(suffix);

  if (nextFragment.size === 0) {
    return baselineDoc.type.createAndFill() ?? baselineDoc;
  }
  return baselineDoc.copy(nextFragment);
}

/**
 * Builds a ProseMirror transaction reverting a single hunk back to its baseline nodes.
 */
export function buildRevertTransaction(
  state: EditorState,
  hunk: DiffHunk
): Transaction {
  const oldNodes = hunk.oldNodesJson.map((json) =>
    state.schema.nodeFromJSON(json)
  );
  const docSize = state.doc.content.size;
  const safeFrom = Math.max(0, Math.min(hunk.newFrom, docSize));
  const safeTo = Math.max(safeFrom, Math.min(hunk.newTo, docSize));

  if (oldNodes.length === 0 && safeFrom === 0 && safeTo === docSize) {
    const fallbackDoc = state.schema.topNodeType.createAndFill();
    if (fallbackDoc) {
      return state.tr.replaceWith(0, docSize, fallbackDoc.content);
    }
  }

  return state.tr.replaceWith(safeFrom, safeTo, oldNodes);
}
