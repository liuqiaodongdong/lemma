import type { JSONContent } from '@tiptap/core';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type {
  Root,
  RootContent,
  PhrasingContent,
  Paragraph,
  Blockquote,
  List,
  ListItem,
  Table,
  Heading,
  Code,
} from 'mdast';
import type { CalloutKind } from '../../types/contract';
import { normalizeHighlightColor } from '../extensions/HighlightMark';
import { unescapeCommentAttr } from './commentAttrCodec';
import {
  normalizeAiMathDelimiters,
  normalizeDisplayDollarBlocks,
} from './mathDelimiterNormalizer';

type MarkSpec = {
  type: string;
  attrs?: Record<string, unknown>;
};

export interface ParseContext {
  extCommentCounter: number;
}

export function createParseContext(): ParseContext {
  return { extCommentCounter: 0 };
}

type StreamToken =
  | { kind: 'text'; value: string }
  | { kind: 'inlineCode'; value: string }
  | { kind: 'inlineMath'; latex: string }
  | { kind: 'hardBreak' }
  | { kind: 'html'; value: string }
  | { kind: 'pushStructural'; mark: MarkSpec }
  | { kind: 'popStructural' }
  | { kind: 'pushAnnotation'; marks: MarkSpec[] }
  | { kind: 'popAnnotation'; types: string[] };

const CALLOUT_MARKER_RE =
  /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\r?\n|[ \t]+|$)/i;

const HTML_TAG_CHUNK_RE =
  /<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>|[^<]+|</g;

const HTML_ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const MATH_AND_CODE_OUTER_MARKS = new Set<string>([
  'comment',
  'highlight',
  'link',
]);

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath);

function parseHtmlTagAttributes(rawTag: string): Record<string, string> {
  const openBodyMatch = /^<[a-zA-Z][a-zA-Z0-9:-]*([\s\S]*?)\/?>$/.exec(
    rawTag.trim()
  );
  if (!openBodyMatch) return {};
  const attrSegment = openBodyMatch[1];
  const attrs: Record<string, string> = {};
  HTML_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_ATTR_RE.exec(attrSegment)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

function cloneMarkSpec(mark: MarkSpec): MarkSpec {
  return mark.attrs
    ? { type: mark.type, attrs: { ...mark.attrs } }
    : { type: mark.type };
}

function areMarkArraysEqual(
  a: MarkSpec[] | undefined,
  b: MarkSpec[] | undefined
): boolean {
  const lenA = a?.length ?? 0;
  const lenB = b?.length ?? 0;
  if (lenA !== lenB) return false;
  if (lenA === 0) return true;
  for (let i = 0; i < lenA; i++) {
    const ma = a![i];
    const mb = b![i];
    if (ma.type !== mb.type) return false;
    if (JSON.stringify(ma.attrs ?? null) !== JSON.stringify(mb.attrs ?? null)) {
      return false;
    }
  }
  return true;
}

function pushTextJson(
  out: JSONContent[],
  text: string,
  marks: MarkSpec[]
): void {
  if (!text) return;
  const normalizedMarks = marks.length > 0 ? marks.map(cloneMarkSpec) : undefined;
  const prev = out[out.length - 1];
  if (
    prev &&
    prev.type === 'text' &&
    typeof prev.text === 'string' &&
    areMarkArraysEqual(prev.marks as MarkSpec[] | undefined, normalizedMarks)
  ) {
    prev.text += text;
    return;
  }
  const item: JSONContent = {
    type: 'text',
    text,
  };
  if (normalizedMarks && normalizedMarks.length > 0) {
    item.marks = normalizedMarks;
  }
  out.push(item);
}

function flattenPhrasingToStream(
  nodes: PhrasingContent[],
  out: StreamToken[]
): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        if (node.value.length > 0) {
          out.push({ kind: 'text', value: node.value });
        }
        break;
      }

      case 'strong': {
        out.push({ kind: 'pushStructural', mark: { type: 'bold' } });
        flattenPhrasingToStream(node.children, out);
        out.push({ kind: 'popStructural' });
        break;
      }

      case 'emphasis': {
        out.push({ kind: 'pushStructural', mark: { type: 'italic' } });
        flattenPhrasingToStream(node.children, out);
        out.push({ kind: 'popStructural' });
        break;
      }

      case 'delete': {
        out.push({ kind: 'pushStructural', mark: { type: 'strike' } });
        flattenPhrasingToStream(node.children, out);
        out.push({ kind: 'popStructural' });
        break;
      }

      case 'link': {
        out.push({
          kind: 'pushStructural',
          mark: {
            type: 'link',
            attrs: {
              href: node.url,
              title: node.title ?? null,
            },
          },
        });
        flattenPhrasingToStream(node.children, out);
        out.push({ kind: 'popStructural' });
        break;
      }

      case 'inlineCode': {
        if (node.value.length > 0) {
          out.push({ kind: 'inlineCode', value: node.value });
        }
        break;
      }

      case 'inlineMath': {
        out.push({ kind: 'inlineMath', latex: node.value });
        break;
      }

      case 'break': {
        out.push({ kind: 'hardBreak' });
        break;
      }

      case 'html': {
        if (node.value.length > 0) {
          out.push({ kind: 'html', value: node.value });
        }
        break;
      }

      case 'image': {
        // Top-level images are promoted in `convertPhrasingToBlocks`
        break;
      }

      default: {
        const anyNode = node as unknown as {
          value?: string;
          children?: PhrasingContent[];
        };
        if (Array.isArray(anyNode.children)) {
          flattenPhrasingToStream(anyNode.children, out);
        } else if (
          typeof anyNode.value === 'string' &&
          anyNode.value.length > 0
        ) {
          out.push({ kind: 'text', value: anyNode.value });
        }
        break;
      }
    }
  }
}

