import type { Node as PMNode } from '@tiptap/pm/model';
import type { WordCountStats } from '../types/contract';

export type { WordCountStats } from '../types/contract';

export const EMPTY_WORD_COUNT_STATS: WordCountStats = {
  totalWords: 0,
  cjkChars: 0,
  latinWords: 0,
  charsNoSpaces: 0,
  charsWithSpaces: 0,
  paragraphs: 0,
  mathCount: 0,
  readingMinutes: 0,
};

/**
 * Lookup table for ASCII characters (`<= 126`) that may trigger inline/multi-line
 * Markdown, math, HTML, or CriticMarkup transitions during scanning.
 * All other characters (CJK ideographs, letters, digits, spaces, CJK punctuation)
 * stream directly through the single-pass token counter with zero allocations.
 */
const SPECIAL_INLINE_CHARS = new Uint8Array(128);
for (const code of [
  10, // \n
  13, // \r
  33, // !
  36, // $
  42, // *
  60, // <
  61, // =
  91, // [
  92, // \
  93, // ]
  95, // _
  96, // `
  123, // {
  124, // |
  126, // ~
]) {
  SPECIAL_INLINE_CHARS[code] = 1;
}

const ASCII_ALNUM = new Uint8Array(128);
for (let c = 0x30; c <= 0x39; c++) ASCII_ALNUM[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) ASCII_ALNUM[c] = 1;
for (let c = 0x61; c <= 0x7a; c++) ASCII_ALNUM[c] = 1;

function isWhitespaceCode(c: number): boolean {
  return (
    c === 0x20 || // space
    c === 0x09 || // \t
    c === 0x0a || // \n
    c === 0x0d || // \r
    c === 0x0b || // \v
    c === 0x0c || // \f
    c === 0x00a0 || // NBSP
    c === 0x3000 || // Ideographic full-width space
    c === 0xfeff // BOM
  );
}

function isAsciiDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isAsciiLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isAsciiPunctuation(c: number): boolean {
  return (
    (c >= 0x21 && c <= 0x2f) ||
    (c >= 0x3a && c <= 0x40) ||
    (c >= 0x5b && c <= 0x60) ||
    (c >= 0x7b && c <= 0x7e)
  );
}

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    cp === 0x3007 || // 〇 (Ideographic number zero)
    (cp >= 0x20000 && cp <= 0x323af) // CJK Extensions B–I
  );
}

function isLatinAlnumCodePoint(cp: number): boolean {
  if (cp < 128) return ASCII_ALNUM[cp] === 1;
  return cp >= 0x00c0 && cp <= 0x024f && cp !== 0x00d7 && cp !== 0x00f7;
}

function readCodePointAt(str: string, idx: number, limit: number): number {
  const first = str.charCodeAt(idx);
  if (first >= 0xd800 && first <= 0xdbff && idx + 1 < limit) {
    const second = str.charCodeAt(idx + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return ((first - 0xd800) << 10) + (second - 0xdc00) + 0x10000;
    }
  }
  return first;
}

function isThousandsSeparatorAt(
  src: string,
  afterCommaIdx: number,
  limit: number
): boolean {
  if (afterCommaIdx + 2 >= limit) return false;
  if (
    !isAsciiDigit(src.charCodeAt(afterCommaIdx)) ||
    !isAsciiDigit(src.charCodeAt(afterCommaIdx + 1)) ||
    !isAsciiDigit(src.charCodeAt(afterCommaIdx + 2))
  ) {
    return false;
  }
  return (
    afterCommaIdx + 3 >= limit || !isAsciiDigit(src.charCodeAt(afterCommaIdx + 3))
  );
}

/**
 * Zero-allocation streaming prose counter shared by both raw Markdown scanning
 * and ProseMirror selection traversal.
 */
class ProseStreamCounter {
  cjkChars = 0;
  latinWords = 0;
  charsNoSpaces = 0;
  charsWithSpaces = 0;
  paragraphs = 0;
  mathCount = 0;

  private hasNonWs = false;
  private pendingSpace = false;
  private inLatinWord = false;
  private pendingConnector = false;
  private lineNonWs = 0;
  private lineInternalSpaces = 0;

  feedSpace(): void {
    if (this.hasNonWs) {
      this.pendingSpace = true;
    }
    this.inLatinWord = false;
    this.pendingConnector = false;
  }

  endLine(): void {
    if (this.hasNonWs) {
      this.paragraphs++;
      this.charsNoSpaces += this.lineNonWs;
      this.charsWithSpaces += this.lineNonWs + this.lineInternalSpaces;
      this.hasNonWs = false;
      this.pendingSpace = false;
      this.inLatinWord = false;
      this.pendingConnector = false;
      this.lineNonWs = 0;
      this.lineInternalSpaces = 0;
    } else {
      this.pendingSpace = false;
      this.inLatinWord = false;
      this.pendingConnector = false;
    }
  }

  feedCharCode(c: number): void {
    if (isWhitespaceCode(c)) {
      if (this.hasNonWs) {
        this.pendingSpace = true;
      }
      this.inLatinWord = false;
      this.pendingConnector = false;
      return;
    }

    if (this.pendingSpace) {
      this.lineInternalSpaces++;
      this.pendingSpace = false;
    }
    this.hasNonWs = true;
    this.lineNonWs++;

    if (c >= 0x4e00 && c <= 0x9fff) {
      this.cjkChars++;
      this.inLatinWord = false;
      this.pendingConnector = false;
    } else if (c < 128 ? ASCII_ALNUM[c] === 1 : isLatinAlnumCodePoint(c)) {
      if (!this.inLatinWord && !this.pendingConnector) {
        this.latinWords++;
      }
      this.inLatinWord = true;
      this.pendingConnector = false;
    } else if (isCjkCodePoint(c)) {
      this.cjkChars++;
      this.inLatinWord = false;
      this.pendingConnector = false;
    } else if (
      this.inLatinWord &&
      (c === 0x27 || c === 0x2019 || c === 0x2d || c === 0x2e)
    ) {
      this.inLatinWord = false;
      this.pendingConnector = true;
    } else {
      this.inLatinWord = false;
      this.pendingConnector = false;
    }
  }

