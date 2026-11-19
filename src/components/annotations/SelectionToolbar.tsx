import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { Check, Eraser, MessageSquarePlus } from 'lucide-react';
import {
  HIGHLIGHT_COLORS,
  type HighlightColor,
} from '../../types/contract';

export interface SelectionToolbarProps {
  editor: Editor | null;
  activeHighlightColor: HighlightColor | null;
  hasSelectionHighlight: boolean;
  onSelectHighlightColor: (color: HighlightColor) => void;
  onClearHighlight: () => void;
  onStartComment: (range: { from: number; to: number }) => void;
}

const HIGHLIGHT_LABELS: Record<HighlightColor, string> = {
  yellow: '琥珀黄高亮',
  green: '薄荷绿高亮',
  blue: '天青蓝高亮',
  pink: '珊瑚粉高亮',
};

const IGNORED_BLOCK_NODE_NAMES = new Set([
  'mathBlock',
  'svgBlock',
  'codeBlock',
  'horizontalRule',
  'image',
]);

interface SelectionBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface ToolbarPosition {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

const VIEWPORT_PADDING_PX = 12;
const VERTICAL_GAP_PX = 10;
const TOPBAR_SAFE_TOP_PX = 56;
const DEFAULT_TOOLBAR_WIDTH = 216;
const DEFAULT_TOOLBAR_HEIGHT = 36;

function hasSelectableInlineContent(editor: Editor): boolean {
  const { state } = editor;
  const { selection, doc } = state;

  if (selection.empty || selection.from >= selection.to) {
    return false;
  }

  if (selection instanceof NodeSelection) {
    const selectedNode = selection.node;
    if (IGNORED_BLOCK_NODE_NAMES.has(selectedNode.type.name)) {
      return false;
    }
    return selectedNode.isInline && selectedNode.type.name === 'mathInline';
  }

  let foundInline = false;
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (foundInline) {
      return false;
    }
    if (node.isText && (node.text?.length ?? 0) > 0) {
      foundInline = true;
      return false;
    }
    if (node.type.name === 'mathInline') {
      foundInline = true;
      return false;
    }
    return true;
  });

  return foundInline;
}

function measureSelectionBox(editor: Editor): SelectionBox | null {
  const { state, view } = editor;
  const { selection } = state;
  const editorDom = view.dom as HTMLElement | null;

  if (!editorDom || !editorDom.isConnected) {
    return null;
  }

  const editorRect = editorDom.getBoundingClientRect();
  if (editorRect.width === 0 && editorRect.height === 0) {
    return null;
  }

  // Hide toolbar while typing in external inputs/textareas (e.g. CommentSidebar draft) or Math popovers
  const activeEl =
    typeof document !== 'undefined' ? document.activeElement : null;
  if (activeEl instanceof HTMLElement) {
    if (activeEl.closest('.lemma-math-popover')) {
      return null;
    }
    if (
      (activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement) &&
      !editorDom.contains(activeEl)
    ) {
      return null;
    }
  }

  // 1) Inline NodeSelection (e.g. clicking or selecting an inline KaTeX formula)
  if (selection instanceof NodeSelection) {
    const domNode = view.nodeDOM(selection.from);
    if (domNode instanceof HTMLElement) {
      const r = domNode.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        return {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
        };
      }
    }
  }

  // 2) Native DOM Selection range (most accurate across multi-line & justified text)
  const domSelection =
    typeof window !== 'undefined' ? window.getSelection() : null;
  if (domSelection && domSelection.rangeCount > 0 && !domSelection.isCollapsed) {
    const range = domSelection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    if (ancestor === editorDom || editorDom.contains(ancestor)) {
      const r = range.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        return {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
        };
      }
      const rects = range.getClientRects();
      if (rects.length > 0) {
        const first = rects[0];
        if (first.width > 0 || first.height > 0) {
          return {
            top: first.top,
            bottom: first.bottom,
            left: first.left,
            right: first.right,
            width: first.width,
            height: first.height,
          };
        }
      }
    }
  }

  // 3) Fallback to ProseMirror coordsAtPos
  try {
    const startCoords = view.coordsAtPos(selection.from);
    const endCoords = view.coordsAtPos(selection.to);
    const left = Math.min(startCoords.left, endCoords.left);
    const right = Math.max(startCoords.right, endCoords.right);
    const top = Math.min(startCoords.top, endCoords.top);
    const bottom = Math.max(startCoords.bottom, endCoords.bottom);
    const width = right - left;
    const height = bottom - top;

    if (width === 0 && height === 0) {
      return null;
    }

    return {
      top,
      bottom,
      left,
      right,
      width,
      height,
    };
  } catch {
    return null;
  }
}