function findUnescapedCriticOpen(str: string, fromIdx: number): number {
  let idx = str.indexOf('{==', fromIdx);
  while (idx !== -1) {
    if (idx === 0 || str[idx - 1] !== '\\') {
      return idx;
    }
    idx = str.indexOf('{==', idx + 3);
  }
  return -1;
}

function extractRawTextFromStreamSlice(
  tokens: StreamToken[],
  startTok: number,
  startChar: number,
  endTok: number,
  endChar: number
): string {
  if (startTok === endTok) {
    const tok = tokens[startTok];
    return tok.kind === 'text' ? tok.value.slice(startChar, endChar) : '';
  }

  const parts: string[] = [];
  for (let t = startTok; t <= endTok; t++) {
    const tok = tokens[t];
    if (t === startTok) {
      if (tok.kind === 'text') parts.push(tok.value.slice(startChar));
    } else if (t === endTok) {
      if (tok.kind === 'text') parts.push(tok.value.slice(0, endChar));
    } else {
      switch (tok.kind) {
        case 'text':
        case 'html':
          parts.push(tok.value);
          break;
        case 'inlineCode':
          parts.push(`\`${tok.value}\``);
          break;
        case 'inlineMath':
          parts.push(`$${tok.latex}$`);
          break;
        case 'hardBreak':
          parts.push('\n');
          break;
        default:
          break;
      }
    }
  }
  return parts.join('');
}

/**
 * Pass 1: Transforms CriticMarkup `{==anchored text==}{>>comment text<<}` into
 * `highlight(yellow)` + `comment` mark spans across single or sibling phrasing tokens.
 */