  /**
   * Streams `src[start..end)` directly into word/char/paragraph counters with
   * fast paths for CJK Unified Ideographs (`0x4E00..0x9FFF`), ASCII spaces,
   * and ASCII alphanumerics.
   */
  feedRange(src: string, start: number, end: number): void {
    let hasNonWs = this.hasNonWs;
    let pendingSpace = this.pendingSpace;
    let inLatinWord = this.inLatinWord;
    let pendingConnector = this.pendingConnector;
    let lineNonWs = this.lineNonWs;
    let lineInternalSpaces = this.lineInternalSpaces;
    let cjkChars = this.cjkChars;
    let latinWords = this.latinWords;

    let i = start;
    while (i < end) {
      const first = src.charCodeAt(i);

      // Fast path 1: Common CJK Unified Ideographs (BMP, non-surrogate)
      if (first >= 0x4e00 && first <= 0x9fff) {
        if (pendingSpace) {
          lineInternalSpaces++;
          pendingSpace = false;
        }
        hasNonWs = true;
        lineNonWs++;
        cjkChars++;
        inLatinWord = false;
        pendingConnector = false;
        i++;
        continue;
      }

      // Fast path 2: ASCII space / tab
      if (first === 0x20 || first === 0x09) {
        if (hasNonWs) {
          pendingSpace = true;
        }
        inLatinWord = false;
        pendingConnector = false;
        i++;
        continue;
      }

      // Fast path 3: ASCII letters & digits
      if (first < 128 && ASCII_ALNUM[first] === 1) {
        if (pendingSpace) {
          lineInternalSpaces++;
          pendingSpace = false;
        }
        hasNonWs = true;
        lineNonWs++;
        if (!inLatinWord && !pendingConnector) {
          latinWords++;
        }
        inLatinWord = true;
        pendingConnector = false;
        i++;
        continue;
      }

      // General Unicode & word-connector path
      const cp =
        first >= 0xd800 && first <= 0xdbff
          ? readCodePointAt(src, i, end)
          : first;
      const step = cp > 0xffff ? 2 : 1;

      if (isWhitespaceCode(cp)) {
        if (hasNonWs) {
          pendingSpace = true;
        }
        inLatinWord = false;
        pendingConnector = false;
        i += step;
        continue;
      }

      if (pendingSpace) {
        lineInternalSpaces++;
        pendingSpace = false;
      }
      hasNonWs = true;
      lineNonWs++;

      if (isCjkCodePoint(cp)) {
        cjkChars++;
        inLatinWord = false;
        pendingConnector = false;
      } else if (isLatinAlnumCodePoint(cp)) {
        if (!inLatinWord && !pendingConnector) {
          latinWords++;
        }
        inLatinWord = true;
        pendingConnector = false;
      } else if (
        inLatinWord &&
        (cp === 0x27 || cp === 0x2019 || cp === 0x2d || cp === 0x2e)
      ) {
        // Defer decision until next character (`don't`, `System-1`, `0.05`, `System-**1**` vs `2026.` or `1..10`)
        inLatinWord = false;
        pendingConnector = true;
      } else if (
        inLatinWord &&
        cp === 0x2c &&
        isThousandsSeparatorAt(src, i + step, end)
      ) {
        // Keep `inLatinWord = true` across thousands separator (`4,731`, `10,000`)
      } else {
        inLatinWord = false;
        pendingConnector = false;
      }

      i += step;
    }

    this.hasNonWs = hasNonWs;
    this.pendingSpace = pendingSpace;
    this.inLatinWord = inLatinWord;
    this.pendingConnector = pendingConnector;
    this.lineNonWs = lineNonWs;
    this.lineInternalSpaces = lineInternalSpaces;
    this.cjkChars = cjkChars;
    this.latinWords = latinWords;
  }

  finalize(): WordCountStats {
    this.endLine();
    const totalWords = this.cjkChars + this.latinWords;
    const readingMinutes =
      totalWords === 0 && this.mathCount === 0
        ? 0
        : Math.max(
            1,
            Math.ceil(
              this.cjkChars / 400 +
                this.latinWords / 220 +
                this.mathCount * 0.08
            )
          );

    return {
      totalWords,
      cjkChars: this.cjkChars,
      latinWords: this.latinWords,
      charsNoSpaces: this.charsNoSpaces,
      charsWithSpaces: this.charsWithSpaces,
      paragraphs: this.paragraphs,
      mathCount: this.mathCount,
      readingMinutes,
    };
  }
}

interface FenceOpenInfo {
  fenceChar: number; // 96 (`) or 126 (~)
  fenceLen: number;
  isSvg: boolean;
  hasBlockquotePrefix: boolean;
}

function matchFenceOpenLine(
  src: string,
  lineStart: number,
  lineEnd: number
): FenceOpenInfo | null {
  let p = lineStart;
  let hasBlockquotePrefix = false;

  while (p < lineEnd) {
    const c = src.charCodeAt(p);
    if (c === 0x20 || c === 0x09) {
      p++;
    } else if (c === 0x3e /* > */) {
      hasBlockquotePrefix = true;
      p++;
    } else {
      break;
    }
  }

  if (p + 3 > lineEnd) return null;
  const fenceChar = src.charCodeAt(p);
  if (fenceChar !== 96 && fenceChar !== 126) return null;

  let fenceLen = 0;
  while (p < lineEnd && src.charCodeAt(p) === fenceChar) {
    fenceLen++;
    p++;
  }
  if (fenceLen < 3) return null;

  if (fenceChar === 96) {
    for (let k = p; k < lineEnd; k++) {
      if (src.charCodeAt(k) === 96) return null;
    }
  }

  while (
    p < lineEnd &&
    (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)
  ) {
    p++;
  }
  let langEnd = p;
  while (
    langEnd < lineEnd &&
    src.charCodeAt(langEnd) !== 0x20 &&
    src.charCodeAt(langEnd) !== 0x09
  ) {
    langEnd++;
  }
  const isSvg =
    langEnd - p === 3 &&
    (src.charCodeAt(p) | 32) === 115 /* s */ &&
    (src.charCodeAt(p + 1) | 32) === 118 /* v */ &&
    (src.charCodeAt(p + 2) | 32) === 103; /* g */

  return { fenceChar, fenceLen, isSvg, hasBlockquotePrefix };
}

