import { Mark, mergeAttributes, type Editor } from '@tiptap/core';
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { DocumentComment } from '../../types/contract';

export interface ActiveCommentPluginState {
  activeCommentId: string | null;
  draftRange: { from: number; to: number } | null;
}

export const CommentMark = Mark.create({
  name: 'comment',
  priority: 120,
  excludes: 'comment',
  inclusive: false,

  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-id') ||
          element.getAttribute('data-comment-id') ||
          '',
        renderHTML: (attributes) => ({
          'data-comment-id': String(attributes.id ?? ''),
        }),
      },
      text: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-comment') ?? '',
        renderHTML: (attributes) => ({
          'data-comment': String(attributes.text ?? ''),
        }),
      },
      createdAt: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-time') || null,
        renderHTML: (attributes) =>
          attributes.createdAt
            ? { 'data-time': String(attributes.createdAt) }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment]' }, { tag: 'span[data-comment-id]' }];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const attrs = mark.attrs;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'lemma-comment-anchor',
        'data-comment-id': String(attrs.id ?? ''),
        'data-comment': String(attrs.text ?? ''),
        ...(attrs.createdAt ? { 'data-time': String(attrs.createdAt) } : {}),
      }),
      0,
    ];
  },
});

export function generateCommentId(): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `c-${Date.now().toString(36)}-${rand}`;
}