function transformCriticMarkupInStream(
  tokens: StreamToken[],
  parseCtx: ParseContext
): StreamToken[] {
  const result: StreamToken[] = [];
  let i = 0;
  let charOffset = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.kind !== 'text') {
      result.push(tok);
      i++;
      charOffset = 0;
      continue;
    }

    const text = tok.value;
    const openIdx = findUnescapedCriticOpen(text, charOffset);
    if (openIdx === -1) {
      const rem = text.slice(charOffset);
      if (rem.length > 0) {
        result.push({ kind: 'text', value: rem });
      }
      i++;
      charOffset = 0;
      continue;
    }

    // Search for `==}{>>` from `(i, openIdx + 3)` onward
    let midTok = -1;
    let midChar = -1;
    for (let j = i; j < tokens.length; j++) {
      const cand = tokens[j];
      if (cand.kind !== 'text') continue;
      const searchFrom = j === i ? openIdx + 3 : 0;
      const foundMid = cand.value.indexOf('==}{>>', searchFrom);
      if (foundMid !== -1) {
        midTok = j;
        midChar = foundMid;
        break;
      }
    }

    if (midTok === -1) {
      const rem = text.slice(charOffset);
      if (rem.length > 0) {
        result.push({ kind: 'text', value: rem });
      }
      i++;
      charOffset = 0;
      continue;
    }

    // Search for `<<}` from `(midTok, midChar + 6)` onward
    let endTok = -1;
    let endChar = -1;
    for (let k = midTok; k < tokens.length; k++) {
      const cand = tokens[k];
      if (cand.kind !== 'text') continue;
      const searchFrom = k === midTok ? midChar + 6 : 0;
      const foundEnd = cand.value.indexOf('<<}', searchFrom);
      if (foundEnd !== -1) {
        endTok = k;
        endChar = foundEnd;
        break;
      }
    }

    const hasAnchoredContent =
      midTok > i || (midTok === i && midChar > openIdx + 3);

    if (endTok === -1 || !hasAnchoredContent) {
      // Not a valid complete `{==...==}{>>...<<}`; emit literal up past `{==`
      result.push({ kind: 'text', value: text.slice(charOffset, openIdx + 3) });
      charOffset = openIdx + 3;
      continue;
    }

    // Emit prefix before `{==`
    if (openIdx > charOffset) {
      result.push({ kind: 'text', value: text.slice(charOffset, openIdx) });
    }

    const rawComment = unescapeCommentAttr(
      extractRawTextFromStreamSlice(
        tokens,
        midTok,
        midChar + 6,
        endTok,
        endChar
      )
    ).trim();

    const marksToPush: MarkSpec[] = [
      { type: 'highlight', attrs: { color: 'yellow' } },
    ];
    const popTypes: string[] = ['highlight'];

    if (rawComment.length > 0) {
      const commentId = `c-ext-${++parseCtx.extCommentCounter}`;
      marksToPush.push({
        type: 'comment',
        attrs: {
          id: commentId,
          text: rawComment,
          createdAt: null,
        },
      });
      popTypes.unshift('comment');
    }

    result.push({ kind: 'pushAnnotation', marks: marksToPush });

    // Emit anchored content between `(i, openIdx + 3)` and `(midTok, midChar)`
    if (i === midTok) {
      const anchored = text.slice(openIdx + 3, midChar);
      if (anchored.length > 0) {
        result.push({ kind: 'text', value: anchored });
      }
    } else {
      const firstTail = text.slice(openIdx + 3);
      if (firstTail.length > 0) {
        result.push({ kind: 'text', value: firstTail });
      }
      for (let m = i + 1; m < midTok; m++) {
        result.push(tokens[m]);
      }
      const midToken = tokens[midTok] as { kind: 'text'; value: string };
      const lastHead = midToken.value.slice(0, midChar);
      if (lastHead.length > 0) {
        result.push({ kind: 'text', value: lastHead });
      }
    }

    // Preserve any structural push/pop balanced markers that might have occurred inside `{>>...<<}`
    for (let m = midTok + 1; m < endTok; m++) {
      const inner = tokens[m];
      if (inner.kind === 'pushStructural' || inner.kind === 'popStructural') {
        result.push(inner);
      }
    }

    result.push({ kind: 'popAnnotation', types: popTypes });

    i = endTok;
    charOffset = endChar + 3;
  }

  return result;
}

function findExactDoubleEquals(str: string, fromIdx: number): number {
  let idx = fromIdx;
  while (idx + 1 < str.length) {
    if (str[idx] === '=' && str[idx + 1] === '=') {
      const prevOk =
        idx === 0 || (str[idx - 1] !== '=' && str[idx - 1] !== '\\');
      const nextOk = idx + 2 >= str.length || str[idx + 2] !== '=';
      if (prevOk && nextOk) {
        return idx;
      }
      // Skip entire run of `=`
      while (idx < str.length && str[idx] === '=') {
        idx++;
      }
      continue;
    }
    idx++;
  }
  return -1;
}

function hasNonWsImmediatelyAfter(
  tokens: StreamToken[],
  tokIdx: number,
  afterCharIdx: number
): boolean {
  const tok = tokens[tokIdx];
  if (tok.kind !== 'text') return false;
  if (afterCharIdx < tok.value.length) {
    return !/\s/.test(tok.value[afterCharIdx]);
  }
  for (let m = tokIdx + 1; m < tokens.length; m++) {
    const cand = tokens[m];
    if (
      cand.kind === 'pushStructural' ||
      cand.kind === 'popStructural' ||
      cand.kind === 'pushAnnotation' ||
      cand.kind === 'popAnnotation'
    ) {
      continue;
    }
    if (cand.kind === 'inlineMath' || cand.kind === 'inlineCode') {
      return true;
    }
    if (cand.kind === 'text') {
      return cand.value.length > 0 && !/\s/.test(cand.value[0]);
    }
    if (cand.kind === 'html') {
      if (/^<br\s*\/?>$/i.test(cand.value.trim())) return false;
      continue;
    }
    return false;
  }
  return false;
}

