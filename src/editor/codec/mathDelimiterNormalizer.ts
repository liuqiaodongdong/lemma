/**
 * Normalizes AI-dialect LaTeX math delimiters (`\[ ... \]` and `\( ... \)`)
 * into standard Markdown math delimiters (`$$\n...\n$$` and `$...$`),
 * while strictly leaving fenced code blocks and inline backtick code spans untouched.
 */

interface FenceOpenMatch {
  fenceChar: '`' | '~';
  fenceLen: number;
}

function matchFenceOpen(line: string): FenceOpenMatch | null {
  const m = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!m) return null;
  const seq = m[1];
  const info = m[2];
  const fenceChar = seq[0] as '`' | '~';
  // Per CommonMark, backtick fence info strings cannot contain backticks
  if (fenceChar === '`' && info.includes('`')) {
    return null;
  }
  return { fenceChar, fenceLen: seq.length };
}

function isFenceClose(line: string, fence: FenceOpenMatch): boolean {
  const escapedChar = fence.fenceChar === '`' ? '`' : '~';
  const re = new RegExp(
    `^[ \\t]*(?:>[ \\t]*)*${escapedChar}{${fence.fenceLen},}[ \\t]*$`
  );
  return re.test(line);
}

/**
 * Splits markdown into alternating segments of `{ isCodeFence: boolean, text: string }`
 * so fenced code blocks (` ``` ` or `~~~`) are never modified.
 */
function splitByFencedCodeBlocks(
  markdown: string
): Array<{ isCodeFence: boolean; text: string }> {
  const lines = markdown.split('\n');
  const segments: Array<{ isCodeFence: boolean; text: string }> = [];
  let buffer: string[] = [];
  let activeFence: FenceOpenMatch | null = null;

  const flush = (isCodeFence: boolean) => {
    if (buffer.length > 0) {
      segments.push({ isCodeFence, text: buffer.join('\n') });
      buffer = [];
    }
  };

  for (const line of lines) {
    if (activeFence === null) {
      const open = matchFenceOpen(line);
      if (open) {
        flush(false);
        activeFence = open;
        buffer.push(line);
      } else {
        buffer.push(line);
      }
    } else {
      buffer.push(line);
      if (isFenceClose(line, activeFence)) {
        flush(true);
        activeFence = null;
      }
    }
  }

  flush(activeFence !== null);
  return segments;
}

/**
 * Finds the end index (exclusive) of an inline backtick code span starting at `start`
 * where `src[start] === '`'`. Returns -1 if no matching closing backtick run exists
 * before a blank line.
 */
