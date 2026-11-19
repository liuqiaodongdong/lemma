/**
 * MDAST-safe progressive Markdown chunker.
 *
 * Splits large Markdown documents at 100% context-free top-level block boundaries
 * so concatenating `parseMarkdownChunkToBlocks` across `[head, ...tailChunks]`
 * produces the exact same `JSONContent[]` AST as `parseMarkdownToDocJson(markdown)`.
 */

export interface ProgressiveMarkdownOptions {
  minProgressiveChars?: number;
  headTargetChars?: number;
  tailChunkTargetChars?: number;
}

export interface ProgressiveMarkdownSplit {
  head: string;
  tailChunks: string[];
}

interface ActiveCodeFence {
  fenceChar: '`' | '~';
  fenceLen: number;
}

const FOOTNOTE_DEF_RE = /\[\^[^\]]+\]:/;
const LINK_REF_DEF_RE =
  /^[ \t]{0,3}\[[^\^\[\]]{1,200}\]:[ \t]*(?:\S|\r?\n[ \t]*\S)/m;
const FENCE_OPEN_RE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})([^\n]*)$/;
const LIST_MARKER_AT_COL0_RE = /^(?:[-*+]|\d+[.)])(?:[ \t]|$)/;
const DOLLAR_BLOCK_OPEN_RE = /^[ \t]*(?:>[ \t]*)*(\${2,})(.*)$/;
const RAW_HTML_BLOCK_OPEN_RE =
  /^[ ]{0,3}<(pre|script|style|textarea|svg)(?:[\s>]|$)/i;

const MIN_REMAINDER_CHARS = 256;

function matchCodeFenceOpen(line: string): ActiveCodeFence | null {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  const seq = m[1];
  const info = m[2];
  const fenceChar = seq[0] as '`' | '~';
  if (fenceChar === '`' && info.includes('`')) {
    return null;
  }
  return { fenceChar, fenceLen: seq.length };
}

function isCodeFenceClose(line: string, fence: ActiveCodeFence): boolean {
  let i = 0;
  const len = line.length;
  // Skip leading spaces/tabs and optional blockquote `>` markers (matching mathDelimiterNormalizer)
  while (i < len) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === '>') {
      i++;
    } else {
      break;
    }
  }
  let count = 0;
  while (i < len && line[i] === fence.fenceChar) {
    count++;
    i++;
  }
  if (count < fence.fenceLen) return false;
  while (i < len) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
    i++;
  }
  return true;
}

function updateAiBracketMathState(
  line: string,
  currentlyInAiMath: boolean,
  fullMarkdown: string,
  lineStartOffset: number
): boolean {
  let inMath = currentlyInAiMath;
  let i = 0;
  const len = line.length;

  while (i < len) {
    if (!inMath) {
      // Skip matched inline code spans `...` on the current line
      if (line[i] === '`') {
        let tickLen = 0;
        while (i + tickLen < len && line[i + tickLen] === '`') {
          tickLen++;
        }
        let scan = i + tickLen;
        let closedAt = -1;
        while (scan < len) {
          if (line[scan] === '`') {
            let cLen = 0;
            while (scan + cLen < len && line[scan + cLen] === '`') {
              cLen++;
            }
            if (cLen === tickLen) {
              closedAt = scan + cLen;
              break;
            }
            scan += cLen;
            continue;
          }
          scan++;
        }
        i = closedAt !== -1 ? closedAt : i + tickLen;
        continue;
      }

      if (line[i] === '\\' && i + 1 < len) {
        if (line[i + 1] === '\\') {
          i += 2;
          continue;
        }
        if (line[i + 1] === '[') {
          // Only enter AI display math if a closing `\]` actually exists ahead in the document
          if (fullMarkdown.indexOf('\\]', lineStartOffset + i + 2) !== -1) {
            inMath = true;
          }
          i += 2;
          continue;
        }
      }
      i++;
    } else {
      if (line[i] === '\\' && i + 1 < len) {
        if (line[i + 1] === '\\') {
          i += 2;
          continue;
        }
        if (line[i + 1] === ']') {
          inMath = false;
          i += 2;
          continue;
        }
      }
      i++;
    }
  }

  return inMath;
}

function detectHtmlBlockCloseRe(line: string): RegExp | null {
  if (/^[ ]{0,3}<!--/.test(line)) {
    return line.includes('-->') ? null : /-->/;
  }
  if (/^[ ]{0,3}<\?/.test(line)) {
    return line.includes('?>') ? null : /\?>/;
  }
  if (/^[ ]{0,3}<!\[CDATA\[/.test(line)) {
    return line.includes(']]>') ? null : /\]\]>/;
  }
  if (/^[ ]{0,3}<![A-Z]/.test(line)) {
    return line.includes('>') ? null : />/;
  }
  const tagMatch = RAW_HTML_BLOCK_OPEN_RE.exec(line);
  if (tagMatch) {
    const tagName = tagMatch[1].toLowerCase();
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
    return closeRe.test(line) ? null : closeRe;
  }
  return null;
}

