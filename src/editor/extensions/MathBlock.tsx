import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import katex from 'katex';
import {
  isHydrationActive,
  isHydrationSliceMounting,
  scheduleOrMountMath,
  unobserveMathElement,
  upgradeMathElementNow,
} from './mathViewportScheduler';

let pendingAutoOpenMathBlock = false;

function consumePendingAutoOpen(): boolean {
  if (pendingAutoOpenMathBlock) {
    pendingAutoOpenMathBlock = false;
    return true;
  }
  return false;
}

const displayKatexTemplateCache = new Map<string, HTMLTemplateElement>();
const MAX_DISPLAY_KATEX_CACHE_SIZE = 1024;

function mountDisplayKatex(target: HTMLElement, latex: string): void {
  target.classList.remove('lemma-math-block-deferred');
  const expr = latex.trim();
  const cacheKey = expr || '__EMPTY_PLACEHOLDER__';
  let tpl = displayKatexTemplateCache.get(cacheKey);
  if (!tpl) {
    let rendered: string;
    if (!expr) {
      rendered =
        '<span class="lemma-math-placeholder" style="opacity:0.55;font-style:italic;">点击输入 LaTeX 数学公式…</span>';
    } else {
      try {
        rendered = katex.renderToString(expr, {
          displayMode: true,
          output: 'html',
          throwOnError: false,
          trust: true,
          strict: 'ignore',
        });
      } catch {
        rendered = expr;
      }
    }

    tpl = document.createElement('template');
    tpl.innerHTML = rendered;
    displayKatexTemplateCache.set(cacheKey, tpl);

    if (displayKatexTemplateCache.size > MAX_DISPLAY_KATEX_CACHE_SIZE) {
      const oldestKey = displayKatexTemplateCache.keys().next().value;
      if (oldestKey !== undefined) {
        displayKatexTemplateCache.delete(oldestKey);
      }
    }
  }

  target.replaceChildren(tpl.content.cloneNode(true));
}

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-latex') ?? element.textContent ?? '',
        renderHTML: (attributes) => ({
          'data-latex': attributes.latex ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="math-block"]' },
      { tag: 'div.lemma-math-block[data-latex]' },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'math-block',
        class: 'lemma-math-block',
      }),
      `$$\n${String(node.attrs.latex ?? '').trim()}\n$$`,
    ];
  },

  addNodeView() {
    return ({ node: initialNode, editor, getPos }) => {
      let currentNode = initialNode;
      let committedLatex = String(currentNode.attrs.latex ?? '');
      let draft = committedLatex;
      let isEditing = false;
      let editorPanelEl: HTMLDivElement | null = null;
      let textareaEl: HTMLTextAreaElement | null = null;
      let focusRaf: number | null = null;

      const dom = document.createElement('div');
      dom.className = 'lemma-math-block';
      dom.setAttribute('data-type', 'math-block');
      dom.contentEditable = 'false';
      dom.style.overflow = 'visible';

      const displayEl = document.createElement('div');
      displayEl.className = 'lemma-math-block-display';
      displayEl.title = '点击展开或收起 LaTeX 公式源码';
      displayEl.style.textAlign = 'center';
      displayEl.style.padding = '0.35rem 0.5rem';
      displayEl.style.cursor = 'pointer';
      displayEl.style.overflowX = 'auto';
      scheduleOrMountMath({
        dom,
        renderTarget: displayEl,
        latex: committedLatex,
        displayMode: true,
        mountFn: () => mountDisplayKatex(displayEl, committedLatex),
      });
      dom.appendChild(displayEl);

      const dispatchLatexUpdate = (nextLatex: string) => {
        if (nextLatex === committedLatex) return;
        committedLatex = nextLatex;
        if (typeof getPos === 'function' && !editor.isDestroyed) {
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(pos, undefined, {
                ...currentNode.attrs,
                latex: nextLatex,
              })
            );
          }
        }
      };

      const handleOutsideMouseDown = (event: MouseEvent) => {
        const target = event.target as globalThis.Node | null;
        if (target && !dom.contains(target)) {
          closeEditor();
        }
      };

      const cleanupEditor = () => {
        if (focusRaf !== null) {
          cancelAnimationFrame(focusRaf);
          focusRaf = null;
        }
        document.removeEventListener('mousedown', handleOutsideMouseDown, true);
        if (editorPanelEl) {
          editorPanelEl.remove();
          editorPanelEl = null;
        }
        textareaEl = null;
        dom.classList.remove('is-editing');
      };

      const closeEditor = () => {
        if (!isEditing) return;
        isEditing = false;
        const nextLatex = draft;
        cleanupEditor();
        unobserveMathElement(dom);
        if (nextLatex !== committedLatex) {
          dispatchLatexUpdate(nextLatex);
        }
        mountDisplayKatex(displayEl, committedLatex);
      };

      const openEditor = () => {
        if (isEditing || !editor.isEditable) return;
        upgradeMathElementNow(dom);
        isEditing = true;
        draft = committedLatex;
        dom.classList.add('is-editing');

        const panel = document.createElement('div');
        panel.className = 'lemma-math-block-editor lemma-math-popover';
        panel.style.marginTop = '0.45rem';
        panel.style.padding = '0.65rem 0.8rem';
        panel.style.borderRadius = '4px';
        panel.style.border =
          '1px solid var(--latex-border-soft, rgba(120, 120, 120, 0.3))';
        panel.style.background = 'var(--bg-color, #ffffff)';
        panel.style.color = 'var(--text-color, #141414)';
        panel.style.textAlign = 'left';
        panel.addEventListener('mousedown', (e) => e.stopPropagation());
        panel.addEventListener('click', (e) => e.stopPropagation());

        const toolbar = document.createElement('div');
        toolbar.className = 'lemma-math-block-toolbar';
        toolbar.style.display = 'flex';
        toolbar.style.justifyContent = 'space-between';
        toolbar.style.alignItems = 'center';
        toolbar.style.marginBottom = '0.4rem';
        toolbar.style.fontSize = '11.5px';
        toolbar.style.color = 'var(--text-muted, inherit)';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = 'LaTeX Display Math (实时预览)';

        const doneBtn = document.createElement('button');
        doneBtn.type = 'button';
        doneBtn.textContent = '完成 (Ctrl+Enter)';
        doneBtn.style.border =
          '1px solid var(--latex-border-soft, rgba(120, 120, 120, 0.35))';
        doneBtn.style.background = 'transparent';
        doneBtn.style.color = 'var(--text-color, inherit)';
        doneBtn.style.borderRadius = '4px';
        doneBtn.style.padding = '2px 8px';
        doneBtn.style.fontSize = '11.5px';
        doneBtn.style.cursor = 'pointer';
        doneBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeEditor();
          editor.commands.focus();
        });

        toolbar.append(titleSpan, doneBtn);

        const textarea = document.createElement('textarea');
        textarea.className = 'lemma-math-block-textarea';
        textarea.value = draft;
        textarea.rows = Math.max(3, Math.min(12, draft.split('\n').length + 1));
        textarea.placeholder =
          "\\begin{aligned}\nV(k) &= \\max_{c} \\{ u(c) + \\beta V(k') \\}\n\\end{aligned}";
        textarea.style.width = '100%';
        textarea.style.boxSizing = 'border-box';
        textarea.style.fontFamily =
          'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';
        textarea.style.fontSize = '13px';
        textarea.style.lineHeight = '1.5';
        textarea.style.padding = '8px 10px';
        textarea.style.borderRadius = '3px';
        textarea.style.border =
          '1px solid var(--latex-border-soft, rgba(120, 120, 120, 0.3))';
        textarea.style.background = 'var(--latex-code-bg, #f8f9fb)';
        textarea.style.color = 'var(--latex-code-inline-color, inherit)';
        textarea.style.resize = 'vertical';
        textarea.style.outline = 'none';

        textarea.addEventListener('input', () => {
          draft = textarea.value;
          mountDisplayKatex(displayEl, draft);
          textarea.rows = Math.max(
            3,
            Math.min(12, draft.split('\n').length + 1)
          );
          dispatchLatexUpdate(draft);
        });

        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
          e.stopPropagation();
          if (
            e.key === 'Escape' ||
            ((e.ctrlKey || e.metaKey) && e.key === 'Enter')
          ) {
            e.preventDefault();
            closeEditor();
            editor.commands.focus();
          }
        });

        panel.append(toolbar, textarea);
        dom.appendChild(panel);

        editorPanelEl = panel;
        textareaEl = textarea;

        document.addEventListener('mousedown', handleOutsideMouseDown, true);
        focusRaf = requestAnimationFrame(() => {
          focusRaf = null;
          if (textareaEl) {
            textareaEl.focus();
            const len = textareaEl.value.length;
            textareaEl.setSelectionRange(len, len);
          }
        });
      };

      displayEl.addEventListener('click', (e: MouseEvent) => {
        if (!editor.isEditable) return;
        e.stopPropagation();
        if (isEditing) {
          closeEditor();
        } else {
          openEditor();
        }
      });

      const autoOpen = consumePendingAutoOpen();
      if (
        editor.isEditable &&
        !isHydrationSliceMounting() &&
        (autoOpen || (!isHydrationActive() && committedLatex.length === 0))
      ) {
        openEditor();
      }

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type !== currentNode.type) {
            return false;
          }
          currentNode = updatedNode;
          const nextLatex = String(updatedNode.attrs.latex ?? '');
          if (nextLatex !== committedLatex) {
            committedLatex = nextLatex;
            unobserveMathElement(dom);
            if (!isEditing) {
              draft = committedLatex;
              mountDisplayKatex(displayEl, committedLatex);
            }
          }
          return true;
        },
        selectNode: () => {
          dom.classList.add('is-selected');
        },
        deselectNode: () => {
          dom.classList.remove('is-selected');
        },
        stopEvent: (event) => {
          const targetNode = event.target as globalThis.Node | null;
          const targetEl =
            targetNode instanceof Element
              ? targetNode
              : targetNode?.parentElement ?? null;
          return Boolean(targetEl?.closest('.lemma-math-block-editor'));
        },
        ignoreMutation: () => true,
        destroy: () => {
          unobserveMathElement(dom);
          cleanupEditor();
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') {
            return null;
          }
          const blockFrom = $from.before();
          const blockTo = $from.after();
          const mathNode = this.type.create({ latex: '' });
          pendingAutoOpenMathBlock = true;

          if (
            $from
              .node(-1)
              .canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)
          ) {
            state.tr.replaceWith(blockFrom, blockTo, mathNode);
          } else {
            state.tr.delete(range.from, range.to).insert(blockFrom + 2, mathNode);
          }
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type.name !== 'paragraph') {
          return false;
        }
        if ($from.parent.textContent.trim() !== '$$') {
          return false;
        }
        const blockFrom = $from.before();
        const blockTo = $from.after();
        const mathNode = this.type.create({ latex: '' });
        pendingAutoOpenMathBlock = true;

        const tr = state.tr;
        if (
          $from
            .node(-1)
            .canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)
        ) {
          tr.replaceWith(blockFrom, blockTo, mathNode);
        } else {
          tr.delete($from.start(), $from.end()).insert($from.start() + 1, mathNode);
        }
        view.dispatch(tr);
        return true;
      },
    };
  },
});

export default MathBlock;