function hasNonWsImmediatelyBefore(
  tokens: StreamToken[],
  openTokIdx: number,
  openAfterCharIdx: number,
  closeTokIdx: number,
  closeCharIdx: number
): boolean {
  if (closeTokIdx === openTokIdx && closeCharIdx <= openAfterCharIdx) {
    return false;
  }
  const closeTok = tokens[closeTokIdx];
  if (closeTok.kind !== 'text') return false;
  if (closeCharIdx > 0) {
    return !/\s/.test(closeTok.value[closeCharIdx - 1]);
  }
  for (let m = closeTokIdx - 1; m >= openTokIdx; m--) {
    if (m === openTokIdx) {
      const openTok = tokens[openTokIdx];
      if (openTok.kind !== 'text') return false;
      const tail = openTok.value.slice(openAfterCharIdx);
      return tail.length > 0 && !/\s/.test(tail[tail.length - 1]);
    }
    const cand = tokens[m];
    if (
      cand.kind === 'pushStructural' ||
      cand.kind === 'popStructural' ||
      cand.kind === 'pushAnnotation' ||
      cand.kind === 'popAnnotation'
    ) {
      continue;
    }
    if (cand.kind === 'inlineMath' || cand.kind === 'inlineCode') {
      return true;
    }
    if (cand.kind === 'text') {
      return (
        cand.value.length > 0 &&
        !/\s/.test(cand.value[cand.value.length - 1])
      );
    }
    if (cand.kind === 'html') {
      if (/^<br\s*\/?>$/i.test(cand.value.trim())) return false;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Pass 2: Transforms Typora-style `==...==` (where `==` is not `===` and has
 * non-whitespace immediately inside both opening and closing `==`, including across
 * sibling phrasing nodes like `==显著 ($p < 0.01$)==`) into `highlight(yellow)`.
 */
function transformTyporaHighlightInStream(tokens: StreamToken[]): StreamToken[] {
  const result: StreamToken[] = [];
  let i = 0;
  let charOffset = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.kind !== 'text') {
      result.push(tok);
      i++;
      charOffset = 0;
      continue;
    }

    const text = tok.value;
    const eqIdx = findExactDoubleEquals(text, charOffset);
    if (eqIdx === -1) {
      const rem = text.slice(charOffset);
      if (rem.length > 0) {
        result.push({ kind: 'text', value: rem });
      }
      i++;
      charOffset = 0;
      continue;
    }

    const canOpen = hasNonWsImmediatelyAfter(tokens, i, eqIdx + 2);
    if (!canOpen) {
      result.push({ kind: 'text', value: text.slice(charOffset, eqIdx + 2) });
      charOffset = eqIdx + 2;
      continue;
    }

    // Scan forward for matching valid closing `==`
    let closeTok = -1;
    let closeChar = -1;

    for (let j = i; j < tokens.length; j++) {
      const cand = tokens[j];
      if (cand.kind !== 'text') continue;
      let searchPos = j === i ? eqIdx + 2 : 0;
      while (searchPos + 1 < cand.value.length) {
        const candidateClose = findExactDoubleEquals(cand.value, searchPos);
        if (candidateClose === -1) break;
        if (
          hasNonWsImmediatelyBefore(
            tokens,
            i,
            eqIdx + 2,
            j,
            candidateClose
          )
        ) {
          closeTok = j;
          closeChar = candidateClose;
          break;
        }
        searchPos = candidateClose + 2;
      }
      if (closeTok !== -1) break;
    }

    if (closeTok === -1) {
      result.push({ kind: 'text', value: text.slice(charOffset, eqIdx + 2) });
      charOffset = eqIdx + 2;
      continue;
    }

    // Emit prefix before opening `==`
    if (eqIdx > charOffset) {
      result.push({ kind: 'text', value: text.slice(charOffset, eqIdx) });
    }

    result.push({
      kind: 'pushAnnotation',
      marks: [{ type: 'highlight', attrs: { color: 'yellow' } }],
    });

    if (i === closeTok) {
      const inner = text.slice(eqIdx + 2, closeChar);
      if (inner.length > 0) {
        result.push({ kind: 'text', value: inner });
      }
    } else {
      const firstTail = text.slice(eqIdx + 2);
      if (firstTail.length > 0) {
        result.push({ kind: 'text', value: firstTail });
      }
      for (let m = i + 1; m < closeTok; m++) {
        result.push(tokens[m]);
      }
      const endToken = tokens[closeTok] as { kind: 'text'; value: string };
      const lastHead = endToken.value.slice(0, closeChar);
      if (lastHead.length > 0) {
        result.push({ kind: 'text', value: lastHead });
      }
    }

    result.push({ kind: 'popAnnotation', types: ['highlight'] });

    i = closeTok;
    charOffset = closeChar + 2;
  }

  return result;
}

function popLastMarkOfType(stack: MarkSpec[], markType: string): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].type === markType) {
      stack.splice(i, 1);
      return true;
    }
  }
  return false;
}