function computeClampedPosition(
  selectionBox: SelectionBox,
  toolbarWidth: number,
  toolbarHeight: number
): ToolbarPosition | null {
  const viewportWidth =
    typeof window !== 'undefined' && window.innerWidth > 0
      ? window.innerWidth
      : 1024;
  const viewportHeight =
    typeof window !== 'undefined' && window.innerHeight > 0
      ? window.innerHeight
      : 768;

  // Hide if the selected text has scrolled completely off-screen
  if (
    typeof window !== 'undefined' &&
    window.innerHeight > 0 &&
    (selectionBox.bottom < 44 || selectionBox.top > viewportHeight - 8)
  ) {
    return null;
  }

  const centerX = (selectionBox.left + selectionBox.right) / 2;
  const maxLeft = Math.max(
    VIEWPORT_PADDING_PX,
    viewportWidth - toolbarWidth - VIEWPORT_PADDING_PX
  );
  const left = Math.min(
    maxLeft,
    Math.max(VIEWPORT_PADDING_PX, Math.round(centerX - toolbarWidth / 2))
  );

  let top = Math.round(selectionBox.top - toolbarHeight - VERTICAL_GAP_PX);
  let placement: 'above' | 'below' = 'above';

  if (top < TOPBAR_SAFE_TOP_PX) {
    top = Math.round(selectionBox.bottom + VERTICAL_GAP_PX);
    placement = 'below';
  }

  const maxTop = Math.max(
    TOPBAR_SAFE_TOP_PX,
    viewportHeight - toolbarHeight - VIEWPORT_PADDING_PX
  );
  top = Math.min(maxTop, Math.max(48, top));

  return { top, left, placement };
}