function findInlineCodeSpanEnd(src: string, start: number): number {
  let tickLen = 0;
  while (start + tickLen < src.length && src[start + tickLen] === '`') {
    tickLen++;
  }
  let i = start + tickLen;
  while (i < src.length) {
    // Inline code spans do not cross paragraph breaks (blank lines)
    if (src[i] === '\n') {
      let k = i + 1;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < src.length && src[k] === '\n') {
        return -1;
      }
    }
    if (src[i] === '`') {
      let closeLen = 0;
      while (i + closeLen < src.length && src[i + closeLen] === '`') {
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

/**
 * Finds the index of an unescaped closing delimiter (`\]` or `\)`) starting at `from`.
 */
function findClosingAiMathDelimiter(
  src: string,
  from: number,
  closeChar: ']' | ')',
  allowBlankLines: boolean
): number {
  let i = from;
  while (i < src.length) {
    if (!allowBlankLines && src[i] === '\n') {
      let k = i + 1;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < src.length && src[k] === '\n') {
        return -1;
      }
    }
    if (src[i] === '`') {
      // Do not get confused by backticks inside LaTeX math (e.g. ``quotes``), just continue
    }
    if (src[i] === '\\') {
      if (i + 1 < src.length && src[i + 1] === '\\') {
        // Escaped backslash pair `\\` (such as LaTeX row break `\\[6pt]`): skip both!
        i += 2;
        continue;
      }
      if (i + 1 < src.length && src[i + 1] === closeChar) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

function normalizeNonFenceSegment(src: string): string {
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    // 1. Preserve inline code spans `...` / ``...`` untouched
    if (ch === '`') {
      const end = findInlineCodeSpanEnd(src, i);
      if (end !== -1) {
        out += src.slice(i, end);
        i = end;
        continue;
      }
      // Unmatched backtick run: consume entire backtick run literally
      while (i < src.length && src[i] === '`') {
        out += '`';
        i++;
      }
      continue;
    }

    // 2. Handle backslash sequences
    if (ch === '\\' && i + 1 < src.length) {
      const next = src[i + 1];

      // Double backslash `\\` (e.g. LaTeX line break `\\[4pt]`): preserve both
      if (next === '\\') {
        out += '\\\\';
        i += 2;
        continue;
      }

      // AI Display Math: `\[ ... \]` -> `$$\n...\n$$`
      if (next === '[') {
        const closeIdx = findClosingAiMathDelimiter(src, i + 2, ']', true);
        if (closeIdx !== -1) {
          const inner = src.slice(i + 2, closeIdx).trim();

          // Inspect what already precedes `\[` on the current output line
          const lastNewline = out.lastIndexOf('\n');
          const linePrefix = out.slice(lastNewline + 1);
          const bqMatch = /^([ \t]*(?:>[ \t]*)+)$/.exec(linePrefix);
          const wsOnlyMatch = /^[ \t]*$/.test(linePrefix);

          // Inspect what follows `\]` on the same source line
          let afterIdx = closeIdx + 2;
          let trailingSpaces = '';
          while (
            afterIdx < src.length &&
            (src[afterIdx] === ' ' || src[afterIdx] === '\t')
          ) {
            trailingSpaces += src[afterIdx];
            afterIdx++;
          }
          const hasTextAfterOnSameLine =
            afterIdx < src.length && src[afterIdx] !== '\n';

          if (bqMatch) {
            const rawPrefix = bqMatch[1];
            const cleanPrefix = rawPrefix.endsWith(' ')
              ? rawPrefix
              : `${rawPrefix} `;
            const prefixedInner = inner
              .split('\n')
              .map((line) => {
                const stripped = line.replace(/^[ \t]*(?:>[ \t]*)+/, '');
                return stripped.length > 0
                  ? `${cleanPrefix}${stripped}`
                  : cleanPrefix.trimEnd();
              })
              .join('\n');
            out =
              out.slice(0, lastNewline + 1) +
              `${cleanPrefix}$$\n${prefixedInner}\n${cleanPrefix}$$`;
            if (hasTextAfterOnSameLine) {
              out += `\n${cleanPrefix}`;
              i = afterIdx;
            } else {
              out += trailingSpaces;
              i = afterIdx;
            }
            continue;
          }

          if (wsOnlyMatch) {
            out = out.slice(0, lastNewline + 1) + `$$\n${inner}\n$$`;
            if (hasTextAfterOnSameLine) {
              out += '\n\n';
              i = afterIdx;
            } else {
              out += trailingSpaces;
              i = afterIdx;
            }
            continue;
          }

          // Inline-embedded `\[ ... \]` with text before it on the same line:
          // surround with blank lines so remark-math parses `$$` as flow mathBlock
          out = out.replace(/[ \t]+$/, '') + `\n\n$$\n${inner}\n$$`;
          if (hasTextAfterOnSameLine) {
            out += '\n\n';
            i = afterIdx;
          } else {
            i = closeIdx + 2;
          }
          continue;
        }
      }

      // AI Inline Math: `\( ... \)` -> `$...$`
      if (next === '(') {
        const closeIdx = findClosingAiMathDelimiter(src, i + 2, ')', false);
        if (closeIdx !== -1) {
          const inner = src
            .slice(i + 2, closeIdx)
            .replace(/[ \t]*\n[ \t]*/g, ' ')
            .trim();
          out += `$${inner}$`;
          i = closeIdx + 2;
          continue;
        }
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Converts AI-dialect LaTeX delimiters outside fenced code blocks and inline code spans:
 * - `\[ ... \]` -> `$$\n...\n$$`
 * - `\( ... \)` -> `$...$`
 */
export function normalizeAiMathDelimiters(markdown: string): string {
  if (!markdown) return markdown;
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) {
    return markdown.includes('\r') ? markdown.replace(/\r\n/g, '\n') : markdown;
  }
  const unix = markdown.includes('\r')
    ? markdown.replace(/\r\n/g, '\n')
    : markdown;
  const segments = splitByFencedCodeBlocks(unix);
  return segments
    .map((seg) => (seg.isCodeFence ? seg.text : normalizeNonFenceSegment(seg.text)))
    .join('\n');
}

/**
 * Pre-remark helper: expands standalone single-line `$$ ... $$` blocks and
 * multi-line `$$...$$` blocks that attach LaTeX directly to the opening/closing `$$`
 * into canonical 3-line `$$\n...\n$$` fences so `remark-math` v6 parses them as flow `math`.
 */
export function normalizeDisplayDollarBlocks(markdown: string): string {
  if (!markdown) return markdown;
  if (!markdown.includes('$$')) {
    return markdown.includes('\r') ? markdown.replace(/\r\n/g, '\n') : markdown;
  }
  const unix = markdown.includes('\r')
    ? markdown.replace(/\r\n/g, '\n')
    : markdown;
  const segments = splitByFencedCodeBlocks(unix);

  return segments
    .map((seg) => {
      if (seg.isCodeFence) return seg.text;

      const lines = seg.text.split('\n');
      const result: string[] = [];
      let idx = 0;

      while (idx < lines.length) {
        const line = lines[idx];

        // Case 1: Single-line standalone `$$ ... $$` (optionally inside blockquote `> `)
        const singleMatch = /^([ \t]*(?:>[ \t]*)*)\$\$([^\n$`]+?)\$\$[ \t]*$/.exec(
          line
        );
        if (singleMatch) {
          const rawPrefix = singleMatch[1];
          const hasBq = rawPrefix.includes('>');
          const prefix = hasBq
            ? rawPrefix.endsWith(' ')
              ? rawPrefix
              : `${rawPrefix} `
            : '';
          const inner = singleMatch[2].trim();
          result.push(`${prefix}$$`);
          result.push(`${prefix}${inner}`);
          result.push(`${prefix}$$`);
          idx++;
          continue;
        }

        // Case 2: Multi-line `$$...` opening fence (with or without attached LaTeX on opening line)
        const openMatch = /^([ \t]*(?:>[ \t]*)*)\$\$([ \t]*[^\n$]*)$/.exec(line);
        if (openMatch) {
          const rawPrefix = openMatch[1];
          const hasBq = rawPrefix.includes('>');
          const prefix = hasBq
            ? rawPrefix.endsWith(' ')
              ? rawPrefix
              : `${rawPrefix} `
            : '';
          const firstLineRemainder = openMatch[2].trim();

          // Scan ahead for matching closing `$$` line (either `$$` alone or `...$$` at end of line)
          let closeLineIdx = -1;
          let lastLineBeforeDollars = '';
          for (let k = idx + 1; k < lines.length; k++) {
            const candidate = lines[k];
            const closeMatch = /^(?:[ \t]*(?:>[ \t]*)*)(.*?)\$\$[ \t]*$/.exec(
              candidate
            );
            if (closeMatch && !closeMatch[1].includes('$$')) {
              closeLineIdx = k;
              lastLineBeforeDollars = closeMatch[1].trimEnd();
              break;
            }
          }

          if (closeLineIdx !== -1) {
            result.push(`${prefix}$$`);
            if (firstLineRemainder.length > 0) {
              result.push(`${prefix}${firstLineRemainder}`);
            }
            for (let k = idx + 1; k < closeLineIdx; k++) {
              result.push(lines[k]);
            }
            if (lastLineBeforeDollars.trim().length > 0) {
              result.push(`${prefix}${lastLineBeforeDollars.trimStart()}`);
            }
            result.push(`${prefix}$$`);
            idx = closeLineIdx + 1;
            continue;
          }
        }

        result.push(line);
        idx++;
      }

      return result.join('\n');
    })
    .join('\n');
}