function endsWithAtLeastDollars(line: string, minDollars: number): boolean {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    end--;
  }
  let count = 0;
  while (end > 0 && line[end - 1] === '$') {
    count++;
    end--;
  }
  return count >= minDollars;
}

/**
 * Splits a Markdown string into an initial `head` slice (~1.5–2.5 screens) and
 * subsequent `tailChunks` at 100% MDAST-safe top-level block boundaries.
 */
export function splitMarkdownForProgressiveLoad(
  markdown: string,
  options?: ProgressiveMarkdownOptions
): ProgressiveMarkdownSplit {
  const minProgressiveChars = options?.minProgressiveChars ?? 8000;
  const headTargetChars = options?.headTargetChars ?? 4200;
  const tailChunkTargetChars = options?.tailChunkTargetChars ?? 12000;

  if (
    !markdown ||
    markdown.length <= minProgressiveChars ||
    FOOTNOTE_DEF_RE.test(markdown) ||
    LINK_REF_DEF_RE.test(markdown)
  ) {
    return { head: markdown ?? '', tailChunks: [] };
  }

  const len = markdown.length;
  let head: string | null = null;
  const tailChunks: string[] = [];

  let chunkStart = 0;
  let hasNonBlankInChunk = false;
  let prevLineIsBlank = false;

  let activeFence: ActiveCodeFence | null = null;
  let inDollarMathLen = 0;
  let inAiBracketMath = false;
  let activeHtmlCloseRe: RegExp | null = null;

  let pos = 0;
  while (pos < len) {
    const nlIdx = markdown.indexOf('\n', pos);
    const lineEnd = nlIdx === -1 ? len : nlIdx + 1;
    const rawLine =
      nlIdx === -1
        ? markdown.slice(pos)
        : nlIdx > pos && markdown[nlIdx - 1] === '\r'
          ? markdown.slice(pos, nlIdx - 1)
          : markdown.slice(pos, nlIdx);

    const isBlank = rawLine.trim().length === 0;

    // Check if `pos` (start of `rawLine`) is a 100% safe top-level split boundary
    const targetChars = head === null ? headTargetChars : tailChunkTargetChars;
    if (
      pos - chunkStart >= targetChars &&
      len - pos >= MIN_REMAINDER_CHARS &&
      hasNonBlankInChunk &&
      prevLineIsBlank &&
      !isBlank &&
      activeFence === null &&
      inDollarMathLen === 0 &&
      !inAiBracketMath &&
      activeHtmlCloseRe === null
    ) {
      const firstChar = rawLine[0];
      const startsAtCol0 = firstChar !== ' ' && firstChar !== '\t';
      if (
        startsAtCol0 &&
        firstChar !== '>' &&
        firstChar !== '|' &&
        !rawLine.startsWith('</') &&
        !LIST_MARKER_AT_COL0_RE.test(rawLine)
      ) {
        const slice = markdown.slice(chunkStart, pos);
        if (head === null) {
          head = slice;
        } else {
          tailChunks.push(slice);
        }
        chunkStart = pos;
        hasNonBlankInChunk = false;
      }
    }

    // Advance block-tracking state across `rawLine`
    if (!isBlank) {
      hasNonBlankInChunk = true;
    }

    if (activeFence !== null) {
      if (isCodeFenceClose(rawLine, activeFence)) {
        activeFence = null;
      }
    } else if (activeHtmlCloseRe !== null) {
      if (activeHtmlCloseRe.test(rawLine)) {
        activeHtmlCloseRe = null;
      }
    } else if (inDollarMathLen > 0) {
      if (endsWithAtLeastDollars(rawLine, inDollarMathLen)) {
        inDollarMathLen = 0;
      }
    } else if (inAiBracketMath) {
      inAiBracketMath = updateAiBracketMathState(rawLine, true, markdown, pos);
    } else {
      const fenceOpen = matchCodeFenceOpen(rawLine);
      if (fenceOpen !== null) {
        activeFence = fenceOpen;
      } else {
        const htmlClose = detectHtmlBlockCloseRe(rawLine);
        if (htmlClose !== null) {
          activeHtmlCloseRe = htmlClose;
        } else {
          const dollarOpen = DOLLAR_BLOCK_OPEN_RE.exec(rawLine);
          if (dollarOpen !== null) {
            const openDollars = dollarOpen[1];
            const rest = dollarOpen[2];
            // Per remark-math & normalizeDisplayDollarBlocks, a multi-line `$$` flow fence
            // only opens when `rest` contains no `$` (lines like `$$x=1$$ prose` are single-line inline math).
            if (!rest.includes('$')) {
              inDollarMathLen = openDollars.length;
            }
          } else {
            inAiBracketMath = updateAiBracketMathState(
              rawLine,
              false,
              markdown,
              pos
            );
          }
        }
      }
    }

    prevLineIsBlank = isBlank;
    pos = lineEnd;
  }

  const finalSlice = markdown.slice(chunkStart);
  if (head === null) {
    return { head: finalSlice, tailChunks: [] };
  }
  if (finalSlice.length > 0) {
    tailChunks.push(finalSlice);
  }
  return { head, tailChunks };
}
