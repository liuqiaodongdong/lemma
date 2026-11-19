import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { normalizeHighlightColor } from '../extensions/HighlightMark';
import { escapeCommentAttr } from './commentAttrCodec';

interface SerializeContext {
  inTableCell: boolean;
}

const CODE_OUTER_MARKS = new Set<string>(['comment', 'highlight', 'link']);

const MARK_PRIORITY: Record<string, number> = {
  comment: 0,
  highlight: 1,
  link: 2,
  bold: 3,
  italic: 4,
  strike: 5,
};

function escapeTablePipes(text: string): string {
  return text.replace(/(?<!\\)\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function wrapInlineCode(code: string, inTableCell: boolean): string {
  const escaped = inTableCell ? escapeTablePipes(code) : code;
  // Choose a backtick fence not present inside `escaped`
  let fence = '`';
  while (escaped.includes(fence)) {
    fence += '`';
  }
  const needsPadding =
    escaped.startsWith('`') ||
    escaped.endsWith('`') ||
    (escaped.startsWith(' ') &&
      escaped.endsWith(' ') &&
      escaped.trim().length > 0);
  return needsPadding
    ? `${fence} ${escaped} ${fence}`
    : `${fence}${escaped}${fence}`;
}

function isSameMark(a: Mark, b: Mark): boolean {
  if (a.type.name !== b.type.name) return false;
  switch (a.type.name) {
    case 'link':
      return (
        (a.attrs.href ?? '') === (b.attrs.href ?? '') &&
        (a.attrs.title ?? null) === (b.attrs.title ?? null)
      );
    case 'highlight':
      return (a.attrs.color || 'yellow') === (b.attrs.color || 'yellow');
    case 'comment':
      return (
        (a.attrs.id ?? '') === (b.attrs.id ?? '') &&
        (a.attrs.text ?? '') === (b.attrs.text ?? '')
      );
    default:
      return true;
  }
}

function hasMark(marks: readonly Mark[], target: Mark): boolean {
  return marks.some((m) => isSameMark(m, target));
}

function getEligibleOuterMarks(node: PMNode): Mark[] {
  if (!node.isText) {
    if (node.type.name === 'mathInline') {
      return node.marks.filter(
        (m) => m.type.name !== 'code' && m.type.name in MARK_PRIORITY
      );
    }
    return [];
  }

  const hasCode = node.marks.some((m) => m.type.name === 'code');
  if (hasCode) {
    return node.marks.filter((m) => CODE_OUTER_MARKS.has(m.type.name));
  }

  return node.marks.filter(
    (m) => m.type.name !== 'code' && m.type.name in MARK_PRIORITY
  );
}

function wrapWithMark(inner: string, mark: Mark): string {
  if (!inner) return inner;

  switch (mark.type.name) {
    case 'comment': {
      const escapedText = escapeCommentAttr(String(mark.attrs.text ?? ''));
      const rawId = String(mark.attrs.id ?? '');
      const idAttr = rawId ? ` data-id="${escapeCommentAttr(rawId)}"` : '';
      const rawTime = mark.attrs.createdAt ? String(mark.attrs.createdAt) : '';
      const timeAttr = rawTime
        ? ` data-time="${escapeCommentAttr(rawTime)}"`
        : '';
      return `<span data-comment="${escapedText}"${idAttr}${timeAttr}>${inner}</span>`;
    }
    case 'highlight': {
      const color = normalizeHighlightColor(mark.attrs.color);
      if (color === 'yellow') {
        return `<mark>${inner}</mark>`;
      }
      return `<mark data-color="${color}">${inner}</mark>`;
    }
    case 'link': {
      const href = String(mark.attrs.href ?? '');
      const title = mark.attrs.title ? ` "${String(mark.attrs.title)}"` : '';
      return `[${inner}](${href}${title})`;
    }
    case 'bold': {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
      if (!match || !match[2]) return inner;
      return `${match[1]}**${match[2]}**${match[3]}`;
    }
    case 'italic': {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
      if (!match || !match[2]) return inner;
      return `${match[1]}*${match[2]}*${match[3]}`;
    }
    case 'strike': {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
      if (!match || !match[2]) return inner;
      return `${match[1]}~~${match[2]}~~${match[3]}`;
    }
    default:
      return inner;
  }
}

function serializeInlineSlice(
  nodes: PMNode[],
  appliedMarks: Mark[],
  ctx: SerializeContext
): string {
  let out = '';
  let i = 0;

  while (i < nodes.length) {
    const node = nodes[i];

    // Check remaining unapplied outer marks BEFORE exiting early on `!node.isText` or `code` mark
    const remaining = getEligibleOuterMarks(node)
      .filter((m) => !hasMark(appliedMarks, m))
      .sort(
        (a, b) =>
          (MARK_PRIORITY[a.type.name] ?? 99) -
          (MARK_PRIORITY[b.type.name] ?? 99)
      );

    if (remaining.length === 0) {
      if (!node.isText) {
        out += serializeLeafInlineNode(node, ctx);
        i++;
        continue;
      }

      const codeMark = node.marks.find((m) => m.type.name === 'code');
      if (codeMark) {
        out += wrapInlineCode(node.text ?? '', ctx.inTableCell);
        i++;
        continue;
      }

      let rawText = node.text ?? '';
      const insideEmphasisOrStrong = appliedMarks.some(
        (m) => m.type.name === 'italic' || m.type.name === 'bold'
      );
      if (insideEmphasisOrStrong && rawText.includes('*')) {
        rawText = rawText.replace(/(?<!\\)\*/g, '\\*');
      }
      out += ctx.inTableCell ? escapeTablePipes(rawText) : rawText;
      i++;
      continue;
    }

    // Group maximal contiguous inline nodes that share `outerMark`
    const outerMark = remaining[0];
    let end = i + 1;
    while (end < nodes.length) {
      const candidate = nodes[end];
      const candidateMarks = getEligibleOuterMarks(candidate);
      if (hasMark(candidateMarks, outerMark)) {
        end++;
      } else if (
        !candidate.isText &&
        candidate.type.name === 'mathInline' &&
        (outerMark.type.name === 'link' ||
          outerMark.type.name === 'bold' ||
          outerMark.type.name === 'italic' ||
          outerMark.type.name === 'strike') &&
        end + 1 < nodes.length &&
        hasMark(getEligibleOuterMarks(nodes[end + 1]), outerMark)
      ) {
        // Bridge inline math inside a single Markdown link/bold/italic/strike span
        end++;
      } else {
        break;
      }
    }

    const innerSerialized = serializeInlineSlice(
      nodes.slice(i, end),
      [...appliedMarks, outerMark],
      ctx
    );
    out += wrapWithMark(innerSerialized, outerMark);
    i = end;
  }

  return out;
}

function serializeLeafInlineNode(node: PMNode, ctx: SerializeContext): string {
  switch (node.type.name) {
    case 'mathInline': {
      const rawLatex = String(node.attrs.latex ?? '').trim();
      const safeLatex = ctx.inTableCell
        ? rawLatex.replace(/(?<!\\)\|/g, '\\vert ').replace(/\r?\n/g, ' ')
        : rawLatex;
      return `$${safeLatex}$`;
    }
    case 'hardBreak': {
      return ctx.inTableCell ? '<br>' : '\\\n';
    }
    case 'image': {
      const alt = String(node.attrs.alt ?? '');
      const src = String(node.attrs.src ?? '');
      const title = node.attrs.title ? ` "${String(node.attrs.title)}"` : '';
      return `![${alt}](${src}${title})`;
    }
    default:
      return ctx.inTableCell
        ? escapeTablePipes(node.textContent)
        : node.textContent;
  }
}

function serializeInlineContent(parent: PMNode, ctx: SerializeContext): string {
  const children: PMNode[] = [];
  parent.forEach((child) => {
    children.push(child);
  });
  return serializeInlineSlice(children, [], ctx);
}

function serializeListItemChildren(itemNode: PMNode): string {
  const childBlocks: PMNode[] = [];
  itemNode.forEach((child) => {
    childBlocks.push(child);
  });

  if (childBlocks.length === 0) return '';

  const parts: string[] = [];
  for (let i = 0; i < childBlocks.length; i++) {
    const block = childBlocks[i];
    const serialized = serializeBlockNode(block);
    if (i === 0) {
      parts.push(serialized);
    } else {
      const prev = childBlocks[i - 1];
      const isTightNestedList =
        prev.type.name === 'paragraph' &&
        (block.type.name === 'bulletList' ||
          block.type.name === 'orderedList' ||
          block.type.name === 'taskList');
      parts.push((isTightNestedList ? '\n' : '\n\n') + serialized);
    }
  }

  return parts.join('');
}

function indentContinuationLines(
  content: string,
  firstPrefix: string,
  indent: string
): string {
  const lines = content.split('\n');
  if (lines.length === 0) return firstPrefix.trimEnd();
  const [first, ...rest] = lines;
  const formattedFirst =
    first.length > 0 ? `${firstPrefix}${first}` : firstPrefix.trimEnd();
  if (rest.length === 0) return formattedFirst;
  const formattedRest = rest.map((line) =>
    line.length > 0 ? `${indent}${line}` : ''
  );
  return [formattedFirst, ...formattedRest].join('\n');
}

function serializeTableCell(cellNode: PMNode): string {
  const segments: string[] = [];
  cellNode.forEach((block) => {
    if (block.type.name === 'paragraph' || block.type.name === 'heading') {
      const text = serializeInlineContent(block, { inTableCell: true }).trim();
      if (text.length > 0) {
        segments.push(text);
      }
    } else if (block.type.name === 'image') {
      const alt = String(block.attrs.alt ?? '');
      const src = String(block.attrs.src ?? '');
      const title = block.attrs.title ? ` "${String(block.attrs.title)}"` : '';
      segments.push(`![${escapeTablePipes(alt)}](${src}${title})`);
    } else if (block.type.name === 'mathBlock') {
      const latex = String(block.attrs.latex ?? '')
        .trim()
        .replace(/(?<!\\)\|/g, '\\vert ')
        .replace(/\r?\n/g, ' ');
      if (latex.length > 0) {
        segments.push(`$${latex}$`);
      }
    } else {
      const fallback = escapeTablePipes(block.textContent.trim());
      if (fallback.length > 0) {
        segments.push(fallback);
      }
    }
  });
  return segments.join('<br>');
}

function serializeTable(tableNode: PMNode): string {
  const rows: string[][] = [];
  const colAligns: Array<string | null> = [];
  let rowIdx = 0;
  tableNode.forEach((rowNode) => {
    const rowCells: string[] = [];
    let colIdx = 0;
    rowNode.forEach((cellNode) => {
      if (rowIdx === 0) {
        const align = cellNode.attrs?.align;
        colAligns[colIdx] =
          align === 'left' || align === 'center' || align === 'right'
            ? align
            : null;
      }
      rowCells.push(serializeTableCell(cellNode));
      colIdx++;
    });
    rows.push(rowCells);
    rowIdx++;
  });

  if (rows.length === 0) return '';
  const colCount = Math.max(1, ...rows.map((r) => r.length));

  const normalizeRow = (cells: string[]): string => {
    const padded: string[] = [];
    for (let c = 0; c < colCount; c++) {
      padded.push(cells[c] ?? '');
    }
    return `| ${padded.join(' | ')} |`;
  };

  const formatAlignMarker = (align: string | null | undefined): string => {
    if (align === 'left') return ':---';
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    return '---';
  };

  const headerLine = normalizeRow(rows[0]);
  const separatorLine = `| ${Array.from({ length: colCount }, (_, c) =>
    formatAlignMarker(colAligns[c])
  ).join(' | ')} |`;
  const bodyLines = rows.slice(1).map(normalizeRow);

  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

function prefixBlockquoteLines(inner: string): string {
  return inner
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

function serializeBlockChildren(parent: PMNode): string {
  const parts: string[] = [];
  parent.forEach((child) => {
    parts.push(serializeBlockNode(child));
  });
  return parts.join('\n\n');
}

function serializeBlockNode(node: PMNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return serializeInlineContent(node, { inTableCell: false });

    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1));
      const hashes = '#'.repeat(level);
      const text = serializeInlineContent(node, { inTableCell: false });
      return text.length > 0 ? `${hashes} ${text}` : hashes;
    }

    case 'mathBlock': {
      const latex = String(node.attrs.latex ?? '').trim();
      return `$$\n${latex}\n$$`;
    }

    case 'svgBlock': {
      const code = String(node.attrs.code ?? '').trim();
      return `\`\`\`svg\n${code}\n\`\`\``;
    }

    case 'codeBlock': {
      const lang = String(node.attrs.language ?? '').trim();
      const rawCode = node.textContent.replace(/\n$/, '');
      let fence = '```';
      while (rawCode.includes(fence)) {
        fence += '`';
      }
      return `${fence}${lang}\n${rawCode}\n${fence}`;
    }

    case 'callout': {
      const kind = String(node.attrs.kind ?? 'note').toUpperCase();
      const inner = serializeBlockChildren(node);
      if (!inner.trim()) {
        return `> [!${kind}]\n> `;
      }
      return `> [!${kind}]\n${prefixBlockquoteLines(inner)}`;
    }

    case 'blockquote': {
      const inner = serializeBlockChildren(node);
      return prefixBlockquoteLines(inner);
    }

    case 'bulletList': {
      const items: string[] = [];
      node.forEach((item) => {
        const body = serializeListItemChildren(item);
        items.push(indentContinuationLines(body, '- ', '  '));
      });
      return items.join('\n');
    }

    case 'orderedList': {
      const start = Number(node.attrs.start ?? 1) || 1;
      const items: string[] = [];
      let idx = 0;
      node.forEach((item) => {
        const prefix = `${start + idx}. `;
        const indent = ' '.repeat(prefix.length);
        const body = serializeListItemChildren(item);
        items.push(indentContinuationLines(body, prefix, indent));
        idx++;
      });
      return items.join('\n');
    }

    case 'taskList': {
      const items: string[] = [];
      node.forEach((item) => {
        const checked = Boolean(item.attrs.checked);
        const prefix = checked ? '- [x] ' : '- [ ] ';
        const body = serializeListItemChildren(item);
        items.push(indentContinuationLines(body, prefix, '  '));
      });
      return items.join('\n');
    }

    case 'table':
      return serializeTable(node);

    case 'image': {
      const alt = String(node.attrs.alt ?? '');
      const src = String(node.attrs.src ?? '');
      const title = node.attrs.title ? ` "${String(node.attrs.title)}"` : '';
      return `![${alt}](${src}${title})`;
    }

    case 'horizontalRule':
      return '---';

    default:
      return node.textContent;
  }
}

/**
 * Serializes a ProseMirror document `Node` into deterministic, human-clean Markdown.
 */
export function serializeDocToMarkdown(doc: PMNode): string {
  const blocks: string[] = [];
  doc.forEach((child) => {
    blocks.push(serializeBlockNode(child));
  });

  // An empty single-paragraph doc serializes to empty string
  if (
    blocks.length === 1 &&
    blocks[0] === '' &&
    doc.firstChild?.type.name === 'paragraph'
  ) {
    return '';
  }

  return blocks.join('\n\n');
}