function buildEffectiveMarks(
  structuralMarks: MarkSpec[],
  openAnnotations: MarkSpec[],
  allowedTypes?: Set<string>
): MarkSpec[] {
  const combined = [...structuralMarks, ...openAnnotations];
  const deduped: MarkSpec[] = [];

  for (const mark of combined) {
    if (allowedTypes && !allowedTypes.has(mark.type)) {
      continue;
    }
    const existingIdx = deduped.findIndex((m) => m.type === mark.type);
    if (existingIdx !== -1) {
      deduped.splice(existingIdx, 1);
    }
    deduped.push(cloneMarkSpec(mark));
  }

  return deduped;
}

function processHtmlChunk(
  chunk: string,
  structuralMarks: MarkSpec[],
  openAnnotations: MarkSpec[],
  spanKindStack: Array<'comment' | 'other'>,
  parseCtx: ParseContext,
  out: JSONContent[]
): void {
  const trimmed = chunk.trim();

  if (/^<br\s*\/?>$/i.test(trimmed)) {
    out.push({ type: 'hardBreak' });
    return;
  }

  if (/^<mark(?:\s[\s\S]*)?>$/i.test(trimmed) && !trimmed.endsWith('/>')) {
    const attrs = parseHtmlTagAttributes(trimmed);
    const color = normalizeHighlightColor(attrs['data-color']);
    openAnnotations.push({
      type: 'highlight',
      attrs: { color },
    });
    return;
  }

  if (/^<\/mark\s*>$/i.test(trimmed)) {
    popLastMarkOfType(openAnnotations, 'highlight');
    return;
  }

  if (/^<span(?:\s[\s\S]*)?>$/i.test(trimmed) && !trimmed.endsWith('/>')) {
    const attrs = parseHtmlTagAttributes(trimmed);
    const hasCommentAttr =
      'data-comment' in attrs ||
      'data-comment-id' in attrs ||
      'data-id' in attrs;

    if (hasCommentAttr) {
      const decodedText = unescapeCommentAttr(attrs['data-comment'] ?? '');
      const rawId = unescapeCommentAttr(
        attrs['data-id'] || attrs['data-comment-id'] || ''
      ).trim();
      const id = rawId || `c-ext-${++parseCtx.extCommentCounter}`;
      const rawTime = attrs['data-time']
        ? unescapeCommentAttr(attrs['data-time']).trim()
        : '';

      spanKindStack.push('comment');
      openAnnotations.push({
        type: 'comment',
        attrs: {
          id,
          text: decodedText,
          createdAt: rawTime || null,
        },
      });
      return;
    }

    spanKindStack.push('other');
    pushTextJson(out, chunk, buildEffectiveMarks(structuralMarks, openAnnotations));
    return;
  }

  if (/^<\/span\s*>$/i.test(trimmed)) {
    if (spanKindStack.length > 0) {
      const top = spanKindStack.pop();
      if (top === 'comment') {
        popLastMarkOfType(openAnnotations, 'comment');
        return;
      }
      pushTextJson(
        out,
        chunk,
        buildEffectiveMarks(structuralMarks, openAnnotations)
      );
      return;
    }

    if (popLastMarkOfType(openAnnotations, 'comment')) {
      return;
    }

    pushTextJson(out, chunk, buildEffectiveMarks(structuralMarks, openAnnotations));
    return;
  }

  pushTextJson(out, chunk, buildEffectiveMarks(structuralMarks, openAnnotations));
}

function convertPhrasingNodes(
  nodes: PhrasingContent[],
  parseCtx: ParseContext
): JSONContent[] {
  const rawStream: StreamToken[] = [];
  flattenPhrasingToStream(nodes, rawStream);

  const afterCritic = transformCriticMarkupInStream(rawStream, parseCtx);
  const finalStream = transformTyporaHighlightInStream(afterCritic);

  const out: JSONContent[] = [];
  const structuralMarks: MarkSpec[] = [];
  const openAnnotations: MarkSpec[] = [];
  const spanKindStack: Array<'comment' | 'other'> = [];

  for (const token of finalStream) {
    switch (token.kind) {
      case 'text': {
        pushTextJson(
          out,
          token.value,
          buildEffectiveMarks(structuralMarks, openAnnotations)
        );
        break;
      }

      case 'inlineCode': {
        if (token.value.length > 0) {
          const outerMarks = buildEffectiveMarks(
            structuralMarks,
            openAnnotations,
            MATH_AND_CODE_OUTER_MARKS
          );
          out.push({
            type: 'text',
            text: token.value,
            marks: [...outerMarks, { type: 'code' }],
          });
        }
        break;
      }

      case 'inlineMath': {
        const mathMarks = buildEffectiveMarks(
          structuralMarks,
          openAnnotations,
          MATH_AND_CODE_OUTER_MARKS
        );
        const mathNode: JSONContent = {
          type: 'mathInline',
          attrs: {
            latex: token.latex,
          },
        };
        if (mathMarks.length > 0) {
          mathNode.marks = mathMarks;
        }
        out.push(mathNode);
        break;
      }

      case 'hardBreak': {
        out.push({ type: 'hardBreak' });
        break;
      }

      case 'pushStructural': {
        structuralMarks.push(token.mark);
        break;
      }

      case 'popStructural': {
        structuralMarks.pop();
        break;
      }

      case 'pushAnnotation': {
        openAnnotations.push(...token.marks.map(cloneMarkSpec));
        break;
      }

      case 'popAnnotation': {
        for (const t of token.types) {
          popLastMarkOfType(openAnnotations, t);
        }
        break;
      }

      case 'html': {
        HTML_TAG_CHUNK_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = HTML_TAG_CHUNK_RE.exec(token.value)) !== null) {
          processHtmlChunk(
            match[0],
            structuralMarks,
            openAnnotations,
            spanKindStack,
            parseCtx,
            out
          );
        }
        break;
      }
    }
  }

  return out;
}