export function formatCommentTimestamp(date?: Date): string {
  const d = date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export function extractSelectionQuote(
  doc: PMNode,
  from: number,
  to: number,
  maxLen = 80
): string {
  const docSize = doc.content.size;
  const safeFrom = Math.max(0, Math.min(from, docSize));
  const safeTo = Math.max(safeFrom, Math.min(to, docSize));
  if (safeFrom >= safeTo) return '';

  const parts: string[] = [];
  let seenTextblock = false;

  doc.nodesBetween(safeFrom, safeTo, (node, pos) => {
    if (node.isTextblock) {
      if (seenTextblock && parts.length > 0) {
        parts.push(' ');
      }
      seenTextblock = true;
      return true;
    }

    if (node.isText && node.text) {
      const startOffset = Math.max(0, safeFrom - pos);
      const endOffset = Math.min(node.text.length, safeTo - pos);
      if (endOffset > startOffset) {
        parts.push(node.text.slice(startOffset, endOffset));
      }
      return false;
    }

    if (node.type.name === 'mathInline') {
      parts.push(`$${String(node.attrs.latex ?? '')}$`);
      return false;
    }

    if (node.type.name === 'mathBlock') {
      if (parts.length > 0) parts.push(' ');
      parts.push(`$$${String(node.attrs.latex ?? '').trim()}$$`);
      return false;
    }

    if (node.type.name === 'hardBreak') {
      parts.push(' ');
      return false;
    }

    return true;
  });

  const collapsed = parts.join('').replace(/\s+/g, ' ').trim();
  if (collapsed.length > maxLen) {
    return `${collapsed.slice(0, maxLen).trimEnd()}…`;
  }
  return collapsed;
}

export function extractDocumentComments(doc: PMNode): DocumentComment[] {
  const commentType = doc.type.schema.marks.comment;
  if (
    !commentType ||
    doc.content.size === 0 ||
    !doc.rangeHasMark(0, doc.content.size, commentType)
  ) {
    return [];
  }

  interface CommentAccumulator {
    id: string;
    text: string;
    createdAt?: string;
    from: number;
    to: number;
  }

  const grouped = new Map<string, CommentAccumulator>();
  let fallbackIdx = 0;

  doc.descendants((node, pos) => {
    if (!node.isInline) return;
    const commentMark = node.marks.find((m) => m.type.name === 'comment');
    if (!commentMark) return;

    const rawId = String(commentMark.attrs.id ?? '').trim();
    const text = String(commentMark.attrs.text ?? '');
    const createdAt = commentMark.attrs.createdAt
      ? String(commentMark.attrs.createdAt)
      : undefined;
    const endPos = pos + node.nodeSize;

    const key = rawId || `__anon_${++fallbackIdx}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.from = Math.min(existing.from, pos);
      existing.to = Math.max(existing.to, endPos);
      if (!existing.text && text) {
        existing.text = text;
      }
      if (!existing.createdAt && createdAt) {
        existing.createdAt = createdAt;
      }
    } else {
      grouped.set(key, {
        id: rawId || key,
        text,
        createdAt,
        from: pos,
        to: endPos,
      });
    }
  });

  const comments: DocumentComment[] = [];
  for (const entry of grouped.values()) {
    const item: DocumentComment = {
      id: entry.id,
      text: entry.text,
      quote: extractSelectionQuote(doc, entry.from, entry.to),
      from: entry.from,
      to: entry.to,
    };
    if (entry.createdAt) {
      item.createdAt = entry.createdAt;
    }
    comments.push(item);
  }

  comments.sort((a, b) => a.from - b.from || a.to - b.to);
  return comments;
}

function getCommentIdFromMarks(marks: readonly PMMark[]): string | null {
  const found = marks.find((m) => m.type.name === 'comment');
  if (!found) return null;
  const id = String(found.attrs.id ?? '').trim();
  return id || null;
}

export function findCommentIdAtPos(doc: PMNode, pos: number): string | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);

  const direct = getCommentIdFromMarks($pos.marks());
  if (direct) return direct;

  if ($pos.parent.inlineContent) {
    if ($pos.nodeAfter) {
      const afterId = getCommentIdFromMarks($pos.nodeAfter.marks);
      if (afterId) return afterId;
    }
    if ($pos.nodeBefore) {
      const beforeId = getCommentIdFromMarks($pos.nodeBefore.marks);
      if (beforeId) return beforeId;
    }
  }

  return null;
}

export function addCommentAtRange(
  editor: Editor,
  from: number,
  to: number,
  text: string,
  createdAt?: string
): string | null {
  if (!editor || editor.isDestroyed) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const { state, view } = editor;
  const commentType = state.schema.marks.comment;
  if (!commentType) return null;

  const docSize = state.doc.content.size;
  const safeFrom = Math.max(0, Math.min(from, docSize));
  const safeTo = Math.max(0, Math.min(to, docSize));
  if (safeFrom >= safeTo) return null;

  const id = generateCommentId();
  const timestamp = createdAt ?? formatCommentTimestamp();
  const mark = commentType.create({
    id,
    text: trimmed,
    createdAt: timestamp,
  });

  const tr = state.tr
    .removeMark(safeFrom, safeTo, commentType)
    .addMark(safeFrom, safeTo, mark);

  if (!tr.docChanged) return null;

  try {
    tr.setSelection(Selection.near(tr.doc.resolve(safeTo), -1));
  } catch {
    // Keep existing mapped selection if resolving near safeTo fails
  }

  view.dispatch(tr);
  return id;
}

export function updateCommentTextById(
  editor: Editor,
  commentId: string,
  nextText: string
): boolean {
  if (!editor || editor.isDestroyed || !commentId) return false;
  const trimmed = nextText.trim();
  if (!trimmed) return false;

  const { state, view } = editor;
  const commentType = state.schema.marks.comment;
  if (!commentType) return false;

  const matches: Array<{ from: number; to: number; oldMark: PMMark }> = [];
  state.doc.descendants((node, pos) => {
    if (!node.isInline) return;
    const oldMark = node.marks.find(
      (m) => m.type.name === 'comment' && m.attrs.id === commentId
    );
    if (oldMark) {
      matches.push({ from: pos, to: pos + node.nodeSize, oldMark });
    }
  });

  if (matches.length === 0) return false;

  const tr = state.tr;
  for (const { from, to, oldMark } of matches) {
    const nextMark = commentType.create({
      ...oldMark.attrs,
      id: commentId,
      text: trimmed,
    });
    tr.removeMark(from, to, oldMark);
    tr.addMark(from, to, nextMark);
  }

  if (tr.steps.length > 0) {
    view.dispatch(tr);
  }
  return true;
}

export function removeCommentById(
  editor: Editor,
  commentId: string
): boolean {
  if (!editor || editor.isDestroyed || !commentId) return false;
  const { state, view } = editor;
  const commentType = state.schema.marks.comment;
  if (!commentType) return false;

  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (!node.isInline) return;
    const targetMark = node.marks.find(
      (m) => m.type.name === 'comment' && m.attrs.id === commentId
    );
    if (targetMark) {
      tr.removeMark(pos, pos + node.nodeSize, targetMark);
    }
  });

  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

export function clearAllComments(editor: Editor): boolean {
  if (!editor || editor.isDestroyed) return false;
  const { state, view } = editor;
  const commentType = state.schema.marks.comment;
  if (!commentType) return false;

  const docSize = state.doc.content.size;
  if (docSize === 0 || !state.doc.rangeHasMark(0, docSize, commentType)) {
    return false;
  }

  const tr = state.tr.removeMark(0, docSize, commentType);
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

export const activeCommentPluginKey = new PluginKey<ActiveCommentPluginState>(
  'lemmaActiveComment'
);

function buildActiveCommentDecorations(
  doc: PMNode,
  pluginState: ActiveCommentPluginState
): DecorationSet {
  const { activeCommentId, draftRange } = pluginState;
  if (!activeCommentId && !draftRange) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];

  if (activeCommentId) {
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      const contentStart = pos + 1;
      let spanStart: number | null = null;
      let spanEnd = 0;

      node.forEach((child, offset) => {
        const childFrom = contentStart + offset;
        const childTo = childFrom + child.nodeSize;
        const hasActiveComment = child.marks.some(
          (m) => m.type.name === 'comment' && m.attrs.id === activeCommentId
        );
        if (hasActiveComment) {
          if (spanStart === null) {
            spanStart = childFrom;
            spanEnd = childTo;
          } else if (spanEnd === childFrom) {
            spanEnd = childTo;
          } else {
            decorations.push(
              Decoration.inline(spanStart, spanEnd, {
                class: 'lemma-comment-anchor-active',
              })
            );
            spanStart = childFrom;
            spanEnd = childTo;
          }
        } else if (spanStart !== null) {
          decorations.push(
            Decoration.inline(spanStart, spanEnd, {
              class: 'lemma-comment-anchor-active',
            })
          );
          spanStart = null;
        }
      });

      if (spanStart !== null) {
        decorations.push(
          Decoration.inline(spanStart, spanEnd, {
            class: 'lemma-comment-anchor-active',
          })
        );
      }

      return false;
    });
  }

  if (draftRange) {
    const docSize = doc.content.size;
    const from = Math.max(0, Math.min(draftRange.from, docSize));
    const to = Math.max(from, Math.min(draftRange.to, docSize));
    if (from < to) {
      decorations.push(
        Decoration.inline(from, to, {
          class: 'lemma-comment-draft-range',
        })
      );
    }
  }

  return decorations.length > 0
    ? DecorationSet.create(doc, decorations)
    : DecorationSet.empty;
}

export function createActiveCommentPlugin(
  onSelectComment?: (commentId: string | null) => void
): Plugin<ActiveCommentPluginState> {
  return new Plugin<ActiveCommentPluginState>({
    key: activeCommentPluginKey,
    state: {
      init: () => ({
        activeCommentId: null,
        draftRange: null,
      }),
      apply: (tr, prev) => {
        const meta = tr.getMeta(activeCommentPluginKey) as
          | ActiveCommentPluginState
          | undefined;

        if (meta !== undefined) {
          return {
            activeCommentId: meta.activeCommentId ?? null,
            draftRange: meta.draftRange ?? null,
          };
        }

        if (!tr.docChanged || !prev.draftRange) {
          return prev;
        }

        const docSize = tr.doc.content.size;
        const mappedFrom = Math.max(
          0,
          Math.min(tr.mapping.map(prev.draftRange.from, 1), docSize)
        );
        const mappedTo = Math.max(
          mappedFrom,
          Math.min(tr.mapping.map(prev.draftRange.to, -1), docSize)
        );

        return {
          activeCommentId: prev.activeCommentId,
          draftRange:
            mappedFrom < mappedTo
              ? { from: mappedFrom, to: mappedTo }
              : null,
        };
      },
    },
    props: {
      decorations(state) {
        const pluginState = activeCommentPluginKey.getState(state);
        if (!pluginState) return DecorationSet.empty;
        return buildActiveCommentDecorations(state.doc, pluginState);
      },
      handleClick(view, pos, event) {
        const targetNode = event?.target as globalThis.Node | null;
        const targetEl =
          targetNode instanceof Element
            ? targetNode
            : targetNode?.parentElement ?? null;
        const domId =
          targetEl
            ?.closest('[data-comment-id]')
            ?.getAttribute('data-comment-id') || null;
        const foundId = domId ?? findCommentIdAtPos(view.state.doc, pos);
        onSelectComment?.(foundId);
        return false;
      },
    },
  });
}

export function setActiveCommentDecoration(
  editor: Editor,
  activeCommentId: string | null,
  draftRange?: { from: number; to: number } | null
): void {
  if (!editor || editor.isDestroyed) return;
  const prev = activeCommentPluginKey.getState(editor.state);
  if (
    prev &&
    prev.activeCommentId === activeCommentId &&
    ((!prev.draftRange && !draftRange) ||
      (prev.draftRange &&
        draftRange &&
        prev.draftRange.from === draftRange.from &&
        prev.draftRange.to === draftRange.to))
  ) {
    return;
  }
  const payload: ActiveCommentPluginState = {
    activeCommentId,
    draftRange: draftRange ?? null,
  };
  editor.view.dispatch(
    editor.state.tr.setMeta(activeCommentPluginKey, payload)
  );
}

export default CommentMark;