export function SelectionToolbar({
  editor,
  activeHighlightColor,
  hasSelectionHighlight,
  onSelectHighlightColor,
  onClearHighlight,
  onStartComment,
}: SelectionToolbarProps): React.ReactElement | null {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [position, setPosition] = useState<ToolbarPosition | null>(null);

  const syncSelectionState = useCallback(() => {
    if (
      !editor ||
      editor.isDestroyed ||
      !editor.isEditable ||
      editor.state.selection.empty ||
      !hasSelectableInlineContent(editor)
    ) {
      setSelectionBox(null);
      setPosition(null);
      return;
    }

    const box = measureSelectionBox(editor);
    if (!box || (box.width === 0 && box.height === 0)) {
      setSelectionBox(null);
      setPosition(null);
      return;
    }

    setSelectionBox(box);

    const toolbarEl = toolbarRef.current;
    const width = toolbarEl?.offsetWidth || DEFAULT_TOOLBAR_WIDTH;
    const height = toolbarEl?.offsetHeight || DEFAULT_TOOLBAR_HEIGHT;
    const nextPos = computeClampedPosition(box, width, height);
    setPosition(nextPos);
  }, [editor]);

  // Refine exact horizontal/vertical centering once the toolbar DOM mounts or changes button count
  useLayoutEffect(() => {
    if (!selectionBox || !toolbarRef.current) {
      return;
    }
    const width = toolbarRef.current.offsetWidth || DEFAULT_TOOLBAR_WIDTH;
    const height = toolbarRef.current.offsetHeight || DEFAULT_TOOLBAR_HEIGHT;
    const refined = computeClampedPosition(selectionBox, width, height);
    setPosition((prev) => {
      if (!refined) return null;
      if (
        prev &&
        prev.top === refined.top &&
        prev.left === refined.left &&
        prev.placement === refined.placement
      ) {
        return prev;
      }
      return refined;
    });
  }, [selectionBox, hasSelectionHighlight]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setSelectionBox(null);
      setPosition(null);
      return;
    }

    let blurRaf: number | null = null;
    let layoutRaf: number | null = null;

    const handleImmediateUpdate = () => {
      if (editor.isDestroyed || editor.state.selection.empty) {
        setSelectionBox((prev) => (prev === null ? null : null));
        setPosition((prev) => (prev === null ? null : null));
        return;
      }
      if (layoutRaf !== null) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = null;
        syncSelectionState();
      });
    };

    const handleBlur = () => {
      if (blurRaf !== null) {
        cancelAnimationFrame(blurRaf);
      }
      blurRaf = requestAnimationFrame(() => {
        blurRaf = null;
        syncSelectionState();
      });
    };

    syncSelectionState();

    editor.on('selectionUpdate', handleImmediateUpdate);
    editor.on('transaction', handleImmediateUpdate);
    editor.on('focus', handleImmediateUpdate);
    editor.on('blur', handleBlur);

    const editorDom = editor.view?.dom as HTMLElement | null;
    const deskScrollEl = editorDom?.closest('.lemma-desk-scroll') ?? null;

    window.addEventListener('resize', handleImmediateUpdate);
    window.addEventListener('scroll', handleImmediateUpdate, { passive: true });
    deskScrollEl?.addEventListener('scroll', handleImmediateUpdate, {
      passive: true,
    });

    return () => {
      if (blurRaf !== null) {
        cancelAnimationFrame(blurRaf);
      }
      if (layoutRaf !== null) {
        cancelAnimationFrame(layoutRaf);
      }
      editor.off('selectionUpdate', handleImmediateUpdate);
      editor.off('transaction', handleImmediateUpdate);
      editor.off('focus', handleImmediateUpdate);
      editor.off('blur', handleBlur);
      window.removeEventListener('resize', handleImmediateUpdate);
      window.removeEventListener('scroll', handleImmediateUpdate);
      deskScrollEl?.removeEventListener('scroll', handleImmediateUpdate);
    };
  }, [editor, syncSelectionState]);

  if (!editor || editor.isDestroyed || !selectionBox || !position) {
    return null;
  }

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="高亮与批注工具栏"
      className="lemma-selection-toolbar"
      data-placement={position.placement}
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: 60,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="lemma-selection-swatches" role="group" aria-label="荧光笔颜色">
        {HIGHLIGHT_COLORS.map((color) => {
          const isActive = activeHighlightColor === color;
          const label = HIGHLIGHT_LABELS[color];
          return (
            <button
              key={color}
              type="button"
              className={`lemma-swatch-btn lemma-swatch-${color}${
                isActive ? ' is-active' : ''
              }`}
              title={label}
              aria-label={label}
              aria-pressed={isActive}
              onClick={() => onSelectHighlightColor(color)}
            >
              {isActive && <Check size={11} strokeWidth={3} />}
            </button>
          );
        })}

        {hasSelectionHighlight && (
          <button
            type="button"
            className="lemma-selection-clear-btn"
            title="取消高亮"
            aria-label="取消高亮"
            onClick={onClearHighlight}
          >
            <Eraser size={13.5} strokeWidth={1.9} />
          </button>
        )}
      </div>

      <span className="lemma-selection-divider" aria-hidden="true" />

      <button
        type="button"
        className="lemma-selection-comment-btn"
        title="添加批注 (Ctrl+Alt+M)"
        aria-label="添加批注 (Ctrl+Alt+M)"
        onClick={() => {
          if (editor.isDestroyed) return;
          const { from, to } = editor.state.selection;
          if (from < to) {
            onStartComment({ from, to });
          }
        }}
      >
        <MessageSquarePlus size={14} strokeWidth={1.9} />
        <span>批注</span>
      </button>
    </div>
  );
}

export default SelectionToolbar;