/**
 * Converts a list of phrasing nodes into ProseMirror block JSON node(s),
 * cleanly promoting `image` nodes (`group: 'block'`) into standalone block image nodes.
 */
function convertPhrasingToBlocks(
  children: PhrasingContent[],
  parseCtx: ParseContext
): JSONContent[] {
  const hasDirectImage = children.some(
    (c) =>
      c.type === 'image' ||
      (c.type === 'link' &&
        c.children.length === 1 &&
        c.children[0].type === 'image')
  );

  if (!hasDirectImage) {
    const inlines = convertPhrasingNodes(children, parseCtx);
    return [
      inlines.length > 0
        ? { type: 'paragraph', content: inlines }
        : { type: 'paragraph' },
    ];
  }

  const blocks: JSONContent[] = [];
  let phrasingRun: PhrasingContent[] = [];

  const flushRun = () => {
    if (phrasingRun.length === 0) return;
    // Ignore purely whitespace runs adjacent to block images
    const isWhitespaceOnly = phrasingRun.every(
      (n) => n.type === 'text' && n.value.trim().length === 0
    );
    if (!isWhitespaceOnly) {
      const inlines = convertPhrasingNodes(phrasingRun, parseCtx);
      if (inlines.length > 0) {
        blocks.push({ type: 'paragraph', content: inlines });
      }
    }
    phrasingRun = [];
  };

  for (const child of children) {
    if (child.type === 'image') {
      flushRun();
      blocks.push({
        type: 'image',
        attrs: {
          src: child.url ?? '',
          alt: child.alt ?? '',
          title: child.title ?? null,
        },
      });
    } else if (
      child.type === 'link' &&
      child.children.length === 1 &&
      child.children[0].type === 'image'
    ) {
      flushRun();
      const img = child.children[0];
      blocks.push({
        type: 'image',
        attrs: {
          src: img.url ?? '',
          alt: img.alt ?? '',
          title: img.title ?? null,
        },
      });
    } else {
      phrasingRun.push(child);
    }
  }

  flushRun();

  return blocks.length > 0 ? blocks : [{ type: 'paragraph' }];
}

function convertParagraph(
  node: Paragraph,
  parseCtx: ParseContext
): JSONContent[] {
  return convertPhrasingToBlocks(node.children, parseCtx);
}

function convertHeading(node: Heading, parseCtx: ParseContext): JSONContent {
  const level = Math.min(6, Math.max(1, node.depth || 1));
  const inlines = convertPhrasingNodes(node.children, parseCtx);
  return inlines.length > 0
    ? { type: 'heading', attrs: { level }, content: inlines }
    : { type: 'heading', attrs: { level } };
}

function convertCode(node: Code): JSONContent {
  const lang = node.lang?.trim() || null;
  if (lang && lang.toLowerCase() === 'svg') {
    return {
      type: 'svgBlock',
      attrs: {
        code: node.value,
      },
    };
  }
  return node.value.length > 0
    ? {
        type: 'codeBlock',
        attrs: { language: lang },
        content: [{ type: 'text', text: node.value }],
      }
    : {
        type: 'codeBlock',
        attrs: { language: lang },
      };
}

