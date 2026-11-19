import { Mark, mergeAttributes, type Editor } from '@tiptap/core';
import type { MarkType, Node as PMNode } from '@tiptap/pm/model';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../../types/contract';

export function normalizeHighlightColor(value: unknown): HighlightColor {
  if (
    typeof value === 'string' &&
    (HIGHLIGHT_COLORS as readonly string[]).includes(value)
  ) {
    return value as HighlightColor;
  }
  return 'yellow';
}

function isMarkableInlineNode(
  node: PMNode,
  parent: PMNode | null | undefined,
  markType: MarkType
): boolean {
  if (!node.isInline || !node.isAtom) return false;
  if (node.type.name === 'hardBreak') return false;
  if (parent && !parent.type.allowsMarkType(markType)) return false;
  return true;
}

export const HighlightMark = Mark.create({
  name: 'highlight',
  priority: 115,
  excludes: 'highlight',
  inclusive: false,

  addAttributes() {
    return {
      color: {
        default: 'yellow' as HighlightColor,
        parseHTML: (element) =>
          normalizeHighlightColor(element.getAttribute('data-color')),
        renderHTML: (attributes) => ({
          'data-color': normalizeHighlightColor(attributes.color),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'mark[data-color]' }, { tag: 'mark' }];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const color = normalizeHighlightColor(
      mark.attrs.color ?? HTMLAttributes['data-color']
    );
    return [
      'mark',
      mergeAttributes(HTMLAttributes, {
        class: 'lemma-highlight',
        'data-color': color,
      }),
      0,
    ];
  },
});

export function getSelectionHighlightColor(
  editor: Editor
): HighlightColor | null {
  if (!editor || editor.isDestroyed) return null;
  const { state } = editor;
  const highlightType = state.schema.marks.highlight;
  if (!highlightType) return null;

  const { from, to, empty, $from } = state.selection;
  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    const active = highlightType.isInSet(marks);
    return active ? normalizeHighlightColor(active.attrs.color) : null;
  }

  let sawMarkable = false;
  let uniformColor: HighlightColor | null = null;
  let isUniform = true;

  state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (!isUniform) return false;
    if (!isMarkableInlineNode(node, parent, highlightType)) {
      return;
    }
    sawMarkable = true;
    const found = highlightType.isInSet(node.marks);
    if (!found) {
      isUniform = false;
      return false;
    }
    const nodeColor = normalizeHighlightColor(found.attrs.color);
    if (uniformColor === null) {
      uniformColor = nodeColor;
    } else if (uniformColor !== nodeColor) {
      isUniform = false;
      return false;
    }
  });

  return sawMarkable && isUniform ? uniformColor : null;
}

export function hasAnyHighlightInSelection(editor: Editor): boolean {
  if (!editor || editor.isDestroyed) return false;
  const { state } = editor;
  const highlightType = state.schema.marks.highlight;
  if (!highlightType) return false;

  const { from, to, empty, $from } = state.selection;
  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    return Boolean(highlightType.isInSet(marks));
  }

  return state.doc.rangeHasMark(from, to, highlightType);
}

export function hasAnyHighlightInDoc(doc: PMNode): boolean {
  const highlightType = doc.type.schema.marks.highlight;
  if (!highlightType || doc.content.size === 0) return false;
  return doc.rangeHasMark(0, doc.content.size, highlightType);
}

export function applyHighlightColor(
  editor: Editor,
  color: HighlightColor
): void {
  if (!editor || editor.isDestroyed) return;
  const { state, view } = editor;
  const highlightType = state.schema.marks.highlight;
  if (!highlightType) return;

  const { from, to, empty } = state.selection;
  if (empty || from >= to) return;

  const validColor = normalizeHighlightColor(color);
  const currentUniform = getSelectionHighlightColor(editor);

  if (currentUniform === validColor) {
    const tr = state.tr.removeMark(from, to, highlightType);
    if (tr.docChanged) {
      view.dispatch(tr);
    }
    return;
  }

  const nextMark = highlightType.create({ color: validColor });
  const tr = state.tr
    .removeMark(from, to, highlightType)
    .addMark(from, to, nextMark);
  if (tr.docChanged) {
    view.dispatch(tr);
  }
}

export function removeSelectionHighlight(editor: Editor): void {
  if (!editor || editor.isDestroyed) return;
  const { state, view } = editor;
  const highlightType = state.schema.marks.highlight;
  if (!highlightType) return;

  const { from, to, empty, $from } = state.selection;
  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    if (highlightType.isInSet(marks)) {
      view.dispatch(state.tr.removeStoredMark(highlightType));
    }
    return;
  }

  if (!state.doc.rangeHasMark(from, to, highlightType)) return;
  const tr = state.tr.removeMark(from, to, highlightType);
  if (tr.docChanged) {
    view.dispatch(tr);
  }
}

export function clearAllHighlights(editor: Editor): boolean {
  if (!editor || editor.isDestroyed) return false;
  const { state, view } = editor;
  const highlightType = state.schema.marks.highlight;
  if (!highlightType) return false;

  const docSize = state.doc.content.size;
  if (docSize === 0 || !state.doc.rangeHasMark(0, docSize, highlightType)) {
    return false;
  }

  const tr = state.tr.removeMark(0, docSize, highlightType);
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

export default HighlightMark;