function isFenceCloseLine(
  src: string,
  lineStart: number,
  lineEnd: number,
  fenceChar: number,
  fenceLen: number
): boolean {
  let p = lineStart;
  while (p < lineEnd) {
    const c = src.charCodeAt(p);
    if (c === 0x20 || c === 0x09 || c === 0x3e) {
      p++;
    } else {
      break;
    }
  }
  let count = 0;
  while (p < lineEnd && src.charCodeAt(p) === fenceChar) {
    count++;
    p++;
  }
  if (count < fenceLen) return false;
  while (p < lineEnd) {
    const c = src.charCodeAt(p);
    if (c !== 0x20 && c !== 0x09) return false;
    p++;
  }
  return true;
}

function findAfterBlockquotePrefix(
  src: string,
  lineStart: number,
  lineEnd: number
): number {
  let p = lineStart;
  while (p < lineEnd) {
    const c = src.charCodeAt(p);
    if (c === 0x20 || c === 0x09 || c === 0x3e) {
      p++;
    } else {
      break;
    }
  }
  return p;
}

function isThematicBreakRange(
  src: string,
  start: number,
  end: number
): boolean {
  let p = start;
  while (p < end && (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)) {
    p++;
  }
  if (p >= end) return false;
  const marker = src.charCodeAt(p);
  if (marker !== 45 /* - */ && marker !== 42 /* * */ && marker !== 95 /* _ */) {
    return false;
  }
  let count = 0;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c === marker) {
      count++;
    } else if (c !== 0x20 && c !== 0x09) {
      return false;
    }
    p++;
  }
  return count >= 3;
}

function isTableSeparatorRange(
  src: string,
  start: number,
  end: number
): boolean {
  let hasPipe = false;
  let hasDash = false;
  for (let p = start; p < end; p++) {
    const c = src.charCodeAt(p);
    if (c === 124 /* | */) {
      hasPipe = true;
    } else if (c === 45 /* - */) {
      hasDash = true;
    } else if (c !== 58 /* : */ && c !== 0x20 && c !== 0x09) {
      return false;
    }
  }
  return hasPipe && hasDash;
}

const CALLOUT_TAG_RE = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

/**
 * Advances past line-start structural markers (`>`, `[!NOTE]`, `#` headings,
 * bullet/ordered/task list markers). Returns `-1` if the entire line is blank,
 * a horizontal rule, or a GFM table separator line.
 */
function advanceLineStartStructuralMarkers(
  src: string,
  lineStart: number,
  lineEnd: number
): number {
  let p = lineStart;
  let sawBlockquote = false;

  while (p < lineEnd) {
    const c = src.charCodeAt(p);
    if (c === 0x20 || c === 0x09) {
      p++;
    } else if (c === 0x3e /* > */) {
      sawBlockquote = true;
      p++;
    } else {
      break;
    }
  }

  if (p >= lineEnd) {
    return -1;
  }

  if (
    isThematicBreakRange(src, p, lineEnd) ||
    isTableSeparatorRange(src, p, lineEnd)
  ) {
    return -1;
  }

  // Callout marker `[!NOTE]`, `[!IMPORTANT]`, etc.
  if (
    src.charCodeAt(p) === 91 /* [ */ &&
    p + 5 < lineEnd &&
    src.charCodeAt(p + 1) === 33 /* ! */
  ) {
    const probe = src.slice(p, Math.min(lineEnd, p + 16));
    const m = CALLOUT_TAG_RE.exec(probe);
    if (m) {
      const afterMarker = p + m[0].length;
      if (
        afterMarker >= lineEnd ||
        src.charCodeAt(afterMarker) === 0x20 ||
        src.charCodeAt(afterMarker) === 0x09
      ) {
        p = afterMarker;
        while (
          p < lineEnd &&
          (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)
        ) {
          p++;
        }
        if (p >= lineEnd) return -1;
      }
    }
  }

  // ATX heading `#{1,6}[ \t]+`
  if (src.charCodeAt(p) === 35 /* # */) {
    let h = p;
    while (h < lineEnd && src.charCodeAt(h) === 35 && h - p < 7) {
      h++;
    }
    if (
      h - p <= 6 &&
      (h === lineEnd ||
        src.charCodeAt(h) === 0x20 ||
        src.charCodeAt(h) === 0x09)
    ) {
      p = h;
      while (
        p < lineEnd &&
        (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)
      ) {
        p++;
      }
      return p;
    }
  }

  // Unordered `[-*+][ \t]+` or ordered `\d{1,9}[.)][ \t]+` list marker
  const first = src.charCodeAt(p);
  let afterListMarker = -1;
  if (first === 45 /* - */ || first === 42 /* * */ || first === 43 /* + */) {
    if (
      p + 1 < lineEnd &&
      (src.charCodeAt(p + 1) === 0x20 || src.charCodeAt(p + 1) === 0x09)
    ) {
      afterListMarker = p + 1;
    } else if (p + 1 === lineEnd && !sawBlockquote && first === 45) {
      return -1;
    }
  } else if (isAsciiDigit(first)) {
    let d = p;
    while (d < lineEnd && isAsciiDigit(src.charCodeAt(d)) && d - p < 10) {
      d++;
    }
    if (
      d - p <= 9 &&
      d < lineEnd &&
      (src.charCodeAt(d) === 46 /* . */ || src.charCodeAt(d) === 41 /* ) */) &&
      (d + 1 === lineEnd ||
        src.charCodeAt(d + 1) === 0x20 ||
        src.charCodeAt(d + 1) === 0x09)
    ) {
      afterListMarker = d + 1;
    }
  }

  if (afterListMarker !== -1) {
    p = afterListMarker;
    while (
      p < lineEnd &&
      (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)
    ) {
      p++;
    }
    // Optional GFM task list checkbox `[ ]`, `[x]`, `[X]`
    if (
      p + 2 < lineEnd &&
      src.charCodeAt(p) === 91 /* [ */ &&
      (src.charCodeAt(p + 1) === 0x20 ||
        src.charCodeAt(p + 1) === 120 /* x */ ||
        src.charCodeAt(p + 1) === 88) /* X */ &&
      src.charCodeAt(p + 2) === 93 /* ] */ &&
      (p + 3 === lineEnd ||
        src.charCodeAt(p + 3) === 0x20 ||
        src.charCodeAt(p + 3) === 0x09)
    ) {
      p += 3;
      while (
        p < lineEnd &&
        (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)
      ) {
        p++;
      }
    }
  }

  return p;
}