function convertBlockquoteOrCallout(
  node: Blockquote,
  parseCtx: ParseContext
): JSONContent {
  const firstChild = node.children[0];
  if (
    firstChild &&
    firstChild.type === 'paragraph' &&
    firstChild.children.length > 0 &&
    firstChild.children[0].type === 'text'
  ) {
    const firstText = firstChild.children[0].value;
    const match = CALLOUT_MARKER_RE.exec(firstText);
    if (match) {
      const kind = match[1].toLowerCase() as CalloutKind;
      const remainderText = firstText.slice(match[0].length);
      const updatedInlineChildren: PhrasingContent[] = [];

      if (remainderText.length > 0) {
        updatedInlineChildren.push({
          type: 'text',
          value: remainderText,
        });
        updatedInlineChildren.push(...firstChild.children.slice(1));
      } else {
        let restSlice = firstChild.children.slice(1);
        if (restSlice[0]?.type === 'break') {
          restSlice = restSlice.slice(1);
        }
        updatedInlineChildren.push(...restSlice);
      }

      const remainingBlocks: JSONContent[] = [];
      if (updatedInlineChildren.length > 0) {
        remainingBlocks.push(
          ...convertPhrasingToBlocks(updatedInlineChildren, parseCtx)
        );
      }
      for (const sibling of node.children.slice(1)) {
        remainingBlocks.push(...convertBlockContent(sibling, parseCtx));
      }

      return {
        type: 'callout',
        attrs: { kind },
        content:
          remainingBlocks.length > 0
            ? remainingBlocks
            : [{ type: 'paragraph' }],
      };
    }
  }

  const innerBlocks: JSONContent[] = [];
  for (const child of node.children) {
    innerBlocks.push(...convertBlockContent(child, parseCtx));
  }

  return {
    type: 'blockquote',
    content: innerBlocks.length > 0 ? innerBlocks : [{ type: 'paragraph' }],
  };
}

function convertListItemBlocks(
  item: ListItem,
  parseCtx: ParseContext
): JSONContent[] {
  const blocks: JSONContent[] = [];
  for (const child of item.children) {
    blocks.push(...convertBlockContent(child, parseCtx));
  }
  // Tiptap's ListItem and TaskItem schemas require `paragraph block*`
  if (blocks.length === 0) {
    return [{ type: 'paragraph' }];
  }
  if (blocks[0].type !== 'paragraph') {
    return [{ type: 'paragraph' }, ...blocks];
  }
  return blocks;
}

function convertList(node: List, parseCtx: ParseContext): JSONContent[] {
  if (node.children.length === 0) {
    return [];
  }

  const result: JSONContent[] = [];
  let currentIsTask: boolean | null = null;
  let currentItems: JSONContent[] = [];
  let orderedCursor = node.start ?? 1;
  let runStartNumber = orderedCursor;

  const flushListRun = () => {
    if (currentItems.length === 0 || currentIsTask === null) return;
    if (currentIsTask) {
      result.push({
        type: 'taskList',
        content: currentItems,
      });
    } else if (node.ordered) {
      result.push({
        type: 'orderedList',
        attrs: { start: runStartNumber },
        content: currentItems,
      });
    } else {
      result.push({
        type: 'bulletList',
        content: currentItems,
      });
    }
    currentItems = [];
  };

  for (const item of node.children) {
    const isTask = item.checked !== null && item.checked !== undefined;
    if (currentIsTask !== null && isTask !== currentIsTask) {
      flushListRun();
      runStartNumber = orderedCursor;
    }
    if (currentIsTask === null) {
      runStartNumber = orderedCursor;
    }
    currentIsTask = isTask;

    const itemBlocks = convertListItemBlocks(item, parseCtx);
    if (isTask) {
      currentItems.push({
        type: 'taskItem',
        attrs: { checked: Boolean(item.checked) },
        content: itemBlocks,
      });
    } else {
      currentItems.push({
        type: 'listItem',
        content: itemBlocks,
      });
    }
    orderedCursor++;
  }

  flushListRun();
  return result;
}

function convertTable(node: Table, parseCtx: ParseContext): JSONContent[] {
  if (node.children.length === 0) {
    return [];
  }

  const colCount = Math.max(
    1,
    ...node.children.map((row) => row.children.length)
  );

  const rows: JSONContent[] = node.children.map((row, rowIndex) => {
    const cellType = rowIndex === 0 ? 'tableHeader' : 'tableCell';
    const cells: JSONContent[] = [];

    for (let c = 0; c < colCount; c++) {
      const mdCell = row.children[c];
      const colAlign = node.align?.[c] ?? null;
      const cellBlocks =
        mdCell && mdCell.children.length > 0
          ? convertPhrasingToBlocks(mdCell.children, parseCtx)
          : [{ type: 'paragraph' }];
      const cellJson: JSONContent = {
        type: cellType,
        content: cellBlocks.length > 0 ? cellBlocks : [{ type: 'paragraph' }],
      };
      if (colAlign === 'left' || colAlign === 'center' || colAlign === 'right') {
        cellJson.attrs = { align: colAlign };
      }
      cells.push(cellJson);
    }

    return {
      type: 'tableRow',
      content: cells,
    };
  });

  return [
    {
      type: 'table',
      content: rows,
    },
  ];
}