function findInlineCodeSpanEnd(
  src: string,
  start: number,
  tickLen: number
): number {
  const len = src.length;
  let i = start + tickLen;
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === 10 /* \n */) {
      let k = i + 1;
      while (
        k < len &&
        (src.charCodeAt(k) === 0x20 ||
          src.charCodeAt(k) === 0x09 ||
          src.charCodeAt(k) === 13)
      ) {
        if (
          src.charCodeAt(k) === 13 &&
          k + 1 < len &&
          src.charCodeAt(k + 1) === 10
        ) {
          return -1;
        }
        k++;
      }
      if (k < len && src.charCodeAt(k) === 10) {
        return -1;
      }
    }
    if (c === 96 /* ` */) {
      let closeLen = 0;
      while (i + closeLen < len && src.charCodeAt(i + closeLen) === 96) {
        closeLen++;
      }
      if (closeLen === tickLen) {
        return i + closeLen;
      }
      i += closeLen;
      continue;
    }
    i++;
  }
  return -1;
}

function findClosingAiMathDelimiter(
  src: string,
  from: number,
  closeCharCode: number,
  allowBlankLines: boolean
): number {
  const len = src.length;
  let i = from;
  while (i < len) {
    const c = src.charCodeAt(i);
    if (!allowBlankLines && c === 10 /* \n */) {
      let k = i + 1;
      while (
        k < len &&
        (src.charCodeAt(k) === 0x20 ||
          src.charCodeAt(k) === 0x09 ||
          src.charCodeAt(k) === 13)
      ) {
        if (
          src.charCodeAt(k) === 13 &&
          k + 1 < len &&
          src.charCodeAt(k + 1) === 10
        ) {
          return -1;
        }
        k++;
      }
      if (k < len && src.charCodeAt(k) === 10) {
        return -1;
      }
    }
    if (c === 92 /* \ */ && i + 1 < len) {
      const next = src.charCodeAt(i + 1);
      if (next === 92) {
        i += 2;
        continue;
      }
      if (next === closeCharCode) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

function findClosingDoubleDollar(src: string, from: number): number {
  const len = src.length;
  let i = from;
  let hasContent = false;
  while (i + 1 < len) {
    const c = src.charCodeAt(i);
    if (c === 92 /* \ */) {
      const next = src.charCodeAt(i + 1);
      if (next === 92 || next === 36 /* $ */) {
        hasContent = true;
        i += 2;
        continue;
      }
    }
    if (c === 36 && src.charCodeAt(i + 1) === 36) {
      return hasContent ? i : -1;
    }
    if (!isWhitespaceCode(c)) {
      hasContent = true;
    }
    i++;
  }
  return -1;
}

function findClosingSingleDollarOnLine(
  src: string,
  from: number,
  isTableRow: boolean
): number {
  const len = src.length;
  let i = from;
  let hasNonWs = false;
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === 10 || c === 13) {
      return -1;
    }
    // Unescaped `|` inside a GFM table row splits table cells before inline `$` math
    if (isTableRow && c === 124 /* | */) {
      return -1;
    }
    if (c === 92 /* \ */ && i + 1 < len) {
      const next = src.charCodeAt(i + 1);
      if (next !== 10 && next !== 13) {
        hasNonWs = true;
        i += 2;
        continue;
      }
    }
    if (c === 36 /* $ */) {
      if (i + 1 < len && src.charCodeAt(i + 1) === 36) {
        return -1;
      }
      // Per remark-math / Pandoc, closing single `$` cannot be followed by a digit (avoids `$50 to $100`)
      if (i + 1 < len && isAsciiDigit(src.charCodeAt(i + 1))) {
        return -1;
      }
      return hasNonWs ? i : -1;
    }
    if (!isWhitespaceCode(c)) {
      hasNonWs = true;
    }
    i++;
  }
  return -1;
}

function isSvgOpenTagAt(src: string, pos: number): boolean {
  if (pos + 4 >= src.length) return false;
  if (src.charCodeAt(pos) !== 60 /* < */) return false;
  const c1 = src.charCodeAt(pos + 1) | 32;
  const c2 = src.charCodeAt(pos + 2) | 32;
  const c3 = src.charCodeAt(pos + 3) | 32;
  if (c1 !== 115 /* s */ || c2 !== 118 /* v */ || c3 !== 103 /* g */) {
    return false;
  }
  const next = src.charCodeAt(pos + 4);
  return next === 62 /* > */ || next === 47 /* / */ || isWhitespaceCode(next);
}

const enum HtmlTagKind {
  Inline = 0,
  Break = 1,
  Block = 2,
}

interface HtmlTagMatch {
  endPos: number;
  kind: HtmlTagKind;
  selfClosing: boolean;
}

function classifyHtmlTagKind(
  src: string,
  nameStart: number,
  nameEnd: number
): HtmlTagKind {
  const len = nameEnd - nameStart;
  if (len === 1) {
    return (src.charCodeAt(nameStart) | 32) === 112 /* p */
      ? HtmlTagKind.Block
      : HtmlTagKind.Inline;
  }
  if (len === 2) {
    const c0 = src.charCodeAt(nameStart) | 32;
    const c1 = src.charCodeAt(nameStart + 1) | 32;
    if (c0 === 98 /* b */ && c1 === 114 /* r */) return HtmlTagKind.Break;
    if (
      (c0 === 104 /* h */ && c1 === 114 /* r */) ||
      (c0 === 116 /* t */ && c1 === 114 /* r */) ||
      (c0 === 108 /* l */ && c1 === 105 /* i */)
    ) {
      return HtmlTagKind.Block;
    }
    return HtmlTagKind.Inline;
  }
  if (len === 3) {
    const c0 = src.charCodeAt(nameStart) | 32;
    const c1 = src.charCodeAt(nameStart + 1) | 32;
    const c2 = src.charCodeAt(nameStart + 2) | 32;
    if (c0 === 100 /* d */ && c1 === 105 /* i */ && c2 === 118 /* v */) {
      return HtmlTagKind.Block;
    }
    return HtmlTagKind.Inline;
  }
  if (len === 10) {
    return src.slice(nameStart, nameEnd).toLowerCase() === 'blockquote'
      ? HtmlTagKind.Block
      : HtmlTagKind.Inline;
  }
  return HtmlTagKind.Inline;
}

/**
 * Attribute-aware HTML tag matcher supporting `>` inside single- or double-quoted
 * attributes (e.g. `<span data-comment="a > b" data-id="c-1">`).
 */
function matchHtmlTagAt(src: string, start: number): HtmlTagMatch | null {
  const len = src.length;
  if (start + 2 >= len || src.charCodeAt(start) !== 60 /* < */) {
    return null;
  }
  let p = start + 1;
  const isClosing = src.charCodeAt(p) === 47 /* / */;
  if (isClosing) {
    p++;
  }
  if (p >= len || !isAsciiLetter(src.charCodeAt(p))) {
    return null;
  }
  const nameStart = p;
  p++;
  while (p < len) {
    const c = src.charCodeAt(p);
    if (
      isAsciiLetter(c) ||
      isAsciiDigit(c) ||
      c === 45 /* - */ ||
      (c === 58 /* : */ && p + 1 < len && src.charCodeAt(p + 1) !== 47)
    ) {
      p++;
    } else {
      break;
    }
  }
  if (p >= len) return null;

  const afterName = src.charCodeAt(p);
  if (
    afterName !== 62 /* > */ &&
    afterName !== 47 /* / */ &&
    !isWhitespaceCode(afterName)
  ) {
    return null;
  }

  const kind = classifyHtmlTagKind(src, nameStart, p);

  while (p < len) {
    const c = src.charCodeAt(p);
    if (c === 62 /* > */) {
      const selfClosing = !isClosing && src.charCodeAt(p - 1) === 47;
      return { endPos: p + 1, kind, selfClosing };
    }
    if (c === 34 /* " */ || c === 39 /* ' */) {
      const quoteIdx = src.indexOf(c === 34 ? '"' : "'", p + 1);
      if (quoteIdx === -1) return null;
      p = quoteIdx + 1;
      continue;
    }
    if (c === 60 /* < */) {
      return null;
    }
    p++;
  }
  return null;
}

function findSvgBlockCloseEnd(src: string, openTagPos: number): number {
  const selfTag = matchHtmlTagAt(src, openTagPos);
  if (selfTag && selfTag.selfClosing) {
    return selfTag.endPos;
  }
  const len = src.length;
  let i = selfTag ? selfTag.endPos : openTagPos + 4;
  while (i + 5 < len) {
    const idx = src.indexOf('</', i);
    if (idx === -1 || idx + 5 >= len) return -1;
    const c1 = src.charCodeAt(idx + 2) | 32;
    const c2 = src.charCodeAt(idx + 3) | 32;
    const c3 = src.charCodeAt(idx + 4) | 32;
    if (c1 === 115 && c2 === 118 && c3 === 103) {
      let k = idx + 5;
      while (k < len && isWhitespaceCode(src.charCodeAt(k))) {
        k++;
      }
      if (k < len && src.charCodeAt(k) === 62 /* > */) {
        return k + 1;
      }
    }
    i = idx + 2;
  }
  return -1;
}

function hasClosingTyporaEqualsOnLine(src: string, from: number): boolean {
  const len = src.length;
  let i = from;
  while (i + 1 < len) {
    const c = src.charCodeAt(i);
    if (c === 10 || c === 13) return false;
    if (c === 92 /* \ */) {
      i += 2;
      continue;
    }
    if (c === 61 /* = */ && src.charCodeAt(i + 1) === 61) {
      if (i + 2 < len && src.charCodeAt(i + 2) === 61) {
        while (i < len && src.charCodeAt(i) === 61) i++;
        continue;
      }
      if (i > from && !isWhitespaceCode(src.charCodeAt(i - 1))) {
        return true;
      }
    }
    i++;
  }
  return false;
}

interface MarkdownLinkMatch {
  closeBracketIdx: number;
  afterParenIdx: number;
}

function matchMarkdownLinkOrImage(
  src: string,
  openBracketPos: number
): MarkdownLinkMatch | null {
  const len = src.length;
  const maxLabelScan = Math.min(len, openBracketPos + 2048);
  let i = openBracketPos + 1;
  let bracketDepth = 0;
  let closeBracketIdx = -1;

  while (i < maxLabelScan) {
    const c = src.charCodeAt(i);
    if (c === 10 /* \n */) {
      let k = i + 1;
      while (
        k < len &&
        (src.charCodeAt(k) === 0x20 ||
          src.charCodeAt(k) === 0x09 ||
          src.charCodeAt(k) === 13)
      ) {
        if (
          src.charCodeAt(k) === 13 &&
          k + 1 < len &&
          src.charCodeAt(k + 1) === 10
        ) {
          return null;
        }
        k++;
      }
      if (k < len && src.charCodeAt(k) === 10) {
        return null;
      }
      i++;
      continue;
    }
    if (c === 92 /* \ */) {
      i += 2;
      continue;
    }
    if (c === 96 /* ` */) {
      let tickLen = 0;
      while (i + tickLen < maxLabelScan && src.charCodeAt(i + tickLen) === 96) {
        tickLen++;
      }
      const codeEnd = findInlineCodeSpanEnd(src, i, tickLen);
      i = codeEnd !== -1 ? codeEnd : i + tickLen;
      continue;
    }
    if (c === 91 /* [ */) {
      bracketDepth++;
      i++;
      continue;
    }
    if (c === 93 /* ] */) {
      if (bracketDepth > 0) {
        bracketDepth--;
        i++;
        continue;
      }
      closeBracketIdx = i;
      break;
    }
    i++;
  }

  if (
    closeBracketIdx === -1 ||
    closeBracketIdx + 1 >= len ||
    src.charCodeAt(closeBracketIdx + 1) !== 40 /* ( */
  ) {
    return null;
  }

  const maxDestScan = Math.min(len, closeBracketIdx + 4096);
  let p = closeBracketIdx + 2;
  let parenDepth = 1;

  while (
    p < maxDestScan &&
    (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)
  ) {
    p++;
  }
  if (p < maxDestScan && src.charCodeAt(p) === 60 /* < */) {
    p++;
    while (p < maxDestScan) {
      const c = src.charCodeAt(p);
      if (c === 10 || c === 13 || c === 60) return null;
      if (c === 92) {
        p += 2;
        continue;
      }
      if (c === 62 /* > */) {
        p++;
        break;
      }
      p++;
    }
  }

  while (p < maxDestScan) {
    const c = src.charCodeAt(p);
    if (c === 10 || c === 13) {
      return null;
    }
    if (c === 92 /* \ */) {
      p += 2;
      continue;
    }
    if (
      (c === 34 /* " */ || c === 39 /* ' */) &&
      p > closeBracketIdx + 2 &&
      isWhitespaceCode(src.charCodeAt(p - 1))
    ) {
      const quoteChar = c === 34 ? '"' : "'";
      const endQuote = src.indexOf(quoteChar, p + 1);
      if (endQuote === -1 || endQuote >= maxDestScan) return null;
      const nlBetween = src.indexOf('\n', p + 1);
      if (nlBetween !== -1 && nlBetween < endQuote) return null;
      p = endQuote + 1;
      continue;
    }
    if (c === 40 /* ( */) {
      parenDepth++;
      p++;
      continue;
    }
    if (c === 41 /* ) */) {
      parenDepth--;
      if (parenDepth === 0) {
        return { closeBracketIdx, afterParenIdx: p + 1 };
      }
      p++;
      continue;
    }
    p++;
  }

  return null;
}

function rangeContainsNewline(src: string, from: number, to: number): boolean {
  const nl = src.indexOf('\n', from);
  return nl !== -1 && nl < to;
}

/**
 * Computes academic paper word, character, paragraph, formula, and reading-time
 * statistics from raw Markdown in a single zero-allocation streaming pass (`< 1 ms` on 102 KB).
 */
export function computeMarkdownWordStats(markdown: string): WordCountStats {
  if (!markdown || markdown.length === 0) {
    return { ...EMPTY_WORD_COUNT_STATS };
  }

  const counter = new ProseStreamCounter();
  const len = markdown.length;
  let pos = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
  let atLineStart = true;
  let isCurrentLineTableRow = false;
  let openCriticHighlightDepth = 0;
  let inTyporaHighlight = false;
  const linkCloseStack: Array<{ bracketIdx: number; resumeIdx: number }> = [];

  while (pos < len) {
    if (atLineStart) {
      const firstCode = markdown.charCodeAt(pos);

      // O(1) fast bypass: lines starting directly at col 0 with CJK or ASCII letters
      // cannot be code fences, blank lines, headings, blockquotes, lists, or table separators.
      if (firstCode >= 128 || isAsciiLetter(firstCode)) {
        isCurrentLineTableRow = false;
        atLineStart = false;
      } else {
        const nlIdx = markdown.indexOf('\n', pos);
        const rawLineEnd =
          nlIdx === -1
            ? len
            : nlIdx > pos && markdown.charCodeAt(nlIdx - 1) === 13
              ? nlIdx - 1
              : nlIdx;
        const nextLinePos = nlIdx === -1 ? len : nlIdx + 1;

        // 1. Check fenced code block open (` ```svg ` vs ` ```python `)
        const fenceOpen = matchFenceOpenLine(markdown, pos, rawLineEnd);
        if (fenceOpen !== null) {
          pos = nextLinePos;
          while (pos < len) {
            const innerNl = markdown.indexOf('\n', pos);
            const innerEnd =
              innerNl === -1
                ? len
                : innerNl > pos && markdown.charCodeAt(innerNl - 1) === 13
                  ? innerNl - 1
                  : innerNl;
            const innerNext = innerNl === -1 ? len : innerNl + 1;

            if (
              isFenceCloseLine(
                markdown,
                pos,
                innerEnd,
                fenceOpen.fenceChar,
                fenceOpen.fenceLen
              )
            ) {
              pos = innerNext;
              break;
            }

            if (!fenceOpen.isSvg) {
              const codeStart = fenceOpen.hasBlockquotePrefix
                ? findAfterBlockquotePrefix(markdown, pos, innerEnd)
                : pos;
              counter.feedRange(markdown, codeStart, innerEnd);
              counter.endLine();
            }

            pos = innerNext;
          }
          inTyporaHighlight = false;
          isCurrentLineTableRow = false;
          linkCloseStack.length = 0;
          atLineStart = true;
          continue;
        }

        // 2. Check blank line / structural line markers
        const contentStart = advanceLineStartStructuralMarkers(
          markdown,
          pos,
          rawLineEnd
        );
        if (contentStart === -1 || contentStart >= rawLineEnd) {
          inTyporaHighlight = false;
          isCurrentLineTableRow = false;
          if (contentStart === -1) {
            let onlyWsOrBq = true;
            for (let k = pos; k < rawLineEnd; k++) {
              const c = markdown.charCodeAt(k);
              if (c !== 0x20 && c !== 0x09 && c !== 0x3e) {
                onlyWsOrBq = false;
                break;
              }
            }
            if (onlyWsOrBq) {
              linkCloseStack.length = 0;
            }
          }
          pos = nextLinePos;
          atLineStart = true;
          continue;
        }

        isCurrentLineTableRow = markdown.charCodeAt(contentStart) === 124 /* | */;
        pos = contentStart;
        atLineStart = false;
      }
    }

    const ch = markdown.charCodeAt(pos);

    // Fast path: stream contiguous runs of ordinary prose characters directly into counter
    if (ch > 126 || SPECIAL_INLINE_CHARS[ch] === 0) {
      let runEnd = pos + 1;
      while (runEnd < len) {
        const c = markdown.charCodeAt(runEnd);
        if (c <= 126 && SPECIAL_INLINE_CHARS[c] !== 0) {
          break;
        }
        runEnd++;
      }
      counter.feedRange(markdown, pos, runEnd);
      pos = runEnd;
      continue;
    }

    // 1. Line break `\n` or `\r`
    if (ch === 10 || ch === 13) {
      counter.endLine();
      inTyporaHighlight = false;
      isCurrentLineTableRow = false;
      if (ch === 13 && pos + 1 < len && markdown.charCodeAt(pos + 1) === 10) {
        pos += 2;
      } else {
        pos += 1;
      }
      atLineStart = true;
      continue;
    }

    // 2. Active Markdown link closing `](url)`
    if (
      ch === 93 /* ] */ &&
      linkCloseStack.length > 0 &&
      linkCloseStack[linkCloseStack.length - 1].bracketIdx === pos
    ) {
      const popped = linkCloseStack.pop()!;
      pos = popped.resumeIdx;
      continue;
    }

    // 3. Inline backtick code span `` `...` ``
    if (ch === 96 /* ` */) {
      let tickLen = 0;
      while (pos + tickLen < len && markdown.charCodeAt(pos + tickLen) === 96) {
        tickLen++;
      }
      const codeEnd = findInlineCodeSpanEnd(markdown, pos, tickLen);
      if (codeEnd !== -1) {
        counter.feedRange(markdown, pos + tickLen, codeEnd - tickLen);
        pos = codeEnd;
      } else {
        pos += tickLen;
      }
      continue;
    }

    // 4. Backslash `\` — AI math `\[...\]`, `\(...\)`, hard break, or escaped punctuation
    if (ch === 92 /* \ */) {
      if (pos + 1 < len) {
        const next = markdown.charCodeAt(pos + 1);
        if (next === 91 /* [ */) {
          const closeIdx = findClosingAiMathDelimiter(
            markdown,
            pos + 2,
            93 /* ] */,
            true
          );
          if (closeIdx !== -1) {
            counter.mathCount++;
            if (rangeContainsNewline(markdown, pos + 2, closeIdx)) {
              counter.endLine();
            } else {
              counter.feedSpace();
            }
            pos = closeIdx + 2;
            continue;
          }
        } else if (next === 40 /* ( */) {
          const closeIdx = findClosingAiMathDelimiter(
            markdown,
            pos + 2,
            41 /* ) */,
            false
          );
          if (closeIdx !== -1) {
            counter.mathCount++;
            counter.feedSpace();
            pos = closeIdx + 2;
            continue;
          }
        } else if (next === 10 || next === 13) {
          counter.feedSpace();
          pos += 1;
          continue;
        } else if (isAsciiPunctuation(next)) {
          counter.feedCharCode(next);
          pos += 2;
          continue;
        }
      }
      counter.feedCharCode(92);
      pos += 1;
      continue;
    }

    // 5. Dollar `$` — Display `$$...$$` or Inline `$...$`
    if (ch === 36 /* $ */) {
      if (pos + 1 < len && markdown.charCodeAt(pos + 1) === 36) {
        let dollarLen = 2;
        while (
          pos + dollarLen < len &&
          markdown.charCodeAt(pos + dollarLen) === 36
        ) {
          dollarLen++;
        }
        if (dollarLen === 2) {
          const closeIdx = findClosingDoubleDollar(markdown, pos + 2);
          if (closeIdx !== -1) {
            counter.mathCount++;
            if (rangeContainsNewline(markdown, pos + 2, closeIdx)) {
              counter.endLine();
            } else {
              counter.feedSpace();
            }
            pos = closeIdx + 2;
            continue;
          }
        }
        for (let d = 0; d < dollarLen; d++) {
          counter.feedCharCode(36);
        }
        pos += dollarLen;
        continue;
      }

      const closeInline = findClosingSingleDollarOnLine(
        markdown,
        pos + 1,
        isCurrentLineTableRow
      );
      if (closeInline !== -1) {
        counter.mathCount++;
        counter.feedSpace();
        pos = closeInline + 1;
        continue;
      }

      counter.feedCharCode(36);
      pos += 1;
      continue;
    }

    // 6. `<` — HTML comments, raw `<svg>...</svg>`, autolinks, or HTML tags (`<span>`, `<mark>`, etc.)
    if (ch === 60 /* < */) {
      if (markdown.startsWith('<!--', pos)) {
        const closeComment = markdown.indexOf('-->', pos + 4);
        const targetPos = closeComment !== -1 ? closeComment + 3 : len;
        if (rangeContainsNewline(markdown, pos, targetPos)) {
          counter.endLine();
        }
        pos = targetPos;
        continue;
      }

      if (isSvgOpenTagAt(markdown, pos)) {
        const svgCloseEnd = findSvgBlockCloseEnd(markdown, pos);
        if (svgCloseEnd !== -1) {
          if (rangeContainsNewline(markdown, pos, svgCloseEnd)) {
            counter.endLine();
          } else {
            counter.feedSpace();
          }
          pos = svgCloseEnd;
          continue;
        }
      }

      if (
        markdown.startsWith('<https://', pos) ||
        markdown.startsWith('<http://', pos) ||
        markdown.startsWith('<mailto:', pos)
      ) {
        let autoEnd = pos + 7;
        while (
          autoEnd < len &&
          markdown.charCodeAt(autoEnd) !== 62 /* > */ &&
          !isWhitespaceCode(markdown.charCodeAt(autoEnd))
        ) {
          autoEnd++;
        }
        if (autoEnd < len && markdown.charCodeAt(autoEnd) === 62) {
          counter.feedRange(markdown, pos + 1, autoEnd);
          pos = autoEnd + 1;
          continue;
        }
      }

      const htmlTag = matchHtmlTagAt(markdown, pos);
      if (htmlTag !== null) {
        if (htmlTag.kind === HtmlTagKind.Break) {
          counter.feedSpace();
        } else if (htmlTag.kind === HtmlTagKind.Block) {
          counter.endLine();
        }
        pos = htmlTag.endPos;
        continue;
      }

      counter.feedCharCode(60);
      pos += 1;
      continue;
    }

    // 7. CriticMarkup `{>> ... <<}` (exclude comment) & `{== ... ==}` (unwrap highlight)
    if (ch === 123 /* { */) {
      if (markdown.startsWith('{>>', pos)) {
        const closeCritic = markdown.indexOf('<<}', pos + 3);
        if (closeCritic !== -1) {
          pos = closeCritic + 3;
          continue;
        }
      } else if (markdown.startsWith('{==', pos)) {
        if (markdown.indexOf('==}', pos + 3) !== -1) {
          openCriticHighlightDepth++;
          pos += 3;
          continue;
        }
      }
      counter.feedCharCode(123);
      pos += 1;
      continue;
    }

    // 8. CriticMarkup closing `==}` or Typora highlight `==...==`
    if (ch === 61 /* = */) {
      if (openCriticHighlightDepth > 0 && markdown.startsWith('==}', pos)) {
        openCriticHighlightDepth--;
        pos += 3;
        continue;
      }

      if (
        pos + 1 < len &&
        markdown.charCodeAt(pos + 1) === 61 &&
        (pos + 2 >= len || markdown.charCodeAt(pos + 2) !== 61) &&
        (pos === 0 || markdown.charCodeAt(pos - 1) !== 61)
      ) {
        if (inTyporaHighlight) {
          if (pos > 0 && !isWhitespaceCode(markdown.charCodeAt(pos - 1))) {
            inTyporaHighlight = false;
            pos += 2;
            continue;
          }
        } else if (
          pos + 2 < len &&
          !isWhitespaceCode(markdown.charCodeAt(pos + 2)) &&
          hasClosingTyporaEqualsOnLine(markdown, pos + 2)
        ) {
          inTyporaHighlight = true;
          pos += 2;
          continue;
        }
      }

      counter.feedCharCode(61);
      pos += 1;
      continue;
    }

    // 9. Markdown image `![alt](url)` (strip) & link `[text](url)` (unwrap text)
    if (ch === 33 /* ! */) {
      if (pos + 1 < len && markdown.charCodeAt(pos + 1) === 91 /* [ */) {
        const imgMatch = matchMarkdownLinkOrImage(markdown, pos + 1);
        if (imgMatch !== null) {
          counter.feedSpace();
          pos = imgMatch.afterParenIdx;
          continue;
        }
      }
      counter.feedCharCode(33);
      pos += 1;
      continue;
    }

    if (ch === 91 /* [ */) {
      const linkMatch = matchMarkdownLinkOrImage(markdown, pos);
      if (linkMatch !== null) {
        linkCloseStack.push({
          bracketIdx: linkMatch.closeBracketIdx,
          resumeIdx: linkMatch.afterParenIdx,
        });
        pos += 1;
        continue;
      }
      counter.feedCharCode(91);
      pos += 1;
      continue;
    }

    // 10. Table pipe `|` -> `' '`
    if (ch === 124 /* | */) {
      counter.feedSpace();
      pos += 1;
      continue;
    }

    // 11. Strikethrough `~~`
    if (ch === 126 /* ~ */) {
      if (pos + 1 < len && markdown.charCodeAt(pos + 1) === 126) {
        while (pos < len && markdown.charCodeAt(pos) === 126) {
          pos++;
        }
        continue;
      }
      counter.feedCharCode(126);
      pos += 1;
      continue;
    }

    // 12. Bold/italic `*` and `_` delimiters
    if (ch === 42 /* * */) {
      if (pos + 1 < len && markdown.charCodeAt(pos + 1) === 42) {
        while (pos < len && markdown.charCodeAt(pos) === 42) {
          pos++;
        }
        continue;
      }
      const prevWs = pos === 0 || isWhitespaceCode(markdown.charCodeAt(pos - 1));
      const nextWs =
        pos + 1 >= len || isWhitespaceCode(markdown.charCodeAt(pos + 1));
      if (prevWs && nextWs) {
        counter.feedCharCode(42);
      }
      pos += 1;
      continue;
    }

    if (ch === 95 /* _ */) {
      if (pos + 1 < len && markdown.charCodeAt(pos + 1) === 95) {
        while (pos < len && markdown.charCodeAt(pos) === 95) {
          pos++;
        }
        continue;
      }
      const prevAlnum =
        pos > 0 && isLatinAlnumCodePoint(markdown.charCodeAt(pos - 1));
      const nextAlnum =
        pos + 1 < len && isLatinAlnumCodePoint(markdown.charCodeAt(pos + 1));
      if (prevAlnum && nextAlnum) {
        counter.feedCharCode(95);
      } else {
        const prevWs =
          pos === 0 || isWhitespaceCode(markdown.charCodeAt(pos - 1));
        const nextWs =
          pos + 1 >= len || isWhitespaceCode(markdown.charCodeAt(pos + 1));
        if (prevWs && nextWs) {
          counter.feedCharCode(95);
        }
      }
      pos += 1;
      continue;
    }

    // Fallback (e.g. ordinary `]` not closing an active `[text](url)`)
    counter.feedCharCode(ch);
    pos += 1;
  }

  return counter.finalize();
}

/**
 * Computes word, character, paragraph, formula, and reading-time statistics
 * for a ProseMirror selection `[from, to]` in WYSIWYG mode.
 *
 * Returns `null` when the selection is collapsed (`from >= to`) or contains
 * neither prose characters nor math formulas.
 */
export function computeProseMirrorSelectionWordStats(
  doc: PMNode,
  from: number,
  to: number
): WordCountStats | null {
  const maxPos = doc.content.size;
  const safeFrom = Math.max(0, Math.min(from, maxPos));
  const safeTo = Math.max(safeFrom, Math.min(to, maxPos));

  if (safeFrom >= safeTo) {
    return null;
  }

  const counter = new ProseStreamCounter();

  doc.nodesBetween(safeFrom, safeTo, (node, pos, parent, index) => {
    const typeName = node.type.name;

    if (typeName === 'svgBlock' || typeName === 'image') {
      return false;
    }

    if (typeName === 'mathInline') {
      counter.mathCount++;
      counter.feedSpace();
      return false;
    }

    if (typeName === 'mathBlock') {
      counter.mathCount++;
      counter.endLine();
      return false;
    }

    if (typeName === 'hardBreak') {
      counter.feedSpace();
      return false;
    }

    if (typeName === 'tableRow') {
      counter.endLine();
      return true;
    }

    if (typeName === 'tableCell' || typeName === 'tableHeader') {
      counter.feedSpace();
      return true;
    }

    if (node.isTextblock) {
      const parentType = parent?.type.name;
      if (
        (parentType === 'tableCell' || parentType === 'tableHeader') &&
        index === 0
      ) {
        counter.feedSpace();
      } else {
        counter.endLine();
      }
      return true;
    }

    if (node.isText && node.text) {
      const text = node.text;
      const sliceStart = Math.max(0, safeFrom - pos);
      const sliceEnd = Math.min(text.length, safeTo - pos);
      if (sliceEnd > sliceStart) {
        // Handle multi-line text inside `codeBlock` textblocks cleanly
        let cursor = sliceStart;
        while (cursor < sliceEnd) {
          const nlIdx = text.indexOf('\n', cursor);
          if (nlIdx === -1 || nlIdx >= sliceEnd) {
            const segEnd =
              sliceEnd > cursor && text.charCodeAt(sliceEnd - 1) === 13
                ? sliceEnd - 1
                : sliceEnd;
            counter.feedRange(text, cursor, segEnd);
            break;
          }
          const segEnd =
            nlIdx > cursor && text.charCodeAt(nlIdx - 1) === 13
              ? nlIdx - 1
              : nlIdx;
          counter.feedRange(text, cursor, segEnd);
          counter.endLine();
          cursor = nlIdx + 1;
        }
      }
      return false;
    }

    return true;
  });

  const stats = counter.finalize();
  if (
    stats.totalWords === 0 &&
    stats.charsNoSpaces === 0 &&
    stats.mathCount === 0
  ) {
    return null;
  }

  return stats;
}