function convertBlockContent(
  node: RootContent,
  parseCtx: ParseContext
): JSONContent[] {
  switch (node.type) {
    case 'paragraph':
      return convertParagraph(node, parseCtx);

    case 'heading':
      return [convertHeading(node, parseCtx)];

    case 'code':
      return [convertCode(node)];

    case 'math':
      return [
        {
          type: 'mathBlock',
          attrs: {
            latex: node.value,
          },
        },
      ];

    case 'blockquote':
      return [convertBlockquoteOrCallout(node, parseCtx)];

    case 'list':
      return convertList(node, parseCtx);

    case 'table':
      return convertTable(node, parseCtx);

    case 'thematicBreak':
      return [{ type: 'horizontalRule' }];

    case 'html': {
      const trimmed = node.value.trim();
      if (/^<svg[\s>][\s\S]*<\/svg>$/i.test(trimmed)) {
        return [
          {
            type: 'svgBlock',
            attrs: { code: trimmed },
          },
        ];
      }
      if (trimmed.length === 0) {
        return [];
      }
      // Handle multi-line `<span ...>\n...\n</span>` or `<mark...>\n...\n</mark>`
      // that CommonMark Rule 7 may classify as an HTML block when the opening tag is followed by EOL
      if (/^<(?:span|mark)\b/i.test(trimmed)) {
        const collapsed = trimmed
          .replace(
            /^(<(?:span|mark)\b(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*>)[ \t]*\r?\n/i,
            '$1'
          )
          .replace(/\r?\n[ \t]*(<\/(?:span|mark)\s*>)$/i, '$1');
        if (collapsed !== trimmed) {
          const reparsed = markdownProcessor.parse(collapsed) as Root;
          const nestedBlocks: JSONContent[] = [];
          for (const child of reparsed.children) {
            if (child.type !== 'html') {
              nestedBlocks.push(...convertBlockContent(child, parseCtx));
            }
          }
          if (nestedBlocks.length > 0) {
            return nestedBlocks;
          }
        }
        const inlines = convertPhrasingNodes(
          [{ type: 'html', value: trimmed }],
          parseCtx
        );
        return [
          inlines.length > 0
            ? { type: 'paragraph', content: inlines }
            : { type: 'paragraph' },
        ];
      }
      return [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: node.value }],
        },
      ];
    }

    case 'image':
      return [
        {
          type: 'image',
          attrs: {
            src: node.url ?? '',
            alt: node.alt ?? '',
            title: node.title ?? null,
          },
        },
      ];

    default: {
      const anyNode = node as unknown as { value?: string };
      if (typeof anyNode.value === 'string' && anyNode.value.length > 0) {
        return [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: anyNode.value }],
          },
        ];
      }
      return [];
    }
  }
}

/**
 * Parses a single Markdown chunk (normalizing AI math & display dollar blocks)
 * into an array of top-level ProseMirror/Tiptap block `JSONContent` nodes while
 * threading `ParseContext` (e.g. sequential `c-ext-N` comment IDs) across chunks.
 */
export function parseMarkdownChunkToBlocks(
  markdownChunk: string,
  parseCtx: ParseContext = createParseContext()
): JSONContent[] {
  const normalized = normalizeDisplayDollarBlocks(
    normalizeAiMathDelimiters(markdownChunk ?? '')
  );
  if (!normalized || normalized.trim().length === 0) {
    return [];
  }
  const mdast = markdownProcessor.parse(normalized) as Root;

  const blocks: JSONContent[] = [];
  for (const child of mdast.children) {
    blocks.push(...convertBlockContent(child, parseCtx));
  }
  return blocks;
}

/**
 * Parses a Markdown string (including AI LaTeX delimiters, GFM tables, task lists,
 * callout alerts, KaTeX math, `svg` diagram blocks, multi-color `<mark>` / `==...==`
 * highlights, and `<span data-comment=...>` / CriticMarkup comments) into Tiptap `JSONContent`.
 */
export function parseMarkdownToDocJson(markdown: string): JSONContent {
  const blocks = parseMarkdownChunkToBlocks(markdown, createParseContext());

  return {
    type: 'doc',
    content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
  };
}

/**
 * Parses a Markdown string directly into a ProseMirror `Node` for a given `Schema`.
 */
export function parseMarkdownToPmNode(markdown: string, schema: Schema): PMNode {
  const docJson = parseMarkdownToDocJson(markdown);
  return PMNode.fromJSON(schema, docJson);
}
